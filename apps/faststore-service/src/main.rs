// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Faststore — tenant-scoped cache and data-structure service backed by
//! Valkey/Redis (in-memory fallback for dev/test). It exposes string keys with
//! TTL and NX/XX semantics, atomic counters, hashes, lists, sets, sorted sets,
//! batch operations, key scanning and distributed locks.
//!
//! Auth matches the rest of the platform: gateway-stamped `x-synapseone-*`
//! headers, the legacy `x-synapsedx-*` aliases and the shared
//! `SYNAPSEONE_INTERNAL_SECRET` for direct service-to-service calls.

mod audit;
mod store;

#[cfg(test)]
mod api_test;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use store::{FaststoreError, FieldValue, MemoryStore, Stats, Store, WriteOptions, ZMember};

const VERSION: &str = "0.7.1";
const MAX_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
const MAX_KEY_LENGTH: usize = 512;
const MAX_FIELD_LENGTH: usize = 256;
const MAX_BATCH_OPS: usize = 100;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
struct Config {
    port: u16,
    is_prod: bool,
    internal_secret: String,
    cors_origins: Vec<String>,
}

#[derive(Clone)]
struct AppState {
    store: Store,
    config: Config,
}

#[derive(Clone)]
struct Tenant(String);

#[derive(Clone)]
struct Principal {
    sub: String,
    org: Option<String>,
    account: Option<String>,
}

#[derive(Clone)]
enum Caller {
    Anon,
    Principal(Principal),
    Platform,
}

type ApiResult = Result<Response, ApiError>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}

impl From<FaststoreError> for ApiError {
    fn from(error: FaststoreError) -> Self {
        match error {
            FaststoreError::Internal(detail) => {
                tracing::error!("[faststore] unhandled storage error: {detail}");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "unexpected error",
                )
            }
            FaststoreError::KeyExists(message) => {
                ApiError::new(StatusCode::CONFLICT, "key_exists", message)
            }
            FaststoreError::WrongType(message) => {
                ApiError::new(StatusCode::CONFLICT, "wrong_type", message)
            }
            FaststoreError::NotFound(message) => {
                ApiError::new(StatusCode::NOT_FOUND, "not_found", message)
            }
            FaststoreError::StorageUnavailable(message) => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                message,
            ),
            FaststoreError::NotANumber(message) => {
                ApiError::new(StatusCode::BAD_REQUEST, "not_a_number", message)
            }
        }
    }
}

