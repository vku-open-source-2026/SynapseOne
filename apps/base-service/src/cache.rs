// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Optional L2 read-through cache for SynapseBase document GETs.
//!
//! The cache is Synapse Faststore (Valkey) reached over the internal network.
//! Every operation is fail-open: a cache timeout, 5xx or malformed value falls
//! back to Postgres and never fails the request. Cache keys are namespaced by
//! Faststore's tenant layer, so a document cannot be served across tenants.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::HeaderMap;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::store::StoredDocument;
use crate::util::tenant_headers;
use crate::Config;

const KEY_PREFIX: &str = "base:doc:v1";
const CIRCUIT_FAILURES: u32 = 3;
const CIRCUIT_COOLDOWN_MS: u64 = 30_000;

const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CachedDocument {
    pub collection_id: String,
    pub id: String,
    pub data: Value,
    pub version: i32,
    pub created_at: String,
    pub updated_at: String,
}

impl CachedDocument {
    pub fn from_stored(document: &StoredDocument) -> Self {
        Self {
            collection_id: document.collection_id.clone(),
            id: document.id.clone(),
            data: document.data.clone(),
            version: document.version,
            created_at: document.created_at.clone(),
            updated_at: document.updated_at.clone(),
        }
    }

    pub fn to_stored(&self) -> StoredDocument {
        StoredDocument {
            collection_id: self.collection_id.clone(),
            id: self.id.clone(),
            data: self.data.clone(),
            version: self.version,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Default)]
struct Counters {
    hits: AtomicU64,
    misses: AtomicU64,
    sets: AtomicU64,
    deletes: AtomicU64,
    errors: AtomicU64,
}

#[derive(Debug, Clone)]
pub struct CacheMetrics {
    pub enabled: bool,
    pub ttl_seconds: i64,
    pub hits: u64,
    pub misses: u64,
    pub sets: u64,
    pub deletes: u64,
    pub errors: u64,
}

#[derive(Clone)]
pub struct Cache {
    url: String,
    internal_secret: String,
    ttl_seconds: i64,
    timeout_ms: u64,
    counters: Arc<Counters>,
    consecutive_errors: Arc<AtomicU32>,
    circuit_open_until: Arc<AtomicU64>,
    warned: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl Cache {
    pub fn from_config(config: &Config) -> Self {
        Self::new(
            config.faststore_service_url.clone(),
            config.internal_secret.clone(),
            config.cache_ttl_seconds,
            config.cache_timeout_ms,
            true,
        )
    }

    pub fn new(
        url: String,
        internal_secret: String,
        ttl_seconds: i64,
        timeout_ms: u64,
        warn: bool,
    ) -> Self {
        if warn && url.is_empty() {
            tracing::info!("[base][cache] FASTSTORE_SERVICE_URL not set — document cache disabled");
        }
        Self {
            url: url.trim_end_matches('/').to_string(),
            internal_secret,
            ttl_seconds,
            timeout_ms,
            counters: Arc::new(Counters::default()),
            consecutive_errors: Arc::new(AtomicU32::new(0)),
            circuit_open_until: Arc::new(AtomicU64::new(0)),
            warned: Arc::new(AtomicBool::new(!warn)),
            client: reqwest::Client::new(),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.url.is_empty()
    }

    pub fn ttl_seconds(&self) -> i64 {
        self.ttl_seconds
    }

    pub fn document_cache_key(collection_id: &str, doc_id: &str) -> String {
        format!("{KEY_PREFIX}:{collection_id}:{doc_id}")
    }

    pub fn metrics(&self) -> CacheMetrics {
        CacheMetrics {
            enabled: self.enabled(),
            ttl_seconds: self.ttl_seconds,
            hits: self.counters.hits.load(Ordering::Relaxed),
            misses: self.counters.misses.load(Ordering::Relaxed),
            sets: self.counters.sets.load(Ordering::Relaxed),
            deletes: self.counters.deletes.load(Ordering::Relaxed),
            errors: self.counters.errors.load(Ordering::Relaxed),
        }
    }

    /// Test helper: reset counters and the one-shot warning flag.
    pub fn reset_metrics(&self) {
        self.counters.hits.store(0, Ordering::Relaxed);
        self.counters.misses.store(0, Ordering::Relaxed);
        self.counters.sets.store(0, Ordering::Relaxed);
        self.counters.deletes.store(0, Ordering::Relaxed);
        self.counters.errors.store(0, Ordering::Relaxed);
        self.consecutive_errors.store(0, Ordering::Relaxed);
        self.circuit_open_until.store(0, Ordering::Relaxed);
        self.warned.store(false, Ordering::Relaxed);
    }

    fn warn_once(&self, message: &str) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            tracing::warn!("[base][cache] {message}; falling back to Postgres");
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    fn circuit_open(&self) -> bool {
        Self::now_ms() < self.circuit_open_until.load(Ordering::Relaxed)
    }

    fn remember_error(&self) {
        let count = self.consecutive_errors.fetch_add(1, Ordering::Relaxed) + 1;
        if count >= CIRCUIT_FAILURES {
            self.circuit_open_until
                .store(Self::now_ms() + CIRCUIT_COOLDOWN_MS, Ordering::Relaxed);
        }
    }

    fn remember_success(&self) {
        self.consecutive_errors.store(0, Ordering::Relaxed);
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        headers: &[(String, String)],
        body: Option<Value>,
    ) -> Option<reqwest::Response> {
        if !self.enabled() || self.circuit_open() {
            return None;
        }
        let mut request = self
            .client
            .request(method, format!("{}{}", self.url, path))
            .header("accept", "application/json")
            .timeout(Duration::from_millis(self.timeout_ms));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .json(&body);
        }
        match request.send().await {
            Ok(response) => {
                if response.status().as_u16() >= 500 {
                    self.remember_error();
                } else {
                    self.remember_success();
                }
                Some(response)
            }
            Err(_) => {
                self.counters.errors.fetch_add(1, Ordering::Relaxed);
                self.remember_error();
                self.warn_once("request failed");
                None
            }
        }
    }

    fn scoped_headers(headers: &HeaderMap) -> Option<Vec<(String, String)>> {
        tenant_headers(headers)
    }

    /// Returns the cached document, or null on miss/disabled/any cache failure.
    pub async fn get_document(
        &self,
        headers: &HeaderMap,
        collection_id: &str,
        doc_id: &str,
    ) -> Option<CachedDocument> {
        if !self.enabled() {
            return None;
        }
        let tenant = Self::scoped_headers(headers)?;
        let key = Self::document_cache_key(collection_id, doc_id);
        let path = format!(
            "/v1/faststore/keys/{}",
            utf8_percent_encode(&key, COMPONENT)
        );
        let response = self
            .request(reqwest::Method::GET, &path, &tenant, None)
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            self.counters.misses.fetch_add(1, Ordering::Relaxed);
            let _ = response.text().await;
            return None;
        }
        if !status.is_success() {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once(&format!("read returned {}", status.as_u16()));
            let _ = response.text().await;
            return None;
        }
        let body: Value = match response.json().await {
            Ok(body) => body,
            Err(_) => {
                self.counters.errors.fetch_add(1, Ordering::Relaxed);
                self.warn_once("cached value is not valid JSON");
                return None;
            }
        };
        let Some(value) = body.get("value") else {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once("cached value has the wrong shape");
            return None;
        };
        if !is_cached_document(value, collection_id, doc_id) {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once("cached value has the wrong shape");
            return None;
        }
        let document: CachedDocument = serde_json::from_value(value.clone()).ok()?;
        self.counters.hits.fetch_add(1, Ordering::Relaxed);
        Some(document)
    }

