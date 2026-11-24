// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP surface for Synapse Warehouse.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Extension, Path, Query, Request, State};
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

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn build_version() -> String {
    std::env::var("SYNAPSEONE_BUILD_VERSION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or_else(|| VERSION.to_string())
}


#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub is_prod: bool,
    pub internal_secret: String,
    pub max_body_bytes: usize,
    pub base_service_url: String,
    pub lakehouse_service_url: String,
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
            base_service_url: std::env::var("BASE_SERVICE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "http://base:4005".into())
                .trim_end_matches('/')
                .to_string(),
            lakehouse_service_url: std::env::var("LAKEHOUSE_SERVICE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "http://lakehouse:4013".into())
                .trim_end_matches('/')
                .to_string(),
        }
    }

    pub fn assert_production_config(&self) -> Result<(), String> {
        if !self.is_prod {
            return Ok(());
        }
        if self.internal_secret.is_empty() {
            return Err("[warehouse] SYNAPSEONE_INTERNAL_SECRET is required in production".into());
        }
        let data_dir = std::env::var("WAREHOUSE_DATA_DIR").unwrap_or_default();
        if std::env::var("WAREHOUSE_IN_MEMORY").as_deref() == Ok("1")
            || data_dir.trim() == ":memory:"
        {
            return Err(
                "[warehouse] WAREHOUSE_IN_MEMORY/:memory: is forbidden in production (analytics must survive restart)"
                    .into(),
            );
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
        "version": build_version(),
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
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, WarehouseError> {
    let items = state.store.list_datasets(tenant_of(&tenant)).await?;
    let name = params
        .get("name")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let mode = params
        .get("mode")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let filtered: Vec<_> = items
        .into_iter()
        .filter(|dataset| {
            name.as_ref()
                .is_none_or(|needle| dataset.name.to_ascii_lowercase().contains(needle))
                && mode
                    .as_ref()
                    .is_none_or(|wanted| dataset.mode.eq_ignore_ascii_case(wanted))
        })
        .collect();
    let total = filtered.len();
    let (offset, limit) = page_params(&params);
    let page: Vec<_> = filtered.into_iter().skip(offset).take(limit).collect();
    Ok(Json(json!({
        "items": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "nextOffset": if offset + limit < total { Some(offset + limit) } else { None::<usize> },
    }))
    .into_response())
}

fn page_params(params: &HashMap<String, String>) -> (usize, usize) {
    let offset = params
        .get("offset")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
        .min(1_000_000);
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 200);
    (offset, limit)
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

async fn update_dataset(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let object = body
        .as_object()
        .ok_or_else(|| WarehouseError::bad_request("invalid_body", "body must be a JSON object"))?;
    if !object.contains_key("name") && !object.contains_key("description") {
        return Err(WarehouseError::bad_request(
            "invalid_body",
            "send at least one of name or description",
        ));
    }
    let name = match object.get("name") {
        Some(value) => Some(require_string(Some(value), "name", 120)?),
        None => None,
    };
    let description = match object.get("description") {
        Some(value) if !value.is_null() => Some(optional_string(Some(value), 500).unwrap_or_default()),
        Some(_) => Some(String::new()),
        None => None,
    };
    match state
        .store
        .update_dataset(tenant_of(&tenant), &id, name, description)
        .await?
    {
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
    // Stop stream workers before dropping the dataset/jobs so a detached task
    // cannot keep polling and writing into a table that is being removed.
    for job in state
        .store
        .list_jobs(tenant_of(&tenant))
        .await?
        .into_iter()
        .filter(|job| job.target_dataset_id.as_str() == id.as_str() && job.mode == "stream")
    {
        state.stream.stop(&job.id);
    }
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
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
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
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
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

fn base_slug(value: &str, field: &str) -> Result<String, WarehouseError> {
    let text = value.trim();
    if text.is_empty()
        || text.len() > 120
        || !text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return Err(WarehouseError::bad_request(
            "invalid_source",
            format!("{field} must be 1..120 chars of letters, numbers, '_' or '-'"),
        ));
    }
    Ok(text.to_string())
}

fn base_document_row(item: &Value, collection: &str) -> Value {
    let data = item
        .get("data")
        .or_else(|| item.get("object"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut row = if data.is_object() {
        data
    } else {
        json!({ "value": data })
    };
    if let Some(object) = row.as_object_mut() {
        object
            .entry("document_id")
            .or_insert_with(|| item.get("id").cloned().unwrap_or(Value::Null));
        object
            .entry("collection")
            .or_insert_with(|| Value::String(collection.to_string()));
        object
            .entry("version")
            .or_insert_with(|| item.get("version").cloned().unwrap_or(Value::Null));
        object
            .entry("created_at")
            .or_insert_with(|| item.get("createdAt").cloned().unwrap_or(Value::Null));
        object
            .entry("updated_at")
            .or_insert_with(|| item.get("updatedAt").cloned().unwrap_or(Value::Null));
    }
    row
}

fn ocs_format(requested: Option<&str>, key: &str) -> Result<String, WarehouseError> {
    let explicit = requested.map(|value| value.trim().to_ascii_lowercase());
    let format = match explicit.as_deref() {
        Some("csv") => "csv",
        Some("json") | Some("jsonl") | Some("ndjson") => "jsonl",
        Some("parquet") => "parquet",
        Some("") | None => {
            let extension = key.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            match extension.as_str() {
                "csv" => "csv",
                "json" | "jsonl" | "ndjson" => "jsonl",
                "parquet" => "parquet",
                _ => {
                    return Err(WarehouseError::bad_request(
                        "ocs_format_required",
                        "format is required (csv, jsonl, parquet) when the key has no known extension",
                    ))
                }
            }
        }
        Some(other) => {
            return Err(WarehouseError::bad_request(
                "invalid_ocs_format",
                format!("format '{other}' is not supported (csv, jsonl, parquet)"),
            ))
        }
    };
    Ok(format.to_string())
}

fn valid_ocs_bucket(bucket: &str) -> bool {
    let bytes = bucket.as_bytes();
    (3..=63).contains(&bytes.len())
        && bytes.first().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
}

fn ocs_object_url(base: &str, bucket: &str, key: &str) -> Result<reqwest::Url, WarehouseError> {
    if !valid_ocs_bucket(bucket) {
        return Err(WarehouseError::bad_request(
            "invalid_bucket",
            "bucket must be 3..63 lowercase letters, digits, dots or hyphens",
        ));
    }
    if key.is_empty() || key.len() > 1024 || key.starts_with('/') || key.contains("..") || key.contains('\0') {
        return Err(WarehouseError::bad_request(
            "invalid_object_key",
            "object key must be 1..1024 characters and must not start with / or contain ..",
        ));
    }
    let mut url = reqwest::Url::parse(&format!(
        "{}/v1/ocs/buckets/{}/objects",
        base.trim_end_matches('/'),
        bucket
    ))
    .map_err(|_| WarehouseError::bad_request("invalid_ocs_url", "OCS_SERVICE_URL is invalid"))?;
    url.path_segments_mut()
        .map_err(|_| WarehouseError::bad_request("invalid_ocs_url", "OCS_SERVICE_URL is invalid"))?
        .extend(key.split('/').filter(|segment| !segment.is_empty()));
    Ok(url)
}

async fn fetch_ocs_file(
    state: &AppState,
    tenant: &Tenant,
    bucket: &str,
    key: &str,
) -> Result<Vec<u8>, WarehouseError> {
    let base = std::env::var("OCS_SERVICE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "http://ocs:4010".into());
    let url = ocs_object_url(&base, bucket, key)?;
    let mut request = reqwest::Client::new().get(url);
    let (tenant_header, tenant_value) = if let Some(org) = tenant_of(tenant).strip_prefix("org:") {
        ("x-synapseone-org", org.to_string())
    } else if let Some(account) = tenant_of(tenant).strip_prefix("account:") {
        ("x-synapseone-account", account.to_string())
    } else {
        return Err(WarehouseError::new(
            StatusCode::FORBIDDEN,
            "tenant_scope_required",
            "OCS ingestion requires an organization or account scope",
        ));
    };
    request = request.header(tenant_header, tenant_value);
    if !state.config.internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", state.config.internal_secret.as_str());
    }
    let response = request.send().await.map_err(|error| {
        WarehouseError::new(
            StatusCode::BAD_GATEWAY,
            "ocs_upstream_error",
            format!("OCS request failed: {error}"),
        )
    })?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        let message: String = text.chars().take(300).collect();
        return Err(WarehouseError::new(
            StatusCode::BAD_GATEWAY,
            "ocs_upstream_error",
            format!("OCS returned {}: {message}", status.as_u16()),
        ));
    }
    let max_bytes = std::env::var("WAREHOUSE_OCS_MAX_FILE_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(64 * 1024 * 1024)
        .clamp(1024 * 1024, 512 * 1024 * 1024);
    if response.content_length().is_some_and(|length| length > max_bytes as u64) {
        return Err(WarehouseError::bad_request(
            "ocs_file_too_large",
            format!("OCS object exceeds the {max_bytes}-byte ingestion limit"),
        ));
    }
    let bytes = response.bytes().await.map_err(|error| {
        WarehouseError::new(
            StatusCode::BAD_GATEWAY,
            "ocs_upstream_error",
            format!("OCS body read failed: {error}"),
        )
    })?;
    if bytes.len() > max_bytes {
        return Err(WarehouseError::bad_request(
            "ocs_file_too_large",
            format!("OCS object exceeds the {max_bytes}-byte ingestion limit"),
        ));
    }
    Ok(bytes.to_vec())
}

async fn stage_ocs_file(bytes: &[u8], format: &str) -> Result<std::path::PathBuf, WarehouseError> {
    let path = std::env::temp_dir().join(format!(
        "synapseone-warehouse-ocs-{}.{}",
        Uuid::new_v4(),
        format
    ));
    tokio::fs::write(&path, bytes).await.map_err(|error| {
        WarehouseError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ocs_stage_failed",
            format!("could not stage OCS file: {error}"),
        )
    })?;
    Ok(path)
}

async fn etl_ocs_preview(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let bucket = require_string(body.get("bucket"), "bucket", 63)?;
    let key = require_string(body.get("key"), "key", 1024)?;
    let format = ocs_format(body.get("format").and_then(Value::as_str), &key)?;
    let bytes = fetch_ocs_file(&state, &tenant, &bucket, &key).await?;
    let path = stage_ocs_file(&bytes, &format).await?;
    let result = state
        .store
        .preview_ocs_file(tenant_of(&tenant), path.to_string_lossy().as_ref(), &format)
        .await;
    let _ = tokio::fs::remove_file(&path).await;
    let (columns, rows) = result?;
    Ok(Json(json!({
        "ok": true,
        "bucket": bucket,
        "key": key,
        "format": format,
        "bytes": bytes.len(),
        "columns": columns,
        "rows": rows,
    }))
    .into_response())
}

async fn etl_ocs(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let bucket = require_string(body.get("bucket"), "bucket", 63)?;
    let key = require_string(body.get("key"), "key", 1024)?;
    let format = ocs_format(body.get("format").and_then(Value::as_str), &key)?;
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    let dataset = state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .ok_or_else(|| WarehouseError::new(StatusCode::NOT_FOUND, "dataset_not_found", "target dataset not found"))?;
    let write_mode = match body.get("writeMode").and_then(Value::as_str) {
        None | Some("replace") => "replace",
        Some("append") => "append",
        Some(_) => return Err(WarehouseError::bad_request("invalid_write_mode", "writeMode must be 'replace' or 'append'")),
    };
    let max_rows = positive_int(body.get("maxRows"), 100_000, 1, 1_000_000);
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("ocs-{}-{}-{target_dataset_id}", bucket, key.rsplit('/').next().unwrap_or("file")),
    };
    let bytes = fetch_ocs_file(&state, &tenant, &bucket, &key).await?;
    let path = stage_ocs_file(&bytes, &format).await?;
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "batch".into(),
                target_dataset_id,
                sql: None,
                stream_topic: None,
                stream_group: None,
                batch_size: max_rows,
                interval_ms: 1000,
                write_mode: write_mode.into(),
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
            },
        )
        .await?;
    let result = state
        .store
        .import_ocs_file(
            tenant_of(&tenant),
            &dataset,
            path.to_string_lossy().as_ref(),
            &format,
            write_mode,
            max_rows,
        )
        .await;
    let _ = tokio::fs::remove_file(&path).await;
    match result {
        Ok(rows) => {
            state
                .store
                .record_job_run(tenant_of(&tenant), &job.id, rows as i64)
                .await?;
            Ok((StatusCode::CREATED, Json(json!({
                "ok": true,
                "job": job,
                "rows": rows,
                "bytes": bytes.len(),
                "format": format,
                "bucket": bucket,
                "key": key,
                "writeMode": write_mode,
            }))).into_response())
        }
        Err(error) => {
            let _ = state.store.record_job_error(tenant_of(&tenant), &job.id, &error).await;
            let _ = state.store.set_job_status(tenant_of(&tenant), &job.id, "error").await;
            Err(error)
        }
    }
}

/// Copy a Base collection into a Warehouse dataset. This is the batch source
/// connector; incremental changes travel through the Base outbox → Stream →
/// stream ETL path. `replace` clears the target once before the snapshot,
/// `append` is at-least-once and relies on the caller's dedupe/query.
async fn etl_base(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    let dataset = state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .ok_or_else(|| {
            WarehouseError::new(
                StatusCode::NOT_FOUND,
                "dataset_not_found",
                "target dataset not found",
            )
        })?;
    let collection = base_slug(
        &require_string(body.get("collection"), "collection", 120)?,
        "collection",
    )?;
    let database = match body.get("database").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Some(base_slug(value, "database")?),
        _ => None,
    };
    let write_mode = match body.get("writeMode").and_then(Value::as_str) {
        None | Some("replace") => "replace",
        Some("append") => "append",
        Some(_) => {
            return Err(WarehouseError::bad_request(
                "invalid_write_mode",
                "writeMode must be 'replace' or 'append'",
            ))
        }
    };
    let page_size = positive_int(body.get("pageSize"), 1000, 1, 1000);
    let max_rows = positive_int(body.get("maxRows"), 100_000, 1, 1_000_000);
    let (tenant_header, tenant_value) = if let Some(org) = tenant_of(&tenant).strip_prefix("org:") {
        ("x-synapseone-org", org.to_string())
    } else if let Some(account) = tenant_of(&tenant).strip_prefix("account:") {
        ("x-synapseone-account", account.to_string())
    } else {
        return Err(WarehouseError::new(
            StatusCode::FORBIDDEN,
            "tenant_scope_required",
            "Base ingestion requires an organization or account scope",
        ));
    };
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("base-{collection}-{target_dataset_id}"),
    };
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "base".into(),
                target_dataset_id: target_dataset_id.clone(),
                sql: None,
                stream_topic: None,
                stream_group: None,
                batch_size: page_size,
                interval_ms: 1000,
                write_mode: write_mode.into(),
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
            },
        )
        .await?;
    let client = reqwest::Client::new();
    let base = state.config.base_service_url.trim_end_matches('/');
    let result: Result<(usize, usize), WarehouseError> = async {
        let mut offset = 0i64;
        let mut inserted = 0usize;
        let mut pages = 0usize;
        let mut collected: Vec<Value> = Vec::new();
        loop {
            let loaded = if write_mode == "replace" {
                collected.len()
            } else {
                inserted
            };
            if loaded >= max_rows as usize {
                break;
            }
            let path = match &database {
                Some(database) => format!(
                    "/v1/base/databases/{database}/collections/{collection}/documents"
                ),
                None => format!("/v1/base/collections/{collection}/documents"),
            };
            let mut request = client
                .get(format!(
                    "{base}{path}?limit={page_size}&offset={offset}&withTotal=1"
                ))
                .header(tenant_header, &tenant_value);
            if !state.config.internal_secret.is_empty() {
                request = request.header(
                    "x-synapseone-internal",
                    state.config.internal_secret.as_str(),
                );
            }
            let response = request.send().await.map_err(|error| {
                WarehouseError::new(
                    StatusCode::BAD_GATEWAY,
                    "base_upstream_error",
                    format!("Base request failed: {error}"),
                )
            })?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if !status.is_success() {
                let message: String = text.chars().take(300).collect();
                return Err(WarehouseError::new(
                    StatusCode::BAD_GATEWAY,
                    "base_upstream_error",
                    format!("Base returned {}: {message}", status.as_u16()),
                ));
            }
            let value: Value = serde_json::from_str(&text).map_err(|_| {
                WarehouseError::new(
                    StatusCode::BAD_GATEWAY,
                    "base_upstream_error",
                    "Base returned a non-JSON response",
                )
            })?;
            let items = value
                .get("items")
                .and_then(Value::as_array)
                .or_else(|| value.as_array())
                .cloned()
                .unwrap_or_default();
            if items.is_empty() {
                break;
            }
            pages += 1;
            let total = value.get("total").and_then(Value::as_i64).unwrap_or(0);
            let loaded = if write_mode == "replace" {
                collected.len()
            } else {
                inserted
            };
            let remaining = max_rows as usize - loaded;
            let take = items.len().min(remaining);
            let rows: Vec<Value> = items
                .iter()
                .take(take)
                .map(|item| base_document_row(item, &collection))
                .collect();
            if write_mode == "replace" {
                collected.extend(rows);
            } else {
                inserted += state
                    .store
                    .insert_rows(tenant_of(&tenant), &dataset, &rows)
                    .await?;
            }
            offset += items.len() as i64;
            if take < items.len()
                || items.len() < page_size as usize
                || (total > 0 && offset >= total)
            {
                break;
            }
        }
        if write_mode == "replace" {
            inserted = state
                .store
                .replace_dataset_rows(tenant_of(&tenant), &dataset, &collected)
                .await?;
        }
        Ok((inserted, pages))
    }
    .await;

    match result {
        Ok((inserted, pages)) => {
            state
                .store
                .record_job_run(tenant_of(&tenant), &job.id, inserted as i64)
                .await?;
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "ok": true,
                    "job": job,
                    "rows": inserted,
                    "pages": pages,
                    "source": "base",
                    "collection": collection,
                    "writeMode": write_mode,
                })),
            )
                .into_response())
        }
        Err(error) => {
            let _ = state
                .store
                .record_job_error(tenant_of(&tenant), &job.id, &error)
                .await;
            let _ = state
                .store
                .set_job_status(tenant_of(&tenant), &job.id, "error")
                .await;
            Err(error)
        }
    }
}