fn json_error(status: StatusCode, code: &'static str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}

fn status_json(status: StatusCode, value: Value) -> ApiResult {
    Ok((status, Json(value)).into_response())
}

fn ok_json(value: Value) -> ApiResult {
    Ok(Json(value).into_response())
}

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn config_from_env() -> Config {
    Config {
        port: env_u64("PORT", 4006) as u16,
        is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
        internal_secret: std::env::var("SYNAPSEONE_INTERNAL_SECRET").unwrap_or_default(),
        cors_origins: std::env::var("CORS_ORIGIN")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

fn redis_url_from_env() -> Option<String> {
    [
        "FASTSTORE_VALKEY_URL",
        "VALKEY_URL",
        "FASTSTORE_REDIS_URL",
        "REDIS_URL",
    ]
    .iter()
    .find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

/// Production is fail-closed: no internal secret and no Redis/Valkey URL means
/// the service must not boot (the in-memory fallback would split-brain).
fn validate_production_config(
    is_prod: bool,
    internal_secret: &str,
    redis_url: Option<&str>,
) -> Result<(), String> {
    if !is_prod {
        return Ok(());
    }
    if internal_secret.is_empty() {
        return Err("[faststore] SYNAPSEONE_INTERNAL_SECRET must be set in production".to_string());
    }
    if redis_url.is_none() {
        return Err(
            "[faststore] FASTSTORE_VALKEY_URL/VALKEY_URL (or legacy FASTSTORE_REDIS_URL/REDIS_URL) must be set in production (in-memory fallback would split-brain)".to_string(),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

fn header(headers: &HeaderMap, name: &str) -> String {
    let legacy = if name.starts_with("x-synapseone-") {
        name.replacen("x-synapseone-", "x-synapsedx-", 1)
    } else {
        name.to_string()
    };
    headers
        .get(name)
        .or_else(|| headers.get(&legacy))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn has_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= '\u{001f}' || character == '\u{007f}')
}

fn principal_from_headers(headers: &HeaderMap) -> Option<Principal> {
    let clean = |value: String| {
        if !value.is_empty() && js_len(&value) <= 128 {
            Some(value)
        } else {
            None
        }
    };
    let user = header(headers, "x-synapseone-user");
    if !user.is_empty() {
        if js_len(&user) > 128 {
            return None;
        }
        return Some(Principal {
            sub: user,
            org: clean(header(headers, "x-synapseone-org")),
            account: clean(header(headers, "x-synapseone-account")),
        });
    }
    // API keys are machine identities: the gateway stamps kind=apikey +
    // account but no user (keys carry no user claim). Without this fallback
    // they would look unauthenticated and fall through to `platform` — a
    // cross-tenant superuser.
    let kind = header(headers, "x-synapseone-kind");
    let account = header(headers, "x-synapseone-account");
    let org = header(headers, "x-synapseone-org");
    if !kind.is_empty() || !account.is_empty() || !org.is_empty() {
        let sub = if account.is_empty() {
            format!(
                "{}:unknown",
                if kind.is_empty() { "principal" } else { &kind }
            )
        } else {
            format!("apikey:{account}")
        };
        return Some(Principal {
            sub,
            org: clean(org),
            account: clean(account),
        });
    }
    None
}

fn resolve_caller(headers: &HeaderMap) -> Caller {
    if let Some(principal) = principal_from_headers(headers) {
        return Caller::Principal(principal);
    }
    let anon = headers
        .get("x-synapseone-anon")
        .or_else(|| headers.get("x-synapsedx-anon"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if anon == "1" {
        Caller::Anon
    } else {
        Caller::Platform
    }
}

fn clean_tenant(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || js_len(trimmed) > 128 || has_control(trimmed) {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn verify_internal(headers: &HeaderMap, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let value = header(headers, "x-synapseone-internal");
    if value.is_empty() || value.len() != secret.len() {
        return false;
    }
    constant_time_eq(value.as_bytes(), secret.as_bytes())
}

/// Timing-safe byte comparison (equal-length inputs; length is checked first).
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn clean_key_or_throw(value: &str) -> Result<String, ApiError> {
    if value.is_empty()
        || js_len(value) > MAX_KEY_LENGTH
        || has_control(value)
        || value.contains(['/', '\\'])
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_key",
            format!("key must be 1..{MAX_KEY_LENGTH} printable characters without '/' or '\\'"),
        ));
    }
    Ok(value.to_string())
}

fn clean_field_or_throw(value: &str) -> Result<String, ApiError> {
    if value.is_empty() || js_len(value) > MAX_FIELD_LENGTH || has_control(value) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_field",
            format!("field must be 1..{MAX_FIELD_LENGTH} printable characters"),
        ));
    }
    Ok(value.to_string())
}

fn clean_lock_name_or_throw(value: &str) -> Result<String, ApiError> {
    if value.is_empty() || js_len(value) > 256 || has_control(value) || value.contains(['/', '\\'])
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_lock_name",
            "lock name must be 1..256 printable characters without '/' or '\\'",
        ));
    }
    Ok(value.to_string())
}

fn js_parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let (sign, unsigned) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1.0, &trimmed[1..]),
        Some(b'+') => (1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if let Some(hex) = unsigned
        .strip_prefix("0x")
        .or_else(|| unsigned.strip_prefix("0X"))
    {
        return i64::from_str_radix(hex, 16)
            .ok()
            .map(|value| sign * value as f64);
    }
    trimmed.parse::<f64>().ok()
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => js_parse_number(text),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number(&items[0]),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

fn integer_in_range(number: f64, min: i64, max: i64) -> Option<i64> {
    if number.is_finite() && number.fract() == 0.0 && number >= min as f64 && number <= max as f64 {
        Some(number as i64)
    } else {
        None
    }
}

fn ttl_or_throw(value: Option<&Value>, allow_zero: bool) -> Result<Option<i64>, ApiError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let min = if allow_zero { 0 } else { 1 };
            match js_number(value).and_then(|number| integer_in_range(number, min, MAX_TTL_SECONDS))
            {
                Some(ttl) => Ok(Some(ttl)),
                None => Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_ttl",
                    format!("ttlSeconds must be an integer {min}..{MAX_TTL_SECONDS}"),
                )),
            }
        }
    }
}

fn int_or_throw(
    value: Option<&Value>,
    name: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, ApiError> {
    match value {
        None | Some(Value::Null) => Ok(default),
        Some(Value::String(text)) if text.is_empty() => Ok(default),
        Some(value) => match js_number(value).and_then(|number| integer_in_range(number, min, max))
        {
            Some(number) => Ok(number),
            None => Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                format!("{name} must be an integer {min}..{max}"),
            )),
        },
    }
}

fn query_int(
    query: &HashMap<String, String>,
    name: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, ApiError> {
    match query.get(name) {
        None => Ok(default),
        Some(raw) => int_or_throw(Some(&Value::String(raw.clone())), name, min, max, default),
    }
}

fn js_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => text == "true" || text == "1",
        Some(Value::Number(number)) => number.as_f64() == Some(1.0),
        _ => false,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `String(value ?? '')` semantics: missing/null become an empty string.
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

fn array_or_throw<'a>(
    value: Option<&'a Value>,
    name: &str,
    min: usize,
    max: usize,
) -> Result<&'a Vec<Value>, ApiError> {
    match value {
        Some(Value::Array(items)) if items.len() >= min && items.len() <= max => Ok(items),
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            format!("{name} must be an array with {min}..{max} items"),
        )),
    }
}

fn values_object_or_throw(value: Option<&Value>) -> Result<&Map<String, Value>, ApiError> {
    let Some(Value::Object(values)) = value else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "values must be an object of field/value pairs",
        ));
    };
    if values.is_empty() || values.len() > 500 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "values must contain 1..500 fields",
        ));
    }
    for field in values.keys() {
        clean_field_or_throw(field)?;
    }
    Ok(values)
}

fn write_options(body: &Map<String, Value>) -> Result<WriteOptions, ApiError> {
    let if_not_exists = js_bool(body.get("ifNotExists"));
    let if_exists = js_bool(body.get("ifExists"));
    if if_not_exists && if_exists {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "use either ifNotExists or ifExists, not both",
        ));
    }
    Ok(WriteOptions {
        ttl_seconds: ttl_or_throw(body.get("ttlSeconds"), true)?,
        if_not_exists,
        if_exists,
    })
}

