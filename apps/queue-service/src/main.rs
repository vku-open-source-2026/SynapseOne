// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseQueue — tenant-scoped message queue with delayed and deduplicated
//! publishing, visibility-timeout consumption, receipts, ack/nack/heartbeat,
//! retries, dead-letter queues, replay and long-poll consumption.
//!
//! Valkey (Redis-protocol) is the production backend; an in-memory fallback
//! keeps local development and tests dependency-free. Auth matches the
//! platform: gateway-stamped `x-synapseone-*` headers plus
//! `SYNAPSEONE_INTERNAL_SECRET`.

mod audit;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use store::{
    now_ms, InternalMessage, NackResult, PublishInput, QueueConfig, QueueError, QueueOptions,
    QueueStats, Store, MAX_SIGNAL_WAIT_MS,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_HEADERS_BYTES: usize = 8192;
const MAX_DELAY_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_VISIBILITY_SECONDS: i64 = 3600;
const MAX_MESSAGES_PER_CONSUME: i64 = 100;
// Long-poll cap: the HTTP edge (gateway) times out at 30s, so a blocked
// consume must always answer before that.
const MAX_WAIT_SECONDS: i64 = {
    let seconds = MAX_SIGNAL_WAIT_MS / 1000;
    if seconds < 1 {
        1
    } else if seconds > 20 {
        20
    } else {
        seconds as i64
    }
};
const MAX_BATCH: i64 = 100;
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Config {
    port: u16,
    is_prod: bool,
    internal_secret: String,
    cors_origins: Vec<String>,
    max_payload_bytes: usize,
    hsts_enabled: bool,
}

fn env_compat(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    let rest = name.strip_prefix("SYNAPSEONE_")?;
    std::env::var(format!("SYNAPSEDX_{rest}"))
        .ok()
        .filter(|value| !value.is_empty())
}

fn config_from_env() -> Config {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(4007);
    let max_payload_bytes = std::env::var("QUEUE_MAX_PAYLOAD_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(262_144)
        .clamp(1024, 1024 * 1024) as usize;
    Config {
        port,
        is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
        internal_secret: env_compat("SYNAPSEONE_INTERNAL_SECRET").unwrap_or_default(),
        cors_origins: std::env::var("CORS_ORIGIN")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        max_payload_bytes,
        hsts_enabled: std::env::var("HSTS_ENABLED").as_deref() == Ok("true"),
    }
}

fn assert_production_config(config: &Config, redis_url: Option<&str>) -> Result<(), String> {
    if !config.is_prod {
        return Ok(());
    }
    if config.internal_secret.is_empty() {
        return Err("[queue] SYNAPSEONE_INTERNAL_SECRET must be set in production".into());
    }
    if redis_url.is_none() {
        return Err(
            "[queue] QUEUE_VALKEY_URL/VALKEY_URL (or legacy QUEUE_REDIS_URL/REDIS_URL) must be set in production (in-memory fallback would split-brain)"
                .into(),
        );
    }
    Ok(())
}

async fn build_store(config: &Config) -> Result<Store, String> {
    let Some(url) = store::redis_url() else {
        if config.is_prod {
            return Err(
                "[queue] QUEUE_VALKEY_URL/VALKEY_URL (or legacy QUEUE_REDIS_URL/REDIS_URL) is required in production"
                    .into(),
            );
        }
        tracing::warn!("[queue] No Valkey/Redis URL provided, using the in-memory backend");
        return Ok(Store::memory());
    };
    let failure = match tokio::time::timeout(
        Duration::from_secs(2),
        store::RedisStore::connect(&url),
    )
    .await
    {
        Ok(Ok(store)) => {
            tracing::info!("[queue] connected to Valkey");
            return Ok(Store::Redis(Box::new(store)));
        }
        Ok(Err(error)) => error,
        Err(_) => "connection timed out".to_string(),
    };
    if config.is_prod {
        return Err(format!(
            "[queue] Failed to connect to Valkey in production (fail-closed): {failure}"
        ));
    }
    tracing::warn!("[queue] Valkey unavailable, using the in-memory backend: {failure}");
    Ok(Store::memory())
}

// ---------------------------------------------------------------------------
// State and principals
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    store: Store,
    config: Config,
    metrics: Arc<Mutex<HashMap<String, u64>>>,
    started: Instant,
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

fn clean_header_value(value: String) -> Option<String> {
    (!value.is_empty() && value.chars().count() <= 128).then_some(value)
}

fn principal_from_headers(headers: &HeaderMap) -> Option<Principal> {
    let user = header(headers, "x-synapseone-user");
    if !user.is_empty() {
        if user.chars().count() > 128 {
            return None;
        }
        return Some(Principal {
            sub: user,
            org: clean_header_value(header(headers, "x-synapseone-org")),
            account: clean_header_value(header(headers, "x-synapseone-account")),
        });
    }
    // API keys are machine identities: the gateway stamps kind=apikey +
    // account but no user. Any tenant marker means "authenticated principal",
    // never internal/platform; synthesize a non-user subject so scoping
    // applies.
    let kind = clean_header_value(header(headers, "x-synapseone-kind"));
    let account = clean_header_value(header(headers, "x-synapseone-account"));
    let org = clean_header_value(header(headers, "x-synapseone-org"));
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
    let anon = header(headers, "x-synapseone-anon") == "1";
    if anon {
        Caller::Anon
    } else {
        Caller::Platform
    }
}

fn clean_tenant(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 || has_control(value) {
        return None;
    }
    Some(format!("tenant:{value}"))
}

fn tenant_for(headers: &HeaderMap, caller: &Caller, query: &str) -> Option<String> {
    match caller {
        Caller::Principal(principal) => {
            if let Some(org) = &principal.org {
                return Some(format!("org:{org}"));
            }
            if let Some(account) = &principal.account {
                return Some(format!("account:{account}"));
            }
            Some(format!("user:{}", principal.sub))
        }
        Caller::Platform => {
            let mut raw = header(headers, "x-synapseone-tenant");
            if raw.is_empty() {
                raw = url::form_urlencoded::parse(query.as_bytes())
                    .find(|(key, _)| key == "tenant")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default();
            }
            clean_tenant(&raw)
        }
        Caller::Anon => None,
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
    value
        .as_bytes()
        .iter()
        .zip(secret.as_bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct AppError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl AppError {
    fn request(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl From<QueueError> for AppError {
    fn from(error: QueueError) -> Self {
        let status = match error.code {
            "not_found" => StatusCode::NOT_FOUND,
            "conflict" => StatusCode::CONFLICT,
            "storage_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
            "internal" => {
                tracing::error!("[queue] backend error: {}", error.message);
                return AppError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "internal",
                    message: "unexpected error".into(),
                };
            }
            _ => StatusCode::BAD_REQUEST,
        };
        Self {
            status,
            code: error.code,
            message: error.message,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        json_error(self.status, self.code, Some(self.message))
    }
}

fn json_error(status: StatusCode, code: &str, message: Option<String>) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String(code.into()));
    if let Some(message) = message {
        body.insert("message".into(), Value::String(message));
    }
    (status, Json(Value::Object(body))).into_response()
}

fn queue_not_found(name: &str) -> AppError {
    AppError::request(
        StatusCode::NOT_FOUND,
        "not_found",
        format!("queue '{name}' not found"),
    )
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

fn has_control(value: &str) -> bool {
    value
        .chars()
        .any(|c| c == '\r' || c == '\n' || (c as u32) < 0x20 || c as u32 == 0x7f)
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn clean_queue(value: &str) -> Result<String, AppError> {
    let mut chars = value.chars();
    let valid_length = (1..=64).contains(&value.chars().count());
    let valid_first = chars
        .next()
        .map(|c| c.is_ascii_alphabetic())
        .unwrap_or(false);
    let valid_rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid_length || !valid_first || !valid_rest {
        return Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_queue",
            "queue must match [A-Za-z][A-Za-z0-9_-]{0,63}",
        ));
    }
    Ok(value.to_string())
}

fn clean_message_id(value: &str) -> Result<String, AppError> {
    let valid = (1..=128).contains(&value.chars().count())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '.' | ':' | '+' | '-'));
    if !valid {
        return Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_message_id",
            "message id must be 1..128 characters from [A-Za-z0-9_@.:+-]",
        ));
    }
    Ok(value.to_string())
}

fn clean_receipt(value: &str) -> Result<String, AppError> {
    if value.is_empty() || value.chars().count() > 512 || has_control(value) {
        return Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_receipt",
            "receipt must be 1..512 printable characters",
        ));
    }
    Ok(value.to_string())
}

fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok()
            }
        }
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number(&items[0]),
            _ => None,
        },
        _ => None,
    }
}

fn int_or_throw(
    value: Option<&Value>,
    name: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, AppError> {
    let Some(value) = value else {
        return Ok(default);
    };
    match value {
        Value::Null => return Ok(default),
        Value::String(text) if text.is_empty() => return Ok(default),
        _ => {}
    }
    let invalid = || {
        AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            format!("{name} must be an integer {min}..{max}"),
        )
    };
    let number = js_number(value).ok_or_else(invalid)?;
    if !number.is_finite() || number.fract() != 0.0 || number < min as f64 || number > max as f64 {
        return Err(invalid());
    }
    Ok(number as i64)
}

fn query_int(
    query: &HashMap<String, String>,
    name: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, AppError> {
    match query.get(name) {
        None => Ok(default),
        Some(value) => int_or_throw(Some(&Value::String(value.clone())), name, min, max, default),
    }
}

fn bool_flag(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::String(text) => text == "true" || text == "1",
        Value::Number(number) => number.as_f64() == Some(1.0),
        _ => false,
    }
}

fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// JS `String(v ?? '')`: null and undefined become the empty string.
fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    }
}

fn parse_body(bytes: &Bytes) -> Result<Map<String, Value>, AppError> {
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| {
        AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "Request body is not valid JSON",
        )
    })?;
    match value {
        Value::Object(map) => Ok(map),
        Value::Array(_) => Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "request body must be a JSON object",
        )),
        // Express' strict JSON parser only accepts objects and arrays.
        _ => Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            "Request body is not valid JSON",
        )),
    }
}

