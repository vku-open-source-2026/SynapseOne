// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Axum HTTP surface for SynapseBase. Routes, scoping, headers and response
//! bodies mirror the TypeScript/Express implementation.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use regex::Regex;
use serde_json::{json, Map, Value};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::audit::build_event;
use crate::cache::CachedDocument;
use crate::error::{ApiError, MappingError, QueryError, StoreError, StoreErrorCode};
use crate::mapping::{
    data_to_object, deep_merge, normalize_document_data, normalize_mapping, object_to_data,
    unset_path, validate_data_against_mapping, validate_document_data, BaseMapping,
};
use crate::query::{
    apply_query, apply_vector_search, encode_cursor, parse_query_spec, parse_vector_search_spec,
    AsView, QuerySpec,
};
use crate::store::{
    CollectionPatch, CollectionScope, CreateCollectionInput, ListDocumentsOptions,
    SetDocumentOptions, StoredCollection, StoredDocument,
};
use crate::util::{
    header, js_number, js_number_string, js_string, now_iso, parse_js_date, request_id,
    sanitize_request_id,
};
use crate::{AppState, Config, VERSION};

type Params = HashMap<String, String>;

const SERVICE: &str = "base";

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn json_with_headers(
    status: StatusCode,
    value: Value,
    headers: &[(&'static str, String)],
) -> Response {
    let mut response = json_response(status, value);
    for (name, value) in headers {
        if let Ok(value) = HeaderValue::from_str(value) {
            response.headers_mut().insert(*name, value);
        }
    }
    response
}

fn payload_too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        "Request body exceeds the size limit",
    )
}

fn parse_body(body: Result<Bytes, BytesRejection>) -> Result<Value, ApiError> {
    let bytes = match body {
        Ok(bytes) => bytes,
        Err(rejection) => {
            return Err(if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                payload_too_large()
            } else {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_json",
                    "Request body is not valid JSON",
                )
            });
        }
    };
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "Request body is not valid JSON",
        )
    })?;
    crate::util::normalize_numbers(&mut value);
    Ok(value)
}

fn body_object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn name_regex() -> &'static Regex {
    static NAME_RE: OnceLock<Regex> = OnceLock::new();
    NAME_RE.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$").expect("name regex"))
}

fn doc_id_regex() -> &'static Regex {
    static DOC_ID_RE: OnceLock<Regex> = OnceLock::new();
    DOC_ID_RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_@.:+-]{1,256}$").expect("document id regex"))
}

fn field_path_regex() -> &'static Regex {
    static FIELD_RE: OnceLock<Regex> = OnceLock::new();
    FIELD_RE.get_or_init(|| Regex::new(r"^[A-Za-z_$][A-Za-z0-9_$.-]{0,255}$").expect("field regex"))
}

fn clean_name(value: Option<&Value>) -> Option<String> {
    let raw = match value {
        Some(Value::Null) | None => String::new(),
        Some(value) => js_string(value),
    };
    name_regex().is_match(&raw).then_some(raw)
}

fn clean_doc_id(value: Option<&Value>) -> Option<String> {
    let raw = match value {
        Some(Value::Null) | None => String::new(),
        Some(value) => js_string(value),
    };
    if raw.is_empty()
        || raw.chars().count() > 256
        || raw == "."
        || raw == ".."
        || raw.contains(['\r', '\n', '/', '\\'])
    {
        return None;
    }
    doc_id_regex().is_match(&raw).then_some(raw)
}

fn clean_tenant(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 || trimmed.contains(['\r', '\n']) {
        return None;
    }
    Some(trimmed.to_string())
}

#[derive(Debug, Clone)]
struct Principal {
    sub: String,
    org: Option<String>,
    account: Option<String>,
}

#[derive(Debug, Clone)]
enum Caller {
    Anon,
    Principal(Principal),
    Platform,
}

fn clean_header_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 128 {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn principal_from_headers(headers: &HeaderMap) -> Option<Principal> {
    let user = header(headers, "x-synapseone-user");
    if !user.is_empty() {
        if user.chars().count() > 128 {
            return None;
        }
        return Some(Principal {
            sub: user,
            org: clean_header_value(&header(headers, "x-synapseone-org")),
            account: clean_header_value(&header(headers, "x-synapseone-account")),
        });
    }
    let kind = clean_header_value(&header(headers, "x-synapseone-kind"));
    let account = clean_header_value(&header(headers, "x-synapseone-account"));
    let org = clean_header_value(&header(headers, "x-synapseone-org"));
    if kind.is_some() || account.is_some() || org.is_some() {
        let sub = match &account {
            Some(account) => format!("apikey:{account}"),
            None => format!("{}:unknown", kind.as_deref().unwrap_or("principal")),
        };
        return Some(Principal { sub, org, account });
    }
    None
}

fn resolve_caller(headers: &HeaderMap) -> Caller {
    if let Some(principal) = principal_from_headers(headers) {
        return Caller::Principal(principal);
    }
    let legacy = header(headers, "x-synapsedx-anon");
    let primary = header(headers, "x-synapseone-anon");
    if primary == "1" || legacy == "1" {
        Caller::Anon
    } else {
        Caller::Platform
    }
}

fn can_access_collection(collection: &StoredCollection, caller: &Caller) -> bool {
    match caller {
        Caller::Platform => true,
        Caller::Anon => false,
        Caller::Principal(principal) => {
            if let Some(org_id) = &collection.org_id {
                principal.org.as_deref() == Some(org_id.as_str())
            } else if let Some(account_id) = &collection.account_id {
                principal.account.as_deref() == Some(account_id.as_str())
            } else {
                false
            }
        }
    }
}

fn collection_scope(caller: &Caller, params: &Params) -> CollectionScope {
    match caller {
        Caller::Platform => {
            let org = params.get("orgId").and_then(|value| clean_tenant(value));
            let account = params
                .get("accountId")
                .and_then(|value| clean_tenant(value));
            if org.is_some() || account.is_some() {
                CollectionScope {
                    org_id: org,
                    account_id: account,
                    platform: false,
                }
            } else {
                CollectionScope {
                    platform: true,
                    ..Default::default()
                }
            }
        }
        Caller::Principal(principal) => CollectionScope {
            org_id: principal.org.clone(),
            account_id: principal.account.clone(),
            platform: false,
        },
        Caller::Anon => CollectionScope::default(),
    }
}

async fn load_collection(
    state: &AppState,
    headers: &HeaderMap,
    params: &Params,
    name: &str,
) -> Result<StoredCollection, ApiError> {
    let caller = resolve_caller(headers);
    if matches!(caller, Caller::Anon) {
        return Err(ApiError::auth_required());
    }
    let name = clean_name(Some(&Value::String(name.to_string()))).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_collection",
            "collection must match [A-Za-z][A-Za-z0-9_-]{0,63}",
        )
    })?;
    let collection = state
        .store
        .find_collection(&name, &collection_scope(&caller, params))
        .await
        .map_err(|error| {
            if error.code == StoreErrorCode::Conflict {
                ApiError::new(StatusCode::CONFLICT, "ambiguous_collection", error.message)
            } else {
                ApiError::from(crate::error::InternalError(error.message))
            }
        })?;
    match collection {
        Some(collection) if can_access_collection(&collection, &caller) => Ok(collection),
        _ => Err(ApiError::not_found(format!(
            "collection '{name}' not found"
        ))),
    }
}

fn etag_version(headers: &HeaderMap, body: &Value) -> Result<Option<i32>, ApiError> {
    let has_if_match =
        headers.contains_key("if-match") || headers.contains_key("x-synapsedx-if-match");
    let raw = if has_if_match {
        Some(Value::String(header(headers, "if-match")))
    } else {
        body.get("ifVersion").cloned()
    };
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let text = js_string(&raw);
    if text.is_empty() {
        return Ok(None);
    }
    let cleaned = text.strip_prefix("W/").unwrap_or(&text).replace('"', "");
    let number = js_number_string(&cleaned).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_version",
            "ifVersion must be a non-negative integer",
        )
    })?;
    if number.fract() != 0.0 || number < 0.0 || number > i32::MAX as f64 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_version",
            "ifVersion must be a non-negative integer",
        ));
    }
    Ok(Some(number as i32))
}

