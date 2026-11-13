// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseStream — tenant-scoped distributed event streaming log with
//! pluggable engines. Production default: Valkey/Redis Streams.

mod audit;
mod engine;

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use audit::{AuditEvent, express_route, is_read_only_post, mutation_action};
use engine::{
    Engine, GroupReadOptions, MemoryEngine, PublishInput, ReadOptions, RedisEngine, StreamError,
};

const VERSION: &str = "0.7.1";
const MAX_BATCH: usize = 100;

#[derive(Clone)]
struct Config {
    port: u16,
    is_prod: bool,
    internal_secret: String,
    cors_origins: Vec<String>,
    max_payload_bytes: usize,
}

#[derive(Clone)]
struct AppState {
    engine: Engine,
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

fn topic_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$").unwrap())
}

fn group_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]{1,128}$").unwrap())
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(fallback)
}

fn config_from_env() -> Config {
    Config {
        port: env_u64("PORT", env_u64("STREAM_PORT", 4009)) as u16,
        is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
        internal_secret: std::env::var("SYNAPSEONE_INTERNAL_SECRET").unwrap_or_default(),
        cors_origins: std::env::var("CORS_ORIGIN")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        max_payload_bytes: env_u64("STREAM_MAX_PAYLOAD_BYTES", 262_144)
            .clamp(1024, 2 * 1024 * 1024) as usize,
    }
}

