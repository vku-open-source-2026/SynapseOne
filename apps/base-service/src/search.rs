// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tenant-scoped search over SynapseBase documents (#46).
//!
//! The index is a denormalised projection: collection/tenant/ACL/text plus a
//! deterministic local embedding. It is rebuilt by POST /v1/search/reindex and
//! every query re-checks tenant and document ACLs — the index is never a way
//! around collection scoping.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::Row;
use unicode_normalization::UnicodeNormalization;

use crate::query::round6;
use crate::store::{Store, StoredCollection, StoredDocument, StoredSearchRecord};
use crate::util::{encode_base64url_json, iso, js_number, parse_cursor_json};
use crate::Config;

pub const SEARCH_DIM: usize = 64;
pub const REAL_DIM: usize = 384;

const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "of",
    "on", "or", "that", "the", "this", "to", "was", "were", "with", "will", "you", "your",
];

#[derive(Debug, Clone, Default)]
pub struct SearchScope {
    pub platform: bool,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub subject: Option<String>,
    /// Operator/machine caller (account-level key or service account). When
    /// false, collections matching the deployment's machine-only prefixes are
    /// excluded from results so reserved names and snippets never leak.
    pub machine: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub mode: Option<String>,
    pub collection: Option<String>,
    pub collections: Option<Vec<String>>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub filters: Map<String, Value>,
}

pub fn tokenize(text: &str) -> Vec<String> {
    let normalized: String = text.to_lowercase().nfkd().collect();
    let mut cleaned = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character.is_whitespace() {
            cleaned.push(character);
        } else {
            cleaned.push(' ');
        }
    }
    cleaned
        .split(|character: char| character.is_whitespace() || character == '-')
        .map(str::trim)
        .filter(|token| token.len() >= 2 && !STOP_WORDS.contains(token))
        .take(4000)
        .map(|token| token.to_string())
        .collect()
}

/// Deterministic feature-hashing embedding (no network, stable across runs).
pub fn embed(text: &str) -> Vec<f64> {
    let mut vector = vec![0.0f64; SEARCH_DIM];
    for token in tokenize(text) {
        let digest = Sha256::digest(token.as_bytes());
        let index =
            u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize % SEARCH_DIM;
        let sign = if digest[4] & 1 == 0 { 1.0 } else { -1.0 };
        vector[index] += sign * (1.0 + ((1.0 + token.len() as f64).ln()));
    }
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    let norm = if norm == 0.0 { 1.0 } else { norm };
    vector.iter().map(|value| round6(value / norm)).collect()
}

pub async fn ensure_vector_column(store: &Store) -> bool {
    if !store.uses_postgres() {
        return false;
    }
    *store
        .vector_ready
        .get_or_init(|| async {
            let Some(pool) = store.pool() else {
                return false;
            };
            let result = async {
                sqlx::raw_sql("CREATE EXTENSION IF NOT EXISTS vector")
                    .execute(pool)
                    .await?;
                sqlx::raw_sql(
                    "ALTER TABLE synapseone_search_index ADD COLUMN IF NOT EXISTS embedding_vec vector(384)",
                )
                .execute(pool)
                .await?;
                sqlx::raw_sql(
                    "CREATE INDEX IF NOT EXISTS idx_search_embedding_vec ON synapseone_search_index USING hnsw (embedding_vec vector_cosine_ops)",
                )
                .execute(pool)
                .await?;
                Ok::<(), sqlx::Error>(())
            }
            .await;
            match result {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(
                        "[base][search] pgvector unavailable, using hashed embeddings: {error}"
                    );
                    false
                }
            }
        })
        .await
}

