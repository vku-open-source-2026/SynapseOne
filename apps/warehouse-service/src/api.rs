// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP surface for Synapse Warehouse.

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Path, Request, State};
use axum::http::{header as http_header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::audit::{self, RequestId};
use crate::error::WarehouseError;
use crate::sql::{
    assert_read_only_sql, is_valid_dataset_id, normalize_columns, slugify_dataset_id,
};
use crate::store::{value_i64, WarehouseStore};
use crate::stream::StreamRuntime;
use crate::templates::etl_templates;
use crate::types::{NewDataset, NewJob};
use crate::usage::{self, UsageStatsFilter};
use crate::util::{header, js_string, number_value, truthy};

pub const VERSION: &str = "0.9.0";

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub is_prod: bool,
    pub internal_secret: String,
    pub max_body_bytes: usize,
}

impl Config {
    pub fn from_env() -> Self {
        let secret = std::env::var("SYNAPSEONE_INTERNAL_SECRET")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                std::env::var("SYNAPSEDX_INTERNAL_SECRET")
                    .ok()
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_default();
        Self {
            port: std::env::var("PORT")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("WAREHOUSE_PORT")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .and_then(|value| value.trim().parse::<u16>().ok())
                .unwrap_or(4012),
            is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
            internal_secret: secret,
            max_body_bytes: parse_body_limit(
                &std::env::var("WAREHOUSE_MAX_BODY").unwrap_or_else(|_| "8mb".into()),
            ),
        }
    }

    pub fn assert_production_config(&self) -> Result<(), String> {
        if !self.is_prod {
            return Ok(());
        }
        if self.internal_secret.is_empty() {
            return Err("[warehouse] SYNAPSEONE_INTERNAL_SECRET is required in production".into());
        }
        Ok(())
    }
}

/// Express `body-parser`/`bytes` compatible size parser (`8mb`, `512kb`, ...).
pub fn parse_body_limit(raw: &str) -> usize {
    let text = raw.trim().to_lowercase();
    if text.is_empty() {
        return 8 * 1024 * 1024;
    }
    let split = text
        .find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))
        .unwrap_or(text.len());
    let (number, suffix) = text.split_at(split);
    let Ok(value) = number.parse::<f64>() else {
        return 8 * 1024 * 1024;
    };
    if !value.is_finite() || value <= 0.0 {
        return 8 * 1024 * 1024;
    }
    let multiplier = match suffix.trim() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0 * 1024.0,
        "g" | "gb" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (value * multiplier).floor().clamp(1.0, usize::MAX as f64) as usize
}

#[derive(Clone)]
pub struct AppState {
    pub store: WarehouseStore,
    pub config: Config,
    pub stream: StreamRuntime,
}

#[derive(Clone)]
pub struct Tenant(pub String);

fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": code,
            "message": message,
        })),
    )
        .into_response()
}

fn body_value(body: &Bytes) -> Result<Value, WarehouseError> {
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body)
        .map_err(|_| WarehouseError::bad_request("invalid_json", "request body is not valid JSON"))
}

fn require_string(
    value: Option<&Value>,
    field: &str,
    max: usize,
) -> Result<String, WarehouseError> {
    let text = js_string(value).trim().to_string();
    if text.is_empty() {
        return Err(
            WarehouseError::bad_request("field_required", format!("{field} is required"))
                .with_details(json!({ "field": field })),
        );
    }
    if text.chars().count() > max {
        return Err(
            WarehouseError::bad_request("field_invalid", format!("{field} is too long"))
                .with_details(json!({ "field": field, "max": max })),
        );
    }
    Ok(text)
}

fn optional_string(value: Option<&Value>, max: usize) -> Option<String> {
    value.map(|value| js_string(Some(value)).trim().chars().take(max).collect())
}

fn positive_int(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    if value.is_none() {
        return fallback;
    }
    match number_value(value) {
        Some(number) if number.is_finite() => (number.floor() as i64).clamp(min, max),
        _ => fallback,
    }
}