fn array_or_throw(
    value: Option<&Value>,
    name: &str,
    min: i64,
    max: i64,
) -> Result<Vec<Value>, AppError> {
    match value {
        Some(Value::Array(items)) if (min as usize..=max as usize).contains(&items.len()) => {
            Ok(items.clone())
        }
        _ => Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            format!("{name} must be an array with {min}..{max} items"),
        )),
    }
}

fn headers_or_throw(value: Option<&Value>) -> Result<Option<Value>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::Null => Ok(None),
        Value::Object(map) => {
            if map.len() > 50 {
                return Err(AppError::request(
                    StatusCode::BAD_REQUEST,
                    "invalid_headers",
                    "headers supports at most 50 entries",
                ));
            }
            for key in map.keys() {
                if key.is_empty() || key.chars().count() > 64 || has_control(key) {
                    return Err(AppError::request(
                        StatusCode::BAD_REQUEST,
                        "invalid_headers",
                        "header names must be 1..64 printable characters",
                    ));
                }
            }
            let bytes = serde_json::to_vec(value).map_err(|_| {
                AppError::request(
                    StatusCode::BAD_REQUEST,
                    "invalid_headers",
                    "headers must be an object",
                )
            })?;
            if bytes.len() > MAX_HEADERS_BYTES {
                return Err(AppError::request(
                    StatusCode::BAD_REQUEST,
                    "invalid_headers",
                    format!("headers exceed {MAX_HEADERS_BYTES} bytes"),
                ));
            }
            Ok(Some(value.clone()))
        }
        _ => Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_headers",
            "headers must be an object",
        )),
    }
}

fn delay_or_throw(value: Option<&Value>) -> Result<i64, AppError> {
    int_or_throw(value, "delaySeconds", 0, MAX_DELAY_SECONDS, 0)
}

fn visibility_or_throw(value: Option<&Value>, default: i64) -> Result<i64, AppError> {
    int_or_throw(
        value,
        "visibilityTimeoutSeconds",
        1,
        MAX_VISIBILITY_SECONDS,
        default,
    )
}

fn publish_input_from(
    body: &Map<String, Value>,
    max_payload_bytes: usize,
) -> Result<PublishInput, AppError> {
    let Some(payload) = body.get("payload") else {
        return Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_payload",
            "payload is required",
        ));
    };
    let payload_bytes = serde_json::to_vec(payload).map_err(|_| {
        AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_payload",
            "payload must be JSON-serializable",
        )
    })?;
    if payload_bytes.len() > max_payload_bytes {
        return Err(AppError::request(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            format!("payload exceeds {max_payload_bytes} bytes"),
        ));
    }
    let mut input = PublishInput {
        payload: payload.clone(),
        delay_seconds: delay_or_throw(body.get("delaySeconds"))?,
        ..PublishInput::default()
    };
    if let Some(value) = body.get("maxAttempts") {
        input.max_attempts = Some(int_or_throw(Some(value), "maxAttempts", 1, 100, 5)?);
    }
    if let Some(value) = body.get("headers") {
        input.headers = headers_or_throw(Some(value))?;
    }
    if let Some(value) = body.get("id") {
        input.id = Some(clean_message_id(&js_string_or_empty(Some(value)))?);
    }
    if let Some(value) = body.get("dedupeKey") {
        let key = js_string(Some(value));
        if key.is_empty() || key.chars().count() > 256 || has_control(&key) {
            return Err(AppError::request(
                StatusCode::BAD_REQUEST,
                "invalid_dedupe_key",
                "dedupeKey must be 1..256 printable characters",
            ));
        }
        input.dedupe_key = Some(key);
    }
    Ok(input)
}

// ---------------------------------------------------------------------------
// API serialization
// ---------------------------------------------------------------------------

