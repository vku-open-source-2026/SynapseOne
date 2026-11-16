// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseLDS — Linked Data Service (NGSI-LD open data gateway).
//!
//! Datasources with licensed, policy-filtered NGSI-LD exports built by a
//! structural-allowlist projector (see ./projector). Postgres persistence with
//! an in-memory fallback (dev/test). Internal-service auth like the rest of the
//! platform (SYNAPSEONE_INTERNAL_SECRET + gateway-stamped principal).

mod audit;
mod licenses;
mod projector;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{MatchedPath, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use unicode_normalization::UnicodeNormalization;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use audit::express_route;
use licenses::{find_license, is_custom_license_id, LDS_LICENSES};
use projector::{
    ingest_record, project_entity, resolve_identity, validate_attribute_registry,
    DatasourceLike, IngestPrincipal, RegistryAttribute, LDS_RESERVED_ATTRIBUTES,
    NGSI_LD_CORE_CONTEXT,
};
use store::{DatasourcePatch, NewDatasource, Store, StoreError, StoredDatasource};

const VERSION: &str = "0.7.1";

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
    metrics: Arc<Mutex<HashMap<String, u64>>>,
    started: Instant,
}

#[derive(Clone)]
struct Principal {
    sub: String,
    org: Option<String>,
    account: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CallerKind {
    Anon,
    Principal,
    Platform,
}

#[derive(Clone)]
struct Caller {
    kind: CallerKind,
    principal: Option<Principal>,
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(fallback)
}

fn config_from_env() -> Config {
    Config {
        port: env_u64("PORT", 4004) as u16,
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
        return Caller {
            kind: CallerKind::Principal,
            principal: Some(principal),
        };
    }
    let anon = header(headers, "x-synapseone-anon") == "1";
    Caller {
        kind: if anon {
            CallerKind::Anon
        } else {
            CallerKind::Platform
        },
        principal: None,
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

fn json_error(status: StatusCode, code: &str, message: Option<String>) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String(code.into()));
    if let Some(message) = message {
        body.insert("message".into(), Value::String(message));
    }
    (status, Json(Value::Object(body))).into_response()
}

fn clean_id(value: &str, max: usize) -> Option<String> {
    if value.is_empty() || value.len() > max || value.contains('\r') || value.contains('\n') {
        None
    } else {
        Some(value.to_string())
    }
}

fn can_access(datasource: &StoredDatasource, caller: &Caller) -> bool {
    if caller.kind == CallerKind::Platform {
        return true;
    }
    if caller.kind != CallerKind::Principal {
        return false;
    }
    let Some(principal) = &caller.principal else {
        return false;
    };
    if let Some(org_id) = &datasource.org_id {
        return principal.org.as_deref() == Some(org_id);
    }
    if let Some(account_id) = &datasource.account_id {
        return principal.account.as_deref() == Some(account_id);
    }
    false
}

fn to_api_datasource(datasource: &StoredDatasource) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), Value::String(datasource.id.clone()));
    out.insert("slug".into(), Value::String(datasource.slug.clone()));
    out.insert("name".into(), Value::String(datasource.name.clone()));
    out.insert(
        "entityType".into(),
        Value::String(datasource.entity_type.clone()),
    );
    out.insert("license".into(), Value::String(datasource.license.clone()));
    if let Some(url) = &datasource.license_url {
        out.insert("licenseUrl".into(), Value::String(url.clone()));
    }
    out.insert("contexts".into(), json!(datasource.contexts));
    out.insert(
        "defaultVisibility".into(),
        Value::String(datasource.default_visibility.clone()),
    );
    if let Some(description) = &datasource.description {
        out.insert("description".into(), Value::String(description.clone()));
    }
    if let Some(org) = &datasource.org_id {
        out.insert("orgId".into(), Value::String(org.clone()));
    }
    if let Some(account) = &datasource.account_id {
        out.insert("accountId".into(), Value::String(account.clone()));
    }
    out.insert(
        "createdAt".into(),
        Value::String(datasource.created_at.clone()),
    );
    out.insert(
        "updatedAt".into(),
        Value::String(datasource.updated_at.clone()),
    );
    Value::Object(out)
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name
        .nfd()
        .filter(|c| !matches!(*c, '\u{0300}'..='\u{036f}'))
        .flat_map(char::to_lowercase)
    {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').chars().take(64).collect::<String>();
    if trimmed.is_empty() {
        "dataset".into()
    } else {
        trimmed
    }
}

fn context_url_re() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^https?://[^\s]{1,400}$").unwrap())
}

fn slug_re() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").unwrap())
}

fn entity_type_re() -> &'static Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$").unwrap())
}

fn clean_contexts(value: Option<&Value>) -> Result<Vec<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) if items.len() <= 10 => {
            let mut out = Vec::new();
            for item in items {
                let text = match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                if !context_url_re().is_match(&text) {
                    return Err(format!(
                        "context URL invalid: '{}'",
                        text.chars().take(80).collect::<String>()
                    ));
                }
                out.push(text);
            }
            Ok(out)
        }
        _ => Err("contexts must be an array of ≤10 URL strings".into()),
    }
}