fn lakehouse_slug(value: &str, field: &str) -> Result<String, WarehouseError> {
    let text = value.trim().to_ascii_lowercase();
    if text.is_empty()
        || text.len() > 41
        || !text
            .chars()
            .next()
            .map(|ch| ch.is_ascii_lowercase())
            .unwrap_or(false)
        || !text
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err(WarehouseError::bad_request(
            "invalid_source",
            format!("{field} must match [a-z][a-z0-9_]{{0,40}}"),
        ));
    }
    Ok(text)
}

/// Create a durable Base → Stream → Lakehouse ETL job. The destination table
/// is an append-only Iceberg change log; `write_mode` is always append.
async fn etl_base_lakehouse(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let collection = base_slug(
        &require_string(body.get("collection"), "collection", 120)?,
        "collection",
    )?;
    let database = match body.get("database").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => Some(base_slug(value, "database")?),
        _ => None,
    };
    let namespace = lakehouse_slug(
        &require_string(body.get("namespace"), "namespace", 41)?,
        "namespace",
    )?;
    let table = lakehouse_slug(
        &require_string(body.get("table"), "table", 41)?,
        "table",
    )?;
    let stream_topic = match body.get("streamTopic").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => topic_name(Some(&Value::String(value.into())))?,
        _ => "base-changes".into(),
    };
    let stream_group = match body.get("streamGroup").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => group_name(Some(&Value::String(value.into())))?,
        _ => format!("warehouse_lakehouse_{}", Uuid::new_v4()),
    };
    let batch_size = positive_int(body.get("batchSize"), 100, 1, 100);
    let interval_ms = positive_int(body.get("intervalMs"), 1000, 100, 60000);
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("base-lakehouse-{collection}-{table}"),
    };
    let (tenant_header, tenant_value) = if let Some(org) = tenant_of(&tenant).strip_prefix("org:") {
        ("x-synapseone-org", org.to_string())
    } else if let Some(account) = tenant_of(&tenant).strip_prefix("account:") {
        ("x-synapseone-account", account.to_string())
    } else {
        return Err(WarehouseError::new(
            StatusCode::FORBIDDEN,
            "tenant_scope_required",
            "Lakehouse ingestion requires an organization or account scope",
        ));
    };
    let mut metadata_request = reqwest::Client::new()
        .get(format!(
            "{}/v1/lakehouse/namespaces/{namespace}/tables/{table}",
            state.config.lakehouse_service_url
        ))
        .header(tenant_header, &tenant_value);
    if !state.config.internal_secret.is_empty() {
        metadata_request = metadata_request.header(
            "x-synapseone-internal",
            state.config.internal_secret.as_str(),
        );
    }
    let metadata_response = metadata_request.send().await.map_err(|error| {
        WarehouseError::new(
            StatusCode::BAD_GATEWAY,
            "lakehouse_upstream_error",
            format!("Lakehouse table lookup failed: {error}"),
        )
    })?;
    let metadata_status = metadata_response.status();
    let metadata_text = metadata_response.text().await.unwrap_or_default();
    if !metadata_status.is_success() {
        return Err(WarehouseError::bad_request(
            "lakehouse_table_not_found",
            format!(
                "Lakehouse table {namespace}.{table} is not available ({})",
                metadata_status.as_u16()
            ),
        ));
    }
    let metadata: Value = serde_json::from_str(&metadata_text).map_err(|_| {
        WarehouseError::bad_request(
            "invalid_lakehouse_schema",
            "Lakehouse table metadata is not valid JSON",
        )
    })?;
    let columns: Vec<&str> = metadata
        .get("schema")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let required = [
        "event_id",
        "collection",
        "document_id",
        "operation",
        "version",
        "occurred_at",
        "data",
        "deleted",
    ];
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|name| !columns.contains(name))
        .collect();
    if !missing.is_empty() {
        return Err(WarehouseError::bad_request(
            "invalid_lakehouse_schema",
            format!(
                "Lakehouse table needs columns: {}",
                missing.join(", ")
            ),
        ));
    }

    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "stream".into(),
                target_dataset_id: String::new(),
                sql: None,
                stream_topic: Some(stream_topic),
                stream_group: Some(stream_group),
                batch_size,
                interval_ms,
                write_mode: "append".into(),
                destination: "lakehouse".into(),
                lakehouse_namespace: Some(namespace.clone()),
                lakehouse_table: Some(table.clone()),
                source_collection: Some(collection.clone()),
                source_database: database.clone(),
            },
        )
        .await?;

    let backfill = body.get("backfill").map(truthy).unwrap_or(true);
    let backfill_result = if backfill {
        let mut url = format!(
            "{}/internal/base/collections/{collection}/backfill",
            state.config.base_service_url
        );
        if let Some(database) = &database {
            url.push_str(&format!("?database={database}"));
        }
        let client = reqwest::Client::new();
        let mut after_id: Option<String> = None;
        let mut enqueued = 0i64;
        let mut scanned = 0i64;
        let mut pages = 0i64;
        loop {
            let mut payload = json!({"limit": 1000});
            if let Some(after) = &after_id {
                payload["afterId"] = json!(after);
            }
            let mut request = client
                .post(&url)
                .header(tenant_header, &tenant_value)
                .json(&payload);
            if !state.config.internal_secret.is_empty() {
                request = request.header(
                    "x-synapseone-internal",
                    state.config.internal_secret.as_str(),
                );
            }
            let response = request.send().await.map_err(|error| {
                WarehouseError::new(
                    StatusCode::BAD_GATEWAY,
                    "base_upstream_error",
                    format!("Base backfill request failed: {error}"),
                )
            })?;
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            if !status.is_success() {
                let message: String = text.chars().take(300).collect();
                let _ = state
                    .store
                    .record_job_error(
                        tenant_of(&tenant),
                        &job.id,
                        format!("Base backfill failed: {} {message}", status.as_u16()),
                    )
                    .await;
                let _ = state
                    .store
                    .set_job_status(tenant_of(&tenant), &job.id, "error")
                    .await;
                return Err(WarehouseError::new(
                    StatusCode::BAD_GATEWAY,
                    "base_upstream_error",
                    format!("Base backfill -> {}: {message}", status.as_u16()),
                ));
            }
            let value: Value = serde_json::from_str(&text).map_err(|_| {
                WarehouseError::bad_request(
                    "invalid_backfill_response",
                    "Base backfill returned a non-JSON response",
                )
            })?;
            pages += 1;
            enqueued += value.get("enqueued").and_then(Value::as_i64).unwrap_or(0);
            scanned += value.get("scanned").and_then(Value::as_i64).unwrap_or(0);
            let has_more = value
                .get("hasMore")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let next = value
                .get("nextAfter")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            match next {
                Some(next) if has_more => {
                    if after_id.as_deref() == Some(next.as_str()) {
                        return Err(WarehouseError::bad_request(
                            "invalid_backfill_cursor",
                            "Base backfill did not advance its cursor",
                        ));
                    }
                    if pages >= 1000 {
                        return Err(WarehouseError::bad_request(
                            "backfill_too_large",
                            "Base backfill exceeded 1,000 pages; narrow the collection or seed it in stages",
                        ));
                    }
                    after_id = Some(next);
                }
                _ => break,
            }
        }
        json!({
            "enqueued": enqueued,
            "scanned": scanned,
            "pages": pages,
            "hasMore": false,
        })
    } else {
        json!({"skipped": true})
    };

    state
        .stream
        .spawn(tenant_of(&tenant).to_string(), job.id.clone());
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "job": job,
            "backfill": backfill_result,
            "semantics": "append-only Iceberg change log",
        })),
    )
        .into_response())
}