/// Embed text with the Tier-1 inference service (all-MiniLM-L6-v2, 384-d).
pub async fn embed_text_async(config: &Config, text: &str) -> Option<Vec<f64>> {
    let base = config.inference_service_url.trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .ok()?;
    let mut request = client
        .post(format!("{base}/v1/inference/embeddings"))
        .header("content-type", "application/json")
        .json(&json!({"input": text.chars().take(8000).collect::<String>()}));
    if !config.synapseone_api_key.is_empty() {
        request = request.header("x-api-key", &config.synapseone_api_key);
    }
    if !config.internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", &config.internal_secret);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    let vector = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("embedding"))
        .or_else(|| {
            body.get("embeddings")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
        })
        .or_else(|| body.get("embedding"))?;
    let items = vector.as_array()?;
    if items.len() != REAL_DIM {
        return None;
    }
    Some(items.iter().filter_map(js_number).collect())
}

pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    let mut dot = 0.0;
    for index in 0..a.len().min(b.len()) {
        dot += a[index] * b[index];
    }
    dot
}

fn record_id(collection_id: &str, document_id: &str) -> String {
    format!("{collection_id}:{document_id}")
}

fn text_of(data: &Value) -> String {
    serde_json::to_string(data)
        .unwrap_or_default()
        .chars()
        .take(20_000)
        .collect()
}

fn title_of(document: &StoredDocument) -> String {
    if let Some(object) = document.data.as_object() {
        for key in ["title", "name", "label", "subject", "headline"] {
            if let Some(Value::String(value)) = object.get(key) {
                if !value.trim().is_empty() {
                    return value.trim().chars().take(300).collect();
                }
            }
        }
    }
    document.id.clone()
}

fn acl_of(data: &Value) -> Vec<String> {
    let object = data.as_object();
    let raw = object
        .and_then(|object| object.get("acl"))
        .or_else(|| object.and_then(|object| object.get("_acl")))
        .or_else(|| object.and_then(|object| object.get("visibility")));
    let mut out: HashSet<String> = HashSet::new();
    let mut ordered = Vec::new();
    let mut add = |value: String| {
        let value: String = value.trim().chars().take(128).collect();
        if !value.is_empty() && out.insert(value.clone()) {
            ordered.push(value);
        }
    };
    match raw {
        Some(Value::Array(items)) => {
            for item in items.iter().take(100) {
                if let Value::String(value) = item {
                    if !value.trim().is_empty() {
                        add(value.clone());
                    }
                }
            }
        }
        Some(Value::String(value)) if !value.trim().is_empty() => {
            for item in value.split(',') {
                if !item.trim().is_empty() {
                    add(item.to_string());
                }
            }
        }
        _ => {}
    }
    if object
        .and_then(|object| object.get("public"))
        .map(|value| value == &Value::Bool(true))
        .unwrap_or(false)
    {
        add("*".to_string());
    }
    ordered
}

pub fn project_document(
    collection: &StoredCollection,
    document: &StoredDocument,
) -> StoredSearchRecord {
    let body = text_of(&document.data);
    let title = title_of(document);
    let metadata = json!({
        "database": &collection.database_name,
        "type": document
            .data
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(&collection.name),
        "status": document
            .data
            .get("status")
            .and_then(Value::as_str)
            .map(|text| Value::String(text.to_string()))
            .unwrap_or(Value::Null),
        "version": document.version,
    });
    StoredSearchRecord {
        id: record_id(&collection.id, &document.id),
        collection_id: collection.id.clone(),
        collection_name: collection.name.clone(),
        document_id: document.id.clone(),
        org_id: collection.org_id.clone(),
        account_id: collection.account_id.clone(),
        title: title.clone(),
        body: body.clone(),
        acl: acl_of(&document.data),
        embedding: embed(&format!("{title} {body}")),
        metadata,
        updated_at: document.updated_at.clone(),
    }
}

