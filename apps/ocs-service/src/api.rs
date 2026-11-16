// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Legacy `/v1/storage` default-bucket API, middleware and router assembly.
//! Mirrors `index.ts`: tenant attachment, internal-secret gate, CORS, audit,
//! health/metrics and binary object CRUD.

use axum::body::Body;
use axum::extract::{MatchedPath, Path, RawQuery, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use tower_http::cors::{AllowHeaders, AllowMethods, AllowOrigin, Any, CorsLayer};
use uuid::Uuid;

use crate::audit::{self, AuditEvent};
use crate::backend::{checksum_hex, validate_key, ObjectMeta};
use crate::ocs::set_header;
use crate::util::{
    backend_error, error_response, header, is_integer, js_number, js_string, media_type_or_default,
    parse_js_number, read_body_limited, read_json, resolve_tenant, verify_internal, QueryParams,
};
use crate::{AppState, Tenant};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn legacy_meta_headers(meta: &ObjectMeta) -> Vec<(String, String)> {
    let mut headers = vec![
        ("Content-Type".into(), meta.content_type.clone()),
        ("Content-Length".into(), meta.size.to_string()),
        ("ETag".into(), format!("\"{}\"", meta.etag)),
        ("x-object-key".into(), meta.key.clone()),
        ("x-object-created-at".into(), meta.created_at.clone()),
        ("x-object-updated-at".into(), meta.updated_at.clone()),
    ];
    if let Some(checksum) = &meta.checksum_sha256 {
        headers.push(("x-object-checksum-sha256".into(), checksum.clone()));
    }
    headers
}

fn apply_headers(response: &mut Response, headers: Vec<(String, String)>) {
    for (name, value) in headers {
        if let Ok(header_name) = name.parse::<axum::http::HeaderName>() {
            if let Ok(header_value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(header_name, header_value);
            }
        }
    }
}

fn error_with_fields(
    status: StatusCode,
    code: &str,
    message: Option<String>,
    fields: Map<String, Value>,
) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String(code.into()));
    if let Some(message) = message {
        body.insert("message".into(), Value::String(message));
    }
    for (key, value) in fields {
        body.insert(key, value);
    }
    (status, Json(Value::Object(body))).into_response()
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "service": "storage",
        "product": "SynapseOCS",
        "status": "ok",
        "version": VERSION,
        "backend": state.backend.name(),
        "capabilities": {
            "buckets": true,
            "objects": true,
            "presign": state.backend.supports_presign(),
            "multipart": state.backend.supports_multipart(),
        },
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

async fn metrics(State(state): State<AppState>) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        format!(
            "# HELP synapseone_storage_up Service up status\n\
             # TYPE synapseone_storage_up gauge\n\
             synapseone_storage_up 1\n\
             synapseone_ocs_up 1\n\
             synapseone_storage_backend{{backend=\"{}\"}} 1\n",
            state.backend.name()
        ),
    )
        .into_response()
}

async fn put_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let bytes = match read_body_limited(
        body,
        state.config.max_object_bytes,
        state.config.max_object_bytes,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    if let Some(error) = validate_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    if bytes.is_empty() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "empty_body",
            Some("object body is required".into()),
            None,
        );
    }
    if bytes.len() > state.config.max_object_bytes {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "object_too_large",
            Some(format!(
                "max object size is {} bytes",
                state.config.max_object_bytes
            )),
            None,
        );
    }
    let content_type = media_type_or_default(&headers);
    if !state.config.allowed_types.is_empty()
        && !state
            .config
            .allowed_types
            .iter()
            .any(|allowed| allowed == &content_type)
    {
        let mut fields = Map::new();
        fields.insert("allowed".into(), json!(state.config.allowed_types));
        return error_with_fields(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            Some(format!("content type '{content_type}' is not allowed")),
            fields,
        );
    }
    let provided = {
        let primary = header(&headers, "x-object-checksum-sha256").to_lowercase();
        if primary.is_empty() {
            header(&headers, "x-amz-checksum-sha256").to_lowercase()
        } else {
            primary
        }
    };
    let actual = checksum_hex(&bytes);
    if !provided.is_empty() && provided != actual {
        let mut fields = Map::new();
        fields.insert("expected".into(), Value::String(actual));
        return error_with_fields(
            StatusCode::BAD_REQUEST,
            "checksum_mismatch",
            Some("x-object-checksum-sha256 does not match the body".into()),
            fields,
        );
    }
    let existing = match state.backend.head(&tenant, &key).await {
        Ok(existing) => existing,
        Err(error) => return backend_error(error),
    };
    let existing_size = existing.as_ref().map(|meta| meta.size).unwrap_or(0);
    let (_, used_bytes) = match state.backend.usage(&tenant).await {
        Ok(usage) => usage,
        Err(error) => return backend_error(error),
    };
    let next_bytes = used_bytes
        .saturating_sub(existing_size)
        .saturating_add(bytes.len() as u64);
    if next_bytes > state.config.tenant_quota_bytes {
        let mut body = Map::new();
        body.insert("error".into(), Value::String("quota_exceeded".into()));
        body.insert(
            "message".into(),
            Value::String(format!(
                "tenant quota is {} bytes",
                state.config.tenant_quota_bytes
            )),
        );
        body.insert("usedBytes".into(), json!(used_bytes));
        body.insert("quotaBytes".into(), json!(state.config.tenant_quota_bytes));
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(Value::Object(body))).into_response();
    }
    match state
        .backend
        .put(&tenant, &key, &bytes, &content_type, Some(&actual))
        .await
    {
        Ok(meta) => {
            let status = if existing.is_some() {
                StatusCode::OK
            } else {
                StatusCode::CREATED
            };
            let mut response = (status, Json(json!({ "object": meta }))).into_response();
            set_header(&mut response, "etag", &format!("\"{}\"", meta.etag));
            response
        }
        Err(error) => backend_error(error),
    }
}