/// Reads the JSON object body, enforcing the 2 MB limit and the TypeScript
/// error codes for malformed or oversized payloads.
async fn read_body(request: Request) -> Result<Map<String, Value>, ApiError> {
    let bytes = axum::body::to_bytes(request.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "Request body exceeds the size limit",
            )
        })?;
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "Request body is not valid JSON",
        )
    })?;
    match value {
        Value::Object(body) => Ok(body),
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "request body must be a JSON object",
        )),
    }
}

// ---------------------------------------------------------------------------
// Handlers: health, metrics, stats and scans
// ---------------------------------------------------------------------------

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "service": "faststore",
        "version": VERSION,
        "backend": state.store.name(),
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
    .into_response()
}

fn metrics_map() -> &'static Mutex<BTreeMap<String, u64>> {
    static METRICS: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
    METRICS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn start_time() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

fn record_metric(method: &str, route: &str, status: u16) {
    let Ok(mut metrics) = metrics_map().lock() else {
        return;
    };
    let route = if metrics.len() >= 300 {
        "**".to_string()
    } else {
        route.chars().take(64).collect::<String>()
    };
    *metrics
        .entry(format!("{method}|{route}|{status}"))
        .or_insert(0) += 1;
}

async fn metrics(State(state): State<AppState>) -> Response {
    let uptime = start_time().elapsed().as_secs();
    let mut lines = vec![
        "# HELP synapseone_faststore_up Synapse Faststore service up.".to_string(),
        "# TYPE synapseone_faststore_up gauge".to_string(),
        "synapseone_faststore_up 1".to_string(),
        "# HELP synapseone_faststore_backend_info Active backend (1 = active).".to_string(),
        "# TYPE synapseone_faststore_backend_info gauge".to_string(),
        format!(
            "synapseone_faststore_backend_info{{backend=\"{}\"}} 1",
            state.store.name()
        ),
        "# HELP synapseone_faststore_process_uptime_seconds Process uptime in seconds."
            .to_string(),
        "# TYPE synapseone_faststore_process_uptime_seconds gauge".to_string(),
        format!("synapseone_faststore_process_uptime_seconds {uptime}"),
        "# HELP synapseone_faststore_http_requests_total HTTP requests by key = method|route|status."
            .to_string(),
        "# TYPE synapseone_faststore_http_requests_total counter".to_string(),
    ];
    if let Ok(metrics) = metrics_map().lock() {
        for (key, value) in metrics.iter() {
            lines.push(format!(
                "synapseone_faststore_http_requests_total{{key=\"{key}\"}} {value}"
            ));
        }
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        format!("{}\n", lines.join("\n")),
    )
        .into_response()
}

async fn stats(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
) -> ApiResult {
    let stats: Stats = state.store.tenant_stats(&tenant).await?;
    let mut by_type = Map::new();
    for kind in ["string", "hash", "list", "set", "zset"] {
        by_type.insert(
            kind.to_string(),
            json!(stats.by_type.get(kind).copied().unwrap_or(0)),
        );
    }
    let short: Vec<&str> = tenant.split(':').take(2).collect();
    ok_json(json!({
        "backend": state.store.name(),
        "tenant": short.join(":"),
        "keys": stats.keys,
        "byType": Value::Object(by_type),
    }))
}

fn is_valid_cursor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 9
        && value.chars().all(|character| character.is_ascii_digit())
}

async fn scan_keys(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let prefix = query.get("prefix").cloned().unwrap_or_default();
    if js_len(&prefix) > 256 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_prefix",
            "prefix must be at most 256 characters",
        ));
    }
    let limit = query_int(&query, "limit", 1, 500, 100)?;
    let cursor = match query.get("cursor") {
        None => None,
        Some(value) => {
            if !is_valid_cursor(value) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_cursor",
                    "cursor must be a non-negative integer",
                ));
            }
            Some(value.clone())
        }
    };
    let result = state
        .store
        .scan_keys(&tenant, &prefix, limit as usize, cursor.as_deref())
        .await?;
    let keys: Vec<Value> = result
        .keys
        .iter()
        .map(|entry| {
            json!({
                "key": entry.key,
                "type": entry.kind,
                "ttlSeconds": entry.ttl_seconds,
            })
        })
        .collect();
    ok_json(json!({
        "keys": keys,
        "cursor": result.cursor,
        "truncated": result.truncated,
    }))
}

// ---------------------------------------------------------------------------
// Handlers: key/value
// ---------------------------------------------------------------------------

async fn get_key(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    match state.store.get_value(&tenant, &key).await? {
        Some(found) => ok_json(json!({
            "key": key,
            "type": found.kind,
            "value": found.value,
            "ttlSeconds": found.ttl_seconds,
        })),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("key '{key}' not found"),
        )),
    }
}

async fn put_key(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    if !body.contains_key("value") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "value is required",
        ));
    }
    let value = body.get("value").cloned().unwrap_or(Value::Null);
    let options = write_options(&body)?;
    let created = state
        .store
        .set_value(&tenant, &key, &value, &options)
        .await?;
    status_json(
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        json!({ "ok": true, "key": key, "created": created }),
    )
}

async fn delete_key(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let deleted = state.store.delete_key(&tenant, &key).await?;
    ok_json(json!({ "key": key, "deleted": deleted }))
}

async fn key_ttl(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    match state.store.ttl_key(&tenant, &key).await? {
        Some(ttl) => ok_json(json!({ "key": key, "ttlSeconds": ttl })),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("key '{key}' not found"),
        )),
    }
}

async fn expire_key(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    if !body.contains_key("ttlSeconds") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_ttl",
            "ttlSeconds is required",
        ));
    }
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?.unwrap_or(0);
    let ok = state.store.expire_key(&tenant, &key, ttl_seconds).await?;
    if !ok {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("key '{key}' not found"),
        ));
    }
    ok_json(json!({ "ok": true, "key": key, "ttlSeconds": ttl_seconds }))
}