fn redis_url() -> Option<String> {
    ["STREAM_VALKEY_URL", "VALKEY_URL", "STREAM_REDIS_URL", "REDIS_URL"]
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn assert_production_config(config: &Config) -> Result<(), String> {
    if !config.is_prod {
        return Ok(());
    }
    if config.internal_secret.is_empty() {
        return Err("[stream] SYNAPSEONE_INTERNAL_SECRET must be set in production (internal-only service).".into());
    }
    let engine = std::env::var("STREAM_ENGINE")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if engine == "memory" {
        return Err("[stream] STREAM_ENGINE=memory is forbidden in production (events are lost on restart). Use valkey/redis or a durable engine.".into());
    }
    if engine.is_empty() && redis_url().is_none() {
        return Err("[stream] In production one of STREAM_ENGINE or STREAM_VALKEY_URL/STREAM_REDIS_URL/VALKEY_URL/REDIS_URL must be set (no memory fallback).".into());
    }
    if config.cors_origins.is_empty() {
        return Err("[stream] CORS_ORIGIN must be set in production (the default allows every origin).".into());
    }
    Ok(())
}

async fn build_engine() -> Result<Engine, String> {
    let is_prod = std::env::var("NODE_ENV").as_deref() == Ok("production");
    let explicit = std::env::var("STREAM_ENGINE")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let url = redis_url();
    let target = if !explicit.is_empty() {
        if explicit == "valkey" {
            "redis".to_string()
        } else {
            explicit
        }
    } else if url.is_some() {
        "redis".to_string()
    } else if is_prod {
        return Err("[stream] In production one of STREAM_ENGINE or STREAM_VALKEY_URL/STREAM_REDIS_URL/VALKEY_URL/REDIS_URL is required (no memory fallback)".into());
    } else {
        "memory".to_string()
    };
    match target.as_str() {
        "memory" => {
            if is_prod {
                return Err(
                    "[stream] STREAM_ENGINE=memory is forbidden in production (events are lost on restart)"
                        .into(),
                );
            }
            Ok(Engine::Memory(MemoryEngine::new()))
        }
        "redis" => match url {
            Some(url) => match RedisEngine::connect(&url).await {
                Ok(engine) => Ok(Engine::Redis(engine)),
                Err(error) => {
                    if is_prod {
                        Err(format!(
                            "[stream] Failed to connect to Valkey Streams in production (fail-closed): {error}"
                        ))
                    } else {
                        tracing::warn!(
                            "[stream] Valkey/Redis connection failed, falling back to in-memory engine: {error}"
                        );
                        Ok(Engine::Memory(MemoryEngine::new()))
                    }
                }
            },
            None => {
                if is_prod {
                    Err("[stream] In production, STREAM_VALKEY_URL/VALKEY_URL (or legacy STREAM_REDIS_URL/REDIS_URL) is required for the Valkey/Redis engine".into())
                } else {
                    tracing::warn!("[stream] No Valkey/Redis URL provided, falling back to in-memory engine");
                    Ok(Engine::Memory(MemoryEngine::new()))
                }
            }
        },
        other => Err(format!(
            "[stream] Unknown stream engine '{other}'. Available: memory, redis, valkey"
        )),
    }
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

fn principal_from_headers(headers: &HeaderMap) -> Option<Principal> {
    let clean = |value: String| (!value.is_empty() && value.len() <= 128).then_some(value);
    let user = header(headers, "x-synapseone-user");
    if user.len() > 128 {
        return None;
    }
    if !user.is_empty() {
        return Some(Principal {
            sub: user,
            org: clean(header(headers, "x-synapseone-org")),
            account: clean(header(headers, "x-synapseone-account")),
        });
    }
    let kind = header(headers, "x-synapseone-kind");
    let account = header(headers, "x-synapseone-account");
    let org = header(headers, "x-synapseone-org");
    if !kind.is_empty() || !account.is_empty() || !org.is_empty() {
        return Some(Principal {
            sub: if account.is_empty() {
                format!("{}:unknown", if kind.is_empty() { "principal" } else { &kind })
            } else {
                format!("apikey:{account}")
            },
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
    let anon = header(headers, "x-synapseone-anon") == "1";
    if anon {
        Caller::Anon
    } else {
        Caller::Platform
    }
}

fn resolve_tenant(headers: &HeaderMap, caller: &Caller, query: &str) -> String {
    if let Caller::Principal(principal) = caller {
        if let Some(org) = &principal.org {
            return format!("org:{org}");
        }
        if let Some(account) = &principal.account {
            return format!("account:{account}");
        }
        return format!("user:{}", principal.sub);
    }
    if let Caller::Platform = caller {
        let mut explicit = header(headers, "x-synapseone-tenant");
        if explicit.is_empty() {
            explicit = url::form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == "tenant")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
        }
        let valid = !explicit.is_empty()
            && explicit.len() <= 128
            && explicit
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '-'));
        if valid {
            return explicit;
        }
    }
    "default".into()
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

fn json_error(status: StatusCode, code: &str, message: Option<String>) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String(code.into()));
    if let Some(message) = message {
        body.insert("message".into(), Value::String(message));
    }
    (status, Json(Value::Object(body))).into_response()
}

fn stream_error_response(error: StreamError) -> Response {
    let status = match error.code {
        "not_found" => StatusCode::NOT_FOUND,
        "conflict" => StatusCode::CONFLICT,
        "storage_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    json_error(status, error.code, Some(error.message))
}

fn internal_error(error: impl std::fmt::Display) -> Response {
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        Some(error.to_string()),
    )
}

fn js_string(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn parse_body(body: &Bytes) -> Result<Value, Response> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| {
        json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        )
    })
}

fn number_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64)),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().map(|value| value as i64),
        _ => None,
    }
}

async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1") {
        return next.run(request).await;
    }
    if state.config.is_prod && !verify_internal(request.headers(), &state.config.internal_secret) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Missing or invalid internal secret".into()),
        );
    }
    let caller = resolve_caller(request.headers());
    if matches!(caller, Caller::Anon) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Authentication required for streaming operations".into()),
        );
    }
    let query = request.uri().query().unwrap_or("").to_string();
    let tenant = resolve_tenant(request.headers(), &caller, &query);
    request.extensions_mut().insert(Tenant(tenant));
    next.run(request).await
}

