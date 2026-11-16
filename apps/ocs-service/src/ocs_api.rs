// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! `/v1/ocs` HTTP handlers. The route surface mirrors `ocs.ts` exactly:
//! signed URLs, buckets, objects, copy, listing, presign and multipart.

use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::backend::{checksum_hex, ListPage, ObjectMeta};
use crate::ocs::{
    bucket_with_stats, create_presign_token, default_bucket_meta, internal_key, marker_key,
    meta_headers, public_meta, set_header, user_key, validate_bucket_name, validate_ocs_key,
    BucketMeta, PresignPayload, BUCKET_MARKER, DEFAULT_BUCKET, OCS_PREFIX,
};
use crate::util::{
    backend_error, decode_base64url, encode_uri_component, error_response, header, is_integer,
    js_coerce_string, js_number, js_string, js_string_or, media_type_or_default, now_iso,
    parse_js_number, read_body_limited, read_json, ApiError, QueryParams,
};
use crate::{AppState, Tenant};

fn bucket_not_found(bucket: &str) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String("bucket_not_found".into()));
    body.insert(
        "message".into(),
        Value::String(format!("bucket '{bucket}' does not exist")),
    );
    body.insert("bucket".into(), Value::String(bucket.to_string()));
    (StatusCode::NOT_FOUND, Json(Value::Object(body))).into_response()
}

async fn list_all(
    state: &AppState,
    tenant: &str,
    prefix: &str,
) -> Result<Vec<ObjectMeta>, ApiError> {
    let mut objects = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..100 {
        let page = state
            .backend
            .list(tenant, prefix, 1000, cursor.as_deref())
            .await
            .map_err(ApiError::backend)?;
        objects.extend(page.objects);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(objects)
}

async fn read_bucket(
    state: &AppState,
    tenant: &str,
    bucket: &str,
) -> Result<Option<BucketMeta>, ApiError> {
    if bucket == DEFAULT_BUCKET {
        return Ok(Some(default_bucket_meta()));
    }
    let marker = state
        .backend
        .get(tenant, &marker_key(bucket))
        .await
        .map_err(ApiError::backend)?;
    let Some(marker) = marker else {
        return Ok(None);
    };
    let mut meta = serde_json::from_slice::<BucketMeta>(&marker.body).unwrap_or(BucketMeta {
        name: bucket.to_string(),
        created_at: marker.meta.created_at.clone(),
        updated_at: None,
        owner: None,
        quota_bytes: None,
    });
    meta.name = bucket.to_string();
    if meta.created_at.is_empty() {
        meta.created_at = marker.meta.created_at;
    }
    Ok(Some(meta))
}

async fn bucket_objects(
    state: &AppState,
    tenant: &str,
    bucket: &str,
) -> Result<Vec<ObjectMeta>, ApiError> {
    let prefix = if bucket == DEFAULT_BUCKET {
        String::new()
    } else {
        format!("{OCS_PREFIX}{bucket}/")
    };
    let all = list_all(state, tenant, &prefix).await?;
    Ok(all
        .into_iter()
        .filter(|object| {
            if bucket == DEFAULT_BUCKET {
                !object.key.starts_with(OCS_PREFIX)
            } else {
                object.key != marker_key(bucket)
            }
        })
        .collect())
}

async fn bucket_stats(
    state: &AppState,
    tenant: &str,
    bucket: &str,
) -> Result<(usize, u64), ApiError> {
    let objects = bucket_objects(state, tenant, bucket).await?;
    Ok((
        objects.len(),
        objects.iter().map(|object| object.size).sum(),
    ))
}

#[allow(clippy::result_large_err)]
async fn require_bucket(
    state: &AppState,
    tenant: &str,
    bucket: &str,
) -> Result<crate::ocs::BucketMeta, Response> {
    match read_bucket(state, tenant, bucket).await {
        Ok(Some(meta)) => Ok(meta),
        Ok(None) => Err(bucket_not_found(bucket)),
        Err(error) => Err(error.into_response()),
    }
}

fn parse_limit(query: &QueryParams) -> Result<usize, ApiError> {
    if query.first("limit").is_none() {
        return Ok(100);
    }
    let raw = query.js_string("limit");
    match parse_js_number(&raw) {
        Some(value) if is_integer(value) && (1.0..=1000.0).contains(&value) => Ok(value as usize),
        _ => Err(ApiError::backend("limit must be 1..1000")),
    }
}

fn parse_expires(value: Option<&Value>) -> Result<u64, ApiError> {
    let ttl = match value {
        None => 900.0,
        Some(value) => js_number(Some(value))
            .ok_or_else(|| ApiError::backend("expiresIn must be 1..604800"))?,
    };
    if is_integer(ttl) && (1.0..=604_800.0).contains(&ttl) {
        Ok(ttl as u64)
    } else {
        Err(ApiError::backend("expiresIn must be 1..604800"))
    }
}

fn encode_cursor(value: Option<&str>) -> Value {
    match value {
        Some(value) if !value.is_empty() => Value::String(base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            value.as_bytes(),
        )),
        _ => Value::Null,
    }
}