async fn list_objects(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let prefix = query.js_string("prefix");
    if !prefix.is_empty() {
        let trimmed = prefix.strip_suffix('/').unwrap_or(&prefix);
        if validate_key(trimmed).is_some() {
            return error_response(StatusCode::BAD_REQUEST, "invalid_prefix", None, None);
        }
    }
    let limit = if query.first("limit").is_none() {
        100usize
    } else {
        let value = parse_js_number(&query.js_string("limit"));
        match value {
            Some(value) if is_integer(value) && (1.0..=1000.0).contains(&value) => value as usize,
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_limit",
                    Some("limit must be 1..1000".into()),
                    None,
                )
            }
        }
    };
    let cursor = query.single("cursor");
    match state.backend.list(&tenant, &prefix, limit, cursor).await {
        Ok(page) => Json(json!({
            "objects": page.objects,
            "nextCursor": page.next_cursor,
        }))
        .into_response(),
        Err(error) => backend_error(error),
    }
}

async fn get_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> Response {
    match state.backend.get(&tenant, &key).await {
        Ok(Some(object)) => {
            let mut response = StatusCode::OK.into_response();
            apply_headers(&mut response, legacy_meta_headers(&object.meta));
            *response.body_mut() = Body::from(object.body);
            response
        }
        Ok(None) => error_response(StatusCode::NOT_FOUND, "not_found", None, None),
        Err(error) => backend_error(error),
    }
}

async fn head_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> Response {
    match state.backend.head(&tenant, &key).await {
        Ok(Some(meta)) => {
            let mut response = StatusCode::OK.into_response();
            apply_headers(&mut response, legacy_meta_headers(&meta));
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn delete_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(key): Path<String>,
) -> Response {
    match state.backend.delete(&tenant, &key).await {
        Ok(true) => Json(json!({ "ok": true, "key": key })).into_response(),
        Ok(false) => error_response(StatusCode::NOT_FOUND, "not_found", None, None),
        Err(error) => backend_error(error),
    }
}

async fn presign(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = js_string(body.get("key"));
    if let Some(error) = validate_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    let verb = {
        let method = js_string(body.get("method"));
        if method.is_empty() {
            "GET".to_string()
        } else {
            method.to_uppercase()
        }
    };
    if !matches!(verb.as_str(), "GET" | "PUT" | "DELETE" | "HEAD") {
        return error_response(StatusCode::BAD_REQUEST, "invalid_method", None, None);
    }
    let ttl = match body.get("expiresIn") {
        None => 900.0,
        Some(value) => match js_number(Some(value)) {
            Some(value) => value,
            None => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_expires_in",
                    Some("expiresIn must be 1..604800".into()),
                    None,
                )
            }
        },
    };
    if !is_integer(ttl) || !(1.0..=604_800.0).contains(&ttl) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_expires_in",
            Some("expiresIn must be 1..604800".into()),
            None,
        );
    }
    let ttl = ttl as u64;
    match state.backend.presign(&tenant, &verb, &key, ttl) {
        Ok(Some(url)) => Json(json!({
            "url": url,
            "method": verb,
            "expiresIn": ttl,
        }))
        .into_response(),
        Ok(None) => {
            let mut body = Map::new();
            body.insert("error".into(), Value::String("presign_unsupported".into()));
            body.insert(
                "message".into(),
                Value::String("presigned URLs require the S3 backend".into()),
            );
            body.insert("backend".into(), Value::String(state.backend.name().into()));
            (StatusCode::NOT_IMPLEMENTED, Json(Value::Object(body))).into_response()
        }
        Err(error) => backend_error(error),
    }
}