async fn incr_key(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let by = int_or_throw(body.get("by"), "by", -1_000_000_000, 1_000_000_000, 1)?;
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let value = state
        .store
        .incr_value(&tenant, &key, by, ttl_seconds)
        .await?;
    ok_json(json!({ "key": key, "value": store::number_json(value) }))
}

// ---------------------------------------------------------------------------
// Handlers: batch
// ---------------------------------------------------------------------------

async fn run_batch_operation(
    store: &Store,
    tenant: &str,
    raw: &Value,
    op_name: &str,
) -> Result<Value, ApiError> {
    let Some(object) = raw.as_object() else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_operation",
            "operation must be an object",
        ));
    };
    let key = clean_key_or_throw(&js_string_or_empty(object.get("key")))?;
    match op_name {
        "set" => {
            if !object.contains_key("value") {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "value is required",
                ));
            }
            let value = object.get("value").cloned().unwrap_or(Value::Null);
            let created = store
                .set_value(tenant, &key, &value, &write_options(object)?)
                .await?;
            Ok(json!({ "ok": true, "op": "set", "key": key, "created": created }))
        }
        "get" => match store.get_value(tenant, &key).await? {
            Some(found) => Ok(json!({
                "ok": true,
                "op": "get",
                "key": key,
                "found": true,
                "type": found.kind,
                "value": found.value,
                "ttlSeconds": found.ttl_seconds,
            })),
            None => Ok(json!({ "ok": true, "op": "get", "key": key, "found": false })),
        },
        "delete" => {
            let deleted = store.delete_key(tenant, &key).await?;
            Ok(json!({ "ok": true, "op": "delete", "key": key, "deleted": deleted }))
        }
        "incr" => {
            let by = int_or_throw(object.get("by"), "by", -1_000_000_000, 1_000_000_000, 1)?;
            let ttl_seconds = ttl_or_throw(object.get("ttlSeconds"), true)?;
            let value = store.incr_value(tenant, &key, by, ttl_seconds).await?;
            Ok(json!({
                "ok": true,
                "op": "incr",
                "key": key,
                "value": store::number_json(value),
            }))
        }
        "expire" => {
            let ttl_seconds = ttl_or_throw(object.get("ttlSeconds"), true)?.ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_ttl",
                    "ttlSeconds is required",
                )
            })?;
            let expired = store.expire_key(tenant, &key, ttl_seconds).await?;
            Ok(json!({ "ok": true, "op": "expire", "key": key, "expired": expired }))
        }
        _ => Ok(json!({
            "ok": false,
            "op": op_name,
            "key": key,
            "error": "unsupported_op",
        })),
    }
}

async fn batch(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    request: Request,
) -> ApiResult {
    let body = read_body(request).await?;
    let operations = array_or_throw(body.get("operations"), "operations", 1, MAX_BATCH_OPS)?;
    let mut results = Vec::with_capacity(operations.len());
    for raw in operations {
        let op_name = raw
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        match run_batch_operation(&state.store, &tenant, raw, &op_name).await {
            Ok(value) => results.push(value),
            Err(error) => results.push(json!({
                "ok": false,
                "op": op_name,
                "error": error.code,
                "message": error.message,
            })),
        }
    }
    let all_ok = results
        .iter()
        .all(|result| result.get("ok").and_then(Value::as_bool).unwrap_or(false));
    ok_json(json!({ "results": results, "ok": all_ok }))
}

// ---------------------------------------------------------------------------
// Handlers: hashes
// ---------------------------------------------------------------------------

async fn hash_get_all(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    match state.store.h_get_all(&tenant, &key).await? {
        Some(found) => ok_json(json!({
            "key": key,
            "values": Value::Object(found.values),
            "ttlSeconds": found.ttl_seconds,
        })),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("hash '{key}' not found"),
        )),
    }
}

async fn hash_set_fields(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let values = values_object_or_throw(body.get("values"))?;
    let options = write_options(&body)?;
    let created = state
        .store
        .h_set_fields(&tenant, &key, values, &options)
        .await?;
    status_json(
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        json!({ "ok": true, "key": key, "created": created }),
    )
}

async fn hash_delete(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let deleted = state.store.delete_key(&tenant, &key).await?;
    ok_json(json!({ "key": key, "deleted": deleted }))
}

async fn hash_len(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let length = state.store.h_len(&tenant, &key).await?;
    ok_json(json!({ "key": key, "length": length }))
}

async fn hash_get_field(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((key, field)): Path<(String, String)>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let field = clean_field_or_throw(&field)?;
    let found: FieldValue = state.store.h_get_field(&tenant, &key, &field).await?;
    if !found.found {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("field '{field}' not found"),
        ));
    }
    ok_json(json!({
        "key": key,
        "field": field,
        "value": found.value,
        "ttlSeconds": found.ttl_seconds,
    }))
}

async fn hash_put_field(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((key, field)): Path<(String, String)>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let field = clean_field_or_throw(&field)?;
    let body = read_body(request).await?;
    if !body.contains_key("value") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "value is required",
        ));
    }
    let mut values = Map::new();
    values.insert(
        field.clone(),
        body.get("value").cloned().unwrap_or(Value::Null),
    );
    let options = WriteOptions {
        ttl_seconds: ttl_or_throw(body.get("ttlSeconds"), true)?,
        if_not_exists: false,
        if_exists: false,
    };
    let created = state
        .store
        .h_set_fields(&tenant, &key, &values, &options)
        .await?;
    status_json(
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        json!({ "ok": true, "key": key, "field": field }),
    )
}