async fn write_record(
    store: &Store,
    config: &Config,
    record: &StoredSearchRecord,
    vectors: bool,
) -> Result<(), String> {
    let Some(pool) = store.pool() else {
        return Ok(());
    };
    let real = if vectors {
        embed_text_async(config, &format!("{} {}", record.title, record.body)).await
    } else {
        None
    };
    if vectors {
        sqlx::query(
            r#"INSERT INTO synapseone_search_index
                 (id, collection_id, collection_name, document_id, org_id, account_id, title, body,
                  acl, embedding, metadata, updated_at, indexed_at, embedding_vec)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::text::timestamptz,now(),$13::text::vector)
               ON CONFLICT (id) DO UPDATE SET
                 collection_name = EXCLUDED.collection_name, org_id = EXCLUDED.org_id,
                 account_id = EXCLUDED.account_id, title = EXCLUDED.title, body = EXCLUDED.body,
                 acl = EXCLUDED.acl, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata,
                 updated_at = EXCLUDED.updated_at, indexed_at = now(),
                 embedding_vec = EXCLUDED.embedding_vec"#,
        )
        .bind(&record.id)
        .bind(&record.collection_id)
        .bind(&record.collection_name)
        .bind(&record.document_id)
        .bind(&record.org_id)
        .bind(&record.account_id)
        .bind(&record.title)
        .bind(&record.body)
        .bind(json!(record.acl))
        .bind(json!(record.embedding))
        .bind(&record.metadata)
        .bind(&record.updated_at)
        .bind(real.map(|vector| serde_json::to_string(&vector).unwrap_or_default()))
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
    } else {
        sqlx::query(
            r#"INSERT INTO synapseone_search_index
                 (id, collection_id, collection_name, document_id, org_id, account_id, title, body,
                  acl, embedding, metadata, updated_at, indexed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::text::timestamptz,now())
               ON CONFLICT (id) DO UPDATE SET
                 collection_name = EXCLUDED.collection_name, org_id = EXCLUDED.org_id,
                 account_id = EXCLUDED.account_id, title = EXCLUDED.title, body = EXCLUDED.body,
                 acl = EXCLUDED.acl, embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata,
                 updated_at = EXCLUDED.updated_at, indexed_at = now()"#,
        )
        .bind(&record.id)
        .bind(&record.collection_id)
        .bind(&record.collection_name)
        .bind(&record.document_id)
        .bind(&record.org_id)
        .bind(&record.account_id)
        .bind(&record.title)
        .bind(&record.body)
        .bind(json!(record.acl))
        .bind(json!(record.embedding))
        .bind(&record.metadata)
        .bind(&record.updated_at)
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Replace one collection's index projection. Safe to re-run.
pub async fn replace_collection_index(
    store: &Store,
    config: &Config,
    collection: &StoredCollection,
    documents: &[StoredDocument],
) -> Result<usize, String> {
    let records: Vec<StoredSearchRecord> = documents
        .iter()
        .map(|document| project_document(collection, document))
        .collect();
    let ids: Vec<String> = records.iter().map(|record| record.id.clone()).collect();
    if store.uses_postgres() {
        let pool = store.pool().expect("postgres");
        let vectors = ensure_vector_column(store).await;
        sqlx::query(
            "DELETE FROM synapseone_search_index WHERE collection_id = $1 AND id <> ALL($2::text[])",
        )
        .bind(&collection.id)
        .bind(&ids)
        .execute(pool)
        .await
        .map_err(|error| error.to_string())?;
        for record in &records {
            write_record(store, config, record, vectors).await?;
        }
    }
    if let Some(mut memory) = store.memory().await {
        memory
            .search
            .retain(|id, record| !(record.collection_id == collection.id && !ids.contains(id)));
        for record in &records {
            memory.search.insert(record.id.clone(), record.clone());
        }
    }
    Ok(records.len())
}

/// Remove a collection projection (collection delete / tenant cleanup).
#[allow(dead_code)]
pub async fn drop_collection_index(store: &Store, collection_id: &str) -> Result<(), String> {
    if store.uses_postgres() {
        let pool = store.pool().expect("postgres");
        sqlx::query("DELETE FROM synapseone_search_index WHERE collection_id = $1")
            .bind(collection_id)
            .execute(pool)
            .await
            .map_err(|error| error.to_string())?;
    }
    if let Some(mut memory) = store.memory().await {
        memory
            .search
            .retain(|_, record| record.collection_id != collection_id);
    }
    Ok(())
}

/// Index one document immediately after a write (upsert semantics).
pub async fn upsert_document_index(
    store: &Store,
    config: &Config,
    collection: &StoredCollection,
    document: &StoredDocument,
) -> Result<(), String> {
    let record = project_document(collection, document);
    if let Some(mut memory) = store.memory().await {
        memory.search.insert(record.id.clone(), record.clone());
    }
    if store.uses_postgres() {
        let vectors = ensure_vector_column(store).await;
        write_record(store, config, &record, vectors).await?;
    }
    Ok(())
}

/// Remove one document from the index after a delete.
pub async fn remove_document_index(
    store: &Store,
    collection_id: &str,
    document_id: &str,
) -> Result<(), String> {
    let id = record_id(collection_id, document_id);
    if let Some(mut memory) = store.memory().await {
        memory.search.remove(&id);
    }
    if store.uses_postgres() {
        let pool = store.pool().expect("postgres");
        sqlx::query("DELETE FROM synapseone_search_index WHERE id = $1")
            .bind(&id)
            .execute(pool)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn load_records(
    store: &Store,
    scope: &SearchScope,
) -> Result<Vec<StoredSearchRecord>, String> {
    if !store.uses_postgres() {
        let Some(memory) = store.memory().await else {
            return Ok(Vec::new());
        };
        let mut rows: Vec<StoredSearchRecord> = memory.search.values().cloned().collect();
        if !scope.platform {
            rows.retain(|record| {
                if let Some(org_id) = &scope.org_id {
                    if record.org_id.as_deref() == Some(org_id.as_str()) {
                        return true;
                    }
                }
                if let Some(account_id) = &scope.account_id {
                    if record.account_id.as_deref() == Some(account_id.as_str()) {
                        return true;
                    }
                }
                false
            });
        }
        return Ok(rows);
    }
    let pool = store.pool().expect("postgres");
    let rows = if scope.platform {
        sqlx::query(
            "SELECT * FROM synapseone_search_index ORDER BY updated_at DESC LIMIT 50000",
        )
        .fetch_all(pool)
        .await
    } else if let Some(org_id) = &scope.org_id {
        sqlx::query(
            "SELECT * FROM synapseone_search_index WHERE org_id = $1 ORDER BY updated_at DESC LIMIT 50000",
        )
        .bind(org_id)
        .fetch_all(pool)
        .await
    } else if let Some(account_id) = &scope.account_id {
        sqlx::query(
            "SELECT * FROM synapseone_search_index WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 50000",
        )
        .bind(account_id)
        .fetch_all(pool)
        .await
    } else {
        return Ok(Vec::new());
    }
    .map_err(|error| error.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
            let updated: Option<DateTime<Utc>> = row.try_get("updated_at").ok();
            StoredSearchRecord {
                id: row.try_get("id").unwrap_or_default(),
                collection_id: row.try_get("collection_id").unwrap_or_default(),
                collection_name: row.try_get("collection_name").unwrap_or_default(),
                document_id: row.try_get("document_id").unwrap_or_default(),
                org_id: row.try_get("org_id").ok().flatten(),
                account_id: row.try_get("account_id").ok().flatten(),
                title: row.try_get("title").unwrap_or_default(),
                body: row.try_get("body").unwrap_or_default(),
                acl: row
                    .try_get::<Value, _>("acl")
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                embedding: row
                    .try_get::<Value, _>("embedding")
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .map(|items| items.iter().filter_map(js_number).collect())
                    .unwrap_or_default(),
                metadata: row
                    .try_get("metadata")
                    .unwrap_or_else(|_| Value::Object(Map::new())),
                updated_at: updated.map(|value| iso(&value)).unwrap_or_default(),
            }
        })
        .collect())
}

fn acl_allows(record: &StoredSearchRecord, scope: &SearchScope) -> bool {
    if scope.platform {
        return true;
    }
    if record.acl.is_empty() {
        return true;
    }
    if record.acl.iter().any(|item| item == "*") {
        return true;
    }
    if let Some(subject) = &scope.subject {
        if record.acl.iter().any(|item| item == subject) {
            return true;
        }
    }
    if let Some(org_id) = &scope.org_id {
        if record
            .acl
            .iter()
            .any(|item| item == &format!("org:{org_id}"))
        {
            return true;
        }
    }
    if let Some(account_id) = &scope.account_id {
        if record
            .acl
            .iter()
            .any(|item| item == &format!("account:{account_id}"))
        {
            return true;
        }
    }
    false
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.find(needle)
}

fn replace_case_insensitive(haystack: &str, needle: &str) -> Option<String> {
    if needle.is_empty() {
        return Some(haystack.to_string());
    }
    let lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    let mut at = find_case_insensitive(&lower, &needle_lower)?;
    let mut out = String::new();
    let mut cursor = 0;
    loop {
        if at < cursor || !haystack.is_char_boundary(at) {
            break;
        }
        out.push_str(&haystack[cursor..at]);
        let end = at + needle_lower.len();
        if end > haystack.len() || !haystack.is_char_boundary(end) {
            break;
        }
        out.push_str("<mark>");
        out.push_str(&haystack[at..end]);
        out.push_str("</mark>");
        cursor = end;
        let Some(remaining) = lower.get(cursor..) else {
            break;
        };
        let Some(next) = find_case_insensitive(remaining, &needle_lower) else {
            break;
        };
        at = cursor + next;
    }
    out.push_str(&haystack[cursor..]);
    Some(out)
}

fn snippet(text: &str, terms: &[String]) -> (String, Vec<String>) {
    let clean = collapse_whitespace(text);
    if clean.is_empty() {
        return (String::new(), Vec::new());
    }
    let lower = clean.to_lowercase();
    let mut at: Option<usize> = None;
    for term in terms {
        if let Some(index) = find_case_insensitive(&lower, term) {
            if at.map(|current| index < current).unwrap_or(true) {
                at = Some(index);
            }
        }
    }
    let mut start = at.map(|at| at.saturating_sub(70)).unwrap_or(0);
    while start > 0 && !clean.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + 240).min(clean.len());
    while end < clean.len() && !clean.is_char_boundary(end) {
        end += 1;
    }
    let raw = &clean[start..end];
    let mut highlights = Vec::new();
    let mut marked = raw.to_string();
    let mut ordered: Vec<&String> = terms.iter().collect();
    ordered.sort_by_key(|left| std::cmp::Reverse(left.len()));
    for term in ordered.into_iter().take(8) {
        if let Some(replaced) = replace_case_insensitive(&marked, term) {
            highlights.push(term.clone());
            marked = replaced;
        }
    }
    (marked, highlights)
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}