fn clean_license(
    id: Option<&Value>,
    url: Option<&Value>,
) -> Result<(String, Option<String>), String> {
    let license = id
        .map(|value| match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if license.is_empty() {
        return Err("license is required (see GET /v1/lds/licenses)".into());
    }
    if let Some(builtin) = find_license(&license) {
        let custom_url = url
            .map(|value| match value {
                Value::String(text) => text.trim().to_string(),
                other => other.to_string(),
            })
            .filter(|value| !value.is_empty());
        if let Some(custom_url) = &custom_url {
            if !context_url_re().is_match(custom_url) {
                return Err("licenseUrl must be an http(s) URL".into());
            }
        }
        return Ok((
            builtin.id.to_string(),
            Some(custom_url.unwrap_or_else(|| builtin.url.to_string())),
        ));
    }
    if !is_custom_license_id(&license) {
        return Err(format!(
            "unknown license '{}' (use a built-in SPDX id or LicenseRef-<name> with licenseUrl)",
            license.chars().take(64).collect::<String>()
        ));
    }
    let custom_url = url
        .map(|value| match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    if !context_url_re().is_match(&custom_url) {
        return Err("custom licenses require an http(s) licenseUrl".into());
    }
    Ok((license, Some(custom_url)))
}

async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1") {
        return next.run(request).await;
    }
    if state.config.is_prod && !verify_internal(request.headers(), &state.config.internal_secret) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Missing or invalid internal credential".into()),
        );
    }
    let caller = resolve_caller(request.headers());
    request.extensions_mut().insert(caller);
    next.run(request).await
}

async fn security_and_metrics(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let hsts = std::env::var("HSTS_ENABLED").as_deref() == Ok("true");
    let incoming = header(request.headers(), "x-request-id")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
        .take(128)
        .collect::<String>();
    let request_id = if incoming.is_empty() {
        format!(
            "{:x}-{:x}",
            Utc::now().timestamp_millis(),
            Utc::now().timestamp_subsec_nanos()
        )
    } else {
        incoming
    };
    let method = request.method().as_str().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| express_route(matched.as_str()))
        .unwrap_or_else(|| {
            let path = request.uri().path();
            let mut segments = path.split('/').filter(|segment| !segment.is_empty());
            let first = segments.next().unwrap_or("");
            let second = segments.next().unwrap_or("");
            let third = segments.next().unwrap_or("");
            format!("/{first}/{second}/{third}")
        });
    let mut response = next.run(request).await;
    let status = response.status().as_u16();
    let headers = response.headers_mut();
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
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
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        headers.insert("x-request-id", value);
    }
    if let Ok(mut metrics) = state.metrics.lock() {
        if metrics.len() < 300 {
            *metrics
                .entry(format!("{method}|{route}|{status}"))
                .or_insert(0) += 1;
        }
    }
    response
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
        && !audit::is_read_only_post(&method, &route);
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
    let action = audit::mutation_action("lds", &method, &route, &path);
    audit::record(audit::AuditEvent {
        actor_type,
        actor_id,
        org_id,
        account_id,
        action,
        resource: format!("lds:{route}"),
        result: result.into(),
        status_code: status,
        request_id,
        context: json!({
            "service": "lds",
            "method": method,
            "route": route,
            "params": {},
            "result": result,
        }),
    });
    response
}

async fn health(State(state): State<AppState>) -> Response {
    let mut body = Map::new();
    body.insert("status".into(), Value::String("ok".into()));
    body.insert("service".into(), Value::String("lds".into()));
    body.insert("version".into(), Value::String(VERSION.into()));
    body.insert(
        "db".into(),
        Value::String(if state.store.uses_postgres() {
            "postgres".into()
        } else {
            "memory".into()
        }),
    );
    body.insert("licenses".into(), json!(LDS_LICENSES.len()));
    body.insert(
        "reservedAttributes".into(),
        json!(LDS_RESERVED_ATTRIBUTES.len()),
    );
    if let Ok(datasources) = state.store.list_datasources().await {
        body.insert("datasources".into(), json!(datasources.len()));
    }
    body.insert(
        "time".into(),
        Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
    );
    Json(Value::Object(body)).into_response()
}

async fn metrics(State(state): State<AppState>) -> Response {
    let mut lines = vec![
        "# HELP synapseone_lds_up LDS service up.".to_string(),
        "# TYPE synapseone_lds_up gauge".to_string(),
        "synapseone_lds_up 1".to_string(),
        "# HELP synapseone_lds_process_uptime_seconds Process uptime in seconds.".to_string(),
        "# TYPE synapseone_lds_process_uptime_seconds gauge".to_string(),
        format!(
            "synapseone_lds_process_uptime_seconds {}",
            state.started.elapsed().as_secs()
        ),
        "# HELP synapseone_lds_http_requests_total HTTP requests by key = method|route|status."
            .to_string(),
        "# TYPE synapseone_lds_http_requests_total counter".to_string(),
    ];
    if let Ok(metrics) = state.metrics.lock() {
        for (key, count) in metrics.iter() {
            lines.push(format!(
                "synapseone_lds_http_requests_total{{key=\"{}\"}} {}",
                key.replace('"', ""),
                count
            ));
        }
    }
    if let Ok(datasources) = state.store.list_datasources().await {
        let mut records = 0i64;
        for datasource in &datasources {
            if let Ok((count, _)) = state.store.stats(&datasource.id).await {
                records += count;
            }
        }
        lines.push("# HELP synapseone_lds_datasources_total Datasource count.".into());
        lines.push("# TYPE synapseone_lds_datasources_total gauge".into());
        lines.push(format!(
            "synapseone_lds_datasources_total {}",
            datasources.len()
        ));
        lines.push(
            "# HELP synapseone_lds_records_total Stored records across all datasources.".into(),
        );
        lines.push("# TYPE synapseone_lds_records_total gauge".into());
        lines.push(format!("synapseone_lds_records_total {records}"));
    }
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        format!("{}\n", lines.join("\n")),
    )
        .into_response()
}