fn topic_name(value: Option<&Value>) -> Result<String, WarehouseError> {
    let topic = js_string(value).trim().to_string();
    let valid = {
        let mut chars = topic.chars();
        matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
            && topic.len() <= 64
            && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    };
    if !valid {
        return Err(WarehouseError::bad_request(
            "invalid_topic",
            "streamTopic must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$",
        ));
    }
    Ok(topic)
}

fn group_name(value: Option<&Value>) -> Result<String, WarehouseError> {
    let group = js_string(value).trim().to_string();
    let valid = !group.is_empty()
        && group.len() <= 128
        && group
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'));
    if !valid {
        return Err(WarehouseError::bad_request(
            "invalid_group",
            "streamGroup is invalid",
        ));
    }
    Ok(group)
}

fn resolve_tenant(headers: &axum::http::HeaderMap, query: &str) -> String {
    let org = header(headers, "x-synapseone-org");
    if !org.is_empty() {
        return format!("org:{org}").chars().take(160).collect();
    }
    let account = header(headers, "x-synapseone-account");
    if !account.is_empty() {
        return format!("account:{account}").chars().take(160).collect();
    }
    let user = header(headers, "x-synapseone-user");
    if !user.is_empty() {
        return format!("user:{user}").chars().take(160).collect();
    }
    let mut explicit = header(headers, "x-synapseone-tenant");
    if explicit.is_empty() {
        explicit = url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "tenant")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
    }
    let explicit = explicit.trim();
    let valid = !explicit.is_empty()
        && explicit.len() <= 128
        && explicit
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '-'));
    if valid {
        return explicit.to_string();
    }
    "platform".into()
}

fn verify_internal(headers: &axum::http::HeaderMap, secret: &str) -> bool {
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

async fn tenant_middleware(mut request: Request, next: Next) -> Response {
    let query = request.uri().query().unwrap_or("").to_string();
    let tenant = resolve_tenant(request.headers(), &query);
    request.extensions_mut().insert(Tenant(tenant));
    next.run(request).await
}

async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let guarded = path.starts_with("/v1/") || path.starts_with("/internal/");
    if !guarded {
        return next.run(request).await;
    }
    if state.config.internal_secret.is_empty() {
        return if state.config.is_prod {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "misconfigured",
                "SYNAPSEONE_INTERNAL_SECRET is required in production",
            )
        } else {
            next.run(request).await
        };
    }
    if !verify_internal(request.headers(), &state.config.internal_secret) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or invalid internal credential",
        );
    }
    next.run(request).await
}

fn sanitize_request_id(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(128)
        .collect::<String>()
        .trim()
        .to_string()
}

async fn response_headers(mut request: Request, next: Next) -> Response {
    let incoming = header(request.headers(), "x-request-id");
    let request_id = if incoming.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        sanitize_request_id(&incoming)
    };
    request
        .extensions_mut()
        .insert(RequestId(request_id.clone()));
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        headers.insert("x-request-id", value);
    }
    headers.insert(
        http_header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        http_header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        http_header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

async fn body_limit(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let limit = state.config.max_body_bytes;
    let content_length = request
        .headers()
        .get(http_header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if content_length.is_some_and(|length| length > limit) {
        return json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body is too large",
        );
    }
    let (parts, body) = request.into_parts();
    match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => {
            let request = Request::from_parts(parts, axum::body::Body::from(bytes));
            next.run(request).await
        }
        Err(_) => json_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "request body is too large",
        ),
    }
}

fn tenant_of(tenant: &Tenant) -> &str {
    &tenant.0
}