fn parse_data_body(
    body: &Value,
    mapping: Option<&BaseMapping>,
    partial: bool,
    max_bytes: usize,
) -> Result<Value, MappingError> {
    let object = body.as_object();
    let has_data = object
        .map(|object| object.contains_key("data"))
        .unwrap_or(false);
    let has_object = object
        .map(|object| object.contains_key("object"))
        .unwrap_or(false);
    if has_data == has_object {
        return Err(MappingError::new("provide exactly one of data or object"));
    }
    if has_object {
        let value = object
            .and_then(|object| object.get("object"))
            .cloned()
            .unwrap_or(Value::Null);
        return object_to_data(&value, mapping, partial);
    }
    let data = object
        .and_then(|object| object.get("data"))
        .cloned()
        .unwrap_or(Value::Null);
    if partial {
        let data = validate_document_data(&data, max_bytes)?;
        validate_data_against_mapping(&data, mapping, true)?;
        Ok(data)
    } else {
        normalize_document_data(&data, mapping, max_bytes)
    }
}

fn mapping_api_error(error: MappingError) -> ApiError {
    ApiError::from(error)
}

fn invalid_mapping_error(error: MappingError) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_mapping", error.message)
        .with_details_opt(error.details.map(|details| *details))
}

fn to_api_collection(collection: &StoredCollection) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::String(collection.id.clone()));
    out.insert("name".into(), Value::String(collection.name.clone()));
    if let Some(description) = &collection.description {
        out.insert("description".into(), Value::String(description.clone()));
    }
    out.insert("mapping".into(), collection.mapping.to_value());
    if let Some(org_id) = &collection.org_id {
        out.insert("orgId".into(), Value::String(org_id.clone()));
    }
    if let Some(account_id) = &collection.account_id {
        out.insert("accountId".into(), Value::String(account_id.clone()));
    }
    out.insert(
        "createdAt".into(),
        Value::String(collection.created_at.clone()),
    );
    out.insert(
        "updatedAt".into(),
        Value::String(collection.updated_at.clone()),
    );
    Value::Object(out)
}

fn to_api_document(
    document: &StoredDocument,
    view: AsView,
    mapping: Option<&BaseMapping>,
) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::String(document.id.clone()));
    if view == AsView::Object {
        out.insert("object".into(), data_to_object(&document.data, mapping));
    } else {
        out.insert("data".into(), document.data.clone());
    }
    out.insert("version".into(), json!(document.version));
    out.insert(
        "createdAt".into(),
        Value::String(document.created_at.clone()),
    );
    out.insert(
        "updatedAt".into(),
        Value::String(document.updated_at.clone()),
    );
    Value::Object(out)
}

fn document_response(document: &StoredDocument, collection: &StoredCollection) -> Value {
    let mut value = to_api_document(document, AsView::Data, Some(&collection.mapping));
    if let Some(object) = value.as_object_mut() {
        object.insert("collection".into(), Value::String(collection.name.clone()));
    }
    value
}

fn store_error(error: StoreError) -> ApiError {
    match error.code {
        StoreErrorCode::VersionConflict => {
            ApiError::new(StatusCode::CONFLICT, "version_conflict", error.message)
        }
        StoreErrorCode::Conflict => {
            ApiError::new(StatusCode::CONFLICT, "document_exists", error.message)
        }
        StoreErrorCode::NotFound => ApiError::not_found(error.message),
        StoreErrorCode::Invalid => ApiError::from(crate::error::InternalError(error.message)),
    }
}

// ---------- health / metrics ----------

async fn health(State(state): State<AppState>) -> Response {
    let collections = state
        .store
        .list_collections()
        .await
        .map(|items| items.len())
        .unwrap_or(0);
    json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "service": "base",
            "version": VERSION,
            "db": if state.store.uses_postgres() { "postgres" } else { "memory" },
            "collections": collections,
            "time": now_iso(),
        }),
    )
}

async fn metrics(State(state): State<AppState>) -> Response {
    let uptime = state.started_at.elapsed().as_secs();
    let mut lines: Vec<String> = vec![
        "# HELP synapseone_base_up SynapseBase service up.".into(),
        "# TYPE synapseone_base_up gauge".into(),
        "synapseone_base_up 1".into(),
        "# HELP synapseone_base_process_uptime_seconds Process uptime in seconds.".into(),
        "# TYPE synapseone_base_process_uptime_seconds gauge".into(),
        format!("synapseone_base_process_uptime_seconds {uptime}"),
        "# HELP synapseone_base_http_requests_total HTTP requests by key = method|route|status."
            .into(),
        "# TYPE synapseone_base_http_requests_total counter".into(),
    ];
    for (key, value) in state.metrics.snapshot() {
        lines.push(format!(
            "synapseone_base_http_requests_total{{key=\"{}\"}} {}",
            key.replace('"', "\\\""),
            value
        ));
    }
    if let Ok(collections) = state.store.list_collections().await {
        lines.push("# HELP synapseone_base_collections_total Collection count.".into());
        lines.push("# TYPE synapseone_base_collections_total gauge".into());
        lines.push(format!(
            "synapseone_base_collections_total {}",
            collections.len()
        ));
    }
    if let Ok((pending, _)) = state.store.outbox_stats().await {
        lines.push("# HELP synapseone_base_outbox_pending Unpublished change events.".into());
        lines.push("# TYPE synapseone_base_outbox_pending gauge".into());
        lines.push(format!("synapseone_base_outbox_pending {pending}"));
    }
    let cache = state.cache.metrics();
    lines.push(
        "# HELP synapseone_base_cache_enabled Whether the Faststore document cache is configured."
            .into(),
    );
    lines.push("# TYPE synapseone_base_cache_enabled gauge".into());
    lines.push(format!(
        "synapseone_base_cache_enabled {}",
        if cache.enabled { 1 } else { 0 }
    ));
    lines.push(
        "# HELP synapseone_base_cache_document_total Document cache outcomes by result.".into(),
    );
    lines.push("# TYPE synapseone_base_cache_document_total counter".into());
    lines.push(format!(
        "synapseone_base_cache_document_total{{result=\"hit\"}} {}",
        cache.hits
    ));
    lines.push(format!(
        "synapseone_base_cache_document_total{{result=\"miss\"}} {}",
        cache.misses
    ));
    lines.push(format!(
        "synapseone_base_cache_document_total{{result=\"error\"}} {}",
        cache.errors
    ));
    lines.push("# HELP synapseone_base_cache_write_total Cache writes and invalidations.".into());
    lines.push("# TYPE synapseone_base_cache_write_total counter".into());
    lines.push(format!(
        "synapseone_base_cache_write_total{{result=\"set\"}} {}",
        cache.sets
    ));
    lines.push(format!(
        "synapseone_base_cache_write_total{{result=\"delete\"}} {}",
        cache.deletes
    ));
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        format!("{}\n", lines.join("\n")),
    )
        .into_response()
}

// ---------- search ----------

fn search_scope(headers: &HeaderMap) -> Result<crate::search::SearchScope, ApiError> {
    match resolve_caller(headers) {
        Caller::Anon => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            "search requires an authenticated caller",
        )),
        Caller::Platform => Ok(crate::search::SearchScope {
            platform: true,
            ..Default::default()
        }),
        Caller::Principal(principal) => Ok(crate::search::SearchScope {
            platform: false,
            org_id: principal.org,
            account_id: principal.account,
            subject: Some(principal.sub),
        }),
    }
}