fn iso(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Utc.timestamp_millis_opt(0).single().expect("epoch"))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn api_config(config: &QueueConfig) -> Value {
    json!({
        "name": config.name.clone(),
        "maxAttempts": config.max_attempts,
        "visibilityTimeoutSeconds": config.visibility_timeout_seconds,
        "createdAt": iso(config.created_at),
        "updatedAt": iso(config.updated_at),
    })
}

fn api_message(message: &InternalMessage) -> Value {
    let mut body = Map::new();
    body.insert("id".into(), Value::String(message.id.clone()));
    body.insert("payload".into(), message.payload.clone());
    if let Some(headers) = &message.headers {
        body.insert("headers".into(), headers.clone());
    }
    body.insert(
        "publishedAt".into(),
        Value::String(iso(message.published_at)),
    );
    if let Some(available_at) = message.available_at {
        body.insert("availableAt".into(), Value::String(iso(available_at)));
    }
    body.insert("attempts".into(), json!(message.attempts));
    body.insert("maxAttempts".into(), json!(message.max_attempts));
    if let Some(dedupe_key) = &message.dedupe_key {
        body.insert("dedupeKey".into(), Value::String(dedupe_key.clone()));
    }
    if let Some(last_error) = &message.last_error {
        body.insert("lastError".into(), Value::String(last_error.clone()));
    }
    body.insert("dead".into(), json!(message.dead));
    if let Some(dead_at) = message.dead_at {
        body.insert("deadAt".into(), Value::String(iso(dead_at)));
    }
    if let Some(consumer) = &message.consumer {
        body.insert("consumer".into(), Value::String(consumer.clone()));
    }
    Value::Object(body)
}

fn api_consumed(consumed: &store::ConsumedMessage) -> Value {
    let mut body = api_message(&consumed.message);
    if let Some(map) = body.as_object_mut() {
        map.insert("receipt".into(), Value::String(consumed.receipt.clone()));
        map.insert(
            "leaseExpiresAt".into(),
            Value::String(iso(consumed.lease_expires_at)),
        );
    }
    body
}

fn api_nack(result: &NackResult) -> Value {
    let mut body = Map::new();
    body.insert("ok".into(), Value::Bool(true));
    body.insert("id".into(), Value::String(result.id.clone()));
    body.insert("state".into(), Value::String(result.state.into()));
    body.insert("attempts".into(), json!(result.attempts));
    if let Some(available_at) = result.available_at {
        body.insert("availableAt".into(), Value::String(iso(available_at)));
    }
    if let Some(dead_at) = result.dead_at {
        body.insert("deadAt".into(), Value::String(iso(dead_at)));
    }
    Value::Object(body)
}

fn stats_value(stats: Option<QueueStats>) -> Value {
    match stats {
        Some(stats) => serde_json::to_value(stats).unwrap_or(Value::Null),
        None => Value::Null,
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

fn sanitize_request_id(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
        .take(128)
        .collect()
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn generate_request_id() -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", base36(now_ms().max(0) as u64), &random[..8])
}

async fn request_id(mut request: Request, next: Next) -> Response {
    let incoming = sanitize_request_id(&header(request.headers(), "x-request-id"));
    let id = if incoming.is_empty() {
        generate_request_id()
    } else {
        incoming
    };
    let value = HeaderValue::from_str(&id).unwrap_or_else(|_| HeaderValue::from_static("unknown"));
    request.headers_mut().insert("x-request-id", value.clone());
    let mut response = next.run(request).await;
    response.headers_mut().insert("x-request-id", value);
    response
}

async fn security_headers(State(state): State<AppState>, request: Request, next: Next) -> Response {
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
    if state.config.hsts_enabled {
        headers.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}

async fn content_length_limit(request: Request, next: Next) -> Response {
    if let Some(length) = request
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if length > MAX_BODY_BYTES {
            return json_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                Some("Request body exceeds the size limit".into()),
            );
        }
    }
    next.run(request).await
}

async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1/") {
        return next.run(request).await;
    }
    let (caller, tenant) = {
        let headers = request.headers();
        if !state.config.internal_secret.is_empty() {
            if !verify_internal(headers, &state.config.internal_secret) {
                return json_error(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    Some("Missing or invalid internal credential".into()),
                );
            }
        } else if state.config.is_prod {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "misconfigured",
                Some("internal secret required in production".into()),
            );
        }
        // Unknown /v1 paths fall through to the JSON 404 fallback without
        // demanding tenant headers (defines routes only enforce tenancy).
        if request.extensions().get::<MatchedPath>().is_none() {
            return next.run(request).await;
        }
        let caller = resolve_caller(headers);
        if matches!(caller, Caller::Anon) {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "auth_required",
                Some("SynapseQueue requires an authenticated caller".into()),
            );
        }
        let query = request.uri().query().unwrap_or("").to_string();
        let Some(tenant) = tenant_for(headers, &caller, &query) else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "tenant_required",
                Some("platform callers must pass x-synapseone-tenant or ?tenant=".into()),
            );
        };
        (caller, tenant)
    };
    request.extensions_mut().insert(Tenant(tenant));
    request.extensions_mut().insert(caller);
    next.run(request).await
}