async fn licenses_route() -> Response {
    Json(LDS_LICENSES).into_response()
}

async fn list_datasources(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if caller.kind == CallerKind::Anon {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports (GET /v1/lds/licenses, GET /v1/lds/datasources/:id/entities)".into()),
        );
    }
    let mut datasources = match state.store.list_datasources().await {
        Ok(datasources) => datasources,
        Err(error) => return internal_error(error),
    };
    datasources.retain(|datasource| can_access(datasource, &caller));
    if let Some(org_id) = query.get("orgId").filter(|value| !value.is_empty()) {
        let wanted = org_id.chars().take(128).collect::<String>();
        datasources.retain(|datasource| datasource.org_id.clone().unwrap_or_default() == wanted);
    }
    if let Some(account_id) = query.get("accountId").filter(|value| !value.is_empty()) {
        let wanted = account_id.chars().take(128).collect::<String>();
        datasources
            .retain(|datasource| datasource.account_id.clone().unwrap_or_default() == wanted);
    }
    Json(Value::Array(
        datasources
            .iter()
            .map(to_api_datasource)
            .collect::<Vec<_>>(),
    ))
    .into_response()
}

async fn create_datasource(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    body: Bytes,
) -> Response {
    if caller.kind == CallerKind::Anon {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports".into()),
        );
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        );
    };
    let object = body.as_object().cloned().unwrap_or_default();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() || name.chars().count() > 200 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_name",
            Some("name must be 1..200 chars".into()),
        );
    }
    let entity_type = object
        .get("entityType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !entity_type_re().is_match(&entity_type) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_entity_type",
            Some("entityType must match [A-Za-z][A-Za-z0-9_-]{0,63}".into()),
        );
    }
    let slug = object
        .get("slug")
        .filter(|value| !matches!(value, Value::Null))
        .map(|value| match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| slugify(&name));
    if !slug_re().is_match(&slug) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_slug",
            Some("slug must match [a-z0-9][a-z0-9-]{0,63}".into()),
        );
    }
    let (license, license_url) = match clean_license(object.get("license"), object.get("licenseUrl"))
    {
        Ok(value) => value,
        Err(message) => {
            return json_error(StatusCode::BAD_REQUEST, "invalid_license", Some(message))
        }
    };
    let contexts = match clean_contexts(object.get("contexts")) {
        Ok(value) => value,
        Err(message) => {
            return json_error(StatusCode::BAD_REQUEST, "invalid_contexts", Some(message))
        }
    };
    let default_visibility = object
        .get("defaultVisibility")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_else(|| "internal".into());
    if !["public", "internal"].contains(&default_visibility.as_str()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_visibility",
            Some("defaultVisibility must be public|internal".into()),
        );
    }
    if let Some(description) = object.get("description") {
        if !description.is_null() && description.as_str().unwrap_or("").chars().count() > 500 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_description",
                Some("description ≤500 chars".into()),
            );
        }
    }
    let body_org = object
        .get("orgId")
        .filter(|value| !matches!(value, Value::Null))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|value| !value.is_empty());
    let body_account = object
        .get("accountId")
        .filter(|value| !matches!(value, Value::Null))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .filter(|value| !value.is_empty());
    let body_org = match body_org {
        Some(value) => match clean_id(&value, 128) {
            Some(value) => Some(value),
            None => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_tenant",
                    Some("orgId/accountId must be 1..128 chars".into()),
                )
            }
        },
        None => None,
    };
    let body_account = match body_account {
        Some(value) => match clean_id(&value, 128) {
            Some(value) => Some(value),
            None => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_tenant",
                    Some("orgId/accountId must be 1..128 chars".into()),
                )
            }
        },
        None => None,
    };
    let principal = caller.principal.clone();
    let (org_id, account_id) = match &principal {
        Some(principal) if principal.org.is_some() => {
            if let Some(body_org) = &body_org {
                if Some(body_org) != principal.org.as_ref() {
                    return json_error(
                        StatusCode::FORBIDDEN,
                        "cross_tenant",
                        Some("cannot create a datasource outside your own org".into()),
                    );
                }
            }
            (
                principal.org.clone(),
                body_account.or_else(|| principal.account.clone()),
            )
        }
        Some(principal) => {
            if body_org.is_some() {
                return json_error(
                    StatusCode::FORBIDDEN,
                    "cross_tenant",
                    Some("account-scoped principals cannot create org-bound datasources".into()),
                );
            }
            if let Some(body_account) = &body_account {
                if Some(body_account) != principal.account.as_ref() {
                    return json_error(
                        StatusCode::FORBIDDEN,
                        "cross_tenant",
                        Some("cannot create a datasource outside your own account".into()),
                    );
                }
            }
            (None, principal.account.clone())
        }
        None => (body_org, body_account),
    };
    let description = object.get("description").map(|value| match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    });
    let created_by = principal.as_ref().map(|principal| principal.sub.clone());
    match state
        .store
        .create_datasource(NewDatasource {
            slug,
            name,
            entity_type,
            license,
            license_url,
            contexts,
            default_visibility,
            description: description.filter(|value| !value.is_empty()),
            org_id,
            account_id,
            created_by,
        })
        .await
    {
        Ok(datasource) => (StatusCode::CREATED, Json(to_api_datasource(&datasource))).into_response(),
        Err(error) if error.conflict => {
            json_error(StatusCode::CONFLICT, "slug_conflict", Some(error.message))
        }
        Err(error) => internal_error(error),
    }
}