async fn create_multipart(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = js_string(body.get("key"));
    if let Some(error) = validate_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    let content_type = {
        let value = js_string(body.get("contentType"));
        if value.is_empty() {
            "application/octet-stream".into()
        } else {
            value.split(';').next().unwrap_or("").trim().to_lowercase()
        }
    };
    if !state.config.allowed_types.is_empty()
        && !state
            .config
            .allowed_types
            .iter()
            .any(|allowed| allowed == &content_type)
    {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            None,
            None,
        );
    }
    match state
        .backend
        .create_multipart(&tenant, &key, &content_type)
        .await
    {
        Ok(upload_id) => (
            StatusCode::CREATED,
            Json(json!({
                "uploadId": upload_id,
                "key": key,
                "contentType": content_type,
            })),
        )
            .into_response(),
        Err(error) => backend_error(error),
    }
}

async fn upload_part(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((upload_id, part)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    body: Body,
) -> Response {
    let bytes = match read_body_limited(
        body,
        state.config.max_object_bytes,
        state.config.max_object_bytes,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };
    let valid_upload_id = !upload_id.is_empty()
        && upload_id.len() <= 128
        && upload_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-');
    if !valid_upload_id {
        return error_response(StatusCode::BAD_REQUEST, "invalid_upload_id", None, None);
    }
    let part_number = match parse_js_number(&part) {
        Some(value) if is_integer(value) && (1.0..=10_000.0).contains(&value) => value as u64,
        _ => return error_response(StatusCode::BAD_REQUEST, "invalid_part_number", None, None),
    };
    let query = QueryParams::parse(raw.as_deref());
    let key = query.js_string("key");
    if bytes.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "empty_body", None, None);
    }
    if bytes.len() > state.config.max_object_bytes {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "part_too_large", None, None);
    }
    match state
        .backend
        .upload_part(&tenant, &upload_id, &key, part_number, &bytes)
        .await
    {
        Ok(etag) => Json(json!({
            "partNumber": part_number,
            "etag": etag,
            "size": bytes.len(),
        }))
        .into_response(),
        Err(error) => backend_error(error),
    }
}

async fn complete_multipart(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let key = js_string(body.get("key"));
    if let Some(error) = validate_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    let parts = match body.get("parts") {
        Some(Value::Array(parts)) if !parts.is_empty() && parts.len() <= 10_000 => parts,
        _ => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_parts",
                Some("parts must contain 1..10000 entries".into()),
                None,
            )
        }
    };
    let mut clean = Vec::new();
    for part in parts {
        let number = js_number(part.get("partNumber"));
        let etag = js_string(part.get("etag"));
        let Some(number) = number.filter(|value| is_integer(*value) && *value >= 1.0) else {
            return error_response(StatusCode::BAD_REQUEST, "invalid_parts", None, None);
        };
        if etag.is_empty() {
            return error_response(StatusCode::BAD_REQUEST, "invalid_parts", None, None);
        }
        clean.push((number as u64, etag));
    }
    match state
        .backend
        .complete_multipart(&tenant, &upload_id, &key, &clean)
        .await
    {
        Ok(meta) => (StatusCode::CREATED, Json(json!({ "object": meta }))).into_response(),
        Err(error) => backend_error(error),
    }
}

async fn abort_multipart(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(upload_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let key = query.js_string("key");
    match state
        .backend
        .abort_multipart(&tenant, &upload_id, &key)
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => backend_error(error),
    }
}

async fn not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "not_found", None, None)
}

fn is_guarded_path(path: &str) -> bool {
    path == "/v1/storage"
        || path.starts_with("/v1/storage/")
        || path == "/v1/ocs"
        || path.starts_with("/v1/ocs/")
}