async fn hash_delete_field(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((key, field)): Path<(String, String)>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let field = clean_field_or_throw(&field)?;
    let deleted = state.store.h_del_field(&tenant, &key, &field).await?;
    ok_json(json!({ "key": key, "field": field, "deleted": deleted }))
}

async fn hash_incr_field(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let field = clean_field_or_throw(&js_string_or_empty(body.get("field")))?;
    let by = int_or_throw(body.get("by"), "by", -1_000_000_000, 1_000_000_000, 1)?;
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let value = state
        .store
        .h_incr_field(&tenant, &key, &field, by, ttl_seconds)
        .await?;
    ok_json(json!({
        "key": key,
        "field": field,
        "value": store::number_json(value),
    }))
}

// ---------------------------------------------------------------------------
// Handlers: lists
// ---------------------------------------------------------------------------

async fn list_range(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let start = query_int(&query, "start", -1_000_000, 1_000_000, 0)?;
    let stop = query_int(&query, "stop", -1_000_000, 1_000_000, -1)?;
    let values = state.store.l_range(&tenant, &key, start, stop).await?;
    let length = state.store.l_len(&tenant, &key).await?;
    ok_json(json!({ "key": key, "values": values, "length": length }))
}

async fn list_delete(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let deleted = state.store.delete_key(&tenant, &key).await?;
    ok_json(json!({ "key": key, "deleted": deleted }))
}

async fn list_push(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let values = array_or_throw(body.get("values"), "values", 1, 1000)?;
    let side = match body.get("side") {
        None => "right".to_string(),
        Some(value) => js_string(value),
    };
    if side != "left" && side != "right" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "side must be 'left' or 'right'",
        ));
    }
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let length = state
        .store
        .l_push(&tenant, &key, values, &side, ttl_seconds)
        .await?;
    ok_json(json!({ "ok": true, "key": key, "side": side, "length": length }))
}

async fn list_pop(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let side = match body.get("side") {
        None => "left".to_string(),
        Some(value) => js_string(value),
    };
    if side != "left" && side != "right" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "side must be 'left' or 'right'",
        ));
    }
    let count = int_or_throw(body.get("count"), "count", 1, 1000, 1)?;
    let values = state
        .store
        .l_pop(&tenant, &key, &side, count as usize)
        .await?;
    let length = state.store.l_len(&tenant, &key).await?;
    ok_json(json!({ "key": key, "side": side, "values": values, "length": length }))
}

async fn list_trim(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let start = int_or_throw(body.get("start"), "start", -1_000_000, 1_000_000, 0)?;
    let stop = int_or_throw(body.get("stop"), "stop", -1_000_000, 1_000_000, -1)?;
    let ok = state.store.l_trim(&tenant, &key, start, stop).await?;
    ok_json(json!({ "ok": ok, "key": key, "start": start, "stop": stop }))
}

async fn list_len(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let length = state.store.l_len(&tenant, &key).await?;
    ok_json(json!({ "key": key, "length": length }))
}

// ---------------------------------------------------------------------------
// Handlers: sets
// ---------------------------------------------------------------------------

async fn set_members(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let members = state.store.s_members(&tenant, &key).await?;
    let card = members.len();
    ok_json(json!({ "key": key, "members": members, "card": card }))
}

async fn set_delete(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let deleted = state.store.delete_key(&tenant, &key).await?;
    ok_json(json!({ "key": key, "deleted": deleted }))
}

async fn set_add(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let members = array_or_throw(body.get("members"), "members", 1, 1000)?;
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let added = state
        .store
        .s_add(&tenant, &key, members, ttl_seconds)
        .await?;
    let card = state.store.s_card(&tenant, &key).await?;
    ok_json(json!({ "ok": true, "key": key, "added": added, "card": card }))
}

async fn set_remove(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let members = array_or_throw(body.get("members"), "members", 1, 1000)?;
    let removed = state.store.s_rem(&tenant, &key, members).await?;
    let card = state.store.s_card(&tenant, &key).await?;
    ok_json(json!({ "key": key, "removed": removed, "card": card }))
}

async fn set_contains(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    if !body.contains_key("member") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "member is required",
        ));
    }
    let member = body.get("member").cloned().unwrap_or(Value::Null);
    let contains = state.store.s_is_member(&tenant, &key, &member).await?;
    ok_json(json!({ "key": key, "member": member, "contains": contains }))
}

async fn set_card(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let card = state.store.s_card(&tenant, &key).await?;
    ok_json(json!({ "key": key, "card": card }))
}

// ---------------------------------------------------------------------------
// Handlers: sorted sets
// ---------------------------------------------------------------------------

async fn zset_range(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let start = query_int(&query, "start", -1_000_000, 1_000_000, 0)?;
    let stop = query_int(&query, "stop", -1_000_000, 1_000_000, -1)?;
    let with_scores = js_bool(
        query
            .get("withScores")
            .map(|value| Value::String(value.clone()))
            .as_ref(),
    );
    let rev = js_bool(
        query
            .get("rev")
            .map(|value| Value::String(value.clone()))
            .as_ref(),
    );
    let members = state.store.z_range(&tenant, &key, start, stop, rev).await?;
    let members: Vec<Value> = if with_scores {
        members
            .iter()
            .map(|member| {
                json!({ "member": member.member, "score": store::number_json(member.score) })
            })
            .collect()
    } else {
        members.iter().map(|member| member.member.clone()).collect()
    };
    let card = state.store.z_card(&tenant, &key).await?;
    ok_json(json!({ "key": key, "members": members, "card": card }))
}