fn mode_value(value: Option<&Value>) -> String {
    match value.map(js_string).as_deref() {
        Some("semantic") => "semantic".into(),
        Some("hybrid") => "hybrid".into(),
        Some("fulltext") => "fulltext".into(),
        _ => "fulltext".into(),
    }
}

fn search_limit(value: Option<&Value>) -> i64 {
    match value.and_then(js_number) {
        Some(number) if number != 0.0 && number.is_finite() => number as i64,
        _ => 20,
    }
}

async fn search_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let scope = search_scope(&headers)?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let query = object
        .get("query")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("q").filter(|value| !value.is_null()))
        .map(js_string)
        .unwrap_or_default()
        .chars()
        .take(2000)
        .collect::<String>();
    let mode = mode_value(object.get("mode"));
    let collections = object
        .get("collections")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).take(50).collect());
    let options = crate::search::SearchOptions {
        mode: Some(mode),
        collection: object
            .get("collection")
            .filter(|value| js_truthy(value))
            .map(js_string),
        collections,
        limit: Some(search_limit(object.get("limit"))),
        cursor: object
            .get("cursor")
            .filter(|value| !value.is_null() && !js_string(value).is_empty())
            .map(js_string),
        filters: object
            .get("filters")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    };
    match crate::search::search_records(&state.store, &state.config, &scope, &query, &options).await
    {
        Ok(result) => Ok(json_with_headers(
            StatusCode::OK,
            result,
            &[("cache-control", "no-store".into())],
        )),
        Err(error) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "search_failed",
            error.chars().take(300).collect::<String>(),
        )),
    }
}

async fn search_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<Params>,
) -> Result<Response, ApiError> {
    let scope = search_scope(&headers)?;
    let query = params
        .get("q")
        .or_else(|| params.get("query"))
        .cloned()
        .unwrap_or_default();
    let options = crate::search::SearchOptions {
        mode: Some(match params.get("mode").map(String::as_str) {
            Some("semantic") => "semantic".into(),
            Some("hybrid") => "hybrid".into(),
            Some("fulltext") => "fulltext".into(),
            _ => "fulltext".into(),
        }),
        collection: params
            .get("collection")
            .filter(|value| !value.is_empty())
            .cloned(),
        collections: None,
        limit: Some(
            params
                .get("limit")
                .and_then(|value| js_number_string(value))
                .filter(|value| *value != 0.0)
                .map(|value| value as i64)
                .unwrap_or(20),
        ),
        cursor: params
            .get("cursor")
            .filter(|value| !value.is_empty())
            .cloned(),
        filters: Map::new(),
    };
    let result =
        crate::search::search_records(&state.store, &state.config, &scope, &query, &options)
            .await
            .map_err(|error| ApiError::from(crate::error::InternalError(error)))?;
    Ok(json_with_headers(
        StatusCode::OK,
        result,
        &[("cache-control", "no-store".into())],
    ))
}

async fn search_reindex(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let scope = search_scope(&headers)?;
    let caller = resolve_caller(&headers);
    let body = parse_body(body)?;
    let object = body_object(&body);
    let wanted: Option<HashSet<String>> = object
        .get("collections")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).collect());
    let max_per_collection = object
        .get("maxPerCollection")
        .and_then(js_number)
        .filter(|value| *value != 0.0 && value.is_finite())
        .unwrap_or(50_000.0) as i64;
    let max_per_collection = max_per_collection.clamp(1, 200_000);
    let mut collections: Vec<StoredCollection> = state
        .store
        .list_collections()
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?
        .into_iter()
        .filter(|collection| can_access_collection(collection, &caller))
        .collect();
    if let Some(wanted) = &wanted {
        collections.retain(|collection| {
            wanted.contains(&collection.name) || wanted.contains(&collection.id)
        });
    }
    let mut indexed = 0usize;
    let mut details = Vec::new();
    for collection in &collections {
        let documents = state
            .store
            .list_all_documents(&collection.id, Some(max_per_collection), None)
            .await
            .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
        indexed += crate::search::replace_collection_index(
            &state.store,
            &state.config,
            collection,
            &documents,
        )
        .await
        .map_err(ApiError::from)?;
        details.push(json!({
            "collection": collection.name,
            "indexed": documents.len(),
        }));
    }
    let status = crate::search::index_status(&state.store, &scope)
        .await
        .map_err(ApiError::from)?;
    Ok(json_response(
        StatusCode::OK,
        json!({"ok": true, "indexed": indexed, "collections": details, "status": status}),
    ))
}

async fn search_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let scope = search_scope(&headers)?;
    let status = crate::search::index_status(&state.store, &scope)
        .await
        .map_err(ApiError::from)?;
    let mut value = status;
    if let Some(object) = value.as_object_mut() {
        object.insert("ok".into(), Value::Bool(true));
    }
    Ok(json_with_headers(
        StatusCode::OK,
        value,
        &[("cache-control", "no-store".into())],
    ))
}

// ---------- collections ----------

async fn list_collections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<Params>,
) -> Result<Response, ApiError> {
    let caller = resolve_caller(&headers);
    if matches!(caller, Caller::Anon) {
        return Err(ApiError::auth_required());
    }
    let mut collections: Vec<StoredCollection> = state
        .store
        .list_collections()
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?
        .into_iter()
        .filter(|collection| can_access_collection(collection, &caller))
        .collect();
    if let Some(org_id) = params.get("orgId").filter(|value| !value.is_empty()) {
        collections.retain(|collection| collection.org_id.as_deref() == Some(org_id.as_str()));
    }
    if let Some(account_id) = params.get("accountId").filter(|value| !value.is_empty()) {
        collections
            .retain(|collection| collection.account_id.as_deref() == Some(account_id.as_str()));
    }
    Ok(json_response(
        StatusCode::OK,
        Value::Array(collections.iter().map(to_api_collection).collect()),
    ))
}

fn optional_tenant(body: &Map<String, Value>, key: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = body.get(key) else {
        return Ok(None);
    };
    let raw = js_string(value);
    let cleaned = if !value.is_null() && !raw.is_empty() {
        clean_tenant(&raw)
    } else {
        None
    };
    if !raw.is_empty() && cleaned.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_tenant",
            "orgId/accountId must be 1..128 chars",
        ));
    }
    Ok(cleaned)
}

async fn create_collection(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let caller = resolve_caller(&headers);
    if matches!(caller, Caller::Anon) {
        return Err(ApiError::auth_required());
    }
    let body = parse_body(body)?;
    let object = body_object(&body);
    let name = clean_name(object.get("name")).ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_name",
            "name must match [A-Za-z][A-Za-z0-9_-]{0,63}",
        )
    })?;
    let description = match object.get("description") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let description = js_string(value);
            if description.chars().count() > 500 {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_description",
                    "description ≤500 chars",
                ));
            }
            Some(description)
        }
    };
    let mapping = normalize_mapping(object.get("mapping")).map_err(invalid_mapping_error)?;
    let body_org = optional_tenant(&object, "orgId")?;
    let body_account = optional_tenant(&object, "accountId")?;
    let principal = match &caller {
        Caller::Principal(principal) => Some(principal),
        _ => None,
    };
    let (request_org, request_account) = if let Some(org) = principal.and_then(|p| p.org.as_ref()) {
        if let Some(body_org) = &body_org {
            if body_org != org {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "cross_tenant",
                    "cannot create a collection outside your own org",
                ));
            }
        }
        (
            Some(org.clone()),
            body_account.or_else(|| principal.and_then(|p| p.account.clone())),
        )
    } else if let Some(principal) = principal {
        if body_org.is_some() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "cross_tenant",
                "account-scoped principals cannot create org-bound collections",
            ));
        }
        if let Some(body_account) = &body_account {
            if Some(body_account) != principal.account.as_ref() {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "cross_tenant",
                    "cannot create a collection outside your own account",
                ));
            }
        }
        (None, principal.account.clone())
    } else {
        (body_org, body_account)
    };
    let collection = state
        .store
        .create_collection(CreateCollectionInput {
            name,
            description,
            mapping,
            org_id: request_org,
            account_id: request_account,
            created_by: principal.map(|principal| principal.sub.clone()),
        })
        .await
        .map_err(|error| match error.code {
            StoreErrorCode::Conflict => {
                ApiError::new(StatusCode::CONFLICT, "collection_exists", error.message)
            }
            _ => ApiError::from(crate::error::InternalError(error.message)),
        })?;
    Ok(json_response(
        StatusCode::CREATED,
        to_api_collection(&collection),
    ))
}