async fn tenant_guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    if !is_guarded_path(&path) {
        return next.run(request).await;
    }
    // HMAC-signed public URLs carry their own tenant/bucket/key scope.
    if path == "/v1/ocs/signed" {
        return next.run(request).await;
    }
    if state.config.is_prod && !verify_internal(request.headers(), &state.config.internal_secret) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Missing or invalid internal secret".into()),
            None,
        );
    }
    let tenant = resolve_tenant(request.headers(), request.uri().query());
    let Some(tenant) = tenant else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "tenant_required",
            Some("Authenticated principal or x-synapseone-tenant required".into()),
            None,
        );
    };
    request.extensions_mut().insert(Tenant(tenant));
    next.run(request).await
}

async fn request_id_middleware(mut request: Request, next: Next) -> Response {
    let incoming = header(request.headers(), "x-request-id");
    let request_id = if incoming.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        incoming
    };
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        request.headers_mut().insert("x-request-id", value);
    }
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

/// HTTP HEAD responses never carry a body; hyper enforces this on the wire,
/// but tests and in-process routers see the handler response directly.
async fn head_body_middleware(request: Request, next: Next) -> Response {
    let is_head = request.method() == Method::HEAD;
    let mut response = next.run(request).await;
    if is_head {
        *response.body_mut() = Body::empty();
    }
    response
}

/// Express' CORS middleware answers preflights with `204 No Content`; the
/// tower-http layer defaults to `200 OK`.
async fn cors_preflight_status(request: Request, next: Next) -> Response {
    let is_preflight = request.method() == Method::OPTIONS
        && request.headers().contains_key(header::ORIGIN)
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let mut response = next.run(request).await;
    if is_preflight && response.status() == StatusCode::OK {
        *response.status_mut() = StatusCode::NO_CONTENT;
    }
    response
}

async fn audit_middleware(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string())
        .unwrap_or_else(|| path.clone());
    let mutating = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE")
        && path.starts_with("/v1")
        && audit::audit_enabled();
    if !mutating {
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
    let express = audit::express_route(&route);
    audit::record(AuditEvent {
        actor_type,
        actor_id,
        org_id,
        account_id,
        action: audit::mutation_action("storage", &method, &express, &path),
        resource: format!("storage:{route}"),
        result: result.into(),
        status_code: status,
        request_id: header(&headers, "x-request-id"),
        context: json!({
            "service": "storage",
            "method": method,
            "route": route,
            "result": result,
        }),
    });
    response
}

pub fn build_app(backend: crate::backend::Backend, config: crate::config::Config) -> Router {
    if config.is_prod {
        assert!(
            !config.internal_secret.is_empty(),
            "[storage] SYNAPSEONE_INTERNAL_SECRET must be set in production."
        );
        assert!(
            !config.cors_origins.is_empty(),
            "[storage] CORS_ORIGIN must be set in production."
        );
    }
    let state = AppState { backend, config };
    let methods = AllowMethods::list([
        Method::GET,
        Method::HEAD,
        Method::PUT,
        Method::PATCH,
        Method::POST,
        Method::DELETE,
    ]);
    let cors = if state.config.cors_origins.is_empty() {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(methods.clone())
            .allow_headers(AllowHeaders::mirror_request())
    } else {
        let origins = state
            .config
            .cors_origins
            .iter()
            .filter_map(|origin| origin.parse().ok())
            .collect::<Vec<_>>();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(methods)
            .allow_headers(AllowHeaders::mirror_request())
    };
    let api = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route(
            "/v1/storage/objects/{*key}",
            axum::routing::put(put_object)
                .get(get_object)
                .head(head_object)
                .delete(delete_object),
        )
        .route("/v1/storage/objects", get(list_objects))
        .route("/v1/storage/presign", post(presign))
        .route("/v1/storage/uploads", post(create_multipart))
        .route(
            "/v1/storage/uploads/{id}/parts/{part}",
            axum::routing::put(upload_part),
        )
        .route(
            "/v1/storage/uploads/{id}/complete",
            post(complete_multipart),
        )
        .route(
            "/v1/storage/uploads/{id}",
            axum::routing::delete(abort_multipart),
        )
        .merge(crate::ocs_api::routes());

    api.fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), tenant_guard))
        .layer(middleware::from_fn(audit_middleware))
        .layer(middleware::from_fn(request_id_middleware))
        .layer(middleware::from_fn(head_body_middleware))
        .layer(middleware::from_fn(security_headers))
        .layer(cors)
        .layer(middleware::from_fn(cors_preflight_status))
        .with_state(state)
}