async fn zset_delete(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let deleted = state.store.delete_key(&tenant, &key).await?;
    ok_json(json!({ "key": key, "deleted": deleted }))
}

fn parse_zset_members(items: &[Value]) -> Result<Vec<ZMember>, ApiError> {
    let mut members = Vec::with_capacity(items.len());
    for item in items {
        let Some(object) = item.as_object() else {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "each member must be {member, score}",
            ));
        };
        if !object.contains_key("member") {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "each member must be {member, score}",
            ));
        }
        let score = object
            .get("score")
            .and_then(js_number)
            .filter(|score| score.is_finite())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "score must be a finite number",
                )
            })?;
        members.push(ZMember {
            member: object.get("member").cloned().unwrap_or(Value::Null),
            score,
        });
    }
    Ok(members)
}

async fn zset_add(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let raw = array_or_throw(body.get("members"), "members", 1, 1000)?;
    let members = parse_zset_members(raw)?;
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let added = state
        .store
        .z_add(&tenant, &key, &members, ttl_seconds)
        .await?;
    let card = state.store.z_card(&tenant, &key).await?;
    ok_json(json!({ "ok": true, "key": key, "added": added, "card": card }))
}

async fn zset_incr(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    if !body.contains_key("member") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "member is required",
        ));
    }
    let member = body.get("member").cloned().unwrap_or(Value::Null);
    let by = match body.get("by") {
        None => 1.0,
        Some(value) => match js_number(value) {
            Some(number) if number.is_finite() => number,
            _ => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "by must be a finite number",
                ))
            }
        },
    };
    let ttl_seconds = ttl_or_throw(body.get("ttlSeconds"), true)?;
    let score = state
        .store
        .z_incr_by(&tenant, &key, &member, by, ttl_seconds)
        .await?;
    ok_json(json!({
        "key": key,
        "member": member,
        "score": store::number_json(score),
    }))
}

async fn zset_remove(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let members = array_or_throw(body.get("members"), "members", 1, 1000)?;
    let removed = state.store.z_rem(&tenant, &key, members).await?;
    let card = state.store.z_card(&tenant, &key).await?;
    ok_json(json!({ "key": key, "removed": removed, "card": card }))
}

fn required_member(body: &Map<String, Value>) -> Result<Value, ApiError> {
    if !body.contains_key("member") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "member is required",
        ));
    }
    Ok(body.get("member").cloned().unwrap_or(Value::Null))
}

async fn zset_score(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let member = required_member(&body)?;
    let score = state.store.z_score(&tenant, &key, &member).await?;
    ok_json(json!({
        "key": key,
        "member": member,
        "score": score.map(store::number_json),
    }))
}

async fn zset_rank(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    request: Request,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let body = read_body(request).await?;
    let member = required_member(&body)?;
    let rev = js_bool(body.get("rev"));
    let rank = state.store.z_rank(&tenant, &key, &member, rev).await?;
    ok_json(json!({ "key": key, "member": member, "rank": rank }))
}

async fn zset_card(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> ApiResult {
    let key = clean_key_or_throw(&key)?;
    let card = state.store.z_card(&tenant, &key).await?;
    ok_json(json!({ "key": key, "card": card }))
}

// ---------------------------------------------------------------------------
// Handlers: distributed locks
// ---------------------------------------------------------------------------

fn new_lock_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn lock_token_or_throw(token: &str) -> Result<(), ApiError> {
    if token.is_empty() || js_len(token) > 256 || token.contains('\r') || token.contains('\n') {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_token",
            "token must be 1..256 characters",
        ));
    }
    Ok(())
}

async fn lock_acquire(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(name): Path<String>,
    request: Request,
) -> ApiResult {
    let name = clean_lock_name_or_throw(&name)?;
    let body = read_body(request).await?;
    let ttl_value = body
        .get("ttlSeconds")
        .cloned()
        .unwrap_or(Value::Number(30.into()));
    let ttl_seconds = ttl_or_throw(Some(&ttl_value), false)?.unwrap_or(30);
    let wait_ms = int_or_throw(body.get("waitMs"), "waitMs", 0, 10_000, 0)?;
    let token = match body.get("token") {
        None => new_lock_token(),
        Some(value) => js_string(value),
    };
    lock_token_or_throw(&token)?;
    let deadline = Instant::now() + Duration::from_millis(wait_ms as u64);
    let mut acquired = state
        .store
        .acquire_lock(&tenant, &name, &token, ttl_seconds * 1000)
        .await?;
    while !acquired && Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let sleep_ms = remaining.as_millis().clamp(1, 50) as u64;
        tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
        acquired = state
            .store
            .acquire_lock(&tenant, &name, &token, ttl_seconds * 1000)
            .await?;
    }
    if !acquired {
        return ok_json(json!({
            "acquired": false,
            "lock": name,
            "retryAfterMs": 50,
            "ttlSeconds": ttl_seconds,
        }));
    }
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_seconds);
    ok_json(json!({
        "acquired": true,
        "lock": name,
        "token": token,
        "ttlSeconds": ttl_seconds,
        "expiresAt": expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

fn required_token(body: &Map<String, Value>) -> Result<String, ApiError> {
    let token = js_string_or_empty(body.get("token"));
    if token.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_token",
            "token is required",
        ));
    }
    Ok(token)
}