async fn health() -> Response {
    Json(json!({
        "status": "ok",
        "service": "warehouse",
        "version": VERSION,
        "engine": "duckdb",
        "persistence": if std::env::var("WAREHOUSE_IN_MEMORY").as_deref() == Ok("1") { "memory" } else { "file" },
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
    .into_response()
}

async fn ready() -> Response {
    Json(json!({ "status": "ok", "service": "warehouse" })).into_response()
}

async fn metrics(State(state): State<AppState>) -> Response {
    let result: Result<String, WarehouseError> = async {
        let mut datasets = 0i64;
        let mut jobs = 0i64;
        let mut applied = 0i64;
        let mut running = 0i64;
        for tenant in state.store.list_tenants() {
            let status = state.store.pipeline_status(&tenant).await?;
            datasets += value_i64(status.get("datasets"));
            jobs += value_i64(status.get("jobs"));
            applied += value_i64(status.get("appliedEvents"));
            running += value_i64(status.get("running"));
        }
        Ok(format!(
            "# HELP synapseone_warehouse_up Warehouse service availability\n\
             # TYPE synapseone_warehouse_up gauge\n\
             synapseone_warehouse_up 1\n\
             # HELP synapseone_warehouse_datasets Tenant datasets\n\
             # TYPE synapseone_warehouse_datasets gauge\n\
             synapseone_warehouse_datasets {datasets}\n\
             # HELP synapseone_warehouse_jobs ETL jobs\n\
             # TYPE synapseone_warehouse_jobs gauge\n\
             synapseone_warehouse_jobs {jobs}\n\
             # HELP synapseone_warehouse_running_stream_jobs Running stream jobs\n\
             # TYPE synapseone_warehouse_running_stream_jobs gauge\n\
             synapseone_warehouse_running_stream_jobs {running}\n\
             # HELP synapseone_warehouse_applied_events Durable stream event markers\n\
             # TYPE synapseone_warehouse_applied_events gauge\n\
             synapseone_warehouse_applied_events {applied}\n"
        ))
    }
    .await;
    match result {
        Ok(body) => (
            StatusCode::OK,
            [(http_header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            body,
        )
            .into_response(),
        Err(_) => (
            StatusCode::OK,
            [(http_header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "synapseone_warehouse_up 0\n",
        )
            .into_response(),
    }
}

async fn list_datasets(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
) -> Result<Response, WarehouseError> {
    let items = state.store.list_datasets(tenant_of(&tenant)).await?;
    Ok(Json(json!({ "items": items })).into_response())
}

async fn create_dataset(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let name = require_string(body.get("name"), "name", 120)?;
    let id_input = match body.get("id") {
        Some(value) if !value.is_null() => value.clone(),
        _ => Value::String(name.clone()),
    };
    let id = slugify_dataset_id(Some(&id_input));
    if !is_valid_dataset_id(&id) {
        return Err(WarehouseError::bad_request(
            "invalid_id",
            "id must be a lower-case slug of 2..41 characters",
        ));
    }
    let columns = normalize_columns(body.get("columns"))
        .map_err(|error| WarehouseError::bad_request("invalid_columns", error))?;
    let mode = if body.get("mode").and_then(Value::as_str) == Some("stream") {
        "stream"
    } else {
        "batch"
    };
    let stream_topic = if mode == "stream" {
        Some(topic_name(body.get("streamTopic"))?)
    } else {
        None
    };
    let dataset = state
        .store
        .create_dataset(
            tenant_of(&tenant),
            NewDataset {
                id,
                name,
                description: optional_string(body.get("description"), 500).unwrap_or_default(),
                columns,
                mode: mode.into(),
                stream_topic,
            },
        )
        .await?;
    Ok((StatusCode::CREATED, Json(dataset)).into_response())
}

async fn get_dataset(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    match state.store.get_dataset(tenant_of(&tenant), &id).await? {
        Some(dataset) => Ok(Json(dataset).into_response()),
        None => Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "dataset_not_found",
            "dataset not found",
        )),
    }
}

async fn delete_dataset(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    if state.store.delete_dataset(tenant_of(&tenant), &id).await? {
        Ok(Json(json!({ "ok": true, "deleted": true })).into_response())
    } else {
        Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "dataset_not_found",
            "dataset not found",
        ))
    }
}

async fn insert_rows(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let dataset = state
        .store
        .get_dataset(tenant_of(&tenant), &id)
        .await?
        .ok_or_else(|| {
            WarehouseError::new(
                StatusCode::NOT_FOUND,
                "dataset_not_found",
                "dataset not found",
            )
        })?;
    let body = body_value(&body)?;
    let rows = body
        .get("rows")
        .and_then(Value::as_array)
        .or_else(|| body.as_array())
        .ok_or_else(|| {
            WarehouseError::bad_request("invalid_rows", "body must be { rows: [...] }")
        })?;
    let inserted = state
        .store
        .insert_rows(tenant_of(&tenant), &dataset, rows)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "inserted": inserted })),
    )
        .into_response())
}