fn decode_cursor(value: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let bytes = decode_base64url(value).ok_or_else(|| ApiError::backend("cursor is invalid"))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn parse_range(range: &str, size: u64) -> Option<(u64, u64)> {
    let rest = range.trim().strip_prefix("bytes=")?;
    if rest.contains(',') {
        return None;
    }
    let (raw_start, raw_end) = rest.split_once('-')?;
    let (start, end) = if raw_start.is_empty() {
        let suffix = if raw_end.is_empty() {
            0
        } else {
            raw_end.parse::<u64>().ok()?
        };
        (size.saturating_sub(suffix), size.saturating_sub(1))
    } else {
        let start = raw_start.parse::<u64>().ok()?;
        let end = if raw_end.is_empty() {
            size.saturating_sub(1)
        } else {
            raw_end.parse::<u64>().ok()?.min(size.saturating_sub(1))
        };
        (start, end)
    };
    if size == 0 || start >= size || end < start {
        return None;
    }
    Some((start, end))
}

fn invalid_range(size: u64) -> Response {
    let mut response = error_response(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "invalid_range",
        None,
        None,
    );
    set_header(&mut response, "content-range", &format!("bytes */{size}"));
    response
}

fn range_response(
    status: StatusCode,
    bucket: &str,
    meta: &ObjectMeta,
    body: bytes::Bytes,
    range: Option<(u64, u64)>,
) -> Response {
    let mut response = (status, body).into_response();
    for (name, value) in meta_headers(bucket, meta) {
        if let Ok(header_name) = name.parse::<axum::http::HeaderName>() {
            if let Ok(header_value) = axum::http::HeaderValue::from_str(&value) {
                response.headers_mut().insert(header_name, header_value);
            }
        }
    }
    if let Some((start, end)) = range {
        set_header(
            &mut response,
            "content-range",
            &format!("bytes {start}-{end}/{}", meta.size),
        );
        set_header(
            &mut response,
            "content-length",
            &(end - start + 1).to_string(),
        );
    }
    response
}

async fn put_object(
    state: &AppState,
    tenant: &str,
    bucket: &str,
    key: &str,
    body: &[u8],
    content_type: &str,
    provided_checksum: Option<&str>,
) -> Result<(ObjectMeta, bool), ApiError> {
    let actual = checksum_hex(body);
    if let Some(provided) = provided_checksum {
        if provided != actual {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "checksum_mismatch",
                "x-object-checksum-sha256 does not match the body",
            ));
        }
    }
    let target = internal_key(bucket, key);
    let existing = state
        .backend
        .head(tenant, &target)
        .await
        .map_err(ApiError::backend)?;
    let existing_size = existing.as_ref().map(|meta| meta.size).unwrap_or(0);
    let (_, tenant_bytes) = state
        .backend
        .usage(tenant)
        .await
        .map_err(ApiError::backend)?;
    let (_, bucket_bytes) = bucket_stats(state, tenant, bucket).await?;
    let bucket_meta = read_bucket(state, tenant, bucket).await?;
    let tenant_next = tenant_bytes
        .saturating_sub(existing_size)
        .saturating_add(body.len() as u64);
    if tenant_next > state.config.tenant_quota_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota_exceeded",
            format!("tenant quota is {} bytes", state.config.tenant_quota_bytes),
        )
        .with_details(json!({
            "usedBytes": tenant_bytes,
            "quotaBytes": state.config.tenant_quota_bytes,
        })));
    }
    if let Some(quota_bytes) = bucket_meta
        .and_then(|meta| meta.quota_bytes)
        .filter(|quota| *quota > 0)
    {
        let bucket_next = bucket_bytes
            .saturating_sub(existing_size)
            .saturating_add(body.len() as u64);
        if bucket_next > quota_bytes {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "bucket_quota_exceeded",
                format!("bucket quota is {quota_bytes} bytes"),
            )
            .with_details(json!({
                "usedBytes": bucket_bytes,
                "quotaBytes": quota_bytes,
            })));
        }
    }
    let meta = state
        .backend
        .put(tenant, &target, body, content_type, Some(&actual))
        .await
        .map_err(ApiError::backend)?;
    Ok((meta, existing.is_none()))
}