fn score_fulltext(record: &StoredSearchRecord, terms: &[String]) -> f64 {
    if terms.is_empty() {
        return 0.0;
    }
    let title = record.title.to_lowercase();
    let body = record.body.to_lowercase();
    let mut score = 0.0;
    for term in terms {
        let mut term_frequency = 0;
        let mut from = 0;
        while let Some(index) = body[from..].find(term) {
            term_frequency += 1;
            from += index + term.len();
            if term_frequency > 50 {
                break;
            }
        }
        let title_hits = count_occurrences(&title, term);
        score += term_frequency as f64 + title_hits as f64 * 4.0;
        if title.contains(term) {
            score += 2.0;
        }
    }
    let length = record.body.chars().count();
    let penalty = ((length as f64 / 200.0).max(1.0)).sqrt();
    let phrase = if body.contains(&terms.join(" ")) {
        2.5
    } else {
        0.0
    };
    round6(score / penalty + phrase)
}

fn decode_search_cursor(cursor: Option<&str>) -> usize {
    let Some(cursor) = cursor else {
        return 0;
    };
    let Some(parsed) = parse_cursor_json(cursor) else {
        return 0;
    };
    match parsed.get("o").and_then(js_number) {
        Some(value) if value.fract() == 0.0 && value >= 0.0 => value as usize,
        _ => 0,
    }
}