async fn get_collection(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let stats = state
        .store
        .document_stats(&collection.id)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let mut value = to_api_collection(&collection);
    if let Some(object) = value.as_object_mut() {
        object.insert("stats".into(), stats_json(&stats));
    }
    Ok(json_response(StatusCode::OK, value))
}

fn stats_json(stats: &crate::store::DocumentStats) -> Value {
    json!({
        "documents": stats.documents,
        "bytes": stats.bytes,
        "lastUpdatedAt": stats.last_updated_at,
    })
}

async fn patch_collection(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let mut patch = CollectionPatch::default();
    if object.contains_key("name") {
        let name = clean_name(object.get("name")).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_name",
                "name must match [A-Za-z][A-Za-z0-9_-]{0,63}",
            )
        })?;
        patch.name = Some(name);
    }
    if let Some(value) = object.get("description") {
        if !value.is_null() {
            let description = js_string(value);
            if description.chars().count() > 500 {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_description",
                    "description ≤500 chars",
                ));
            }
            patch.description = Some(Some(description));
        } else {
            patch.description = Some(None);
        }
    }
    if let Some(value) = object.get("mapping") {
        patch.mapping = Some(normalize_mapping(Some(value)).map_err(invalid_mapping_error)?);
    }
    if patch.name.is_none() && patch.description.is_none() && patch.mapping.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "no updatable fields provided",
        ));
    }
    let updated = state
        .store
        .update_collection(&collection.id, patch)
        .await
        .map_err(|error| match error.code {
            StoreErrorCode::Conflict => {
                ApiError::new(StatusCode::CONFLICT, "collection_exists", error.message)
            }
            _ => ApiError::from(crate::error::InternalError(error.message)),
        })?
        .ok_or_else(ApiError::internal)?;
    Ok(json_response(StatusCode::OK, to_api_collection(&updated)))
}

async fn delete_collection(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    state
        .store
        .delete_collection(&collection.id)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    Ok(json_response(
        StatusCode::OK,
        json!({"ok": true, "id": collection.id, "name": collection.name}),
    ))
}

async fn collection_stats(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let stats = state
        .store
        .document_stats(&collection.id)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    Ok(json_response(
        StatusCode::OK,
        json!({
            "id": collection.id,
            "name": collection.name,
            "documents": stats.documents,
            "bytes": stats.bytes,
            "lastUpdatedAt": stats.last_updated_at,
        }),
    ))
}

// ---------- documents ----------

async fn create_document(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let id = match object.get("id") {
        Some(value) if !value.is_null() && !js_string(value).is_empty() => {
            clean_doc_id(Some(value)).ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_document_id",
                    "id must match [A-Za-z0-9_@.:+-]{1,256}",
                )
            })?
        }
        _ => crate::util::random_id(),
    };
    let data = parse_data_body(
        &body,
        Some(&collection.mapping),
        false,
        state.config.max_document_bytes,
    )
    .map_err(mapping_api_error)?;
    let document = state
        .store
        .create_document(&collection.id, &id, data)
        .await
        .map_err(|error| match error.code {
            StoreErrorCode::Conflict => {
                ApiError::new(StatusCode::CONFLICT, "document_exists", error.message)
            }
            _ => ApiError::from(crate::error::InternalError(error.message)),
        })?;
    let _ =
        crate::search::upsert_document_index(&state.store, &state.config, &collection, &document)
            .await;
    state
        .cache
        .delete_document(&headers, &collection.id, &id)
        .await;
    Ok(json_response(
        StatusCode::CREATED,
        document_response(&document, &collection),
    ))
}

async fn get_document(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_document_id"))?;
    let view = match params.get("as") {
        None => AsView::Data,
        Some(value) => AsView::parse(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_view",
                "as must be 'data' or 'object'",
            )
        })?,
    };
    let cached = state
        .cache
        .get_document(&headers, &collection.id, &id)
        .await;
    let document = match cached {
        Some(cached) => cached.to_stored(),
        None => {
            let document = state
                .store
                .get_document(&collection.id, &id)
                .await
                .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
            let Some(document) = document else {
                return Err(ApiError::not_found(format!("document '{id}' not found")));
            };
            state
                .cache
                .set_document(&headers, &CachedDocument::from_stored(&document))
                .await;
            document
        }
    };
    let mut value = to_api_document(&document, view, Some(&collection.mapping));
    if let Some(object) = value.as_object_mut() {
        object.insert("collection".into(), Value::String(collection.name.clone()));
    }
    Ok(json_response(StatusCode::OK, value))
}

async fn put_document(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_document_id"))?;
    let body = parse_body(body)?;
    let data = parse_data_body(
        &body,
        Some(&collection.mapping),
        false,
        state.config.max_document_bytes,
    )
    .map_err(mapping_api_error)?;
    let if_version = etag_version(&headers, &body)?;
    let merge = body
        .get("merge")
        .map(|value| value == &Value::Bool(true))
        .unwrap_or(false);
    let result = state
        .store
        .set_document(
            &collection.id,
            &id,
            data,
            SetDocumentOptions { merge, if_version },
        )
        .await
        .map_err(store_error)?;
    let _ =
        crate::search::upsert_document_index(&state.store, &state.config, &collection, &result.doc)
            .await;
    state
        .cache
        .delete_document(&headers, &collection.id, &id)
        .await;
    Ok(json_response(
        if result.created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        document_response(&result.doc, &collection),
    ))
}

fn valid_unset_path(path: &str) -> bool {
    field_path_regex().is_match(path)
        && !path
            .split('.')
            .any(|segment| matches!(segment, "__proto__" | "prototype" | "constructor"))
}

async fn patch_document(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_document_id"))?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let unset: Vec<String> = object
        .get("unset")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).take(100).collect())
        .unwrap_or_default();
    if !unset.iter().all(|path| valid_unset_path(path)) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_unset",
            "unset must contain valid dot paths",
        ));
    }
    let has_data = object.contains_key("data") || object.contains_key("object");
    if !has_data && unset.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "provide data/object and/or unset",
        ));
    }
    let patch_data = if has_data {
        parse_data_body(
            &body,
            Some(&collection.mapping),
            true,
            state.config.max_document_bytes,
        )
        .map_err(mapping_api_error)?
    } else {
        Value::Object(Map::new())
    };
    let if_version = etag_version(&headers, &body)?;
    let current = state
        .store
        .get_document(&collection.id, &id)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let Some(current) = current else {
        return Err(ApiError::not_found(format!("document '{id}' not found")));
    };
    if let Some(version) = if_version {
        if current.version != version {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "version_conflict",
                format!(
                    "document version is {}, expected {version}",
                    current.version
                ),
            ));
        }
    }
    let mut next = deep_merge(&current.data, &patch_data);
    for path in &unset {
        unset_path(&mut next, path);
    }
    validate_data_against_mapping(&next, Some(&collection.mapping), false)
        .map_err(mapping_api_error)?;
    let result = state
        .store
        .set_document(
            &collection.id,
            &id,
            next,
            SetDocumentOptions {
                merge: false,
                if_version: Some(current.version),
            },
        )
        .await
        .map_err(store_error)?;
    let _ =
        crate::search::upsert_document_index(&state.store, &state.config, &collection, &result.doc)
            .await;
    state
        .cache
        .delete_document(&headers, &collection.id, &id)
        .await;
    Ok(json_response(
        StatusCode::OK,
        document_response(&result.doc, &collection),
    ))
}