async fn lock_release(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(name): Path<String>,
    request: Request,
) -> ApiResult {
    let name = clean_lock_name_or_throw(&name)?;
    let body = read_body(request).await?;
    let token = required_token(&body)?;
    let released = state.store.release_lock(&tenant, &name, &token).await?;
    ok_json(json!({ "lock": name, "released": released }))
}

async fn lock_extend(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(name): Path<String>,
    request: Request,
) -> ApiResult {
    let name = clean_lock_name_or_throw(&name)?;
    let body = read_body(request).await?;
    let token = required_token(&body)?;
    let ttl_value = body
        .get("ttlSeconds")
        .cloned()
        .unwrap_or(Value::Number(30.into()));
    let ttl_seconds = ttl_or_throw(Some(&ttl_value), false)?.unwrap_or(30);
    let extended = state
        .store
        .extend_lock(&tenant, &name, &token, ttl_seconds * 1000)
        .await?;
    ok_json(json!({ "lock": name, "extended": extended }))
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

fn sanitize_request_id(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '~' | '-')
        })
        .take(128)
        .collect()
}

fn generate_request_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", to_base36(millis), &random[..8])
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_else(|_| "0".to_string())
}

/// Request id + security headers, applied to every response (like the Express
/// middleware stack in index.ts).
async fn request_context(mut request: Request, next: Next) -> Response {
    let incoming = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let sanitized = sanitize_request_id(incoming);
    let request_id = if sanitized.is_empty() {
        generate_request_id()
    } else {
        sanitized
    };
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        request.headers_mut().insert("x-request-id", value);
    }

    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let started = Instant::now();
    let mut response = next.run(request).await;
    let status = response.status();

    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        headers.insert("x-request-id", value);
    }
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
    if std::env::var("HSTS_ENABLED").as_deref() == Ok("true") {
        headers.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }

    tracing::info!(
        "{method} {path} {} {}ms rid={request_id}",
        status.as_u16(),
        started.elapsed().as_millis()
    );
    response
}

async fn metrics_middleware(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let matched = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| audit::express_route(matched.as_str()));
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    let route = matched.unwrap_or_else(|| {
        let segments: Vec<&str> = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .take(3)
            .collect();
        format!("/{}", segments.join("/"))
    });
    record_metric(&method, &route, response.status().as_u16());
    response
}

async fn audit_middleware(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| audit::express_route(matched.as_str()))
        .unwrap_or_else(|| path.clone());
    let mutating = audit::MUTATING_METHODS.contains(&method.as_str())
        && path.starts_with("/v1/")
        && !audit::is_read_only_post(&method, &route);
    if !mutating || !audit::audit_enabled() {
        return next.run(request).await;
    }
    let headers = request.headers().clone();
    let params = audit::sanitized_params(&route, &path);
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let result = if status < 400 {
        "allowed"
    } else if status < 500 {
        "denied"
    } else {
        "error"
    };
    let (actor_type, actor_id, org_id, account_id) = audit::audit_actor(&headers);
    let request_id = header(&headers, "x-request-id");
    let action = audit::mutation_action("faststore", &method, &route, &path);
    audit::record(audit::AuditEvent {
        actor_type,
        actor_id,
        org_id,
        account_id,
        action,
        resource: bounded(&format!("faststore:{route}"), 512),
        result: result.to_string(),
        status_code: status,
        request_id: bounded(&request_id, 128),
        context: json!({
            "service": "faststore",
            "method": method,
            "route": bounded(&route, 256),
            "params": Value::Object(params),
            "result": result,
        }),
    });
    response
}

fn bounded(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(max)
        .collect()
}

async fn gate(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1/") {
        return next.run(request).await;
    }
    if state.config.internal_secret.is_empty() {
        if state.config.is_prod {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "misconfigured",
                "internal secret required in production",
            );
        }
    } else if !verify_internal(request.headers(), &state.config.internal_secret) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Missing or invalid internal credential",
        );
    }

    let caller = resolve_caller(request.headers());
    let tenant = match caller {
        Caller::Anon => {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "auth_required",
                "Synapse Faststore requires an authenticated caller",
            )
        }
        Caller::Principal(principal) => {
            if let Some(org) = principal.org {
                format!("org:{org}")
            } else if let Some(account) = principal.account {
                format!("account:{account}")
            } else {
                format!("user:{}", principal.sub)
            }
        }
        Caller::Platform => {
            let header_tenant = header(request.headers(), "x-synapseone-tenant");
            let explicit = if header_tenant.is_empty() {
                query_param(request.uri().query(), "tenant").unwrap_or_default()
            } else {
                header_tenant
            };
            match clean_tenant(&explicit) {
                Some(tenant) => format!("tenant:{tenant}"),
                None => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        "tenant_required",
                        "platform callers must pass x-synapseone-tenant or ?tenant=",
                    )
                }
            }
        }
    };
    request.extensions_mut().insert(Tenant(tenant));
    next.run(request).await
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found", "route not found")
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

