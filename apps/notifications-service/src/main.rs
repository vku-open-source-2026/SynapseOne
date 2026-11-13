// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseNotifications — tenant-scoped notification delivery.
//!
//! Outbox + templates + preferences + retries/DLQ. Delivery adapters are HTTP
//! relays (email/SMS/push) plus direct webhooks, so no provider SDK is bundled.
//! With NOTIFICATIONS_QUEUE_URL set, delivery jobs travel through SynapseQueue
//! for at-least-once processing across replicas.

mod db;
mod delivery;
mod ssrf;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use db::{NewNotification, NotificationRecord, Store, CHANNELS};

const VERSION: &str = "0.7.1";

#[derive(Clone)]
struct Config {
    port: u16,
    is_prod: bool,
    internal_secret: String,
    cors_origins: Vec<String>,
    max_attempts: usize,
    rate_limit: u32,
    queue_url: String,
    queue_name: String,
    use_queue: bool,
    tick_ms: u64,
}

#[derive(Clone)]
struct AppState {
    store: Store,
    config: Config,
    limiter: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
}

#[derive(Clone)]
struct Tenant(String);

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn env_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
}

fn config_from_env() -> Config {
    let cors_origins = std::env::var("CORS_ORIGIN")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let queue_url = std::env::var("NOTIFICATIONS_QUEUE_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let use_queue = !queue_url.is_empty()
        && std::env::var("NOTIFICATIONS_USE_QUEUE").as_deref() != Ok("false");
    Config {
        port: env_u64("PORT", 4011) as u16,
        is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
        internal_secret: std::env::var("SYNAPSEONE_INTERNAL_SECRET").unwrap_or_default(),
        cors_origins,
        max_attempts: env_i64("NOTIFICATIONS_MAX_ATTEMPTS", 5).clamp(1, 20) as usize,
        rate_limit: env_i64("NOTIFICATIONS_RATE_LIMIT_PER_MIN", 120).clamp(1, 100_000) as u32,
        queue_url,
        queue_name: std::env::var("NOTIFICATIONS_QUEUE_NAME")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "notifications".into()),
        use_queue,
        tick_ms: env_u64("NOTIFICATIONS_TICK_MS", 2000).max(500),
    }
}

fn assert_production_config(config: &Config, database_url: &str) -> Result<(), String> {
    if !config.is_prod {
        return Ok(());
    }
    if config.internal_secret.is_empty() {
        return Err("[notifications] SYNAPSEONE_INTERNAL_SECRET must be set in production.".into());
    }
    if database_url.trim().is_empty() {
        return Err(
            "[notifications] DATABASE_URL must be set in production (in-memory outbox would split-brain)."
                .into(),
        );
    }
    if config.cors_origins.is_empty() {
        return Err("[notifications] CORS_ORIGIN must be set in production.".into());
    }
    Ok(())
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

fn principal_from_headers(headers: &HeaderMap) -> Option<Value> {
    let user = header(headers, "x-synapseone-user");
    let org = header(headers, "x-synapseone-org");
    let account = header(headers, "x-synapseone-account");
    if !user.is_empty() {
        return Some(json!({
            "sub": user,
            "org": if org.is_empty() { Value::Null } else { Value::String(org) },
            "account": if account.is_empty() { Value::Null } else { Value::String(account) },
        }));
    }
    if !org.is_empty() || !account.is_empty() {
        return Some(json!({
            "sub": if account.is_empty() { "service".to_string() } else { format!("apikey:{account}") },
            "org": if org.is_empty() { Value::Null } else { Value::String(org) },
            "account": if account.is_empty() { Value::Null } else { Value::String(account) },
        }));
    }
    None
}

fn resolve_tenant(headers: &HeaderMap, query: &str, principal: Option<&Value>) -> Option<String> {
    if let Some(principal) = principal {
        if let Some(org) = principal.get("org").and_then(Value::as_str) {
            if !org.is_empty() {
                return Some(format!("org:{org}"));
            }
        }
        if let Some(account) = principal.get("account").and_then(Value::as_str) {
            if !account.is_empty() {
                return Some(format!("account:{account}"));
            }
        }
        if let Some(sub) = principal.get("sub").and_then(Value::as_str) {
            if !sub.is_empty() {
                return Some(format!("user:{sub}"));
            }
        }
    }
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
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'));
    valid.then_some(explicit)
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

fn js_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn recipient_key(recipient: &Value) -> String {
    for key in ["userId", "email", "phone", "url", "webhookUrl", "pushToken"] {
        if let Some(value) = recipient.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                return if key == "userId" {
                    format!("user:{value}")
                } else {
                    value.to_string()
                };
            }
        }
    }
    "unknown".into()
}