async fn get_datasource(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = clean_id(&id, 128) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id", None);
    };
    if caller.kind == CallerKind::Anon {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports".into()),
        );
    }
    let datasource = match state.store.get_datasource(&id).await {
        Ok(Some(datasource)) if can_access(&datasource, &caller) => datasource,
        Ok(_) => {
            return json_error(
                StatusCode::NOT_FOUND,
                "not_found",
                Some("datasource not found".into()),
            )
        }
        Err(error) => return internal_error(error),
    };
    let attributes = match state.store.get_attributes(&id).await {
        Ok(attributes) => attributes,
        Err(error) => return internal_error(error),
    };
    let stats = match stats_json(&state, &datasource, &attributes).await {
        Ok(stats) => stats,
        Err(error) => return internal_error(error),
    };
    let mut body = to_api_datasource(&datasource).as_object().cloned().unwrap_or_default();
    body.insert("attributes".into(), serde_json::to_value(attributes).unwrap_or(Value::Null));
    body.insert("stats".into(), stats);
    Json(Value::Object(body)).into_response()
}

async fn patch_datasource(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(id) = clean_id(&id, 128) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id", None);
    };
    if caller.kind == CallerKind::Anon {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports".into()),
        );
    }
    let current = match state.store.get_datasource(&id).await {
        Ok(Some(datasource)) if can_access(&datasource, &caller) => datasource,
        Ok(_) => {
            return json_error(
                StatusCode::NOT_FOUND,
                "not_found",
                Some("datasource not found".into()),
            )
        }
        Err(error) => return internal_error(error),
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        );
    };
    let object = body.as_object().cloned().unwrap_or_default();
    let mut patch = DatasourcePatch::default();
    if let Some(value) = object.get("name") {
        let name = match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        };
        if name.is_empty() || name.chars().count() > 200 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_name",
                Some("name must be 1..200 chars".into()),
            );
        }
        patch.name = Some(name);
    }
    if let Some(value) = object.get("slug") {
        let slug = match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        };
        if !slug_re().is_match(&slug) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_slug",
                Some("slug must match [a-z0-9][a-z0-9-]{0,63}".into()),
            );
        }
        patch.slug = Some(slug);
    }
    if object.get("license").is_some() {
        let (license, license_url) =
            match clean_license(object.get("license"), object.get("licenseUrl")) {
                Ok(value) => value,
                Err(message) => {
                    return json_error(StatusCode::BAD_REQUEST, "invalid_license", Some(message))
                }
            };
        patch.license = Some(license);
        patch.license_url = Some(license_url);
    } else if let Some(value) = object.get("licenseUrl") {
        let url = match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        };
        if !context_url_re().is_match(&url) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_license",
                Some("licenseUrl must be an http(s) URL".into()),
            );
        }
        patch.license_url = Some(Some(url));
    }
    if let Some(value) = object.get("contexts") {
        match clean_contexts(Some(value)) {
            Ok(contexts) => patch.contexts = Some(contexts),
            Err(message) => {
                return json_error(StatusCode::BAD_REQUEST, "invalid_contexts", Some(message))
            }
        }
    }
    if let Some(value) = object.get("defaultVisibility") {
        let visibility = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        if !["public", "internal"].contains(&visibility.as_str()) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_visibility",
                Some("defaultVisibility must be public|internal".into()),
            );
        }
        patch.default_visibility = Some(visibility);
    }
    if let Some(value) = object.get("entityType") {
        let entity_type = match value {
            Value::String(text) => text.trim().to_string(),
            other => other.to_string(),
        };
        if !entity_type_re().is_match(&entity_type) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_entity_type",
                Some("entityType must match [A-Za-z][A-Za-z0-9_-]{0,63}".into()),
            );
        }
        patch.entity_type = Some(entity_type);
    }
    if let Some(value) = object.get("description") {
        let description = match value {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            other => Some(other.to_string()),
        };
        if let Some(description) = &description {
            if description.chars().count() > 500 {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_description",
                    Some("description ≤500 chars".into()),
                );
            }
        }
        patch.description = Some(description);
    }
    let has_fields = patch.name.is_some()
        || patch.slug.is_some()
        || patch.license.is_some()
        || patch.license_url.is_some()
        || patch.contexts.is_some()
        || patch.default_visibility.is_some()
        || patch.entity_type.is_some()
        || patch.description.is_some();
    if !has_fields {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            Some("no updatable fields provided".into()),
        );
    }
    let _ = current;
    match state.store.update_datasource(&id, patch).await {
        Ok(Some(updated)) => Json(to_api_datasource(&updated)).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "not_found",
            Some("datasource not found".into()),
        ),
        Err(error) if error.conflict => {
            json_error(StatusCode::CONFLICT, "slug_conflict", Some(error.message))
        }
        Err(error) => internal_error(error),
    }
}