fn ensure_allowed_type(state: &AppState, content_type: &str) -> Result<(), ApiError> {
    if !state.config.allowed_types.is_empty()
        && !state
            .config
            .allowed_types
            .iter()
            .any(|allowed| allowed == content_type)
    {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            format!("content type '{content_type}' is not allowed"),
        ));
    }
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/ocs/signed",
            get(signed_get)
                .head(signed_head)
                .put(signed_put)
                .delete(signed_delete),
        )
        .route("/v1/ocs/buckets", get(list_buckets).post(create_bucket))
        .route(
            "/v1/ocs/buckets/{bucket}",
            get(get_bucket).head(head_bucket).delete(delete_bucket),
        )
        .route("/v1/ocs/buckets/{bucket}/stats", get(bucket_stats_handler))
        .route("/v1/ocs/buckets/{bucket}/objects", get(list_objects))
        .route("/v1/ocs/buckets/{bucket}/objects/copy", post(copy_object))
        .route(
            "/v1/ocs/buckets/{bucket}/objects/{*key}",
            get(get_object)
                .head(head_object)
                .put(put_object_handler)
                .delete(delete_object),
        )
        .route("/v1/ocs/buckets/{bucket}/presign", post(presign_object))
        .route("/v1/ocs/buckets/{bucket}/uploads", post(create_multipart))
        .route(
            "/v1/ocs/buckets/{bucket}/uploads/{id}/parts/{part}",
            axum::routing::put(upload_part),
        )
        .route(
            "/v1/ocs/buckets/{bucket}/uploads/{id}/complete",
            post(complete_multipart),
        )
        .route(
            "/v1/ocs/buckets/{bucket}/uploads/{id}",
            axum::routing::delete(abort_multipart),
        )
}

async fn signed_get(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let payload = match crate::ocs::verify_presign_token(
        &query.js_string("token"),
        "GET",
        &state.config.presign_secret,
    ) {
        Ok(payload) => payload,
        Err(error) => return error.into_response(),
    };
    match read_bucket(&state, &payload.tenant, &payload.bucket).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "bucket_not_found", None, None),
        Err(error) => return error.into_response(),
    }
    let object = match state
        .backend
        .get(
            &payload.tenant,
            &internal_key(&payload.bucket, &payload.key),
        )
        .await
    {
        Ok(Some(object)) => object,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "object_not_found", None, None),
        Err(error) => return backend_error(error),
    };
    let range_header = header(&headers, "range");
    if range_header.is_empty() {
        return range_response(
            StatusCode::OK,
            &payload.bucket,
            &object.meta,
            object.body,
            None,
        );
    }
    let Some((start, end)) = parse_range(&range_header, object.meta.size) else {
        return invalid_range(object.meta.size);
    };
    let slice = object.body.slice(start as usize..=end as usize);
    range_response(
        StatusCode::PARTIAL_CONTENT,
        &payload.bucket,
        &object.meta,
        slice,
        Some((start, end)),
    )
}