async fn delete_document(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_document_id"))?;
    let body = parse_body(body)?;
    let mut if_version = etag_version(&headers, &body)?;
    if if_version.is_none() {
        if let Some(raw) = params.get("ifVersion") {
            let number = js_number_string(raw).ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_version",
                    "ifVersion must be a non-negative integer",
                )
            })?;
            if number.fract() != 0.0 || number < 0.0 || number > i32::MAX as f64 {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_version",
                    "ifVersion must be a non-negative integer",
                ));
            }
            if_version = Some(number as i32);
        }
    }
    let ok = state
        .store
        .delete_document(&collection.id, &id, if_version)
        .await
        .map_err(|error| match error.code {
            StoreErrorCode::VersionConflict => {
                ApiError::new(StatusCode::CONFLICT, "version_conflict", error.message)
            }
            StoreErrorCode::NotFound => ApiError::not_found(error.message),
            _ => ApiError::from(crate::error::InternalError(error.message)),
        })?;
    if !ok {
        return Err(ApiError::not_found(format!("document '{id}' not found")));
    }
    let _ = crate::search::remove_document_index(&state.store, &collection.id, &id).await;
    state
        .cache
        .delete_document(&headers, &collection.id, &id)
        .await;
    Ok(json_response(
        StatusCode::OK,
        json!({"ok": true, "id": id, "collection": collection.name}),
    ))
}

async fn increment_document(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_document_id"))?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let field = object.get("field").map(js_string).unwrap_or_default();
    if !field_path_regex().is_match(&field)
        || field
            .split('.')
            .any(|segment| matches!(segment, "__proto__" | "prototype" | "constructor"))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_field",
            "field must be a valid dot path",
        ));
    }
    let by = match object.get("by") {
        None => 1.0,
        Some(value) => js_number(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_increment",
                "by must be a finite number",
            )
        })?,
    };
    if !by.is_finite() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_increment",
            "by must be a finite number",
        ));
    }
    let if_version = etag_version(&headers, &body)?;
    let document = state
        .store
        .increment_document(&collection.id, &id, &field, by, if_version)
        .await
        .map_err(|error| match error.code {
            StoreErrorCode::VersionConflict => {
                ApiError::new(StatusCode::CONFLICT, "version_conflict", error.message)
            }
            StoreErrorCode::Invalid => {
                ApiError::new(StatusCode::BAD_REQUEST, "invalid_field", error.message)
            }
            _ => ApiError::from(crate::error::InternalError(error.message)),
        })?;
    let _ =
        crate::search::upsert_document_index(&state.store, &state.config, &collection, &document)
            .await;
    state
        .cache
        .delete_document(&headers, &collection.id, &id)
        .await;
    Ok(json_response(
        StatusCode::OK,
        document_response(&document, &collection),
    ))
}

async fn query_documents(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let spec: QuerySpec = parse_query_spec(&body, Some(&collection.mapping))
        .map_err(|error: QueryError| ApiError::from(error))?;
    if state.store.uses_postgres() {
        let result = state
            .store
            .query_documents(&collection.id, &spec, Some(&collection.mapping))
            .await
            .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
        return Ok(json_response(StatusCode::OK, result));
    }
    let documents = if spec.vector_search.is_some() {
        state
            .store
            .list_documents_matching(
                &collection.id,
                spec.where_.clone(),
                state.config.query_scan_limit + 1,
            )
            .await
    } else {
        state
            .store
            .list_all_documents(
                &collection.id,
                Some(state.config.query_scan_limit + 1),
                None,
            )
            .await
    }
    .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    if documents.len() as i64 > state.config.query_scan_limit {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "collection_too_large",
            format!(
                "query scan limit is {} documents; narrow the collection or raise BASE_QUERY_SCAN_LIMIT",
                state.config.query_scan_limit
            ),
        ));
    }
    Ok(json_response(
        StatusCode::OK,
        apply_query(&documents, &spec, Some(&collection.mapping)),
    ))
}

async fn vector_search(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let spec = parse_vector_search_spec(&body, Some(&collection.mapping))
        .map_err(|error: QueryError| ApiError::from(error))?;
    let documents = state
        .store
        .list_documents_matching(
            &collection.id,
            spec.where_.clone(),
            state.config.query_scan_limit,
        )
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    Ok(json_response(
        StatusCode::OK,
        apply_vector_search(&documents, &spec, Some(&collection.mapping)),
    ))
}

async fn batch_documents(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let operations = object.get("operations").and_then(Value::as_array).cloned();
    let Some(operations) = operations else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_batch",
            "operations must contain 1..100 entries",
        ));
    };
    if operations.is_empty() || operations.len() > 100 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_batch",
            "operations must contain 1..100 entries",
        ));
    }
    let mut results = Vec::with_capacity(operations.len());
    let mut touched: Vec<String> = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        let op = operation.as_object().cloned().unwrap_or_default();
        let op_name = op.get("op").map(js_string).unwrap_or_default();
        let outcome: Result<Value, (String, String)> = async {
            match op_name.as_str() {
                "create" => {
                    let id = match op.get("id") {
                        Some(value) if js_truthy(value) => {
                            clean_doc_id(op.get("id")).ok_or_else(|| {
                                ("invalid".to_string(), "invalid document id".to_string())
                            })?
                        }
                        _ => crate::util::random_id(),
                    };
                    touched.push(id.clone());
                    let data = parse_data_body(
                        operation,
                        Some(&collection.mapping),
                        false,
                        state.config.max_document_bytes,
                    )
                    .map_err(|error| ("mapping_error".to_string(), error.message))?;
                    let document = state
                        .store
                        .create_document(&collection.id, &id, data)
                        .await
                        .map_err(|error| (store_code(&error), error.message))?;
                    let _ = crate::search::upsert_document_index(
                        &state.store,
                        &state.config,
                        &collection,
                        &document,
                    )
                    .await;
                    Ok(json!({
                        "index": index,
                        "ok": true,
                        "op": "create",
                        "document": to_api_document(
                            &document,
                            AsView::Data,
                            Some(&collection.mapping),
                        ),
                    }))
                }
                "set" | "update" => {
                    let id = clean_doc_id(op.get("id"))
                        .ok_or_else(|| ("invalid".to_string(), "id is required".to_string()))?;
                    touched.push(id.clone());
                    let data = parse_data_body(
                        operation,
                        Some(&collection.mapping),
                        op_name == "update",
                        state.config.max_document_bytes,
                    )
                    .map_err(|error| ("mapping_error".to_string(), error.message))?;
                    let result = state
                        .store
                        .set_document(
                            &collection.id,
                            &id,
                            data,
                            SetDocumentOptions {
                                merge: op_name == "update",
                                if_version: None,
                            },
                        )
                        .await
                        .map_err(|error| (store_code(&error), error.message))?;
                    let _ = crate::search::upsert_document_index(
                        &state.store,
                        &state.config,
                        &collection,
                        &result.doc,
                    )
                    .await;
                    Ok(json!({
                        "index": index,
                        "ok": true,
                        "op": op_name,
                        "created": result.created,
                        "document": to_api_document(
                            &result.doc,
                            AsView::Data,
                            Some(&collection.mapping),
                        ),
                    }))
                }
                "delete" => {
                    let id = clean_doc_id(op.get("id"))
                        .ok_or_else(|| ("invalid".to_string(), "id is required".to_string()))?;
                    touched.push(id.clone());
                    let if_version = match op.get("ifVersion") {
                        None => None,
                        Some(value) => match js_number(value) {
                            Some(number)
                                if number.is_finite()
                                    && number.fract() == 0.0
                                    && number >= 0.0
                                    && number <= i32::MAX as f64 =>
                            {
                                Some(number as i32)
                            }
                            _ => {
                                return Err((
                                    "version_conflict".to_string(),
                                    "ifVersion must be a non-negative integer".to_string(),
                                ))
                            }
                        },
                    };
                    let ok = state
                        .store
                        .delete_document(&collection.id, &id, if_version)
                        .await
                        .map_err(|error| (store_code(&error), error.message))?;
                    if ok {
                        let _ =
                            crate::search::remove_document_index(&state.store, &collection.id, &id)
                                .await;
                    }
                    Ok(json!({
                        "index": index,
                        "ok": ok,
                        "op": "delete",
                        "id": id,
                    }))
                }
                "increment" => {
                    let id = clean_doc_id(op.get("id"))
                        .ok_or_else(|| ("invalid".to_string(), "id is required".to_string()))?;
                    touched.push(id.clone());
                    let field = op.get("field").map(js_string).unwrap_or_default();
                    let by = match op.get("by") {
                        None | Some(Value::Null) => 1.0,
                        Some(value) => js_number(value).unwrap_or(f64::NAN),
                    };
                    let document = state
                        .store
                        .increment_document(&collection.id, &id, &field, by, None)
                        .await
                        .map_err(|error| (store_code(&error), error.message))?;
                    Ok(json!({
                        "index": index,
                        "ok": true,
                        "op": "increment",
                        "document": to_api_document(
                            &document,
                            AsView::Data,
                            Some(&collection.mapping),
                        ),
                    }))
                }
                _ => Err((
                    "invalid".to_string(),
                    format!(
                        "unknown op '{}'",
                        op_name.chars().take(40).collect::<String>()
                    ),
                )),
            }
        }
        .await;
        match outcome {
            Ok(value) => results.push(value),
            Err((code, message)) => {
                let mut failure = Map::new();
                failure.insert("index".into(), json!(index));
                failure.insert("ok".into(), Value::Bool(false));
                if let Some(value) = op.get("op") {
                    failure.insert("op".into(), value.clone());
                }
                failure.insert("error".into(), Value::String(code));
                failure.insert(
                    "message".into(),
                    Value::String(message.chars().take(300).collect()),
                );
                results.push(Value::Object(failure));
            }
        }
    }
    state
        .cache
        .delete_documents(&headers, &collection.id, &touched)
        .await;
    let all_ok = results
        .iter()
        .all(|result| result.get("ok").and_then(Value::as_bool).unwrap_or(false));
    Ok(json_response(
        StatusCode::OK,
        json!({"results": results, "ok": all_ok}),
    ))
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn store_code(error: &StoreError) -> String {
    match error.code {
        StoreErrorCode::Conflict => "conflict".into(),
        StoreErrorCode::VersionConflict => "version_conflict".into(),
        StoreErrorCode::NotFound => "not_found".into(),
        StoreErrorCode::Invalid => "invalid".into(),
    }
}