fn build_cors(config: &Config) -> CorsLayer {
    if config.cors_origins.is_empty() {
        if config.is_prod {
            // Production without an allow-list stays closed (no CORS headers).
            CorsLayer::new()
        } else {
            tracing::warn!(
                "[faststore][security] CORS_ORIGIN not set — allowing all origins (dev default)."
            );
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

fn build_app(state: AppState) -> Router {
    let cors = build_cors(&state.config);
    let api = Router::new()
        .route("/v1/faststore/stats", get(stats))
        .route("/v1/faststore/keys", get(scan_keys))
        .route(
            "/v1/faststore/keys/{key}",
            get(get_key).put(put_key).post(put_key).delete(delete_key),
        )
        .route("/v1/faststore/keys/{key}/ttl", get(key_ttl))
        .route("/v1/faststore/keys/{key}/expire", post(expire_key))
        .route("/v1/faststore/keys/{key}/incr", post(incr_key))
        .route("/v1/faststore/batch", post(batch))
        .route(
            "/v1/faststore/hashes/{key}",
            get(hash_get_all).put(hash_set_fields).delete(hash_delete),
        )
        .route("/v1/faststore/hashes/{key}/length", get(hash_len))
        .route("/v1/faststore/hashes/{key}/incr", post(hash_incr_field))
        .route(
            "/v1/faststore/hashes/{key}/{field}",
            get(hash_get_field)
                .put(hash_put_field)
                .delete(hash_delete_field),
        )
        .route(
            "/v1/faststore/lists/{key}",
            get(list_range).delete(list_delete),
        )
        .route("/v1/faststore/lists/{key}/push", post(list_push))
        .route("/v1/faststore/lists/{key}/pop", post(list_pop))
        .route("/v1/faststore/lists/{key}/trim", post(list_trim))
        .route("/v1/faststore/lists/{key}/length", get(list_len))
        .route(
            "/v1/faststore/sets/{key}",
            get(set_members).delete(set_delete),
        )
        .route("/v1/faststore/sets/{key}/add", post(set_add))
        .route("/v1/faststore/sets/{key}/remove", post(set_remove))
        .route("/v1/faststore/sets/{key}/contains", post(set_contains))
        .route("/v1/faststore/sets/{key}/card", get(set_card))
        .route(
            "/v1/faststore/zsets/{key}",
            get(zset_range).delete(zset_delete),
        )
        .route("/v1/faststore/zsets/{key}/add", post(zset_add))
        .route("/v1/faststore/zsets/{key}/incr", post(zset_incr))
        .route("/v1/faststore/zsets/{key}/remove", post(zset_remove))
        .route("/v1/faststore/zsets/{key}/score", post(zset_score))
        .route("/v1/faststore/zsets/{key}/rank", post(zset_rank))
        .route("/v1/faststore/zsets/{key}/card", get(zset_card))
        .route("/v1/faststore/locks/{name}/acquire", post(lock_acquire))
        .route("/v1/faststore/locks/{name}/release", post(lock_release))
        .route("/v1/faststore/locks/{name}/extend", post(lock_extend));

    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .merge(api)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), gate))
        .layer(middleware::from_fn(audit_middleware))
        .layer(middleware::from_fn(metrics_middleware))
        .layer(cors)
        .layer(middleware::from_fn(request_context))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Process entrypoint
// ---------------------------------------------------------------------------

async fn check_health(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buffer = String::new();
    if stream.read_to_string(&mut buffer).is_err() {
        return false;
    }
    buffer.starts_with("HTTP/1.1 200") || buffer.starts_with("HTTP/1.0 200")
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = config_from_env();
    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if check_health(config.port).await {
            0
        } else {
            1
        });
    }
    let redis_url = redis_url_from_env();
    if let Err(error) = validate_production_config(
        config.is_prod,
        &config.internal_secret,
        redis_url.as_deref(),
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[faststore][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let store = match redis_url.as_deref() {
        Some(url) => match Store::connect(Some(url)).await {
            Ok(store) => {
                tracing::info!("[faststore] connected to Valkey");
                store
            }
            Err(error) => {
                if config.is_prod {
                    eprintln!("[faststore] Redis is required in production: {error}");
                    std::process::exit(1);
                }
                tracing::warn!("[faststore] Valkey unavailable, using in-memory fallback: {error}");
                Store::Memory(MemoryStore::new())
            }
        },
        None => {
            tracing::warn!(
                "[faststore] No Valkey/Redis URL provided, using in-memory fallback (dev default)"
            );
            Store::Memory(MemoryStore::new())
        }
    };

    let state = AppState {
        store,
        config: config.clone(),
    };
    let backend_name = state.store.name();
    let app = build_app(state);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[faststore] Synapse Faststore listening on :{} (backend={backend_name})",
        config.port
    );

    let audit_task = tokio::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            audit::flush_now().await;
        }
    });

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    audit_task.abort();
    result?;
    Ok(())
}

#[cfg(test)]
mod config_tests {
    use super::*;

    #[test]
    fn production_requires_secret_and_valkey() {
        assert!(validate_production_config(false, "", None).is_ok());
        assert!(validate_production_config(true, "", Some("redis://localhost")).is_err());
        assert!(validate_production_config(true, "secret", None).is_err());
        assert!(validate_production_config(true, "secret", Some("redis://localhost")).is_ok());
    }

    #[test]
    fn request_ids_are_sanitized() {
        assert_eq!(sanitize_request_id("abc-123_X.Y~"), "abc-123_X.Y~");
        assert_eq!(sanitize_request_id("bad id<script>"), "badidscript");
        assert_eq!(sanitize_request_id("x".repeat(200).as_str()).len(), 128);
    }

    #[test]
    fn constant_time_comparison_is_length_checked() {
        assert!(constant_time_eq(b"top-secret", b"top-secret"));
        assert!(!constant_time_eq(b"top-secret", b"top-secreu"));
        assert!(!constant_time_eq(b"top-secret", b"top-secret-longer"));
        assert!(!constant_time_eq(b"", b"x"));
    }

    #[test]
    fn base36_matches_the_typescript_request_id_shape() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
    }
}