async fn delete_datasource(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> Response {
    let Some(id) = clean_id(&id, 128) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id", None);
    };
    if caller.kind == CallerKind::Anon {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports".into()),
        );
    }
    match state.store.get_datasource(&id).await {
        Ok(Some(datasource)) if can_access(&datasource, &caller) => {}
        Ok(_) => {
            return json_error(
                StatusCode::NOT_FOUND,
                "not_found",
                Some("datasource not found".into()),
            )
        }
        Err(error) => return internal_error(error),
    }
    match state.store.delete_datasource(&id).await {
        Ok(_) => Json(json!({"ok": true, "id": id})).into_response(),
        Err(error) => internal_error(error),
    }
}

async fn get_attributes(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> Response {
    let datasource = match load_datasource(&state, &caller, &id).await {
        Ok(datasource) => datasource,
        Err(response) => return response,
    };
    match state.store.get_attributes(&datasource.id).await {
        Ok(attributes) => Json(serde_json::to_value(attributes).unwrap_or(Value::Null)).into_response(),
        Err(error) => internal_error(error),
    }
}

async fn put_attributes(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let datasource = match load_datasource(&state, &caller, &id).await {
        Ok(datasource) => datasource,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        );
    };
    let attributes = body.get("attributes").cloned().unwrap_or(Value::Null);
    let with_defaults = if let Some(items) = attributes.as_array() {
        Value::Array(
            items
                .iter()
                .map(|item| {
                    let Some(object) = item.as_object() else {
                        return item.clone();
                    };
                    if object.get("visibility").is_some() {
                        return item.clone();
                    }
                    let mut object = object.clone();
                    object.insert(
                        "visibility".into(),
                        Value::String(if datasource.default_visibility == "public" {
                            "public".into()
                        } else {
                            "internal".into()
                        }),
                    );
                    Value::Object(object)
                })
                .collect(),
        )
    } else {
        attributes
    };
    let validated = match validate_attribute_registry(&with_defaults) {
        Ok(attributes) => attributes,
        Err(error) => {
            let mut body = Map::new();
            body.insert("error".into(), Value::String(error.error));
            body.insert("message".into(), Value::String(error.message));
            if !error.reserved.is_empty() {
                body.insert("reserved".into(), json!(error.reserved));
            }
            return (StatusCode::BAD_REQUEST, Json(Value::Object(body))).into_response();
        }
    };
    match state.store.replace_attributes(&datasource.id, validated).await {
        Ok(saved) => Json(serde_json::to_value(saved).unwrap_or(Value::Null)).into_response(),
        Err(error) => internal_error(error),
    }
}

async fn ingest_records(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let datasource = match load_datasource(&state, &caller, &id).await {
        Ok(datasource) => datasource,
        Err(response) => return response,
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        );
    };
    let records: Vec<Value> = match body.as_object() {
        Some(object) if object.contains_key("records") => object
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        Some(object)
            if object.len() == 1
                && object
                    .get("record")
                    .map(Value::is_object)
                    .unwrap_or(false) =>
        {
            vec![object.get("record").cloned().unwrap()]
        }
        _ => vec![body.clone()],
    };
    if records.is_empty() || records.len() > 1000 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_records",
            Some("1..1000 records per call".into()),
        );
    }
    let principal = caller.principal.as_ref().map(|principal| IngestPrincipal {
        sub: Some(principal.sub.clone()),
        org: principal.org.clone(),
        account: principal.account.clone(),
    });
    let registry = match state.store.get_attributes(&datasource.id).await {
        Ok(registry) => registry,
        Err(error) => return internal_error(error),
    };
    let like = DatasourceLike {
        id: datasource.id.clone(),
        entity_type: datasource.entity_type.clone(),
    };
    let mut entities = Vec::new();
    let mut quarantined: Vec<Value> = Vec::new();
    let mut created = 0usize;
    let mut updated = 0usize;
    for (index, raw) in records.iter().enumerate() {
        let result: Result<(), String> = async {
            let Some(object) = raw.as_object() else {
                return Err("record must be a JSON object".to_string());
            };
            if serde_json::to_string(raw).map(|text| text.len()).unwrap_or(0) > 256 * 1024 {
                return Err("record exceeds 256KB".to_string());
            }
            let previous = match resolve_identity(&like, object, None) {
                Ok((entity_id, _, _)) => state
                    .store
                    .get_record(&datasource.id, &entity_id)
                    .await
                    .map_err(|error| error.message)?,
                Err(_) => None,
            };
            let ingested = ingest_record(&like, &registry, object, principal.as_ref(), previous.as_ref())?;
            let (saved, was_created) = state
                .store
                .upsert_record(ingested.record.clone())
                .await
                .map_err(|error| error.message)?;
            if was_created {
                created += 1;
            } else {
                updated += 1;
            }
            for (field, reason) in ingested.quarantined {
                let mut item = json!({ "field": field, "reason": reason });
                if let Some(source) = &saved.source_record_id {
                    item["record"] = Value::String(source.chars().take(64).collect());
                }
                quarantined.push(item);
            }
            entities.push(json!({
                "entityId": saved.entity_id,
                "sourceRecordId": saved.source_record_id,
                "version": saved.version,
            }));
            Ok(())
        }
        .await;
        if let Err(error) = result {
            quarantined.push(json!({
                "field": format!("records[{index}]"),
                "reason": error.chars().take(200).collect::<String>(),
            }));
        }
    }
    let ingested = created + updated;
    let status = if ingested > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::BAD_REQUEST
    };
    (
        status,
        Json(json!({
            "ingested": ingested,
            "created": created,
            "updated": updated,
            "quarantined": quarantined,
            "entities": entities,
        })),
    )
        .into_response()
}