fn infer_channel(recipient: &Value) -> &'static str {
    if recipient
        .get("email")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return "email";
    }
    if recipient
        .get("phone")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return "sms";
    }
    if recipient
        .get("url")
        .or_else(|| recipient.get("webhookUrl"))
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return "webhook";
    }
    if recipient
        .get("pushToken")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return "push";
    }
    "log"
}

// ---- queue integration ----

async fn queue_call(state: &AppState, path: &str, body: Value) -> Result<Value, String> {
    let url = format!("{}{}", state.config.queue_url, path);
    let mut request = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .header("x-synapseone-tenant", "notifications-outbox")
        .json(&body);
    if !state.config.internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", &state.config.internal_secret);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("queue {}", response.status()));
    }
    response.json::<Value>().await.map_err(|e| e.to_string())
}

async fn publish_to_queue(state: &AppState, record: &NotificationRecord) -> bool {
    if !state.config.use_queue {
        return false;
    }
    let path = format!(
        "/v1/queue/queues/{}/messages",
        urlencoding(&state.config.queue_name)
    );
    let result = queue_call(
        state,
        &path,
        json!({
            "payload": { "notificationId": record.id, "tenant": record.tenant },
            "headers": { "notificationId": record.id },
        }),
    )
    .await;
    match result {
        Ok(_) => true,
        Err(error) => {
            tracing::error!("[notifications] queue publish failed, falling back to local worker: {error}");
            false
        }
    }
}