// ---------- changes ----------

async fn changes(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let since = params.get("since").cloned().unwrap_or_default();
    if since.is_empty() || parse_js_date(&since).is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_since",
            "since must be an ISO-8601 timestamp",
        ));
    }
    let limit = match params.get("limit") {
        None => 100.0,
        Some(value) => js_number_string(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_limit",
                "limit must be an integer 1..1000",
            )
        })?,
    };
    if limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_limit",
            "limit must be an integer 1..1000",
        ));
    }
    let view = match params.get("as") {
        None => AsView::Data,
        Some(value) => AsView::parse(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_view",
                "as must be 'data' or 'object'",
            )
        })?,
    };
    let after = params.get("after").cloned();
    let page = state
        .store
        .list_changes(&collection.id, &since, after.as_deref(), limit as i64)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let mut entries = Vec::with_capacity(page.events.len());
    for event in &page.events {
        let operation = event.get("operation").and_then(Value::as_str).unwrap_or("");
        let mut entry = Map::new();
        entry.insert(
            "id".into(),
            event.get("document_id").cloned().unwrap_or(Value::Null),
        );
        entry.insert("collection".into(), Value::String(collection.name.clone()));
        entry.insert(
            "version".into(),
            event.get("version").cloned().unwrap_or(Value::Null),
        );
        entry.insert(
            "createdAt".into(),
            event.get("occurred_at").cloned().unwrap_or(Value::Null),
        );
        entry.insert(
            "updatedAt".into(),
            event.get("occurred_at").cloned().unwrap_or(Value::Null),
        );
        entry.insert("operation".into(), Value::String(operation.into()));
        entry.insert("deleted".into(), Value::Bool(operation == "delete"));
        entry.insert(
            "eventId".into(),
            event.get("event_id").cloned().unwrap_or(Value::Null),
        );
        if let Some(data) = event.get("data") {
            entry.insert("data".into(), data.clone());
            if view == AsView::Object {
                entry.insert(
                    "object".into(),
                    data_to_object(data, Some(&collection.mapping)),
                );
            }
        }
        entries.push(Value::Object(entry));
    }
    Ok(json_response(
        StatusCode::OK,
        json!({
            "changes": entries,
            "nextSince": page.next_since,
            "nextAfter": page.next_after,
            "hasMore": page.events.len() as i64 == limit as i64,
        }),
    ))
}

// ---------- document listing ----------

async fn list_documents(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let limit = match params.get("limit") {
        None => 100.0,
        Some(value) => js_number_string(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_pagination",
                "limit 1..1000 and offset >= 0 required",
            )
        })?,
    };
    let offset = match params.get("offset") {
        None => 0.0,
        Some(value) => js_number_string(value).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_pagination",
                "limit 1..1000 and offset >= 0 required",
            )
        })?,
    };
    if limit.fract() != 0.0
        || !(1.0..=1000.0).contains(&limit)
        || offset.fract() != 0.0
        || offset < 0.0
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_pagination",
            "limit 1..1000 and offset >= 0 required",
        ));
    }
    let page = state
        .store
        .list_documents_page(&collection.id, limit as i64, offset as i64)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let items: Vec<Value> = page
        .iter()
        .map(|document| to_api_document(document, AsView::Data, Some(&collection.mapping)))
        .collect();
    let total = state
        .store
        .count_documents(&collection.id)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let headers_out = [("x-total-count", total.to_string())];
    let with_total = matches!(
        params.get("withTotal").map(String::as_str),
        Some("1") | Some("true")
    );
    if with_total {
        let next_offset = offset as i64 + items.len() as i64;
        let next_cursor = if next_offset < total {
            Value::String(encode_cursor(next_offset))
        } else {
            Value::Null
        };
        let mut response = json_response(
            StatusCode::OK,
            json!({
                "items": items,
                "total": total,
                "limit": limit as i64,
                "offset": offset as i64,
                "nextCursor": next_cursor,
            }),
        );
        for (name, value) in headers_out {
            if let Ok(value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(name, value);
            }
        }
        return Ok(response);
    }
    let mut response = json_response(StatusCode::OK, Value::Array(items));
    for (name, value) in headers_out {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().insert(name, value);
        }
    }
    Ok(response)
}

// ---------- graph ----------

async fn graph_upsert_nodes(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let input = body.get("nodes").cloned().unwrap_or_else(|| body.clone());
    match crate::graph::upsert_nodes(&state.store, &collection.id, &input).await {
        Ok(nodes) => Ok(json_response(StatusCode::CREATED, json!({"nodes": nodes}))),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_graph",
            message,
        )),
    }
}

async fn graph_upsert_edges(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let input = body.get("edges").cloned().unwrap_or_else(|| body.clone());
    match crate::graph::upsert_edges(&state.store, &collection.id, &input).await {
        Ok(edges) => Ok(json_response(StatusCode::CREATED, json!({"edges": edges}))),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_graph",
            message,
        )),
    }
}

fn number_param(params: &Params, key: &str, fallback: f64) -> f64 {
    match params.get(key) {
        None => fallback,
        Some(value) => js_number_string(value)
            .filter(|value| value.is_finite())
            .unwrap_or(fallback),
    }
}