async fn export_entities(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path((id, entity_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    export_entities_inner(state, caller, id, Some(entity_id), query).await
}

async fn export_entities_list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    export_entities_inner(state, caller, id, None, query).await
}

async fn export_entities_inner(
    state: AppState,
    caller: Caller,
    id: String,
    entity_id: Option<String>,
    query: HashMap<String, String>,
) -> Response {
    if caller.kind == CallerKind::Anon && entity_id.is_some() {
        // GET is allowed for anonymous callers; nothing to reject here.
    }
    let Some(id) = clean_id(&id, 128) else {
        return json_error(StatusCode::BAD_REQUEST, "invalid_id", None);
    };
    let datasource = match state.store.get_datasource(&id).await {
        Ok(Some(datasource)) => datasource,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                "not_found",
                Some("datasource not found".into()),
            )
        }
        Err(error) => return internal_error(error),
    };
    if caller.kind == CallerKind::Principal && !can_access(&datasource, &caller) {
        return json_error(
            StatusCode::NOT_FOUND,
            "not_found",
            Some("datasource not found".into()),
        );
    }
    let visibility = query
        .get("visibility")
        .cloned()
        .unwrap_or_else(|| "public".into());
    if !["public", "restricted"].contains(&visibility.as_str()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_visibility",
            Some("visibility must be public|restricted".into()),
        );
    }
    if visibility == "restricted" {
        let tenanted = caller.kind == CallerKind::Platform
            || caller
                .principal
                .as_ref()
                .is_some_and(|principal| {
                    (principal.org.is_some()
                        && datasource.org_id.is_some()
                        && principal.org == datasource.org_id)
                        || (principal.account.is_some()
                            && datasource.account_id.is_some()
                            && principal.account == datasource.account_id)
                });
        if !tenanted {
            return if caller.kind == CallerKind::Anon {
                json_error(
                    StatusCode::UNAUTHORIZED,
                    "auth_required",
                    Some("restricted visibility requires an authenticated caller inside the datasource tenant".into()),
                )
            } else {
                json_error(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    Some("datasource not found".into()),
                )
            };
        }
    }
    let registry = match state.store.get_attributes(&datasource.id).await {
        Ok(registry) => registry,
        Err(error) => return internal_error(error),
    };
    let mut context_urls = Vec::new();
    if let Some(url) = &datasource.license_url {
        context_urls.push(url.clone());
    }
    context_urls.extend(datasource.contexts.iter().cloned());
    let mode = if visibility == "restricted" {
        "restricted"
    } else {
        "public"
    };
    let mut response = if let Some(entity_id) = entity_id {
        let Some(entity_id) = clean_id(&entity_id, 512) else {
            return json_error(StatusCode::BAD_REQUEST, "invalid_entity_id", None);
        };
        match state.store.get_record(&datasource.id, &entity_id).await {
            Ok(Some(record)) => {
                Json(project_entity(&record, &registry, &context_urls, mode)).into_response()
            }
            Ok(None) => {
                return json_error(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    Some("entity not found".into()),
                )
            }
            Err(error) => return internal_error(error),
        }
    } else {
        if let Some(raw_limit) = query.get("limit") {
            if !raw_limit.chars().all(|c| c.is_ascii_digit())
                || raw_limit.is_empty()
                || raw_limit.len() > 4
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_limit",
                    Some("limit must be an integer 1..500".into()),
                );
            }
        }
        let limit = query
            .get("limit")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(100);
        if !(1..=500).contains(&limit) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_limit",
                Some("limit must be an integer 1..500".into()),
            );
        }
        if let Some(raw_offset) = query.get("offset") {
            if !raw_offset.chars().all(|c| c.is_ascii_digit())
                || raw_offset.is_empty()
                || raw_offset.len() > 9
            {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_offset",
                    Some("offset must be an integer >= 0".into()),
                );
            }
        }
        let offset = query
            .get("offset")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let (items, total) = match state.store.list_records(&datasource.id, limit, offset).await {
            Ok(value) => value,
            Err(error) => return internal_error(error),
        };
        let entities = items
            .iter()
            .map(|record| project_entity(record, &registry, &context_urls, mode))
            .collect::<Vec<_>>();
        let mut response = Json(Value::Array(entities)).into_response();
        response
            .headers_mut()
            .insert("x-lds-total", HeaderValue::from_str(&total.to_string()).unwrap());
        response
    };
    let headers = response.headers_mut();
    if let Some(url) = &datasource.license_url {
        if let Ok(value) = HeaderValue::from_str(&format!("<{url}>; rel=\"license\"")) {
            headers.insert("link", value);
        }
    }
    if let Ok(value) = HeaderValue::from_str(&datasource.license) {
        headers.insert("x-lds-license", value);
    }
    if let Ok(value) = HeaderValue::from_str(&datasource.slug) {
        headers.insert("x-lds-datasource", value);
    }
    headers.insert(
        "x-lds-context",
        HeaderValue::from_static(NGSI_LD_CORE_CONTEXT),
    );
    headers.insert(
        "cache-control",
        HeaderValue::from_static(if mode == "restricted" {
            "private, no-store"
        } else {
            "public, max-age=60"
        }),
    );
    response
}