fn fallback_route(path: &str) -> String {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .take(3)
        .collect::<Vec<_>>();
    format!("/{}", segments.join("/"))
}

fn record_metric(state: &AppState, method: &str, route: &str, status: u16) {
    let mut route = truncate_chars(route, 64);
    let mut metrics = state.metrics.lock().expect("metrics registry");
    if metrics.len() >= 300 {
        route = "**".into();
    }
    let key = format!("{method}|{route}|{status}");
    *metrics.entry(key).or_insert(0) += 1;
}

async fn observability(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let matched = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string());
    let route = matched
        .as_deref()
        .map(audit::express_route)
        .unwrap_or_else(|| fallback_route(&path));
    let mutating = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE")
        && path.starts_with("/v1/")
        && !audit::is_read_only_post(&method, &route);
    let audit_headers = mutating.then(|| request.headers().clone());
    let params = if mutating {
        audit::route_params(&route, &path)
    } else {
        Value::Null
    };
    let request_id = header(request.headers(), "x-request-id");
    let started = Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    record_metric(&state, &method, &route, status);
    tracing::info!(
        method = %method,
        path = %path,
        status,
        elapsed_ms = started.elapsed().as_millis() as u64,
        rid = %request_id,
        "request"
    );
    if let Some(headers) = audit_headers {
        let (actor_type, actor_id, org_id, account_id) = audit::audit_actor(&headers);
        let result = if status < 400 {
            "allowed"
        } else if status < 500 {
            "denied"
        } else {
            "error"
        };
        audit::record(audit::AuditEvent {
            actor_type,
            actor_id,
            org_id,
            account_id,
            action: audit::mutation_action("queue", &method, &route, &path),
            resource: truncate_chars(&format!("queue:{route}"), 512),
            result: result.into(),
            status_code: status,
            request_id,
            context: json!({
                "service": "queue",
                "method": method,
                "route": truncate_chars(&route, 256),
                "params": params,
                "result": result,
            }),
        });
    }
    response
}

// ---------------------------------------------------------------------------
// Health and metrics
// ---------------------------------------------------------------------------

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "service": "queue",
        "version": VERSION,
        "backend": state.store.backend(),
        "time": iso(now_ms()),
    }))
    .into_response()
}

async fn metrics(State(state): State<AppState>) -> Response {
    let mut lines = vec![
        "# HELP synapseone_queue_up SynapseQueue service up.".to_string(),
        "# TYPE synapseone_queue_up gauge".to_string(),
        "synapseone_queue_up 1".to_string(),
        "# HELP synapseone_queue_backend_info Active backend (1 = active).".to_string(),
        "# TYPE synapseone_queue_backend_info gauge".to_string(),
        format!(
            "synapseone_queue_backend_info{{backend=\"{}\"}} 1",
            state.store.backend()
        ),
        "# HELP synapseone_queue_process_uptime_seconds Process uptime in seconds.".to_string(),
        "# TYPE synapseone_queue_process_uptime_seconds gauge".to_string(),
        format!(
            "synapseone_queue_process_uptime_seconds {}",
            state.started.elapsed().as_secs()
        ),
        "# HELP synapseone_queue_http_requests_total HTTP requests by key = method|route|status."
            .to_string(),
        "# TYPE synapseone_queue_http_requests_total counter".to_string(),
    ];
    let mut counters = state
        .metrics
        .lock()
        .expect("metrics registry")
        .iter()
        .map(|(key, value)| (key.clone(), *value))
        .collect::<Vec<_>>();
    counters.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, value) in counters {
        lines.push(format!(
            "synapseone_queue_http_requests_total{{key=\"{key}\"}} {value}"
        ));
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        format!("{}\n", lines.join("\n")),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Queue routes
// ---------------------------------------------------------------------------

async fn list_queues(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
) -> Result<Response, AppError> {
    let queues = state.store.list_queues(&tenant).await?;
    Ok(Json(queues.iter().map(api_config).collect::<Vec<_>>()).into_response())
}

async fn create_or_update_queue(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let mut options = QueueOptions::default();
    if let Some(value) = body.get("maxAttempts") {
        options.max_attempts = Some(int_or_throw(Some(value), "maxAttempts", 1, 100, 5)?);
    }
    if let Some(value) = body.get("visibilityTimeoutSeconds") {
        options.visibility_timeout_seconds = Some(int_or_throw(
            Some(value),
            "visibilityTimeoutSeconds",
            1,
            MAX_VISIBILITY_SECONDS,
            30,
        )?);
    }
    let existed = state.store.get_queue(&tenant, &name).await?.is_some();
    let config = state.store.ensure_queue(&tenant, &name, options).await?;
    let status = if existed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(api_config(&config))).into_response())
}