async fn etl_lakehouse(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let target_dataset_id = require_string(body.get("targetDatasetId"), "targetDatasetId", 64)?;
    let dataset = state
        .store
        .get_dataset(tenant_of(&tenant), &target_dataset_id)
        .await?
        .ok_or_else(|| {
            WarehouseError::new(
                StatusCode::NOT_FOUND,
                "dataset_not_found",
                "target dataset not found",
            )
        })?;
    let namespace = lakehouse_slug(
        &require_string(body.get("namespace"), "namespace", 41)?,
        "namespace",
    )?;
    let table = lakehouse_slug(
        &require_string(body.get("table"), "table", 41)?,
        "table",
    )?;
    let write_mode = match body.get("writeMode").and_then(Value::as_str) {
        None | Some("replace") => "replace",
        Some("append") => "append",
        Some(_) => {
            return Err(WarehouseError::bad_request(
                "invalid_write_mode",
                "writeMode must be 'replace' or 'append'",
            ))
        }
    };
    let limit = positive_int(body.get("limit"), 5000, 1, 5000);
    let snapshot_id = match body.get("snapshotId") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => number.as_i64(),
        Some(Value::String(text)) => text.parse::<i64>().ok(),
        Some(_) => None,
    };
    let (tenant_header, tenant_value) = if let Some(org) = tenant_of(&tenant).strip_prefix("org:") {
        ("x-synapseone-org", org.to_string())
    } else if let Some(account) = tenant_of(&tenant).strip_prefix("account:") {
        ("x-synapseone-account", account.to_string())
    } else {
        return Err(WarehouseError::new(
            StatusCode::FORBIDDEN,
            "tenant_scope_required",
            "Lakehouse ingestion requires an organization or account scope",
        ));
    };
    let name = match body.get("name") {
        Some(value) if !value.is_null() => require_string(Some(value), "name", 120)?,
        _ => format!("lakehouse-{namespace}-{table}-{target_dataset_id}"),
    };
    let job = state
        .store
        .create_job(
            tenant_of(&tenant),
            NewJob {
                name,
                mode: "lakehouse".into(),
                target_dataset_id: target_dataset_id.clone(),
                sql: None,
                stream_topic: None,
                stream_group: None,
                batch_size: limit,
                interval_ms: 1000,
                write_mode: write_mode.into(),
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
            },
        )
        .await?;
    let mut payload = json!({ "limit": limit });
    if let Some(snapshot_id) = snapshot_id {
        payload["snapshotId"] = json!(snapshot_id);
    }
    let mut request = reqwest::Client::new()
        .post(format!(
            "{}/v1/lakehouse/namespaces/{namespace}/tables/{table}/query",
            state.config.lakehouse_service_url
        ))
        .header(tenant_header, &tenant_value)
        .json(&payload);
    if !state.config.internal_secret.is_empty() {
        request = request.header(
            "x-synapseone-internal",
            state.config.internal_secret.as_str(),
        );
    }
    let result: Result<(usize, Value, Value), WarehouseError> = async {
        let response = request.send().await.map_err(|error| {
            WarehouseError::new(
                StatusCode::BAD_GATEWAY,
                "lakehouse_upstream_error",
                format!("Lakehouse request failed: {error}"),
            )
        })?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let message: String = text.chars().take(300).collect();
            return Err(WarehouseError::new(
                StatusCode::BAD_GATEWAY,
                "lakehouse_upstream_error",
                format!("Lakehouse returned {}: {message}", status.as_u16()),
            ));
        }
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            WarehouseError::new(
                StatusCode::BAD_GATEWAY,
                "lakehouse_upstream_error",
                "Lakehouse returned a non-JSON response",
            )
        })?;
        let rows = value
            .get("rows")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let snapshot = value.get("snapshotId").cloned().unwrap_or(Value::Null);
        let inserted = if write_mode == "replace" {
            state
                .store
                .replace_dataset_rows(tenant_of(&tenant), &dataset, &rows)
                .await?
        } else if rows.is_empty() {
            0
        } else {
            state
                .store
                .insert_rows(tenant_of(&tenant), &dataset, &rows)
                .await?
        };
        Ok((inserted, snapshot, value))
    }
    .await;
    match result {
        Ok((inserted, snapshot, value)) => {
            state
                .store
                .record_job_run(tenant_of(&tenant), &job.id, inserted as i64)
                .await?;
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "ok": true,
                    "job": job,
                    "rows": inserted,
                    "source": "lakehouse",
                    "namespace": namespace,
                    "table": table,
                    "snapshotId": snapshot,
                    "upstreamRowCount": value.get("rowCount").cloned().unwrap_or(Value::Null),
                    "writeMode": write_mode,
                })),
            )
                .into_response())
        }
        Err(error) => {
            let _ = state
                .store
                .record_job_error(tenant_of(&tenant), &job.id, &error)
                .await;
            let _ = state
                .store
                .set_job_status(tenant_of(&tenant), &job.id, "error")
                .await;
            Err(error)
        }
    }
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
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, WarehouseError> {
    let items = state.store.list_jobs(tenant_of(&tenant)).await?;
    let status = params
        .get("status")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let mode = params
        .get("mode")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let target = params
        .get("targetDatasetId")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let name = params
        .get("name")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let filtered: Vec<_> = items
        .into_iter()
        .filter(|job| {
            status
                .as_ref()
                .is_none_or(|wanted| job.status.eq_ignore_ascii_case(wanted))
                && mode
                    .as_ref()
                    .is_none_or(|wanted| job.mode.eq_ignore_ascii_case(wanted))
                && target
                    .as_ref()
                    .is_none_or(|wanted| job.target_dataset_id == *wanted)
                && name
                    .as_ref()
                    .is_none_or(|needle| job.name.to_ascii_lowercase().contains(needle))
        })
        .collect();
    let total = filtered.len();
    let (offset, limit) = page_params(&params);
    let page: Vec<_> = filtered.into_iter().skip(offset).take(limit).collect();
    Ok(Json(json!({
        "items": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "nextOffset": if offset + limit < total { Some(offset + limit) } else { None::<usize> },
    }))
    .into_response())
}