async fn datasource_stats(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(id): Path<String>,
) -> Response {
    let datasource = match load_datasource(&state, &caller, &id).await {
        Ok(datasource) => datasource,
        Err(response) => return response,
    };
    let attributes = match state.store.get_attributes(&datasource.id).await {
        Ok(attributes) => attributes,
        Err(error) => return internal_error(error),
    };
    match stats_json(&state, &datasource, &attributes).await {
        Ok(stats) => {
            let mut body = Map::new();
            body.insert("id".into(), Value::String(datasource.id));
            body.insert("slug".into(), Value::String(datasource.slug));
            if let Value::Object(stats) = stats {
                for (key, value) in stats {
                    body.insert(key, value);
                }
            }
            Json(Value::Object(body)).into_response()
        }
        Err(error) => internal_error(error),
    }
}

async fn stats_json(
    state: &AppState,
    datasource: &StoredDatasource,
    attributes: &[RegistryAttribute],
) -> Result<Value, StoreError> {
    let (records, last_ingest) = state.store.stats(&datasource.id).await?;
    let mut public = 0u64;
    let mut restricted = 0u64;
    let mut internal = 0u64;
    for attribute in attributes {
        match attribute.visibility.as_str() {
            "public" => public += 1,
            "restricted" => restricted += 1,
            _ => internal += 1,
        }
    }
    Ok(json!({
        "records": records,
        "attributes": {
            "public": public,
            "restricted": restricted,
            "internal": internal,
        },
        "lastIngestAt": last_ingest,
    }))
}

async fn load_datasource(
    state: &AppState,
    caller: &Caller,
    id: &str,
) -> Result<StoredDatasource, Response> {
    let Some(id) = clean_id(id, 128) else {
        return Err(json_error(StatusCode::BAD_REQUEST, "invalid_id", None));
    };
    if caller.kind == CallerKind::Anon {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "auth_required",
            Some("anonymous callers may only read public exports (GET /v1/lds/licenses, GET /v1/lds/datasources/:id/entities)".into()),
        ));
    }
    match state.store.get_datasource(&id).await {
        Ok(Some(datasource)) if can_access(&datasource, caller) => Ok(datasource),
        Ok(_) => Err(json_error(
            StatusCode::NOT_FOUND,
            "not_found",
            Some("datasource not found".into()),
        )),
        Err(error) => Err(internal_error(error)),
    }
}

fn internal_error(error: StoreError) -> Response {
    tracing::error!("[lds] store error: {}", error.message);
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        Some("unexpected error".into()),
    )
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "not_found", None)
}