async fn get_queue_config(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let config = state
        .store
        .get_queue(&tenant, &name)
        .await?
        .ok_or_else(|| queue_not_found(&name))?;
    let stats = state.store.queue_stats(&tenant, &name).await?;
    let mut body = api_config(&config);
    if let Some(map) = body.as_object_mut() {
        map.insert("stats".into(), stats_value(stats));
    }
    Ok(Json(body).into_response())
}

async fn delete_queue(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let deleted = state.store.delete_queue(&tenant, &name).await?;
    Ok(Json(json!({ "queue": name, "deleted": deleted })).into_response())
}

async fn purge_queue(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    if !state.store.purge_queue(&tenant, &name).await? {
        return Err(queue_not_found(&name));
    }
    Ok(Json(json!({ "ok": true, "queue": name, "purged": true })).into_response())
}

async fn queue_stats(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let stats = state
        .store
        .queue_stats(&tenant, &name)
        .await?
        .ok_or_else(|| queue_not_found(&name))?;
    Ok(Json(stats).into_response())
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async fn publish_message(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let input = publish_input_from(&body, state.config.max_payload_bytes)?;
    let result = state.store.publish_message(&tenant, &name, input).await?;
    let status = if result.duplicate {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(json!({
            "ok": true,
            "queue": name,
            "id": result.id,
            "duplicate": result.duplicate,
            "message": api_message(&result.message),
        })),
    )
        .into_response())
}

async fn publish_batch(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let items = array_or_throw(body.get("messages"), "messages", 1, MAX_BATCH)?;
    let mut results = Vec::with_capacity(items.len());
    for raw in items {
        let Some(object) = raw.as_object() else {
            results.push(json!({
                "ok": false,
                "error": "invalid_request",
                "message": "message must be an object",
            }));
            continue;
        };
        match publish_input_from(object, state.config.max_payload_bytes) {
            Ok(input) => match state.store.publish_message(&tenant, &name, input).await {
                Ok(result) => results.push(json!({
                    "ok": true,
                    "id": result.id,
                    "duplicate": result.duplicate,
                    "message": api_message(&result.message),
                })),
                Err(error) => {
                    let error = AppError::from(error);
                    results.push(json!({
                        "ok": false,
                        "error": error.code,
                        "message": error.message,
                    }));
                }
            },
            Err(error) => results.push(json!({
                "ok": false,
                "error": error.code,
                "message": error.message,
            })),
        }
    }
    let ok = results
        .iter()
        .all(|result| result.get("ok").and_then(Value::as_bool).unwrap_or(false));
    Ok(Json(json!({ "queue": name, "results": results, "ok": ok })).into_response())
}

// ---------------------------------------------------------------------------
// Consume, ack, nack, heartbeat
// ---------------------------------------------------------------------------