async fn update_job(
    State(state): State<AppState>,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Response, WarehouseError> {
    let body = body_value(&body)?;
    let name = require_string(body.get("name"), "name", 120)?;
    match state
        .store
        .update_job_name(tenant_of(&tenant), &id, name)
        .await?
    {
        Some(job) => Ok(Json(job).into_response()),
        None => Err(WarehouseError::new(
            StatusCode::NOT_FOUND,
            "job_not_found",
            "job not found",
        )),
    }
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
                destination: "warehouse".into(),
                lakehouse_namespace: None,
                lakehouse_table: None,
                source_collection: None,
                source_database: None,
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
            get(get_dataset).patch(update_dataset).delete(delete_dataset),
        )
        .route("/v1/warehouse/datasets/{id}/rows", post(insert_rows))
        .route("/v1/warehouse/query", post(run_query))
        .route("/v1/warehouse/etl/batch", post(etl_batch))
        .route("/v1/warehouse/etl/stream", post(etl_stream))
        .route("/v1/warehouse/etl/ocs/preview", post(etl_ocs_preview))
        .route("/v1/warehouse/etl/ocs", post(etl_ocs))
        .route("/v1/warehouse/etl/base", post(etl_base))
        .route("/v1/warehouse/etl/base-lakehouse", post(etl_base_lakehouse))
        .route("/v1/warehouse/etl/lakehouse", post(etl_lakehouse))
        .route("/v1/warehouse/templates", get(templates))
        .route("/v1/warehouse/pipeline/status", get(pipeline_status))
        .route("/v1/warehouse/jobs", get(list_jobs).post(create_job))
        .route(
            "/v1/warehouse/jobs/{id}",
            get(get_job).patch(update_job).delete(delete_job),
        )
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