async fn graph_node(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_node_id"))?;
    let depth = number_param(&params, "depth", 1.0);
    let limit = number_param(&params, "limit", 200.0);
    let result = crate::graph::subgraph(
        &state.store,
        &collection.id,
        std::slice::from_ref(&id),
        depth,
        &[],
        limit,
    )
    .await
    .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_graph", message))?;
    let Some(node) = crate::graph::get_node(&state.store, &collection.id, &id)
        .await
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_graph", message))?
    else {
        return Err(ApiError::not_found(format!("node '{id}' not found")));
    };
    Ok(json_response(
        StatusCode::OK,
        json!({
            "node": node,
            "nodes": result.nodes,
            "edges": result.edges,
            "next": result.next,
        }),
    ))
}

async fn graph_query(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let start: Vec<String> = match object.get("start").and_then(Value::as_array) {
        Some(items) => items.iter().map(js_string).collect(),
        None => object
            .get("id")
            .filter(|value| js_truthy(value))
            .map(|value| vec![js_string(value)])
            .unwrap_or_default(),
    };
    if start.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_graph",
            "start (or id) is required",
        ));
    }
    let depth = object
        .get("depth")
        .filter(|value| !value.is_null())
        .and_then(js_number)
        .filter(|value| value.is_finite())
        .unwrap_or(1.0);
    let limit = object
        .get("limit")
        .filter(|value| !value.is_null())
        .and_then(js_number)
        .filter(|value| value.is_finite())
        .unwrap_or(200.0);
    let edge_types: Vec<String> = object
        .get("edgeTypes")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(js_string).collect())
        .unwrap_or_default();
    let result = crate::graph::subgraph(
        &state.store,
        &collection.id,
        &start,
        depth,
        &edge_types,
        limit,
    )
    .await
    .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_graph", message))?;
    Ok(json_response(
        StatusCode::OK,
        json!({"nodes": result.nodes, "edges": result.edges, "next": result.next}),
    ))
}

async fn graph_stats(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let stats = crate::graph::graph_stats(&state.store, &collection.id)
        .await
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_graph", message))?;
    Ok(json_response(StatusCode::OK, stats))
}

async fn graph_delete_node(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_node_id"))?;
    let ok = crate::graph::delete_node(&state.store, &collection.id, &id)
        .await
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_graph", message))?;
    if !ok {
        return Err(ApiError::code(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(json_response(StatusCode::OK, json!({"ok": true, "id": id})))
}

// ---------- GIS ----------

async fn geo_upsert(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let input = body
        .get("features")
        .cloned()
        .unwrap_or_else(|| body.clone());
    match crate::gis::upsert_features(&state.store, &collection.id, &input).await {
        Ok(features) => Ok(json_response(
            StatusCode::CREATED,
            json!({"features": features}),
        )),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_geo",
            message,
        )),
    }
}

async fn geo_list(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let limit = number_param(&params, "limit", 200.0);
    let bbox = params.get("bbox").map(String::as_str);
    match crate::gis::list_features(&state.store, &collection.id, bbox, limit).await {
        Ok(features) => Ok(json_response(
            StatusCode::OK,
            json!({"type": "FeatureCollection", "features": features}),
        )),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_geo",
            message,
        )),
    }
}

async fn geo_near(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let lat = object.get("lat").and_then(js_number).unwrap_or(f64::NAN);
    let lng = object.get("lng").and_then(js_number).unwrap_or(f64::NAN);
    let radius = object
        .get("radiusMeters")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("radius").filter(|value| !value.is_null()))
        .and_then(js_number)
        .unwrap_or(f64::NAN);
    let limit = object
        .get("limit")
        .filter(|value| !value.is_null())
        .and_then(js_number)
        .unwrap_or(200.0);
    match crate::gis::near(&state.store, &collection.id, lat, lng, radius, limit).await {
        Ok(features) => Ok(json_response(
            StatusCode::OK,
            json!({"type": "FeatureCollection", "features": features}),
        )),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_geo",
            message,
        )),
    }
}

async fn geo_within(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let geometry = object.get("geometry").cloned().unwrap_or(Value::Null);
    let limit = object
        .get("limit")
        .filter(|value| !value.is_null())
        .and_then(js_number)
        .unwrap_or(200.0);
    match crate::gis::within(&state.store, &collection.id, &geometry, limit).await {
        Ok(features) => Ok(json_response(
            StatusCode::OK,
            json!({"type": "FeatureCollection", "features": features}),
        )),
        Err(message) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_geo",
            message,
        )),
    }
}

async fn geo_stats(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let stats = crate::gis::geo_stats(&state.store, &collection.id)
        .await
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_geo", message))?;
    Ok(json_response(StatusCode::OK, stats))
}

async fn geo_delete_feature(
    State(state): State<AppState>,
    Path((collection_name, id)): Path<(String, String)>,
    Query(params): Query<Params>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let id = clean_doc_id(Some(&Value::String(id)))
        .ok_or_else(|| ApiError::code(StatusCode::BAD_REQUEST, "invalid_feature_id"))?;
    let ok = crate::gis::delete_feature(&state.store, &collection.id, &id)
        .await
        .map_err(|message| ApiError::new(StatusCode::BAD_REQUEST, "invalid_geo", message))?;
    if !ok {
        return Err(ApiError::code(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(json_response(StatusCode::OK, json!({"ok": true, "id": id})))
}

// ---------- internal ----------

async fn backfill(
    State(state): State<AppState>,
    Path(collection_name): Path<String>,
    Query(params): Query<Params>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<Response, ApiError> {
    let collection = load_collection(&state, &headers, &params, &collection_name).await?;
    let body = parse_body(body)?;
    let object = body_object(&body);
    let limit = object
        .get("limit")
        .and_then(js_number)
        .filter(|value| *value != 0.0 && value.is_finite())
        .unwrap_or(500.0) as i64;
    let limit = limit.clamp(1, 1000);
    let after_id = object
        .get("afterId")
        .filter(|value| js_truthy(value))
        .map(js_string);
    let documents = state
        .store
        .list_documents(
            &collection.id,
            ListDocumentsOptions {
                since: None,
                scan_limit: Some(limit),
                after_id: after_id.clone(),
            },
        )
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let enqueued = state
        .store
        .enqueue_backfill(&collection.id, &documents)
        .await
        .map_err(|error| ApiError::from(crate::error::InternalError(error.message)))?;
    let next_after = documents
        .last()
        .map(|document| Value::String(document.id.clone()))
        .or_else(|| after_id.map(Value::String))
        .unwrap_or(Value::Null);
    Ok(json_response(
        StatusCode::OK,
        json!({
            "enqueued": enqueued,
            "scanned": documents.len(),
            "nextAfter": next_after,
            "hasMore": documents.len() as i64 == limit,
        }),
    ))
}

// ---------- middleware ----------

#[derive(Clone)]
struct RequestId(String);

async fn security_headers(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let hsts = state.config.hsts_enabled;
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    if hsts {
        headers.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}

async fn request_id_middleware(mut request: Request, next: Next) -> Response {
    let incoming = header(request.headers(), "x-request-id");
    let sanitized = sanitize_request_id(&incoming);
    let id = if sanitized.is_empty() {
        request_id()
    } else {
        sanitized
    };
    request.extensions_mut().insert(RequestId(id.clone()));
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

/// Route template for the known table. Axum's `MatchedPath` is only visible
/// inside the routed service; audit/metrics run outside the internal gate so
/// rejected `/v1` requests are still observed, and use this stable template.
pub fn route_pattern(path: &str) -> String {
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let joined = |pattern: &[&str]| -> String {
        format!("/{}", pattern.join("/")).replace(":collection", ":collection")
    };
    match segments.as_slice() {
        ["v1", "search"] => "/v1/search".into(),
        ["v1", "search", "reindex"] => "/v1/search/reindex".into(),
        ["v1", "search", "status"] => "/v1/search/status".into(),
        ["v1", "base", "collections"] => "/v1/base/collections".into(),
        ["v1", "base", "collections", _] => joined(&["v1", "base", "collections", ":collection"]),
        ["v1", "base", "collections", _, "stats"] => {
            joined(&["v1", "base", "collections", ":collection", "stats"])
        }
        ["v1", "base", "collections", _, "documents"] => {
            joined(&["v1", "base", "collections", ":collection", "documents"])
        }
        ["v1", "base", "collections", _, "documents:batch"] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "documents:batch",
        ]),
        ["v1", "base", "collections", _, "documents", _] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "documents",
            ":id",
        ]),
        ["v1", "base", "collections", _, "documents", _, "increment"] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "documents",
            ":id",
            "increment",
        ]),
        ["v1", "base", "collections", _, "query"] => {
            joined(&["v1", "base", "collections", ":collection", "query"])
        }
        ["v1", "base", "collections", _, "vector-search"] => {
            joined(&["v1", "base", "collections", ":collection", "vector-search"])
        }
        ["v1", "base", "collections", _, "changes"] => {
            joined(&["v1", "base", "collections", ":collection", "changes"])
        }
        ["v1", "base", "collections", _, "graph", "nodes"] => {
            joined(&["v1", "base", "collections", ":collection", "graph", "nodes"])
        }
        ["v1", "base", "collections", _, "graph", "edges"] => {
            joined(&["v1", "base", "collections", ":collection", "graph", "edges"])
        }
        ["v1", "base", "collections", _, "graph", "nodes", _] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "graph",
            "nodes",
            ":id",
        ]),
        ["v1", "base", "collections", _, "graph", "query"] => {
            joined(&["v1", "base", "collections", ":collection", "graph", "query"])
        }
        ["v1", "base", "collections", _, "graph", "stats"] => {
            joined(&["v1", "base", "collections", ":collection", "graph", "stats"])
        }
        ["v1", "base", "collections", _, "geo", "features"] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "geo",
            "features",
        ]),
        ["v1", "base", "collections", _, "geo", "features", _] => joined(&[
            "v1",
            "base",
            "collections",
            ":collection",
            "geo",
            "features",
            ":id",
        ]),
        ["v1", "base", "collections", _, "geo", "near"] => {
            joined(&["v1", "base", "collections", ":collection", "geo", "near"])
        }
        ["v1", "base", "collections", _, "geo", "within"] => {
            joined(&["v1", "base", "collections", ":collection", "geo", "within"])
        }
        ["v1", "base", "collections", _, "geo", "stats"] => {
            joined(&["v1", "base", "collections", ":collection", "geo", "stats"])
        }
        ["internal", "base", "collections", _, "backfill"] => {
            joined(&["internal", "base", "collections", ":collection", "backfill"])
        }
        _ => path.to_string(),
    }
}