async fn signed_head(State(state): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let payload = match crate::ocs::verify_presign_token(
        &query.js_string("token"),
        "HEAD",
        &state.config.presign_secret,
    ) {
        Ok(payload) => payload,
        Err(error) => return error.into_response(),
    };
    match read_bucket(&state, &payload.tenant, &payload.bucket).await {
        Ok(Some(_)) => {}
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => return error.into_response(),
    }
    match state
        .backend
        .head(
            &payload.tenant,
            &internal_key(&payload.bucket, &payload.key),
        )
        .await
    {
        Ok(Some(meta)) => {
            let mut response = StatusCode::OK.into_response();
            for (name, value) in meta_headers(&payload.bucket, &meta) {
                if let Ok(header_name) = name.parse::<axum::http::HeaderName>() {
                    if let Ok(header_value) = axum::http::HeaderValue::from_str(&value) {
                        response.headers_mut().insert(header_name, header_value);
                    }
                }
            }
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => error.into_response(),
    }
}

async fn signed_put(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
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
    let query = QueryParams::parse(raw.as_deref());
    let payload = match crate::ocs::verify_presign_token(
        &query.js_string("token"),
        "PUT",
        &state.config.presign_secret,
    ) {
        Ok(payload) => payload,
        Err(error) => return error.into_response(),
    };
    match read_bucket(&state, &payload.tenant, &payload.bucket).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "bucket_not_found", None, None),
        Err(error) => return error.into_response(),
    }
    if let Some(error) = validate_ocs_key(&payload.key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    if bytes.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "empty_body", None, None);
    }
    if bytes.len() > state.config.max_object_bytes {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "object_too_large",
            None,
            None,
        );
    }
    let content_type = media_type_or_default(&headers);
    if let Err(error) = ensure_allowed_type(&state, &content_type) {
        return error.into_response();
    }
    let checksum = header(&headers, "x-object-checksum-sha256").to_lowercase();
    let result = put_object(
        &state,
        &payload.tenant,
        &payload.bucket,
        &payload.key,
        &bytes,
        &content_type,
        if checksum.is_empty() {
            None
        } else {
            Some(checksum.as_str())
        },
    )
    .await;
    match result {
        Ok((meta, created)) => {
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let mut response = (
                status,
                Json(json!({
                    "bucket": payload.bucket,
                    "object": public_meta(&payload.bucket, &meta),
                })),
            )
                .into_response();
            set_header(&mut response, "etag", &format!("\"{}\"", meta.etag));
            response
        }
        Err(error) => error.into_response(),
    }
}

async fn signed_delete(State(state): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let payload = match crate::ocs::verify_presign_token(
        &query.js_string("token"),
        "DELETE",
        &state.config.presign_secret,
    ) {
        Ok(payload) => payload,
        Err(error) => return error.into_response(),
    };
    match read_bucket(&state, &payload.tenant, &payload.bucket).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "bucket_not_found", None, None),
        Err(error) => return error.into_response(),
    }
    match state
        .backend
        .delete(
            &payload.tenant,
            &internal_key(&payload.bucket, &payload.key),
        )
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "bucket": payload.bucket,
            "key": payload.key,
        }))
        .into_response(),
        Ok(false) => error_response(StatusCode::NOT_FOUND, "object_not_found", None, None),
        Err(error) => backend_error(error),
    }
}

async fn list_buckets(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = QueryParams::parse(raw.as_deref());
    let markers = match list_all(&state, &tenant, OCS_PREFIX).await {
        Ok(markers) => markers,
        Err(error) => return error.into_response(),
    };
    let mut names = std::collections::BTreeSet::new();
    names.insert(DEFAULT_BUCKET.to_string());
    let suffix = format!("/{BUCKET_MARKER}");
    for marker in markers {
        let Some(name) = marker.key.strip_suffix(&suffix) else {
            continue;
        };
        if let Some(name) = name.strip_prefix(OCS_PREFIX) {
            if !name.is_empty() && !name.contains('/') {
                names.insert(name.to_string());
            }
        }
    }
    let with_stats = query.js_string("withStats") == "1";
    let mut buckets = Vec::new();
    for name in names {
        let Some(meta) = (match read_bucket(&state, &tenant, &name).await {
            Ok(meta) => meta,
            Err(error) => return error.into_response(),
        }) else {
            continue;
        };
        if with_stats {
            let (objects, bytes) = match bucket_stats(&state, &tenant, &name).await {
                Ok(stats) => stats,
                Err(error) => return error.into_response(),
            };
            buckets.push(bucket_with_stats(&meta, objects, bytes));
        } else {
            buckets.push(serde_json::to_value(&meta).unwrap_or_else(|_| json!({})));
        }
    }
    Json(json!({ "buckets": buckets, "total": buckets.len() })).into_response()
}