async fn consume(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Extension(caller): Extension<Caller>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let max_messages = int_or_throw(
        body.get("maxMessages"),
        "maxMessages",
        1,
        MAX_MESSAGES_PER_CONSUME,
        1,
    )?;
    let config = state
        .store
        .ensure_queue(&tenant, &name, QueueOptions::default())
        .await?;
    let visibility = visibility_or_throw(
        body.get("visibilityTimeoutSeconds"),
        config.visibility_timeout_seconds,
    )?;
    let wait_seconds = int_or_throw(
        body.get("waitSeconds"),
        "waitSeconds",
        0,
        MAX_WAIT_SECONDS,
        0,
    )?;
    let consumer = match body.get("consumer") {
        Some(value) => truncate_chars(&js_string(Some(value)), 128),
        None => match &caller {
            Caller::Principal(principal) => principal.sub.clone(),
            _ => "worker".into(),
        },
    };
    if consumer.is_empty() || has_control(&consumer) {
        return Err(AppError::request(
            StatusCode::BAD_REQUEST,
            "invalid_consumer",
            "consumer must be a printable string",
        ));
    }

    let started = now_ms();
    let deadline = started + wait_seconds * 1000;
    let messages: Vec<store::ConsumedMessage> = loop {
        // Arm the wake-up *before* scanning so a publish that lands between the
        // scan and the park is not lost.
        let signal = if deadline > now_ms() {
            state.store.arm_activity_signal(&tenant, &name).await
        } else {
            None
        };
        let scanned = state
            .store
            .consume_messages(&tenant, &name, max_messages, visibility, &consumer)
            .await?;
        if !scanned.is_empty() {
            break scanned;
        }
        let remaining = deadline - now_ms();
        if signal.is_none() || remaining <= 0 {
            break Vec::new();
        }
        let due = state.store.next_activity_at(&tenant, &name).await?;
        let wait_ms = remaining.min(match due {
            None => remaining,
            Some(due) => (due - now_ms()).max(0),
        });
        if wait_ms > 0 {
            if let Some(signal) = signal {
                signal.wait(Duration::from_millis(wait_ms as u64)).await;
            }
        } else {
            // A due timestamp in the past means another consumer won the race
            // (or a lease just expired): re-scan instead of holding.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };

    let waited_ms = now_ms() - started;
    let mut body = Map::new();
    body.insert("queue".into(), Value::String(name));
    body.insert("count".into(), json!(messages.len()));
    body.insert("visibilityTimeoutSeconds".into(), json!(visibility));
    body.insert("waitedMs".into(), json!(waited_ms));
    if wait_seconds > 0 {
        body.insert("waitSeconds".into(), json!(wait_seconds));
    }
    body.insert(
        "messages".into(),
        Value::Array(messages.iter().map(api_consumed).collect()),
    );
    Ok(Json(Value::Object(body)).into_response())
}

async fn ack(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    if let Some(value) = body.get("receipts") {
        let items = array_or_throw(Some(value), "receipts", 1, MAX_BATCH)?;
        let receipts = items
            .iter()
            .map(|item| clean_receipt(&js_string_or_empty(Some(item))))
            .collect::<Result<Vec<_>, _>>()?;
        let mut results = Vec::with_capacity(receipts.len());
        for receipt in receipts {
            match state.store.ack_message(&tenant, &name, &receipt).await? {
                Some(id) => results.push(json!({
                    "ok": true,
                    "receipt": receipt,
                    "id": id,
                })),
                None => results.push(json!({
                    "ok": false,
                    "receipt": receipt,
                    "error": "receipt_not_found",
                })),
            }
        }
        let ok = results
            .iter()
            .all(|result| result.get("ok").and_then(Value::as_bool).unwrap_or(false));
        return Ok(Json(json!({ "queue": name, "results": results, "ok": ok })).into_response());
    }
    let receipt = clean_receipt(&js_string_or_empty(body.get("receipt")))?;
    let Some(id) = state.store.ack_message(&tenant, &name, &receipt).await? else {
        return Err(AppError::request(
            StatusCode::NOT_FOUND,
            "receipt_not_found",
            "receipt is unknown or already acknowledged",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "queue": name,
        "receipt": receipt,
        "id": id,
    }))
    .into_response())
}

async fn nack(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let receipt = clean_receipt(&js_string_or_empty(body.get("receipt")))?;
    let delay_seconds = delay_or_throw(body.get("delaySeconds"))?;
    let error = body
        .get("error")
        .map(|value| truncate_chars(&js_string(Some(value)), 1024));
    let requeue = body.get("requeue").map(bool_flag).unwrap_or(true);
    let Some(result) = state
        .store
        .nack_message(
            &tenant,
            &name,
            &receipt,
            requeue,
            delay_seconds,
            error.as_deref(),
        )
        .await?
    else {
        return Err(AppError::request(
            StatusCode::NOT_FOUND,
            "receipt_not_found",
            "receipt is unknown or already acknowledged",
        ));
    };
    let mut body = api_nack(&result);
    if let Some(map) = body.as_object_mut() {
        map.insert("queue".into(), Value::String(name));
    }
    Ok(Json(body).into_response())
}

async fn heartbeat(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let body = parse_body(&body)?;
    let receipt = clean_receipt(&js_string_or_empty(body.get("receipt")))?;
    let config = state
        .store
        .ensure_queue(&tenant, &name, QueueOptions::default())
        .await?;
    let visibility = visibility_or_throw(
        body.get("visibilityTimeoutSeconds"),
        config.visibility_timeout_seconds,
    )?;
    let Some(deadline) = state
        .store
        .heartbeat_message(&tenant, &name, &receipt, visibility)
        .await?
    else {
        return Err(AppError::request(
            StatusCode::NOT_FOUND,
            "receipt_not_found",
            "receipt is unknown or already acknowledged",
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "queue": name,
        "receipt": receipt,
        "leaseExpiresAt": iso(deadline),
        "visibilityTimeoutSeconds": visibility,
    }))
    .into_response())
}

// ---------------------------------------------------------------------------
// Inspection and dead letters
// ---------------------------------------------------------------------------