async fn metrics_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .map(|id| id.0.clone())
        .unwrap_or_default();
    let response = next.run(request).await;
    let route = route_pattern(&path);
    state
        .metrics
        .record(method.as_str(), &route, response.status().as_u16());
    tracing::info!(
        "[base] {} {} {} {}ms rid={}",
        method,
        path,
        response.status().as_u16(),
        started.elapsed().as_millis(),
        request_id
    );
    response
}

fn verify_internal(headers: &HeaderMap, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let value = header(headers, "x-synapseone-internal");
    if value.is_empty() || value.len() != secret.len() {
        return false;
    }
    value
        .as_bytes()
        .iter()
        .zip(secret.as_bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

async fn internal_gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    if !path.starts_with("/v1/") && !path.starts_with("/internal/") {
        return next.run(request).await;
    }
    if state.config.internal_secret.is_empty() {
        if state.config.is_prod {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({
                    "error": "misconfigured",
                    "message": "internal secret required in production",
                }),
            );
        }
        return next.run(request).await;
    }
    if !verify_internal(request.headers(), &state.config.internal_secret) {
        return ApiError::unauthorized_internal().into_response();
    }
    next.run(request).await
}

async fn audit_middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let matched = route_pattern(&path);
    let should_audit = state.audit.enabled()
        && matches!(
            method,
            Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        )
        && path.starts_with("/v1/")
        && !(method == Method::POST && crate::audit::is_read_only_post(&matched));
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .map(|id| id.0.clone())
        .unwrap_or_default();
    let headers = request.headers().clone();
    let response = next.run(request).await;
    if should_audit {
        let event = build_event(
            SERVICE,
            &headers,
            &method,
            &matched,
            &path,
            &request_id,
            response.status().as_u16(),
        );
        state.audit.record(event).await;
    }
    response
}

async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, json!({"error": "not_found"}))
}

// ---------- router ----------

fn cors_layer(config: &Config) -> CorsLayer {
    if config.cors_origins.is_empty() {
        if config.is_prod {
            CorsLayer::new()
        } else {
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
        }
    } else {
        let origins: Vec<HeaderValue> = config
            .cors_origins
            .iter()
            .filter_map(|origin| origin.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(Any)
            .allow_headers(Any)
    }
}

pub fn build_app(state: AppState) -> Router {
    let v1 = Router::new()
        .route(
            "/v1/base/collections",
            get(list_collections).post(create_collection),
        )
        .route(
            "/v1/base/collections/{collection}",
            get(get_collection)
                .patch(patch_collection)
                .delete(delete_collection),
        )
        .route(
            "/v1/base/collections/{collection}/stats",
            get(collection_stats),
        )
        .route(
            "/v1/base/collections/{collection}/documents",
            get(list_documents).post(create_document),
        )
        .route(
            "/v1/base/collections/{collection}/documents:batch",
            post(batch_documents),
        )
        .route(
            "/v1/base/collections/{collection}/documents/{id}",
            get(get_document)
                .put(put_document)
                .patch(patch_document)
                .delete(delete_document),
        )
        .route(
            "/v1/base/collections/{collection}/documents/{id}/increment",
            post(increment_document),
        )
        .route(
            "/v1/base/collections/{collection}/query",
            post(query_documents),
        )
        .route(
            "/v1/base/collections/{collection}/vector-search",
            post(vector_search),
        )
        .route("/v1/base/collections/{collection}/changes", get(changes))
        .route(
            "/v1/base/collections/{collection}/graph/nodes",
            post(graph_upsert_nodes),
        )
        .route(
            "/v1/base/collections/{collection}/graph/edges",
            post(graph_upsert_edges),
        )
        .route(
            "/v1/base/collections/{collection}/graph/nodes/{id}",
            get(graph_node).delete(graph_delete_node),
        )
        .route(
            "/v1/base/collections/{collection}/graph/query",
            post(graph_query),
        )
        .route(
            "/v1/base/collections/{collection}/graph/stats",
            get(graph_stats),
        )
        .route(
            "/v1/base/collections/{collection}/geo/features",
            get(geo_list).post(geo_upsert),
        )
        .route("/v1/base/collections/{collection}/geo/near", post(geo_near))
        .route(
            "/v1/base/collections/{collection}/geo/within",
            post(geo_within),
        )
        .route(
            "/v1/base/collections/{collection}/geo/stats",
            get(geo_stats),
        )
        .route(
            "/v1/base/collections/{collection}/geo/features/{id}",
            delete(geo_delete_feature),
        )
        .route("/v1/search", get(search_get).post(search_post))
        .route("/v1/search/reindex", post(search_reindex))
        .route("/v1/search/status", get(search_status));

    let internal = Router::new().route(
        "/internal/base/collections/{collection}/backfill",
        post(backfill),
    );

    let cors = cors_layer(&state.config);
    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .merge(v1)
        .merge(internal)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), internal_gate))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            audit_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            metrics_middleware,
        ))
        .layer(middleware::from_fn(request_id_middleware))
        .layer(cors)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(5 * 1024 * 1024))
        .with_state(state)
}