async fn create_bucket(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let name = js_string(body.get("name")).trim().to_lowercase();
    if let Some(error) = validate_bucket_name(&name) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_bucket_name",
            Some(error),
            None,
        );
    }
    if name == DEFAULT_BUCKET {
        return error_response(
            StatusCode::CONFLICT,
            "bucket_exists",
            Some("the default bucket is managed by the platform".into()),
            None,
        );
    }
    match read_bucket(&state, &tenant, &name).await {
        Ok(Some(_)) => {
            return error_response(
                StatusCode::CONFLICT,
                "bucket_exists",
                Some(format!("bucket '{name}' already exists")),
                None,
            )
        }
        Ok(None) => {}
        Err(error) => return error.into_response(),
    }
    let quota = match body.get("quotaBytes") {
        None => None,
        Some(value) => {
            let Some(number) = js_number(Some(value)) else {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_quota",
                    Some("quotaBytes must be an integer between 1024 and 1 TiB".into()),
                    None,
                );
            };
            if !is_integer(number) || !(1024.0..=1024.0_f64.powi(4)).contains(&number) {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_quota",
                    Some("quotaBytes must be an integer between 1024 and 1 TiB".into()),
                    None,
                );
            }
            Some(number as u64)
        }
    };
    let owner = header(&headers, "x-synapseone-user");
    let meta = crate::ocs::BucketMeta {
        name: name.clone(),
        created_at: now_iso(),
        updated_at: None,
        owner: (!owner.is_empty()).then_some(owner),
        quota_bytes: quota,
    };
    let marker = serde_json::to_vec(&meta).unwrap_or_default();
    if let Err(error) = state
        .backend
        .put(
            &tenant,
            &marker_key(&name),
            &marker,
            "application/json",
            None,
        )
        .await
    {
        return backend_error(error);
    }
    let (objects, bytes) = match bucket_stats(&state, &tenant, &name).await {
        Ok(stats) => stats,
        Err(error) => return error.into_response(),
    };
    (
        StatusCode::CREATED,
        Json(json!({ "bucket": bucket_with_stats(&meta, objects, bytes) })),
    )
        .into_response()
}

async fn get_bucket(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
) -> Response {
    let meta = match require_bucket(&state, &tenant, &bucket).await {
        Ok(meta) => meta,
        Err(response) => return response,
    };
    let (objects, bytes) = match bucket_stats(&state, &tenant, &bucket).await {
        Ok(stats) => stats,
        Err(error) => return error.into_response(),
    };
    let mut response =
        Json(json!({ "bucket": bucket_with_stats(&meta, objects, bytes) })).into_response();
    set_header(&mut response, "cache-control", "no-store");
    set_header(&mut response, "x-ocs-bucket", &bucket);
    set_header(
        &mut response,
        "x-ocs-quota-bytes",
        &meta
            .quota_bytes
            .filter(|quota| *quota > 0)
            .unwrap_or(state.config.tenant_quota_bytes)
            .to_string(),
    );
    response
}