fn urlencoding(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

// ---- delivery worker ----

async fn process_due_once(state: &AppState, limit: i64) -> Result<(usize, usize, usize), String> {
    let due = state.store.claim_due(limit).await?;
    let mut delivered = 0usize;
    let mut failed = 0usize;
    for notification in &due {
        let pref = state
            .store
            .get_preference(&notification.tenant, &recipient_key(&notification.recipient))
            .await?;
        if let Some(pref) = &pref {
            if pref.unsubscribed
                || (!pref.channels.is_empty() && !pref.channels.contains(&notification.channel))
            {
                state
                    .store
                    .update(
                        &notification.id,
                        Some("cancelled"),
                        None,
                        None,
                        Some("recipient_unsubscribed"),
                    )
                    .await?;
                continue;
            }
        }
        let result = delivery::deliver(notification).await;
        let mut attempts = notification
            .attempts
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut attempt = json!({
            "at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "ok": result.ok,
        });
        if let Some(error) = &result.error {
            attempt["error"] = Value::String(error.clone());
        }
        attempts.push(attempt);
        let attempts_value = Value::Array(attempts.clone());
        if result.ok {
            delivered += 1;
            state
                .store
                .update(&notification.id, Some("delivered"), Some(attempts_value), None, None)
                .await?;
        } else {
            failed += 1;
            let dead = attempts.len() >= state.config.max_attempts;
            let next = Utc::now()
                + chrono::Duration::seconds(delivery::backoff_seconds(attempts.len()));
            state
                .store
                .update(
                    &notification.id,
                    Some(if dead { "dead" } else { "failed" }),
                    Some(attempts_value),
                    Some(&next.to_rfc3339_opts(SecondsFormat::Millis, true)),
                    if dead {
                        Some(result.error.as_deref().unwrap_or("max attempts exceeded"))
                    } else {
                        None
                    },
                )
                .await?;
        }
    }
    Ok((due.len(), delivered, failed))
}

async fn consume_from_queue(state: &AppState, consumer: &str) {
    let path = format!(
        "/v1/queue/queues/{}/consume",
        urlencoding(&state.config.queue_name)
    );
    let page = match queue_call(
        state,
        &path,
        json!({
            "maxMessages": 20,
            "visibilityTimeoutSeconds": 60,
            "consumer": consumer,
        }),
    )
    .await
    {
        Ok(page) => page,
        Err(error) => {
            tracing::error!("[notifications] queue consume failed: {error}");
            return;
        }
    };
    let Some(messages) = page.get("messages").and_then(Value::as_array) else {
        return;
    };
    for item in messages {
        let receipt = item.get("receipt").cloned().unwrap_or(Value::Null);
        let payload = item
            .get("payload")
            .or_else(|| item.get("message").and_then(|m| m.get("payload")))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let tenant = payload.get("tenant").and_then(Value::as_str).unwrap_or("");
        let id = payload
            .get("notificationId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let notification = match state.store.get(tenant, id).await {
            Ok(Some(notification)) => notification,
            _ => {
                let _ = ack_or_nack(state, "ack", json!({ "receipt": receipt })).await;
                continue;
            }
        };
        let pref = state
            .store
            .get_preference(&notification.tenant, &recipient_key(&notification.recipient))
            .await
            .ok()
            .flatten();
        if pref.as_ref().is_some_and(|p| p.unsubscribed) {
            let _ = state
                .store
                .update(
                    &notification.id,
                    Some("cancelled"),
                    None,
                    None,
                    Some("recipient_unsubscribed"),
                )
                .await;
            let _ = ack_or_nack(state, "ack", json!({ "receipt": receipt })).await;
            continue;
        }
        let result = delivery::deliver(&notification).await;
        let mut attempts = notification
            .attempts
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut attempt = json!({
            "at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "ok": result.ok,
        });
        if let Some(error) = &result.error {
            attempt["error"] = Value::String(error.clone());
        }
        attempts.push(attempt);
        if result.ok {
            let _ = state
                .store
                .update(
                    &notification.id,
                    Some("delivered"),
                    Some(Value::Array(attempts)),
                    None,
                    None,
                )
                .await;
            let _ = ack_or_nack(state, "ack", json!({ "receipt": receipt })).await;
        } else {
            let _ = state
                .store
                .update(
                    &notification.id,
                    Some("failed"),
                    Some(Value::Array(attempts)),
                    None,
                    None,
                )
                .await;
            let _ = ack_or_nack(
                state,
                "nack",
                json!({
                    "receipt": receipt,
                    "error": result.error.clone().unwrap_or_else(|| "delivery failed".into()),
                    "requeue": true,
                }),
            )
            .await;
        }
    }
}

async fn ack_or_nack(state: &AppState, action: &str, body: Value) -> Result<(), String> {
    let path = format!(
        "/v1/queue/queues/{}/{action}",
        urlencoding(&state.config.queue_name)
    );
    queue_call(state, &path, body).await.map(|_| ())
}

async fn worker_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_millis(state.config.tick_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let consumer = format!("notifications-{}", std::process::id());
    loop {
        interval.tick().await;
        if state.config.use_queue {
            consume_from_queue(&state, &consumer).await;
        } else if let Err(error) = process_due_once(&state, 20).await {
            tracing::error!("[notifications] worker error: {error}");
        }
    }
}

// ---- HTTP ----

async fn guard(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    if !path.starts_with("/v1/notifications") {
        return next.run(request).await;
    }
    if state.config.is_prod
        && !verify_internal(request.headers(), &state.config.internal_secret)
    {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Missing or invalid internal secret".into()),
        );
    }
    let query = request.uri().query().unwrap_or("").to_string();
    let principal = principal_from_headers(request.headers());
    let Some(tenant) = resolve_tenant(request.headers(), &query, principal.as_ref()) else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "tenant_required",
            Some("Authenticated principal or x-synapseone-tenant required".into()),
        );
    };
    request.extensions_mut().insert(Tenant(tenant));
    next.run(request).await
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "service": "notifications",
        "status": "ok",
        "version": VERSION,
        "store": if state.store.uses_postgres() { "postgres" } else { "memory" },
        "delivery": if state.config.use_queue { "queue" } else { "local" },
        "channels": CHANNELS,
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
    .into_response()
}

async fn metrics() -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        "# HELP synapseone_notifications_up Service up status\n\
         # TYPE synapseone_notifications_up gauge\n\
         synapseone_notifications_up 1\n",
    )
        .into_response()
}

async fn rate_limited(state: &AppState, tenant: &str) -> bool {
    let mut limiter = state.limiter.lock().await;
    let now = Instant::now();
    let entry = limiter
        .entry(tenant.to_string())
        .or_insert((0, now + Duration::from_secs(60)));
    if entry.1 < now {
        *entry = (1, now + Duration::from_secs(60));
        return false;
    }
    entry.0 += 1;
    entry.0 > state.config.rate_limit
}