    /// Best-effort cache fill; failures are counted but never surfaced.
    pub async fn set_document(&self, headers: &HeaderMap, document: &CachedDocument) {
        if !self.enabled() {
            return;
        }
        let Some(tenant) = Self::scoped_headers(headers) else {
            return;
        };
        let key = Self::document_cache_key(&document.collection_id, &document.id);
        let path = format!(
            "/v1/faststore/keys/{}",
            utf8_percent_encode(&key, COMPONENT)
        );
        let body = json!({"value": document, "ttlSeconds": self.ttl_seconds});
        let Some(response) = self
            .request(reqwest::Method::PUT, &path, &tenant, Some(body))
            .await
        else {
            return;
        };
        if response.status().is_success() {
            self.counters.sets.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once(&format!("write returned {}", response.status().as_u16()));
        }
        let _ = response.text().await;
    }

    /// Best-effort invalidation after a write. Missing keys are not an error.
    pub async fn delete_document(&self, headers: &HeaderMap, collection_id: &str, doc_id: &str) {
        if !self.enabled() {
            return;
        }
        let Some(tenant) = Self::scoped_headers(headers) else {
            return;
        };
        let key = Self::document_cache_key(collection_id, doc_id);
        let path = format!(
            "/v1/faststore/keys/{}",
            utf8_percent_encode(&key, COMPONENT)
        );
        let Some(response) = self
            .request(reqwest::Method::DELETE, &path, &tenant, None)
            .await
        else {
            return;
        };
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            self.counters.deletes.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once(&format!("delete returned {}", response.status().as_u16()));
        }
        let _ = response.text().await;
    }

    /// Invalidate up to 100 documents with one Faststore batch call.
    pub async fn delete_documents(
        &self,
        headers: &HeaderMap,
        collection_id: &str,
        doc_ids: &[String],
    ) {
        if !self.enabled() || doc_ids.is_empty() {
            return;
        }
        let Some(tenant) = Self::scoped_headers(headers) else {
            return;
        };
        let operations: Vec<Value> = doc_ids
            .iter()
            .take(100)
            .map(|doc_id| {
                json!({
                    "op": "delete",
                    "key": Self::document_cache_key(collection_id, doc_id),
                })
            })
            .collect();
        let body = json!({"operations": operations});
        let Some(response) = self
            .request(
                reqwest::Method::POST,
                "/v1/faststore/batch",
                &tenant,
                Some(body),
            )
            .await
        else {
            return;
        };
        if response.status().is_success() {
            self.counters
                .deletes
                .fetch_add(operations.len() as u64, Ordering::Relaxed);
        } else {
            self.counters.errors.fetch_add(1, Ordering::Relaxed);
            self.warn_once(&format!(
                "batch delete returned {}",
                response.status().as_u16()
            ));
        }
        let _ = response.text().await;
    }
}

fn is_cached_document(value: &Value, collection_id: &str, doc_id: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("collection_id").and_then(Value::as_str) == Some(collection_id)
        && object.get("id").and_then(Value::as_str) == Some(doc_id)
        && object.get("version").map(Value::is_number).unwrap_or(false)
        && object.get("data").map(Value::is_object).unwrap_or(false)
        && object
            .get("created_at")
            .map(Value::is_string)
            .unwrap_or(false)
        && object
            .get("updated_at")
            .map(Value::is_string)
            .unwrap_or(false)
}