pub async fn search_records(
    store: &Store,
    config: &Config,
    scope: &SearchScope,
    query: &str,
    options: &SearchOptions,
) -> Result<Value, String> {
    let mode = match options.mode.as_deref() {
        Some("semantic") => "semantic",
        Some("hybrid") => "hybrid",
        _ => "fulltext",
    };
    let terms = tokenize(query);
    if terms.is_empty() && mode != "semantic" {
        return Ok(json!({
            "items": [],
            "total": 0,
            "nextCursor": Value::Null,
            "facets": {},
            "mode": mode,
            "index": {"indexed": 0, "updatedAt": Value::Null},
        }));
    }
    let mut rows = load_records(store, scope).await?;
    rows.retain(|record| acl_allows(record, scope));
    if !scope.machine {
        rows.retain(|record| {
            !crate::util::is_reserved_collection(
                &record.collection_name,
                &config.machine_collection_prefixes,
            )
        });
    }
    if let Some(collection) = &options.collection {
        rows.retain(|record| {
            &record.collection_name == collection || &record.collection_id == collection
        });
    }
    if let Some(collections) = &options.collections {
        if !collections.is_empty() {
            let wanted: HashSet<&String> = collections.iter().collect();
            rows.retain(|record| {
                wanted.contains(&record.collection_name) || wanted.contains(&record.collection_id)
            });
        }
    }
    for (key, value) in &options.filters {
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        if text.is_empty() {
            continue;
        }
        if key == "status" || key == "type" {
            rows.retain(|record| {
                let current = record
                    .metadata
                    .get(key)
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        Value::Null => String::new(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default();
                current == text
            });
        }
    }

    let qvec = embed(&terms.join(" "));
    let qvec_real = if mode == "semantic" || mode == "hybrid" {
        embed_text_async(config, query).await
    } else {
        None
    };
    let mut scored: Vec<Value> = Vec::new();
    for record in &rows {
        let full = score_fulltext(record, &terms);
        let semantic = if mode == "semantic" || mode == "hybrid" {
            let value = match &qvec_real {
                Some(real)
                    if !record.embedding.is_empty() && record.embedding.len() == real.len() =>
                {
                    cosine(real, &record.embedding)
                }
                _ => cosine(&qvec, &record.embedding),
            };
            value.max(0.0)
        } else {
            0.0
        };
        let score = match mode {
            "semantic" => semantic,
            "hybrid" => round6(full * 0.65 + semantic * 35.0),
            _ => full,
        };
        if score > 0.0 || (mode == "semantic" && semantic > 0.0) {
            let (snippet_text, highlights) =
                snippet(&format!("{} {}", record.title, record.body), &terms);
            let mut metadata = record.metadata.as_object().cloned().unwrap_or_default();
            metadata.insert(
                "collection".into(),
                Value::String(if record.collection_name.is_empty() {
                    record.collection_id.clone()
                } else {
                    record.collection_name.clone()
                }),
            );
            scored.push(json!({
                "id": record.id,
                "collectionId": record.collection_id,
                "documentId": record.document_id,
                "title": record.title,
                "snippet": snippet_text,
                "highlights": highlights,
                "score": crate::query::number_value(score),
                "mode": mode,
                "acl": record.acl,
                "metadata": metadata,
                "updatedAt": record.updated_at,
                "_semantic": semantic,
            }));
        }
    }
    scored.sort_by(|left, right| {
        let left_score = left.get("score").and_then(js_number).unwrap_or(0.0);
        let right_score = right.get("score").and_then(js_number).unwrap_or(0.0);
        if left_score != right_score {
            return right_score
                .partial_cmp(&left_score)
                .unwrap_or(std::cmp::Ordering::Equal);
        }
        let left_updated = left.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let right_updated = right.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        if left_updated != right_updated {
            return right_updated.cmp(left_updated);
        }
        let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
        let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
        left_id.cmp(right_id)
    });

    let mut facets: Map<String, Value> = Map::new();
    let mut add_facet = |name: &str, value: String| {
        let entry = facets
            .entry(name.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(items) = entry.as_array_mut() else {
            return;
        };
        if let Some(found) = items
            .iter_mut()
            .find(|item| item.get("value").and_then(Value::as_str) == Some(value.as_str()))
        {
            let count = found.get("count").and_then(js_number).unwrap_or(0.0) + 1.0;
            if let Some(object) = found.as_object_mut() {
                object.insert("count".into(), crate::query::number_value(count));
            }
        } else {
            items.push(json!({"value": value, "count": 1}));
        }
    };
    for hit in scored.iter().take(5000) {
        let metadata = hit.get("metadata").and_then(Value::as_object);
        if let Some(collection) = metadata.and_then(|metadata| metadata.get("collection")) {
            let value = match collection {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            add_facet("collection", value);
        }
        for key in ["type", "status"] {
            if let Some(Value::String(value)) = metadata.and_then(|metadata| metadata.get(key)) {
                if !value.is_empty() {
                    add_facet(key, value.clone());
                }
            }
        }
    }
    for list in facets.values_mut() {
        if let Some(items) = list.as_array_mut() {
            items.sort_by(|left, right| {
                let left_count = left.get("count").and_then(js_number).unwrap_or(0.0);
                let right_count = right.get("count").and_then(js_number).unwrap_or(0.0);
                if left_count != right_count {
                    return right_count
                        .partial_cmp(&left_count)
                        .unwrap_or(std::cmp::Ordering::Equal);
                }
                let left_value = left.get("value").and_then(Value::as_str).unwrap_or("");
                let right_value = right.get("value").and_then(Value::as_str).unwrap_or("");
                left_value.cmp(right_value)
            });
        }
    }

    let limit = match options.limit {
        Some(value) if value != 0 => value,
        _ => 20,
    }
    .clamp(1, 100) as usize;
    let offset = decode_search_cursor(options.cursor.as_deref());
    let total = scored.len();
    let page: Vec<Value> = scored
        .iter()
        .skip(offset)
        .take(limit)
        .map(|hit| {
            let mut object = hit.as_object().cloned().unwrap_or_default();
            object.remove("_semantic");
            Value::Object(object)
        })
        .collect();
    let next_cursor = if offset + limit < total {
        Value::String(encode_base64url_json(&json!({"o": offset + limit})))
    } else {
        Value::Null
    };
    let updated_at = scored
        .first()
        .and_then(|hit| hit.get("updatedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "items": page,
        "total": total,
        "nextCursor": next_cursor,
        "facets": facets,
        "mode": mode,
        "index": {"indexed": rows.len(), "updatedAt": updated_at},
    }))
}

pub async fn index_status(store: &Store, scope: &SearchScope) -> Result<Value, String> {
    let rows = load_records(store, scope).await?;
    let collections: HashSet<&str> = rows
        .iter()
        .map(|record| record.collection_id.as_str())
        .collect();
    let updated_at = rows
        .iter()
        .map(|record| record.updated_at.clone())
        .max()
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(json!({
        "indexed": rows.len(),
        "collections": collections.len(),
        "updatedAt": updated_at,
    }))
}