async fn run_query(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let sql = assert_read_only_sql(body.get("sql"))
        .map_err(|error| WarehouseError::bad_request("invalid_sql", error))?;
    let result = state
        .store
        .query(
            tenant_of(&tenant),
            Some(&Value::String(sql)),
            positive_int(body.get("limit"), 200, 1, 5000),
        )
        .await?;
    Ok(Json(result).into_response())
}

async fn etl_batch(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    if state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .is_none()
    {
        return Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "dataset_not_found",
            "target dataset not found",
        ));
    }
    let sql = assert_read_only_sql(body.get("sql"))
        .map_err(|error| WarehouseError::bad_request("invalid_sql", error))?;
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("adhoc-{target_dataset_id}"),
    };
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "batch".into(),
                target_dataset_id,
                sql: Some(sql),
                stream_topic: None,
                stream_group: None,
                batch_size: 100,
                interval_ms: 1000,
                write_mode: if body.get("writeMode").and_then(Value::as_str) == Some("replace") {
                    "replace".into()
                } else {
                    "append".into()
                },
            },
        )
        .await?;
    let (rows, duration_ms) = state.store.run_batch_job(tenant_of(&tenant), &job).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "job": job,
            "rows": rows,
            "durationMs": duration_ms as u64,
        })),
    )
        .into_response())
}

async fn etl_stream(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    if state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .is_none()
    {
        return Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "dataset_not_found",
            "target dataset not found",
        ));
    }
    let stream_topic = topic_name(body.get("streamTopic"))?;
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("stream-{target_dataset_id}"),
    };
    if let Some(existing) = state
        .store
        .find_job_by_name(tenant_of(&tenant), &name)
        .await?
    {
        return Ok(Json(json!({ "ok": true, "created": false, "job": existing })).into_response());
    }
    let group = match body.get("streamGroup") {
        Some(value) if !value.is_null() => group_name(Some(value))?,
        _ => format!("warehouse_{}", Uuid::new_v4()),
    };
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "stream".into(),
                target_dataset_id,
                sql: None,
                stream_topic: Some(stream_topic),
                stream_group: Some(group),
                batch_size: positive_int(body.get("batchSize"), 100, 1, 100),
                interval_ms: positive_int(body.get("intervalMs"), 1000, 100, 60000),
                write_mode: "append".into(),
            },
        )
        .await?;
    state
        .stream
        .spawn(tenant_of(&tenant).to_string(), job.id.clone());
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "created": true, "job": job })),
    )
        .into_response())
}

async fn templates() -> Response {
    Json(json!({ "items": etl_templates() })).into_response()
}

async fn pipeline_status(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
) -> Result<Response, WarehouseError> {
    let mut status = state.store.pipeline_status(tenant_of(&tenant)).await?;
    if let Some(object) = status.as_object_mut() {
        object.insert("ok".into(), Value::Bool(true));
    }
    Ok(Json(status).into_response())
}

async fn list_jobs(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
) -> Result<Response, WarehouseError> {
    let items = state.store.list_jobs(tenant_of(&tenant)).await?;
    Ok(Json(json!({ "items": items })).into_response())
}