async fn peek_messages(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    if state.store.get_queue(&tenant, &name).await?.is_none() {
        return Err(queue_not_found(&name));
    }
    let limit = query_int(&query, "limit", 1, 500, 100)?;
    let mut messages = state.store.peek_messages(&tenant, &name, limit).await?;
    let ready = query
        .get("ready")
        .map(|value| bool_flag(&Value::String(value.clone())))
        .unwrap_or(false);
    if ready {
        let now = now_ms();
        messages.retain(|message| message.available_at.is_some_and(|at| at <= now));
    }
    Ok(Json(json!({
        "queue": name,
        "count": messages.len(),
        "messages": messages.iter().map(api_message).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn dead_messages(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(queue): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    if state.store.get_queue(&tenant, &name).await?.is_none() {
        return Err(queue_not_found(&name));
    }
    let limit = query_int(&query, "limit", 1, 500, 100)?;
    let messages = state.store.dead_messages(&tenant, &name, limit).await?;
    Ok(Json(json!({
        "queue": name,
        "count": messages.len(),
        "messages": messages.iter().map(api_message).collect::<Vec<_>>(),
    }))
    .into_response())
}

async fn replay_dead(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((queue, id)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let id = clean_message_id(&id)?;
    let body = parse_body(&body)?;
    let delay_seconds = delay_or_throw(body.get("delaySeconds"))?;
    let reset_attempts = body.get("resetAttempts").map(bool_flag).unwrap_or(false);
    let Some(message) = state
        .store
        .replay_dead_message(&tenant, &name, &id, delay_seconds, reset_attempts)
        .await?
    else {
        return Err(AppError::request(
            StatusCode::NOT_FOUND,
            "dead_message_not_found",
            format!("dead message '{id}' not found"),
        ));
    };
    Ok(Json(json!({
        "ok": true,
        "queue": name,
        "message": api_message(&message),
    }))
    .into_response())
}

async fn delete_dead(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((queue, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let name = clean_queue(&queue)?;
    let id = clean_message_id(&id)?;
    let deleted = state.store.delete_dead_message(&tenant, &name, &id).await?;
    Ok(Json(json!({ "queue": name, "id": id, "deleted": deleted })).into_response())
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found", None)
}

// ---------------------------------------------------------------------------
// Router and process lifecycle
// ---------------------------------------------------------------------------

fn build_app(state: AppState) -> Router {
    let cors = if state.config.cors_origins.is_empty() {
        if state.config.is_prod {
            CorsLayer::new()
        } else {
            tracing::warn!(
                "[queue][security] CORS_ORIGIN not set — allowing all origins (dev default)."
            );
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
        }
    } else {
        let origins = state
            .config
            .cors_origins
            .iter()
            .filter_map(|origin| origin.parse().ok())
            .collect::<Vec<_>>();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(Any)
            .allow_headers(Any)
    };

    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/v1/queue/queues", get(list_queues))
        .route(
            "/v1/queue/queues/{queue}",
            put(create_or_update_queue)
                .get(get_queue_config)
                .delete(delete_queue),
        )
        .route("/v1/queue/queues/{queue}/purge", post(purge_queue))
        .route("/v1/queue/queues/{queue}/stats", get(queue_stats))
        .route(
            "/v1/queue/queues/{queue}/messages",
            post(publish_message).get(peek_messages),
        )
        .route(
            "/v1/queue/queues/{queue}/messages:batch",
            post(publish_batch),
        )
        .route("/v1/queue/queues/{queue}/consume", post(consume))
        .route("/v1/queue/queues/{queue}/ack", post(ack))
        .route("/v1/queue/queues/{queue}/nack", post(nack))
        .route("/v1/queue/queues/{queue}/heartbeat", post(heartbeat))
        .route("/v1/queue/queues/{queue}/dead", get(dead_messages))
        .route(
            "/v1/queue/queues/{queue}/dead/{id}/replay",
            post(replay_dead),
        )
        .route("/v1/queue/queues/{queue}/dead/{id}", delete(delete_dead))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn_with_state(state.clone(), observability))
        .layer(middleware::from_fn(content_length_limit))
        .layer(middleware::from_fn(request_id))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(cors)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state)
}

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
    let url = store::redis_url();
    assert_production_config(&config, url.as_deref())?;
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[queue][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let store = build_store(&config).await?;
    let backend = store.backend();
    tracing::info!("[queue] backend={backend}");
    let state = AppState {
        store,
        config: config.clone(),
        metrics: Arc::new(Mutex::new(HashMap::new())),
        started: Instant::now(),
    };
    let app = build_app(state);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[queue] SynapseQueue v{VERSION} listening on :{} (backend={backend})",
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

#[cfg(test)]
mod tests;