async fn audit_middleware(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| express_route(matched.as_str()))
        .unwrap_or_else(|| path.clone());
    let mutating = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE")
        && path.starts_with("/v1")
        && !is_read_only_post(&method, &route);
    if !mutating || !audit::audit_enabled() {
        return next.run(request).await;
    }
    let headers = request.headers().clone();
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
    let action = mutation_action("stream", &method, &route, &path);
    audit::record(AuditEvent {
        actor_type,
        actor_id,
        org_id,
        account_id,
        action,
        resource: format!("stream:{route}"),
        result: result.into(),
        status_code: status,
        request_id,
        context: json!({
            "service": "stream",
            "method": method,
            "route": route,
            "params": {},
            "result": result,
        }),
    });
    response
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "service": "stream",
        "status": "ok",
        "version": VERSION,
        "engine": state.engine.name(),
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
    .into_response()
}

async fn metrics(State(state): State<AppState>) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        format!(
            "# HELP synapseone_stream_up Service up status\n\
             # TYPE synapseone_stream_up gauge\n\
             synapseone_stream_up 1\n\
             # HELP synapseone_stream_engine Active backend engine\n\
             # TYPE synapseone_stream_engine gauge\n\
             synapseone_stream_engine{{engine=\"{}\"}} 1\n",
            state.engine.name()
        ),
    )
        .into_response()
}

async fn list_topics(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
) -> Response {
    match state.engine.list_topics(&tenant).await {
        Ok(topics) => Json(json!({ "topics": topics })).into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn create_topic(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
    body: Bytes,
) -> Response {
    if !topic_re().is_match(&topic_name) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Topic name must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$".into()),
        );
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let object = body.as_object().cloned().unwrap_or_default();
    match state
        .engine
        .create_topic(
            &tenant,
            &topic_name,
            number_value(object.get("maxLen")),
            js_string(object.get("minId")),
            number_value(object.get("retentionMs")),
        )
        .await
    {
        Ok(topic) => (StatusCode::CREATED, Json(json!({ "topic": topic }))).into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn get_topic(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
) -> Response {
    match state.engine.get_topic(&tenant, &topic_name).await {
        Ok(Some(topic)) => Json(json!({ "topic": topic })).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "not_found",
            Some(format!("Topic '{topic_name}' not found")),
        ),
        Err(error) => stream_error_response(error),
    }
}

async fn delete_topic(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
) -> Response {
    match state.engine.delete_topic(&tenant, &topic_name).await {
        Ok(deleted) => Json(json!({ "deleted": deleted })).into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn topic_stats(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
) -> Response {
    match state.engine.topic_stats(&tenant, &topic_name).await {
        Ok(stats) => Json(json!({ "stats": stats })).into_response(),
        Err(error) => stream_error_response(error),
    }
}

fn publish_input(value: &Value) -> PublishInput {
    PublishInput {
        payload: value.get("payload").cloned().unwrap_or(Value::Null),
        key: js_string(value.get("key")),
        headers: value.get("headers").filter(|value| value.is_object()).cloned(),
        id: js_string(value.get("id")),
    }
}

async fn publish_event(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
    body: Bytes,
) -> Response {
    if !topic_re().is_match(&topic_name) {
        return json_error(StatusCode::BAD_REQUEST, "invalid", Some("Invalid topic name".into()));
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    if !body.is_object() || body.get("payload").is_none() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Missing payload in request body".into()),
        );
    }
    let serialized = serde_json::to_string(body.get("payload").unwrap())
        .unwrap_or_default()
        .chars()
        .count();
    if serialized > state.config.max_payload_bytes {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            Some(format!(
                "Payload exceeds limit of {} bytes",
                state.config.max_payload_bytes
            )),
        );
    }
    match state
        .engine
        .publish(&tenant, &topic_name, publish_input(&body))
        .await
    {
        Ok(event) => (StatusCode::CREATED, Json(json!({ "event": event }))).into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn publish_batch(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
    body: Bytes,
) -> Response {
    if !topic_re().is_match(&topic_name) {
        return json_error(StatusCode::BAD_REQUEST, "invalid", Some("Invalid topic name".into()));
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(events) = body.get("events").and_then(Value::as_array) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Expected non-empty array under events field".into()),
        );
    };
    if events.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Expected non-empty array under events field".into()),
        );
    }
    if events.len() > MAX_BATCH {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some(format!("Batch size exceeds maximum of {MAX_BATCH}")),
        );
    }
    let inputs = events.iter().map(publish_input).collect();
    match state.engine.publish_batch(&tenant, &topic_name, inputs).await {
        Ok(events) => {
            let count = events.len();
            (StatusCode::CREATED, Json(json!({ "events": events, "count": count }))).into_response()
        }
        Err(error) => stream_error_response(error),
    }
}