async fn create_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let mode = match body.get("mode") {
        Some(value) if !value.is_null() => js_string(Some(value)),
        _ => "batch".into(),
    };
    if mode != "batch" && mode != "stream" {
        return Err(WarehouseError::bad_request(
            "invalid_mode",
            "mode must be 'batch' or 'stream'",
        ));
    }
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    if state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .is_none()
    {
        return Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "dataset_not_found",
            "target dataset not found",
        ));
    }
    let (sql, stream_topic, stream_group) = if mode == "batch" {
        let sql = assert_read_only_sql(body.get("sql"))
            .map_err(|error| WarehouseError::bad_request("invalid_sql", error))?;
        (Some(sql), None, None)
    } else {
        let topic = topic_name(body.get("streamTopic"))?;
        let group = match body.get("streamGroup") {
            Some(value) if !value.is_null() => group_name(Some(value))?,
            _ => format!("warehouse_{}", Uuid::new_v4()),
        };
        (None, Some(topic), Some(group))
    };
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("{mode}-{target_dataset_id}"),
    };
    let write_mode = if body.get("writeMode").and_then(Value::as_str) == Some("replace") {
        "replace"
    } else {
        "append"
    };
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: mode.clone(),
                target_dataset_id,
                sql,
                stream_topic,
                stream_group,
                batch_size: positive_int(body.get("batchSize"), 100, 1, 100),
                interval_ms: positive_int(body.get("intervalMs"), 1000, 100, 60000),
                write_mode: write_mode.into(),
            },
        )
        .await?;
    if mode == "stream" {
        state
            .stream
            .spawn(tenant_of(&tenant).to_string(), job.id.clone());
    }
    Ok((StatusCode::CREATED, Json(job)).into_response())
}

async fn get_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    match state.store.get_job(tenant_of(&tenant), &id).await? {
        Some(job) => Ok(Json(job).into_response()),
        None => Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "job_not_found",
            "job not found",
        )),
    }
}

async fn run_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    let job = state
        .store
        .get_job(tenant_of(&tenant), &id)
        .await?
        .ok_or_else(|| {
            WarehouseError::new(StatusCode::NOT_FOUND, "job_not_found", "job not found")
        })?;
    if job.mode != "batch" {
        return Err(WarehouseError::bad_request(
            "invalid_job",
            "only batch jobs can be run manually",
        ));
    }
    let (rows, duration_ms) = state.store.run_batch_job(tenant_of(&tenant), &job).await?;
    Ok(Json(json!({
        "ok": true,
        "rows": rows,
        "durationMs": duration_ms as u64,
    }))
    .into_response())
}

async fn pause_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    let job = state
        .store
        .set_job_status(tenant_of(&tenant), &id, "paused")
        .await?
        .ok_or_else(|| {
            WarehouseError::new(StatusCode::NOT_FOUND, "job_not_found", "job not found")
        })?;
    state.stream.stop(&job.id);
    Ok(Json(job).into_response())
}

async fn resume_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    let job = state
        .store
        .set_job_status(tenant_of(&tenant), &id, "running")
        .await?
        .ok_or_else(|| {
            WarehouseError::new(StatusCode::NOT_FOUND, "job_not_found", "job not found")
        })?;
    if job.mode == "stream" {
        state
            .stream
            .spawn(tenant_of(&tenant).to_string(), job.id.clone());
    }
    Ok(Json(job).into_response())
}

async fn delete_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Result<Response, WarehouseError> {
    state.stream.stop(&id);
    if state.store.delete_job(tenant_of(&tenant), &id).await? {
        Ok(Json(json!({ "ok": true, "deleted": true })).into_response())
    } else {
        Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "job_not_found",
            "job not found",
        ))
    }
}

async fn rollup(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let (hourly, users) =
        usage::replace_usage_rollup(&state.store, tenant_of(&tenant), &body).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "ok": true, "hourly": hourly, "users": users })),
    )
        .into_response())
}

async fn watermark(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
) -> Result<Response, WarehouseError> {
    let mut value = usage::usage_watermark(&state.store, tenant_of(&tenant)).await?;
    if let Some(object) = value.as_object_mut() {
        object.insert("ok".into(), Value::Bool(true));
    }
    Ok(Json(value).into_response())
}