async fn head_bucket(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
) -> Response {
    match read_bucket(&state, &tenant, &bucket).await {
        Ok(Some(meta)) => {
            let mut response = StatusCode::OK.into_response();
            set_header(&mut response, "x-ocs-bucket", &bucket);
            set_header(
                &mut response,
                "x-ocs-quota-bytes",
                &meta
                    .quota_bytes
                    .filter(|quota| *quota > 0)
                    .unwrap_or(state.config.tenant_quota_bytes)
                    .to_string(),
            );
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn bucket_stats_handler(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
) -> Response {
    let meta = match read_bucket(&state, &tenant, &bucket).await {
        Ok(Some(meta)) => meta,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "bucket_not_found", None, None),
        Err(error) => return error.into_response(),
    };
    let (objects, bytes) = match bucket_stats(&state, &tenant, &bucket).await {
        Ok(stats) => stats,
        Err(error) => return error.into_response(),
    };
    Json(json!({
        "bucket": bucket,
        "objects": objects,
        "bytes": bytes,
        "quotaBytes": meta
            .quota_bytes
            .filter(|quota| *quota > 0)
            .unwrap_or(state.config.tenant_quota_bytes),
    }))
    .into_response()
}

async fn delete_bucket(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    if bucket == DEFAULT_BUCKET {
        return error_response(
            StatusCode::FORBIDDEN,
            "default_bucket_protected",
            Some("the default bucket cannot be deleted".into()),
            None,
        );
    }
    match read_bucket(&state, &tenant, &bucket).await {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "bucket_not_found", None, None),
        Err(error) => return error.into_response(),
    }
    let objects = match bucket_objects(&state, &tenant, &bucket).await {
        Ok(objects) => objects,
        Err(error) => return error.into_response(),
    };
    let query = QueryParams::parse(raw.as_deref());
    let force = query.js_string("force") == "true";
    if !objects.is_empty() && !force {
        let mut body = Map::new();
        body.insert("error".into(), Value::String("bucket_not_empty".into()));
        body.insert(
            "message".into(),
            Value::String(format!(
                "bucket '{bucket}' still has {} object(s); pass ?force=true to delete them",
                objects.len()
            )),
        );
        body.insert("objects".into(), json!(objects.len()));
        return (StatusCode::CONFLICT, Json(Value::Object(body))).into_response();
    }
    for object in &objects {
        if let Err(error) = state.backend.delete(&tenant, &object.key).await {
            return backend_error(error);
        }
    }
    if let Err(error) = state.backend.delete(&tenant, &marker_key(&bucket)).await {
        return backend_error(error);
    }
    Json(json!({
        "ok": true,
        "bucket": bucket,
        "deletedObjects": objects.len(),
    }))
    .into_response()
}

async fn list_objects(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let query = QueryParams::parse(raw.as_deref());
    let prefix = query.js_string("prefix");
    if !prefix.is_empty() {
        let trimmed = prefix.strip_suffix('/').unwrap_or(&prefix);
        if let Some(error) = validate_ocs_key(trimmed) {
            return error_response(StatusCode::BAD_REQUEST, "invalid_prefix", Some(error), None);
        }
    }
    let delimiter = query.js_string("delimiter");
    if delimiter.chars().count() > 1 {
        return error_response(StatusCode::BAD_REQUEST, "invalid_delimiter", None, None);
    }
    let limit = match parse_limit(&query) {
        Ok(limit) => limit,
        Err(error) => return error.into_response(),
    };
    let cursor = match decode_cursor(query.single("cursor")) {
        Ok(cursor) => cursor,
        Err(error) => return error.into_response(),
    };
    let internal_prefix = if bucket == DEFAULT_BUCKET {
        prefix.clone()
    } else {
        format!("{OCS_PREFIX}{bucket}/{prefix}")
    };
    let page = match state
        .backend
        .list(&tenant, &internal_prefix, limit, cursor.as_deref())
        .await
    {
        Ok(page) => page,
        Err(error) => return backend_error(error),
    };
    let ListPage {
        objects: page_objects,
        next_cursor,
    } = page;
    let marker = marker_key(&bucket);
    let mut objects = Vec::new();
    let mut common_prefixes = std::collections::BTreeSet::new();
    for object in page_objects {
        if object.key == marker {
            continue;
        }
        let key = user_key(&bucket, &object.key);
        if !delimiter.is_empty() && key.len() >= prefix.len() {
            if let Some(relative) = key[prefix.len()..].find(&delimiter) {
                let index = prefix.len() + relative;
                common_prefixes.insert(key[..index + delimiter.len()].to_string());
                continue;
            }
        }
        objects.push(public_meta(&bucket, &object));
    }
    let mut body = Map::new();
    body.insert("bucket".into(), Value::String(bucket));
    body.insert("prefix".into(), Value::String(prefix));
    if !delimiter.is_empty() {
        body.insert("delimiter".into(), Value::String(delimiter));
    }
    body.insert("objects".into(), Value::Array(objects));
    body.insert(
        "commonPrefixes".into(),
        Value::Array(common_prefixes.into_iter().map(Value::String).collect()),
    );
    body.insert("nextCursor".into(), encode_cursor(next_cursor.as_deref()));
    Json(Value::Object(body)).into_response()
}

async fn copy_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let source_bucket = js_string_or(body.get("sourceBucket"), &bucket);
    if let Err(response) = require_bucket(&state, &tenant, &source_bucket).await {
        return response;
    }
    let source_key = js_string(body.get("sourceKey"));
    let destination_key = js_string(body.get("destinationKey"));
    if let Some(error) = validate_ocs_key(&source_key) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_source_key",
            Some(error),
            None,
        );
    }
    if let Some(error) = validate_ocs_key(&destination_key) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_destination_key",
            Some(error),
            None,
        );
    }
    let source = match state
        .backend
        .get(&tenant, &internal_key(&source_bucket, &source_key))
        .await
    {
        Ok(Some(source)) => source,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "source_not_found", None, None),
        Err(error) => return backend_error(error),
    };
    let content_type = match body.get("contentType") {
        None => source.meta.content_type.clone(),
        Some(value) => js_coerce_string(Some(value))
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase(),
    };
    if let Err(error) = ensure_allowed_type(&state, &content_type) {
        return error.into_response();
    }
    let checksum = checksum_hex(&source.body);
    match put_object(
        &state,
        &tenant,
        &bucket,
        &destination_key,
        &source.body,
        &content_type,
        Some(&checksum),
    )
    .await
    {
        Ok((meta, created)) => {
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (
                status,
                Json(json!({
                    "bucket": bucket,
                    "object": public_meta(&bucket, &meta),
                    "source": { "bucket": source_bucket, "key": source_key },
                })),
            )
                .into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn put_object_handler(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((bucket, key)): Path<(String, String)>,
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
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    if let Some(error) = validate_ocs_key(&key) {
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
    if let Err(error) = ensure_allowed_type(&state, &content_type) {
        return error.into_response();
    }
    let checksum = {
        let primary = header(&headers, "x-object-checksum-sha256").to_lowercase();
        if primary.is_empty() {
            header(&headers, "x-amz-checksum-sha256").to_lowercase()
        } else {
            primary
        }
    };
    match put_object(
        &state,
        &tenant,
        &bucket,
        &key,
        &bytes,
        &content_type,
        if checksum.is_empty() {
            None
        } else {
            Some(checksum.as_str())
        },
    )
    .await
    {
        Ok((meta, created)) => {
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            let mut response = (
                status,
                Json(json!({ "bucket": bucket, "object": public_meta(&bucket, &meta) })),
            )
                .into_response();
            set_header(&mut response, "etag", &format!("\"{}\"", meta.etag));
            response
        }
        Err(error) => error.into_response(),
    }
}

async fn get_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((bucket, key)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let object = match state
        .backend
        .get(&tenant, &internal_key(&bucket, &key))
        .await
    {
        Ok(Some(object)) => object,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "object_not_found", None, None),
        Err(error) => return backend_error(error),
    };
    let etag = format!("\"{}\"", object.meta.etag);
    let if_none_match = header(&headers, "if-none-match");
    if !if_none_match.is_empty()
        && (if_none_match == "*"
            || if_none_match
                .split(',')
                .map(str::trim)
                .any(|value| value == etag))
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let if_match = header(&headers, "if-match");
    if !if_match.is_empty()
        && if_match != "*"
        && !if_match
            .split(',')
            .map(str::trim)
            .any(|value| value == etag)
    {
        return error_response(
            StatusCode::PRECONDITION_FAILED,
            "precondition_failed",
            None,
            None,
        );
    }
    let range_header = header(&headers, "range");
    if range_header.is_empty() {
        return range_response(StatusCode::OK, &bucket, &object.meta, object.body, None);
    }
    let Some((start, end)) = parse_range(&range_header, object.meta.size) else {
        return invalid_range(object.meta.size);
    };
    let slice = object.body.slice(start as usize..=end as usize);
    range_response(
        StatusCode::PARTIAL_CONTENT,
        &bucket,
        &object.meta,
        slice,
        Some((start, end)),
    )
}

async fn head_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((bucket, key)): Path<(String, String)>,
) -> Response {
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    match state
        .backend
        .head(&tenant, &internal_key(&bucket, &key))
        .await
    {
        Ok(Some(meta)) => {
            let mut response = StatusCode::OK.into_response();
            for (name, value) in meta_headers(&bucket, &meta) {
                if let Ok(header_name) = name.parse::<axum::http::HeaderName>() {
                    if let Ok(header_value) = axum::http::HeaderValue::from_str(&value) {
                        response.headers_mut().insert(header_name, header_value);
                    }
                }
            }
            response
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn delete_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((bucket, key)): Path<(String, String)>,
) -> Response {
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    match state
        .backend
        .delete(&tenant, &internal_key(&bucket, &key))
        .await
    {
        Ok(true) => Json(json!({ "ok": true, "bucket": bucket, "key": key })).into_response(),
        Ok(false) => error_response(StatusCode::NOT_FOUND, "object_not_found", None, None),
        Err(error) => backend_error(error),
    }
}

async fn presign_object(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let key = js_string(body.get("key"));
    if let Some(error) = validate_ocs_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    let method = {
        let method = js_string(body.get("method"));
        if method.is_empty() {
            "GET".to_string()
        } else {
            method.to_uppercase()
        }
    };
    if !matches!(method.as_str(), "GET" | "PUT" | "DELETE" | "HEAD") {
        return error_response(StatusCode::BAD_REQUEST, "invalid_method", None, None);
    }
    let expires_in = match parse_expires(body.get("expiresIn")) {
        Ok(expires_in) => expires_in,
        Err(error) => return error.into_response(),
    };
    let payload = PresignPayload {
        tenant,
        bucket: bucket.clone(),
        key: key.clone(),
        method: method.clone(),
        exp: chrono::Utc::now().timestamp() + expires_in as i64,
        nonce: Uuid::new_v4().to_string(),
    };
    let token = create_presign_token(&payload, &state.config.presign_secret);
    Json(json!({
        "url": format!(
            "{}/v1/ocs/signed?token={}",
            state.config.public_base_url,
            encode_uri_component(&token)
        ),
        "bucket": bucket,
        "key": key,
        "method": method,
        "expiresIn": expires_in,
    }))
    .into_response()
}

async fn create_multipart(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path(bucket): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let key = js_string(body.get("key"));
    if let Some(error) = validate_ocs_key(&key) {
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
    if let Err(error) = ensure_allowed_type(&state, &content_type) {
        return error.into_response();
    }
    match state
        .backend
        .create_multipart(&tenant, &internal_key(&bucket, &key), &content_type)
        .await
    {
        Ok(upload_id) => (
            StatusCode::CREATED,
            Json(json!({
                "uploadId": upload_id,
                "bucket": bucket,
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
    Path((bucket, upload_id, part)): Path<(String, String, String)>,
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
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
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
    if let Some(error) = validate_ocs_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    if bytes.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "empty_body", None, None);
    }
    if bytes.len() > state.config.max_object_bytes {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "part_too_large", None, None);
    }
    match state
        .backend
        .upload_part(
            &tenant,
            &upload_id,
            &internal_key(&bucket, &key),
            part_number,
            &bytes,
        )
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
    Path((bucket, upload_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let body = match read_json(&headers, body, state.config.max_object_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let key = js_string(body.get("key"));
    if let Some(error) = validate_ocs_key(&key) {
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
        .complete_multipart(&tenant, &upload_id, &internal_key(&bucket, &key), &clean)
        .await
    {
        Ok(meta) => (
            StatusCode::CREATED,
            Json(json!({
                "bucket": bucket,
                "object": public_meta(&bucket, &meta),
            })),
        )
            .into_response(),
        Err(error) => backend_error(error),
    }
}

async fn abort_multipart(
    State(state): State<AppState>,
    Extension(Tenant(tenant)): Extension<Tenant>,
    Path((bucket, upload_id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    if let Err(response) = require_bucket(&state, &tenant, &bucket).await {
        return response;
    }
    let query = QueryParams::parse(raw.as_deref());
    let key = query.js_string("key");
    if let Some(error) = validate_ocs_key(&key) {
        return error_response(StatusCode::BAD_REQUEST, "invalid_key", Some(error), None);
    }
    match state
        .backend
        .abort_multipart(&tenant, &upload_id, &internal_key(&bucket, &key))
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => backend_error(error),
    }
}