async fn read_events(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
    body: Bytes,
) -> Response {
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let object = body.as_object().cloned().unwrap_or_default();
    let options = ReadOptions {
        from_id: js_string(object.get("fromId")),
        count: number_value(object.get("count")).map(|value| value.min(1000)),
        block_ms: number_value(object.get("blockMs")),
    };
    match state.engine.read(&tenant, &topic_name, options).await {
        Ok(events) => {
            let count = events.len();
            Json(json!({ "events": events, "count": count })).into_response()
        }
        Err(error) => stream_error_response(error),
    }
}

async fn range_events(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(topic_name): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = query.get("start").cloned().unwrap_or_else(|| "-".into());
    let end = query.get("end").cloned().unwrap_or_else(|| "+".into());
    let count = query
        .get("count")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(100)
        .min(1000);
    match state
        .engine
        .range(&tenant, &topic_name, &start, &end, count)
        .await
    {
        Ok(events) => {
            let count = events.len();
            Json(json!({ "events": events, "count": count })).into_response()
        }
        Err(error) => stream_error_response(error),
    }
}

async fn create_group(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((topic_name, group_name)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    if !group_re().is_match(&group_name) {
        return json_error(StatusCode::BAD_REQUEST, "invalid", Some("Invalid group name".into()));
    }
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let start_id = js_string(body.get("startId")).unwrap_or_else(|| "$".into());
    match state
        .engine
        .create_group(&tenant, &topic_name, &group_name, &start_id)
        .await
    {
        Ok(_) => (
            StatusCode::CREATED,
            Json(json!({
                "group": group_name,
                "topic": topic_name,
                "startId": start_id,
            })),
        )
            .into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn destroy_group(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((topic_name, group_name)): Path<(String, String)>,
) -> Response {
    match state
        .engine
        .destroy_group(&tenant, &topic_name, &group_name)
        .await
    {
        Ok(destroyed) => Json(json!({ "destroyed": destroyed })).into_response(),
        Err(error) => stream_error_response(error),
    }
}

async fn read_group(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((topic_name, group_name)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let object = body.as_object().cloned().unwrap_or_default();
    let options = GroupReadOptions {
        consumer: js_string(object.get("consumer")).unwrap_or_else(|| "default-worker".into()),
        count: number_value(object.get("count")).map(|value| value.min(100)),
        block_ms: number_value(object.get("blockMs")),
        auto_ack: object.get("autoAck").map(truthy).unwrap_or(false),
    };
    match state
        .engine
        .read_group(&tenant, &topic_name, &group_name, options)
        .await
    {
        Ok(events) => {
            let count = events.len();
            Json(json!({ "events": events, "count": count })).into_response()
        }
        Err(error) => stream_error_response(error),
    }
}

async fn ack_events(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((topic_name, group_name)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(ids) = body.get("ids").and_then(Value::as_array) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Expected array of message ids under ids field".into()),
        );
    };
    if ids.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid",
            Some("Expected array of message ids under ids field".into()),
        );
    }
    let ids = ids
        .iter()
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>();
    match state
        .engine
        .ack(&tenant, &topic_name, &group_name, &ids)
        .await
    {
        Ok(acked) => Json(json!({ "acked": acked })).into_response(),
        Err(error) => stream_error_response(error),
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found", None)
}

fn build_app(state: AppState) -> Router {
    let cors = if state.config.cors_origins.is_empty() {
        CorsLayer::new().allow_origin(Any)
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

    let api = Router::new()
        .route(
            "/v1/stream/topics",
            get(list_topics),
        )
        .route(
            "/v1/stream/topics/{topic}",
            put(create_topic).get(get_topic).delete(delete_topic),
        )
        .route("/v1/stream/topics/{topic}/stats", get(topic_stats))
        .route("/v1/stream/topics/{topic}/events", post(publish_event))
        .route("/v1/stream/topics/{topic}/events:batch", post(publish_batch))
        .route("/v1/stream/topics/{topic}/read", post(read_events))
        .route("/v1/stream/topics/{topic}/range", get(range_events))
        .route(
            "/v1/stream/topics/{topic}/groups/{group}",
            put(create_group).delete(destroy_group),
        )
        .route(
            "/v1/stream/topics/{topic}/groups/{group}/read",
            post(read_group),
        )
        .route(
            "/v1/stream/topics/{topic}/groups/{group}/ack",
            post(ack_events),
        );

    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .merge(api)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn(audit_middleware))
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(cors)
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
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let config = config_from_env();
    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if check_health(config.port).await { 0 } else { 1 });
    }
    assert_production_config(&config)?;
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[stream][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let engine = build_engine().await?;
    tracing::info!("[stream] Active streaming engine: {}", engine.name());
    let state = AppState {
        engine,
        config: config.clone(),
    };
    let app = build_app(state);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[stream] SynapseStream service v{VERSION} listening on port {}",
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
mod tests {
    use super::engine::MemoryEngine;
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            engine: Engine::Memory(MemoryEngine::new()),
            config: Config {
                port: 0,
                is_prod: false,
                internal_secret: String::new(),
                cors_origins: vec![],
                max_payload_bytes: 262_144,
            },
        }
    }

    fn headers(builder: axum::http::request::Builder) -> axum::http::request::Builder {
        builder
            .header("content-type", "application/json")
            .header("x-synapseone-user", "user-1")
            .header("x-synapseone-org", "tenant-a")
            .header("x-synapseone-kind", "user")
    }

    async fn send(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = HttpRequest::builder().method(method).uri(uri);
        builder = headers(builder);
        let request = builder
            .body(Body::from(
                body.map(|value| serde_json::to_vec(&value).unwrap())
                    .unwrap_or_default(),
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn topic_lifecycle() {
        let app = build_app(test_state());
        let (status, body) = send(
            app.clone(),
            "PUT",
            "/v1/stream/topics/telemetry",
            Some(json!({"maxLen": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["topic"]["name"], "telemetry");
        assert_eq!(body["topic"]["maxLen"], 1000);

        let (status, body) = send(app.clone(), "GET", "/v1/stream/topics", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["topics"].as_array().unwrap().len(), 1);

        let (status, body) = send(
            app.clone(),
            "GET",
            "/v1/stream/topics/telemetry/stats",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["stats"]["length"], 0);

        let (status, body) = send(app.clone(), "DELETE", "/v1/stream/topics/telemetry", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["deleted"], true);

        let (status, _) = send(app, "GET", "/v1/stream/topics/telemetry", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn publish_read_and_batch() {
        let app = build_app(test_state());
        send(app.clone(), "PUT", "/v1/stream/topics/sensors", None).await;
        let (status, first) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/sensors/events",
            Some(json!({"payload": {"temp": 24.5}, "key": "sensor-1"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let first_id = first["event"]["id"].as_str().unwrap().to_string();
        let (_, second) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/sensors/events",
            Some(json!({"payload": {"temp": 25.1}})),
        )
        .await;
        let second_id = second["event"]["id"].as_str().unwrap().to_string();

        let (_, body) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/sensors/read",
            Some(json!({"fromId": "0-0"})),
        )
        .await;
        assert_eq!(body["count"], 2);
        let (_, body) = send(
            app,
            "POST",
            "/v1/stream/topics/sensors/read",
            Some(json!({"fromId": first_id})),
        )
        .await;
        assert_eq!(body["count"], 1);
        assert_eq!(body["events"][0]["id"], second_id);
    }

    #[tokio::test]
    async fn consumer_groups_ack_and_destroy() {
        let app = build_app(test_state());
        send(app.clone(), "PUT", "/v1/stream/topics/jobs", None).await;
        send(
            app.clone(),
            "POST",
            "/v1/stream/topics/jobs/events",
            Some(json!({"payload": {"task": "job-1"}})),
        )
        .await;
        send(
            app.clone(),
            "POST",
            "/v1/stream/topics/jobs/events",
            Some(json!({"payload": {"task": "job-2"}})),
        )
        .await;
        let (status, _) = send(
            app.clone(),
            "PUT",
            "/v1/stream/topics/jobs/groups/workers",
            Some(json!({"startId": "0-0"})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let (_, body) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/jobs/groups/workers/read",
            Some(json!({"consumer": "worker-a", "count": 10})),
        )
        .await;
        assert_eq!(body["count"], 2);
        let ids = body["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["id"].clone())
            .collect::<Vec<_>>();
        let (_, body) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/jobs/groups/workers/ack",
            Some(json!({"ids": ids})),
        )
        .await;
        assert_eq!(body["acked"], 2);
        let (_, body) = send(
            app.clone(),
            "POST",
            "/v1/stream/topics/jobs/groups/workers/read",
            Some(json!({"consumer": "worker-a"})),
        )
        .await;
        assert_eq!(body["count"], 0);
        let (_, body) = send(
            app,
            "DELETE",
            "/v1/stream/topics/jobs/groups/workers",
            None,
        )
        .await;
        assert_eq!(body["destroyed"], true);
    }

    #[tokio::test]
    async fn tenant_isolation() {
        let app = build_app(test_state());
        let (status, _) = send(
            app.clone(),
            "PUT",
            "/v1/stream/topics/sensor-feed",
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        let request = HttpRequest::builder()
            .method("GET")
            .uri("/v1/stream/topics")
            .header("x-synapseone-user", "user-2")
            .header("x-synapseone-org", "org-b")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["topics"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn mutation_audit_records_actor_and_action() {
        audit::clear();
        let app = build_app(test_state());
        send(
            app.clone(),
            "PUT",
            "/v1/stream/topics/audit-topic",
            Some(json!({"maxLen": 100})),
        )
        .await;
        send(
            app.clone(),
            "POST",
            "/v1/stream/topics/audit-topic/events",
            Some(json!({"payload": {"secret": "super-secret-value"}})),
        )
        .await;
        let events = audit::events();
        let event = events
            .iter()
            .find(|event| event.action == "stream:topics.events:create")
            .expect("audit event");
        assert_eq!(event.actor_type, "user");
        assert_eq!(event.actor_id, "user-1");
        assert_eq!(event.org_id.as_deref(), Some("tenant-a"));
        assert_eq!(event.result, "allowed");
        assert_eq!(event.status_code, 201);
        assert!(!serde_json::to_string(&audit::events())
            .unwrap()
            .contains("super-secret-value"));

        let before = audit::events().len();
        send(
            app,
            "POST",
            "/v1/stream/topics/audit-topic/read",
            Some(json!({"count": 1})),
        )
        .await;
        assert_eq!(audit::events().len(), before);
    }
}