fn build_app(state: AppState) -> Router {
    let cors = if state.config.cors_origins.is_empty() {
        if state.config.is_prod {
            None
        } else {
            Some(CorsLayer::new().allow_origin(Any))
        }
    } else {
        let origins = state
            .config
            .cors_origins
            .iter()
            .filter_map(|origin| origin.parse().ok())
            .collect::<Vec<_>>();
        Some(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods(Any)
                .allow_headers(Any),
        )
    };
    let mut app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/v1/lds/licenses", get(licenses_route))
        .route(
            "/v1/lds/datasources",
            get(list_datasources).post(create_datasource),
        )
        .route(
            "/v1/lds/datasources/{id}",
            get(get_datasource)
                .patch(patch_datasource)
                .delete(delete_datasource),
        )
        .route(
            "/v1/lds/datasources/{id}/attributes",
            get(get_attributes).put(put_attributes),
        )
        .route(
            "/v1/lds/datasources/{id}/records",
            post(ingest_records),
        )
        .route(
            "/v1/lds/datasources/{id}/entities",
            get(export_entities_list),
        )
        .route(
            "/v1/lds/datasources/{id}/entities/{entityId}",
            get(export_entities),
        )
        .route("/v1/lds/datasources/{id}/stats", get(datasource_stats))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .layer(middleware::from_fn(audit_middleware))
        .layer(middleware::from_fn_with_state(state.clone(), security_and_metrics))
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state);
    if let Some(cors) = cors {
        app = app.layer(cors);
    }
    app
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
    if config.is_prod {
        if config.internal_secret.is_empty() {
            eprintln!("[lds] SYNAPSEONE_INTERNAL_SECRET must be set in production");
            std::process::exit(1);
        }
        if std::env::var("DATABASE_URL").unwrap_or_default().trim().is_empty() {
            eprintln!("[lds] DATABASE_URL must be set in production (in-memory fallback would split-brain)");
            std::process::exit(1);
        }
    }
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[lds][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let database_url = std::env::var("DATABASE_URL").unwrap_or_default();
    let store = Store::connect(Some(&database_url)).await?;
    let state = AppState {
        store: store.clone(),
        config: config.clone(),
        metrics: Arc::new(Mutex::new(HashMap::new())),
        started: Instant::now(),
    };
    let app = build_app(state);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[lds] SynapseLDS listening on :{} (db={})",
        config.port,
        if store.uses_postgres() {
            "postgres"
        } else {
            "memory"
        }
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
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    async fn state() -> AppState {
        AppState {
            store: Store::connect(None).await.unwrap(),
            config: Config {
                port: 0,
                is_prod: false,
                internal_secret: String::new(),
                cors_origins: vec![],
            },
            metrics: Arc::new(Mutex::new(HashMap::new())),
            started: Instant::now(),
        }
    }


    async fn send(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
        org: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let builder = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-synapseone-user", "user-1")
            .header("x-synapseone-org", org);
        let request = builder
            .body(Body::from(
                body.map(|value| serde_json::to_vec(&value).unwrap())
                    .unwrap_or_default(),
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, json)
    }

    async fn create(app: Router) -> (String, Value) {
        let (status, _, body) = send(
            app,
            "POST",
            "/v1/lds/datasources",
            Some(json!({
                "name": "Business Registry",
                "entityType": "Organization",
                "license": "CC-BY-4.0",
            })),
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (body["id"].as_str().unwrap().to_string(), body)
    }

    #[tokio::test]
    async fn datasource_lifecycle_and_licenses() {
        let app = build_app(state().await);
        let (status, _, body) = send(app.clone(), "GET", "/v1/lds/licenses", None, "org-a").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().unwrap().len(), 6);

        let (id, body) = create(app.clone()).await;
        assert_eq!(body["licenseUrl"], "https://creativecommons.org/licenses/by/4.0/");
        let (status, _, fetched) = send(
            app.clone(),
            "GET",
            &format!("/v1/lds/datasources/{id}"),
            None,
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fetched["id"], id);

        let (status, _, _) = send(
            app.clone(),
            "PATCH",
            &format!("/v1/lds/datasources/{id}"),
            Some(json!({"license": "ODbL-1.0"})),
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (status, _, _) = send(
            app,
            "DELETE",
            &format!("/v1/lds/datasources/{id}"),
            None,
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn attribute_registry_default_deny_and_reserved() {
        let app = build_app(state().await);
        let (id, _) = create(app.clone()).await;
        let (status, _, body) = send(
            app.clone(),
            "PUT",
            &format!("/v1/lds/datasources/{id}/attributes"),
            Some(json!({"attributes": [{"name": "name", "ngsiLdType": "Property", "visibility": "public"}]})),
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["name"], "name");

        let (status, _, body) = send(
            app,
            "PUT",
            &format!("/v1/lds/datasources/{id}/attributes"),
            Some(json!({"attributes": [{"name": "id"}]})),
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "reserved_attribute");
    }

    #[tokio::test]
    async fn ingest_and_public_export_filters_unregistered() {
        let app = build_app(state().await);
        let (id, _) = create(app.clone()).await;
        send(
            app.clone(),
            "PUT",
            &format!("/v1/lds/datasources/{id}/attributes"),
            Some(json!({
                "attributes": [
                    {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
                    {"name": "ownerEmail", "sourceField": "email", "visibility": "restricted"},
                    {"name": "secret", "visibility": "internal"}
                ]
            })),
            "org-a",
        )
        .await;
        let (status, _, body) = send(
            app.clone(),
            "POST",
            &format!("/v1/lds/datasources/{id}/records"),
            Some(json!({"id": "55001", "name": "ACME", "email": "ops@acme.test", "secret": "hidden", "unregistered": "nope", "_core": {"x": 1}})),
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["created"], 1);
        assert!(body["quarantined"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["field"] == "_core"));

        let (status, headers, entities) = send(
            app.clone(),
            "GET",
            &format!("/v1/lds/datasources/{id}/entities"),
            None,
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(entities.as_array().unwrap().len(), 1);
        assert_eq!(entities[0]["name"]["value"], "ACME");
        assert!(entities[0].get("ownerEmail").is_none());
        assert!(entities[0].get("secret").is_none());
        assert!(entities[0].get("unregistered").is_none());
        assert_eq!(headers["x-lds-license"], "CC-BY-4.0");

        let (status, _, restricted) = send(
            app,
            "GET",
            &format!("/v1/lds/datasources/{id}/entities?visibility=restricted"),
            None,
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(restricted[0]["ownerEmail"]["value"], "ops@acme.test");
        assert!(restricted[0].get("secret").is_none());
    }

    #[tokio::test]
    async fn tenant_isolation_hides_datasources() {
        let app = build_app(state().await);
        let (id, _) = create(app.clone()).await;
        let (status, _, body) = send(
            app.clone(),
            "GET",
            &format!("/v1/lds/datasources/{id}"),
            None,
            "org-b",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not_found");
        let (_, _, list) = send(app, "GET", "/v1/lds/datasources", None, "org-b").await;
        assert!(list.as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pagination_validation() {
        let app = build_app(state().await);
        let (id, _) = create(app.clone()).await;
        let (status, _, body) = send(
            app,
            "GET",
            &format!("/v1/lds/datasources/{id}/entities?limit=0"),
            None,
            "org-a",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "invalid_limit");
    }
}