async fn create_notification(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    body: Bytes,
) -> Response {
    if rate_limited(&state, &tenant).await {
        let mut response = json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            Some(format!(
                "limit is {} notifications/minute",
                state.config.rate_limit
            )),
        );
        response
            .headers_mut()
            .insert("retry-after", "60".parse().unwrap());
        return response;
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None);
    };
    let object = body.as_object().cloned().unwrap_or_default();
    let recipient = object
        .get("recipient")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));

    let channels: Vec<String> = match object.get("channels").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .map(|item| js_string(Some(item)).to_ascii_lowercase())
            .collect(),
        None => {
            let channel = object.get("channel");
            match channel.filter(|value| !value.is_null()) {
                Some(value) => vec![js_string(Some(value)).to_ascii_lowercase()],
                None => vec![infer_channel(&recipient).to_string()],
            }
        }
    };
    if channels.is_empty()
        || channels
            .iter()
            .any(|channel| !CHANNELS.contains(&channel.as_str()))
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_channels",
            Some(format!("channels must be one of {}", CHANNELS.join(","))),
        );
    }
    let mut text = js_string(object.get("body").or_else(|| object.get("text")));
    text.truncate(100_000);
    if text.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "body_required",
            Some("body (or template) is required".into()),
        );
    }
    let mut subject = js_string(object.get("subject"));
    subject.truncate(500);
    let idempotency_key = object
        .get("idempotencyKey")
        .map(|value| js_string(Some(value)))
        .filter(|value| !value.is_empty())
        .map(|mut value| {
            value.truncate(200);
            value
        });
    let data = object
        .get("data")
        .filter(|value| value.is_object() || value.is_array())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let rendered = delivery::render_template(&text, &data);

    let mut created = Vec::new();
    for channel in channels {
        let key = idempotency_key
            .as_ref()
            .map(|key| format!("{channel}:{key}"));
        match state
            .store
            .create(NewNotification {
                tenant: tenant.clone(),
                channel,
                recipient: recipient.clone(),
                subject: subject.clone(),
                body: rendered.clone(),
                idempotency_key: key,
                metadata: data.clone(),
            })
            .await
        {
            Ok(record) => {
                if state.config.use_queue {
                    publish_to_queue(&state, &record).await;
                }
                created.push(record);
            }
            Err(error) => {
                tracing::error!("[notifications] create failed: {error}");
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None);
            }
        }
    }
    (StatusCode::ACCEPTED, Json(json!({ "notifications": created }))).into_response()
}