async fn usage_summary(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let filter = UsageStatsFilter {
        from: js_string(body.get("from")),
        to: js_string(body.get("to")),
        feature: body
            .get("feature")
            .filter(|value| truthy(value))
            .map(|value| js_string(Some(value))),
        account_id: body
            .get("accountId")
            .filter(|value| truthy(value))
            .map(|value| js_string(Some(value))),
        method: body
            .get("method")
            .filter(|value| truthy(value))
            .map(|value| js_string(Some(value))),
        status_class: body
            .get("statusClass")
            .filter(|value| truthy(value))
            .map(|value| {
                number_value(Some(value))
                    .filter(|number| number.is_finite())
                    .map(|number| number.floor() as i64)
                    .unwrap_or(0)
            }),
    };
    let summary = usage::usage_stats_summary(&state.store, tenant_of(&tenant), filter).await?;
    Ok(Json(summary).into_response())
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found", "route not found")
}

pub fn build_app(state: AppState) -> Router {
    let limit = state.config.max_body_bytes;
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods(Any)
        .allow_headers(Any);
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/metrics", get(metrics))
        .route(
            "/v1/warehouse/datasets",
            get(list_datasets).post(create_dataset),
        )
        .route(
            "/v1/warehouse/datasets/{id}",
            get(get_dataset).delete(delete_dataset),
        )
        .route("/v1/warehouse/datasets/{id}/rows", post(insert_rows))
        .route("/v1/warehouse/query", post(run_query))
        .route("/v1/warehouse/etl/batch", post(etl_batch))
        .route("/v1/warehouse/etl/stream", post(etl_stream))
        .route("/v1/warehouse/templates", get(templates))
        .route("/v1/warehouse/pipeline/status", get(pipeline_status))
        .route("/v1/warehouse/jobs", get(list_jobs).post(create_job))
        .route("/v1/warehouse/jobs/{id}", get(get_job).delete(delete_job))
        .route("/v1/warehouse/jobs/{id}/run", post(run_job))
        .route("/v1/warehouse/jobs/{id}/pause", post(pause_job))
        .route("/v1/warehouse/jobs/{id}/resume", post(resume_job))
        .route("/internal/usage/rollup", post(rollup))
        .route("/internal/usage/watermark", get(watermark))
        .route("/internal/usage/summary", post(usage_summary))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn(tenant_middleware))
        .layer(DefaultBodyLimit::max(limit))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn_with_state(state.clone(), body_limit))
        .layer(middleware::from_fn(audit::middleware))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .layer(middleware::from_fn(response_headers))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_limits_accept_express_units() {
        assert_eq!(parse_body_limit("8mb"), 8 * 1024 * 1024);
        assert_eq!(parse_body_limit("512kb"), 512 * 1024);
        assert_eq!(parse_body_limit("1024"), 1024);
        assert_eq!(parse_body_limit("1gb"), 1024 * 1024 * 1024);
        assert_eq!(parse_body_limit("nonsense"), 8 * 1024 * 1024);
    }

    #[test]
    fn tenant_resolution_prefers_org_then_account_then_user() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-synapseone-org", HeaderValue::from_static("acme"));
        headers.insert("x-synapseone-user", HeaderValue::from_static("u-1"));
        assert_eq!(resolve_tenant(&headers, ""), "org:acme");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-synapseone-account", HeaderValue::from_static("acc"));
        assert_eq!(resolve_tenant(&headers, ""), "account:acc");
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-synapseone-user", HeaderValue::from_static("u-1"));
        assert_eq!(resolve_tenant(&headers, ""), "user:u-1");
        let headers = axum::http::HeaderMap::new();
        assert_eq!(resolve_tenant(&headers, "tenant=explicit-1"), "explicit-1");
        assert_eq!(resolve_tenant(&headers, ""), "platform");
    }

    #[test]
    fn topic_and_group_validation_matches_the_contract() {
        assert!(topic_name(Some(&json!("iot-sensors"))).is_ok());
        assert!(topic_name(Some(&json!("1bad"))).is_err());
        assert!(topic_name(Some(&json!("bad topic"))).is_err());
        assert!(group_name(Some(&json!("warehouse_abc-1.2"))).is_ok());
        assert!(group_name(Some(&json!("bad group"))).is_err());
    }
}