async fn list_notifications(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let status = query.get("status").map(String::as_str);
    let limit = match query.get("limit") {
        None => 50,
        Some(raw) => match raw.parse::<i64>() {
            Ok(value) if (1..=200).contains(&value) => value,
            _ => return json_error(StatusCode::BAD_REQUEST, "invalid_limit", None),
        },
    };
    match state.store.list(&tenant, status, limit).await {
        Ok(items) => Json(Value::Array(
            items
                .into_iter()
                .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
                .collect(),
        ))
        .into_response(),
        Err(error) => {
            tracing::error!("[notifications] list failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
    }
}

async fn get_notification(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.store.get(&tenant, &id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "not_found", None),
        Err(error) => {
            tracing::error!("[notifications] get failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
    }
}

async fn cancel_notification(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.store.cancel(&tenant, &id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => json_error(
            StatusCode::CONFLICT,
            "not_cancellable",
            Some("notification is not queued/failed or does not exist".into()),
        ),
        Err(error) => {
            tracing::error!("[notifications] cancel failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
    }
}

async fn get_preference(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    axum::extract::Path(recipient): axum::extract::Path<String>,
) -> Response {
    match state.store.get_preference(&tenant, &recipient).await {
        Ok(Some(pref)) => Json(pref).into_response(),
        Ok(None) => Json(json!({
            "tenant": tenant,
            "recipient": recipient,
            "channels": [],
            "unsubscribed": false,
        }))
        .into_response(),
        Err(error) => {
            tracing::error!("[notifications] preference read failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
    }
}

async fn put_preference(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    axum::extract::Path(recipient): axum::extract::Path<String>,
    body: Bytes,
) -> Response {
    let body = serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({}));
    let channels: Vec<String> = body
        .get("channels")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| js_string(Some(item)).to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();
    if channels
        .iter()
        .any(|channel| !CHANNELS.contains(&channel.as_str()))
    {
        return json_error(StatusCode::BAD_REQUEST, "invalid_channels", None);
    }
    let unsubscribed = body
        .get("unsubscribed")
        .map(|value| match value {
            Value::Bool(flag) => *flag,
            Value::Null => false,
            Value::Number(number) => number.as_f64().unwrap_or(0.0) != 0.0,
            Value::String(text) => !text.is_empty(),
            _ => true,
        })
        .unwrap_or(false);
    match state
        .store
        .set_preference(&tenant, &recipient, channels, unsubscribed)
        .await
    {
        Ok(pref) => Json(pref).into_response(),
        Err(error) => {
            tracing::error!("[notifications] preference write failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
    }
}

async fn unsubscribe(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    body: Bytes,
) -> Response {
    let body = serde_json::from_slice::<Value>(&body).unwrap_or_else(|_| json!({}));
    let recipient = js_string(body.get("recipient"));
    if recipient.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "recipient_required", None);
    }
    let prev = state
        .store
        .get_preference(&tenant, &recipient)
        .await
        .ok()
        .flatten();
    let channels = prev.map(|p| p.channels).unwrap_or_default();
    match state
        .store
        .set_preference(&tenant, &recipient, channels, true)
        .await
    {
        Ok(pref) => Json(pref).into_response(),
        Err(error) => {
            tracing::error!("[notifications] unsubscribe failed: {error}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None)
        }
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
        .route("/v1/notifications", post(create_notification).get(list_notifications))
        .route("/v1/notifications/{id}", get(get_notification))
        .route("/v1/notifications/{id}/cancel", post(cancel_notification))
        .route(
            "/v1/notifications/preferences/{recipient}",
            get(get_preference).put(put_preference),
        )
        .route("/v1/notifications/unsubscribe", post(unsubscribe));

    Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .merge(api)
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(cors)
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}

async fn check_health(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
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
    let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
    if let Err(error) = assert_production_config(&config, &database_url) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    if !config.is_prod && config.internal_secret.is_empty() {
        tracing::warn!(
            "[notifications][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let store = Store::connect(Some(&database_url)).await?;
    let state = AppState {
        store: store.clone(),
        config: config.clone(),
        limiter: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = build_app(state.clone());
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[notifications] listening on :{} store={} delivery={}",
        config.port,
        if store.uses_postgres() { "postgres" } else { "memory" },
        if config.use_queue { "queue" } else { "local" }
    );
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { worker_loop(worker_state).await });
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    worker.abort();
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
    use super::db::{NewNotification, Store};
    use super::delivery;
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    async fn test_state() -> AppState {
        AppState {
            store: Store::connect(None).await.expect("memory store"),
            config: Config {
                port: 0,
                is_prod: false,
                internal_secret: String::new(),
                cors_origins: vec![],
                max_attempts: 5,
                rate_limit: 120,
                queue_url: String::new(),
                queue_name: "notifications".into(),
                use_queue: false,
                tick_ms: 500,
            },
            limiter: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[tokio::test]
    async fn health_and_validation() {
        let state = test_state().await;
        let app = build_app(state);
        let response = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["service"], "notifications");
        assert_eq!(body["store"], "memory");

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/notifications")
                    .header("content-type", "application/json")
                    .header("x-synapseone-org", "org-a")
                    .body(Body::from(r#"{"recipient":{},"body":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn templates_and_backoff() {
        assert_eq!(
            delivery::render_template(
                "Flood {{level}}m in {{city}}",
                &json!({"level": 2.5, "city": "Hanoi"})
            ),
            "Flood 2.5m in Hanoi"
        );
        assert_eq!(delivery::backoff_seconds(1), 5);
    }

    #[tokio::test]
    async fn idempotency_and_cancel() {
        let store = Store::connect(None).await.unwrap();
        let input = || NewNotification {
            tenant: "org:org-a".into(),
            channel: "log".into(),
            recipient: json!({"userId": "u2"}),
            subject: String::new(),
            body: "one".into(),
            idempotency_key: Some("log:key-1".into()),
            metadata: json!({}),
        };
        let first = store.create(input()).await.unwrap();
        let second = store.create(input()).await.unwrap();
        assert_eq!(first.id, second.id);
        let cancelled = store
            .cancel("org:org-a", &first.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(store.cancel("org:org-a", &first.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn tenant_isolation_on_read() {
        let state = test_state().await;
        let app = build_app(state.clone());
        let created = state
            .store
            .create(NewNotification {
                tenant: "org:org-a".into(),
                channel: "log".into(),
                recipient: json!({"userId": "u1"}),
                subject: String::new(),
                body: "hi".into(),
                idempotency_key: None,
                metadata: json!({}),
            })
            .await
            .unwrap();
        let response = app
            .oneshot(
                HttpRequest::builder()
                    .uri(format!("/v1/notifications/{}", created.id))
                    .header("x-synapseone-org", "org-b")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
