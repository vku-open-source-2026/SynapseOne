// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Application wiring: middleware, public endpoints, route dispatch and the
//! central auth/authorization/proxy pipeline.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::{AuthFailure, AuthService, Principal};
use crate::authz::{action_for, AuthzDecider, AuthzMode, AuthzOutcome, AuthzService, IamDecider};
use crate::config::{validate_security_config, Config};
use crate::headers::{propagate_principal, request_id, HSTS_HEADER, SECURITY_HEADERS};
use crate::metrics::{Metrics, CONTENT_TYPE};
use crate::proxy::{proxy_error_response, proxy_request, ProxyError};
use crate::rate_limit::{LimitResult, RateLimiter};
use crate::routes::{find_route, validate_routes, AuthMode, RouteRule};
use crate::scopes::scope_allows;
use crate::usage::{feature_for_route, is_usage_excluded, UsageEvent, UsageTelemetry};

const INTERNAL_ONLY_PATHS: [&str; 3] = ["/v1/audit/ingest", "/v1/usage/ingest", "/v1/keys/verify"];

/// Owner-scoped platform runner keys are system compute. Keep them on the
/// runner protocol, runner bootstrap/heartbeat, the platform queue namespace
/// and key verification; everything else is denied at the edge.
pub(crate) fn platform_runner_path_allowed(path: &str) -> bool {
    // Platform runner paths are plain ids/queue names. Refuse encoded or
    // non-canonical spellings so `/v1/workflow-runners/../platform` cannot be
    // matched as one prefix by us and another by an upstream.
    let Some(canonical) = canonical_policy_path(path) else {
        return false;
    };
    if canonical != path {
        return false;
    }
    path == "/v1/auth/verify"
        || path.starts_with("/v1/runner/")
        || path.starts_with("/v1/workflow-runners/")
        || path.starts_with("/v1/queue/")
}

fn path_under(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// Decode one percent-encoding layer and resolve `.`/`..`/duplicate slashes.
/// The result is used only for policy decisions; forwarding keeps the original
/// URI. Returns `None` for malformed/ambiguous paths (invalid UTF-8/hex,
/// remaining `%` after one decode = double encoding, backslashes, controls,
/// or an escape above the root).
pub(crate) fn canonical_policy_path(path: &str) -> Option<String> {
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_value(bytes[i + 1])?;
            let lo = hex_value(bytes[i + 2])?;
            decoded.push((hi << 4) | lo);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(decoded).ok()?;
    // A second layer (`%252e`) would become `%2e` above; refusing any residual
    // `%` closes double-encoding differences between gateway and upstream.
    if decoded.contains('%') || decoded.contains('\\') {
        return None;
    }
    if decoded
        .chars()
        .any(|ch| ch == '\0' || ch.is_control())
    {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return None;
                }
            }
            value => segments.push(value),
        }
    }
    Some(format!("/{}", segments.join("/")))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Data-plane services an exec-delegated token may call. Everything else
/// (IAM, keys, credentials, workflow definitions/executions/runners, platform
/// admin, audit/usage, secrets, MCP) is denied. The existing scope check still
/// runs afterwards, so the grant needs the concrete service action.
const EXEC_DELEGATED_DATA_PLANE_PREFIXES: [&str; 10] = [
    "/v1/base",
    "/v1/search",
    "/v1/lds",
    "/v1/faststore",
    "/v1/ocs",
    "/v1/storage",
    "/v1/warehouse",
    "/v1/stream",
    "/v1/notifications",
    "/v1/inference",
];

fn service_prefix(path: &str) -> Option<&'static str> {
    EXEC_DELEGATED_DATA_PLANE_PREFIXES
        .iter()
        .copied()
        .find(|prefix| path_under(path, *prefix))
}

/// Data-plane scope families an execution grant may carry. Universal (`*`,
/// `*:read`) and control-plane families are refused so a grant cannot become a
/// master tenant credential even before the path policy runs.
const EXEC_DELEGATED_SCOPE_FAMILIES: [&str; 11] = [
    "base",
    "search",
    "lds",
    "faststore",
    "ocs",
    "storage",
    "warehouse",
    "stream",
    "notifications",
    "inference",
    "queue",
];

pub(crate) fn exec_delegated_scopes_allowed(scopes: &[String]) -> bool {
    if scopes.is_empty() {
        return false;
    }
    scopes.iter().all(|scope| {
        let family = scope.split(':').next().unwrap_or("");
        // Never accept a universal grant: execution tokens must name their
        // concrete data-plane family (workflow-service derives them from the graph).
        if family == "*" {
            return false;
        }
        !family.is_empty() && EXEC_DELEGATED_SCOPE_FAMILIES.contains(&family)
    })
}

/// Policy for `kind=exec-delegated` JWTs. Requires the raw and canonical paths
/// to resolve to the *same* data-plane service; this blocks traversal and
/// encoding differences without breaking encoded object keys under `/v1/ocs`.
/// Queue access is limited to message operations in the execution's tenant.
pub(crate) fn exec_delegated_request_allowed(method: &str, raw: &str, canonical: &str) -> bool {
    if !matches!(
        method,
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return false;
    }
    if let (Some(raw_service), Some(canonical_service)) =
        (service_prefix(raw), service_prefix(canonical))
    {
        return raw_service == canonical_service;
    }
    // `/v1/inference-jobs` is the inference job data lane (separate route).
    if path_under(raw, "/v1/inference-jobs") && path_under(canonical, "/v1/inference-jobs") {
        return true;
    }
    // Queue is data-plane but has destructive admin routes. Only publish /
    // consume / ack / nack / heartbeat are allowed, and only via POST.
    if method != "POST"
        || !path_under(raw, "/v1/queue/queues")
        || !path_under(canonical, "/v1/queue/queues")
    {
        return false;
    }
    let Some(rest) = canonical.strip_prefix("/v1/queue/queues/") else {
        return false;
    };
    let Some((queue, action)) = rest.split_once('/') else {
        return false;
    };
    if queue.is_empty() || queue.contains('/') {
        return false;
    }
    matches!(action, "messages" | "consume" | "ack" | "nack" | "heartbeat")
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub routes: Arc<Vec<RouteRule>>,
    pub auth: Arc<AuthService>,
    pub authz: Arc<AuthzService>,
    pub usage: Arc<UsageTelemetry>,
    pub metrics: Arc<Metrics>,
    pub rate: Arc<RateLimiter>,
    pub quota: Arc<RateLimiter>,
    pub client: reqwest::Client,
}

impl AppState {
    pub fn client_ip(&self, headers: &HeaderMap, remote: Option<IpAddr>) -> String {
        self.config
            .trust_proxy
            .client_ip(headers, remote)
            .unwrap_or_else(|| "anon".into())
            .chars()
            .take(64)
            .collect()
    }
}

type MetaHandle = axum::extract::Extension<Arc<Mutex<RequestMeta>>>;

#[derive(Clone, Debug, Default)]
struct RequestMeta {
    route: Option<RouteMeta>,
    principal: Option<Principal>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct RouteMeta {
    path: String,
    auth: AuthMode,
}

fn update_meta(meta: &Option<MetaHandle>, update: impl FnOnce(&mut RequestMeta)) {
    if let Some(meta) = meta {
        if let Ok(mut value) = meta.0.lock() {
            update(&mut value);
        }
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .expect("gateway http client")
}

#[cfg(test)]
pub fn create_app(config: Config, routes: Vec<RouteRule>) -> Result<Router, String> {
    Ok(build_router(build_state(config, routes)?))
}

#[cfg(test)]
pub fn create_app_with_decider(
    config: Config,
    routes: Vec<RouteRule>,
    decider: Arc<dyn AuthzDecider>,
) -> Result<Router, String> {
    Ok(build_router(build_state_with_decider(
        config,
        routes,
        Some(decider),
    )?))
}

pub fn create_app_with_state(
    config: Config,
    routes: Vec<RouteRule>,
) -> Result<(Router, AppState), String> {
    let state = build_state(config, routes)?;
    Ok((build_router(state.clone()), state))
}

fn build_state(config: Config, routes: Vec<RouteRule>) -> Result<AppState, String> {
    build_state_with_decider(config, routes, None)
}

fn build_state_with_decider(
    config: Config,
    routes: Vec<RouteRule>,
    decider: Option<Arc<dyn AuthzDecider>>,
) -> Result<AppState, String> {
    validate_security_config(
        config.is_prod,
        config.verify_api_key,
        config.authz_mode,
        std::env::var("AUTHZ_MODE_REQUIRED").as_deref() == Ok("true"),
        &config.authz_audit_ack,
    )?;
    validate_routes(&routes)?;
    let client = http_client();
    let auth = Arc::new(AuthService::new(&config, client.clone()));
    let metrics = Arc::new(Metrics::new());
    let decider = decider.unwrap_or_else(|| {
        Arc::new(IamDecider::new(
            client.clone(),
            &config.iam_service_url,
            &config.internal_secret,
        ))
    });
    let authz = Arc::new(AuthzService::new(
        config.authz_mode,
        config.authz_cache_ttl,
        decider,
        metrics.clone(),
    ));
    let usage = UsageTelemetry::new(
        client.clone(),
        &config.iam_service_url,
        &config.internal_secret,
        config.usage_enabled,
    );
    Ok(AppState {
        config: Arc::new(config),
        routes: Arc::new(routes),
        auth,
        authz,
        usage,
        metrics,
        rate: Arc::new(RateLimiter::new()),
        quota: Arc::new(RateLimiter::new()),
        client,
    })
}

pub fn start_background(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    state.usage.start()
}

fn build_router(state: AppState) -> Router {
    let health_route = get(health).fallback(method_not_found);
    let metrics_route = get(metrics).fallback(method_not_found);
    let ready_route = get(ready).fallback(method_not_found);
    let root_route = get(root).fallback(method_not_found);
    Router::new()
        .route("/health", health_route)
        .route("/metrics", metrics_route)
        .route("/ready", ready_route)
        .route("/", root_route)
        .fallback(dispatch)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            usage_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_id_middleware,
        ))
        .with_state(state)
}

// ---------- small response helpers ----------

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn error_response(status: StatusCode, error: &str, message: Option<&str>) -> Response {
    let mut body = serde_json::Map::new();
    body.insert("error".into(), json!(error));
    if let Some(message) = message {
        if !message.is_empty() {
            body.insert("message".into(), json!(message));
        }
    }
    json_response(status, Value::Object(body))
}

fn not_found_response() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "not_found",
        Some("No gateway route matched"),
    )
}

async fn method_not_found() -> Response {
    not_found_response()
}

// ---------- middleware ----------

async fn request_id_middleware(
    State(_state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let id = request_id(request.headers());
    if let Ok(value) = HeaderValue::from_str(&id) {
        request
            .headers_mut()
            .insert(HeaderName::from_static("x-request-id"), value);
    }
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-request-id"), value);
    }
    response
}

async fn security_middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in SECURITY_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    if state.config.hsts {
        headers.insert(HSTS_HEADER.0, HeaderValue::from_static(HSTS_HEADER.1));
    }
    response
}

async fn cors_middleware(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let is_preflight = request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key("access-control-request-method");
    let allowed_origin = cors_allowed_origin(&state.config.cors_origins, origin.as_deref());

    if is_preflight {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        if let Some(origin) = &allowed_origin {
            if let Ok(value) = HeaderValue::from_str(origin) {
                headers.insert("access-control-allow-origin", value);
            }
        }
        if !state.config.cors_origins.is_empty() {
            headers.append(
                "vary",
                HeaderValue::from_static("Origin, Access-Control-Request-Headers"),
            );
        }
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET,HEAD,PUT,PATCH,POST,DELETE"),
        );
        if let Some(requested) = request
            .headers()
            .get("access-control-request-headers")
            .cloned()
        {
            headers.insert("access-control-allow-headers", requested);
        }
        return response;
    }

    let mut response = next.run(request).await;
    if let Some(origin) = allowed_origin {
        if let Ok(value) = HeaderValue::from_str(&origin) {
            response
                .headers_mut()
                .insert("access-control-allow-origin", value);
        }
    }
    if !state.config.cors_origins.is_empty() && origin.is_some() {
        response
            .headers_mut()
            .append("vary", HeaderValue::from_static("Origin"));
    }
    response
}

fn cors_allowed_origin(configured: &[String], origin: Option<&str>) -> Option<String> {
    if configured.is_empty() {
        return Some("*".into());
    }
    let origin = origin?;
    configured
        .iter()
        .find(|allowed| allowed.as_str() == origin)
        .cloned()
}

async fn usage_middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let meta = Arc::new(Mutex::new(RequestMeta::default()));
    request
        .extensions_mut()
        .insert(axum::extract::Extension(meta.clone()));

    let response = next.run(request).await;
    let status = response.status();

    let snapshot = match meta.lock() {
        Ok(meta) => meta.clone(),
        Err(_) => RequestMeta::default(),
    };
    if let Some(route) = &snapshot.route {
        if !is_usage_excluded(&path) {
            let principal = snapshot.principal.as_ref();
            let mut auth_kind = "unauthenticated".to_string();
            if let Some(principal) = principal {
                auth_kind = if principal.r#type == "jwt" {
                    principal.kind_or_user()
                } else {
                    "apikey".into()
                };
            } else if route.auth == AuthMode::None {
                auth_kind = "anonymous".into();
            }
            let is_user = principal
                .map(|principal| principal.r#type == "jwt" && principal.kind_or_user() == "user")
                .unwrap_or(false);
            let error = snapshot.error.clone().or_else(|| {
                if status.as_u16() >= 500 {
                    Some("server_error".to_string())
                } else if status.as_u16() >= 400 {
                    Some("client_error".to_string())
                } else {
                    None
                }
            });
            let duration_ms = (started.elapsed().as_secs_f64() * 1000.0).round().max(0.0) as u64;
            state.usage.enqueue(UsageEvent {
                created_at: now_iso(),
                request_id,
                feature: feature_for_route(&route.path),
                route: route.path.clone(),
                method,
                path: path.clone(),
                status: status.as_u16(),
                duration_ms,
                auth_kind,
                org_id: principal.and_then(|principal| principal.org.clone()),
                account_id: principal.and_then(|principal| principal.account.clone()),
                user_id: if is_user {
                    principal.and_then(|principal| principal.sub.clone())
                } else {
                    None
                },
                error,
            });
        }
    }
    response
}

// ---------- public endpoints ----------

async fn health(State(state): State<AppState>) -> Response {
    json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "service": "gateway",
            "version": state.config.version,
            "schemaVersion": "1",
            "dependencies": [],
            "time": now_iso(),
        }),
    )
}

async fn metrics(State(state): State<AppState>) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, CONTENT_TYPE)],
        state.metrics.render(&state.config.version),
    )
        .into_response()
}

async fn root(State(state): State<AppState>) -> Response {
    let routes = state
        .routes
        .iter()
        .map(|route| json!({ "path": route.path, "auth": route.auth.as_str() }))
        .collect::<Vec<_>>();
    json_response(
        StatusCode::OK,
        json!({
            "name": "SynapseOne Gateway (Tier-1 PaaS)",
            "version": state.config.version,
            "docs": ["/health", "/ready", "/metrics"],
            "auth": "Bearer JWT | X-API-Key (except /v1/auth/*)",
            "routes": routes,
        }),
    )
}

async fn ready(State(state): State<AppState>, request: Request) -> Response {
    let ip = state.client_ip(request.headers(), remote_ip(&request));
    if let LimitResult::Limited { .. } = state.rate.hit(&ip, 30) {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            Some("Too many requests, slow down"),
        );
    }

    let probes = state.config.ready_upstreams.iter().map(|upstream| {
        let client = state.client.clone();
        let internal_secret = state.config.internal_secret.clone();
        let name = upstream.name.clone();
        let url = upstream.url.clone();
        let required = upstream.required;
        async move { probe_upstream(&client, &name, &url, &internal_secret, required).await }
    });
    let upstreams = futures_util::future::join_all(probes).await;
    let critical_ok = upstreams.iter().filter(|u| u.required).all(|u| u.ok);
    let optional_degraded = upstreams.iter().any(|u| !u.required && !u.ok);
    let authz_audit = state.config.is_prod && state.config.authz_mode == AuthzMode::Audit;
    let mut body = json!({
        "status": if critical_ok { "ready" } else { "degraded" },
        "service": "gateway",
        "version": state.config.version,
        "schemaVersion": "1",
        "criticalOk": critical_ok,
        "optionalDegraded": optional_degraded,
        "authzMode": state.config.authz_mode.as_str(),
        "upstreams": upstreams,
        "time": now_iso(),
    });
    if authz_audit {
        body["authzWarning"] = json!("audit mode does not enforce policy denies");
        body["authzAuditAck"] = json!(state.config.authz_audit_ack);
    }
    json_response(
        if critical_ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        body,
    )
}

#[derive(Serialize)]
struct ProbeResult {
    name: String,
    ok: bool,
    required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "dependencyStatus")]
    dependency_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn probe_upstream(
    client: &reqwest::Client,
    name: &str,
    base_url: &str,
    internal_secret: &str,
    required: bool,
) -> ProbeResult {
    let started = Instant::now();
    // Node services expose a dependency-aware /ready; Rust services expose
    // /health. Probing the stronger endpoint avoids green readiness on a
    // service whose database is down.
    let path = if matches!(name, "iam" | "workflow") { "/ready" } else { "/health" };
    let mut request = client
        .get(format!("{}{path}", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(4))
        .header("x-request-id", "ready-probe");
    if !internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", internal_secret);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            let body = response.json::<Value>().await.ok();
            let version = body
                .as_ref()
                .and_then(|body| body.get("version"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let dependency_status = body
                .as_ref()
                .and_then(|body| body.get("status"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let reported_ok = dependency_status
                .as_deref()
                .map(|value| matches!(value, "ok" | "ready" | "healthy"))
                .unwrap_or(true);
            ProbeResult {
                name: name.to_string(),
                ok: status.is_success() && reported_ok,
                required,
                status: Some(status.as_u16()),
                ms: elapsed_ms(started),
                version,
                dependency_status,
                error: None,
            }
        }
        Err(_) => ProbeResult {
            name: name.to_string(),
            ok: false,
            required,
            status: None,
            ms: elapsed_ms(started),
            version: None,
            dependency_status: None,
            error: Some("unreachable".into()),
        },
    }
}

// ---------- dispatch pipeline ----------

async fn dispatch(State(state): State<AppState>, mut request: Request) -> Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let method_text = method.as_str().to_string();
    let meta = request
        .extensions()
        .get::<axum::extract::Extension<Arc<Mutex<RequestMeta>>>>()
        .cloned();
    let ip = state.client_ip(request.headers(), remote_ip(&request));

    if path.starts_with("/v1/auth/") && path != "/v1/auth/verify" {
        if let LimitResult::Limited { .. } = state.rate.hit(&ip, 120) {
            update_meta(&meta, |meta| meta.error = Some("rate_limited".into()));
            return error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                Some("Too many requests, slow down"),
            );
        }
    }
    if path.starts_with("/v1/platform/") {
        if let LimitResult::Limited { .. } = state.rate.hit(&ip, 120) {
            update_meta(&meta, |meta| meta.error = Some("rate_limited".into()));
            return error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                Some("Too many requests, slow down"),
            );
        }
    }

    // Service-to-service endpoints never reach the public gateway.
    if INTERNAL_ONLY_PATHS.contains(&path.as_str()) {
        return not_found_response();
    }

    let route = match find_route(&state.routes, &path) {
        Some(route) => route,
        None => return not_found_response(),
    };
    update_meta(&meta, |meta| {
        meta.route = Some(RouteMeta {
            path: route.path.clone(),
            auth: route.auth,
        })
    });
    state.metrics.inc_request(&route.path, "incoming");

    let principal = match state.auth.authenticate(route, request.headers()).await {
        Ok(principal) => principal,
        Err(failure) => {
            update_meta(&meta, |meta| meta.error = Some(failure.error.clone()));
            return auth_failure_response(failure);
        }
    };
    update_meta(&meta, |meta| meta.principal = principal.clone());

    let is_platform_path = path == "/v1/platform" || path.starts_with("/v1/platform/");
    let is_platform_session = path == "/v1/platform/session";
    let principal_kind = principal
        .as_ref()
        .and_then(|principal| principal.kind.as_deref());
    if is_platform_path && !is_platform_session && principal_kind != Some("platform-admin") {
        update_meta(&meta, |meta| {
            meta.error = Some("platform_admin_required".into())
        });
        return error_response(
            StatusCode::FORBIDDEN,
            "platform_admin_required",
            Some("a platform administrator token is required"),
        );
    }
    if !is_platform_path && principal_kind == Some("platform-admin") {
        update_meta(&meta, |meta| {
            meta.error = Some("platform_token_tenant_forbidden".into())
        });
        return error_response(
            StatusCode::FORBIDDEN,
            "platform_token_tenant_forbidden",
            Some("platform tokens cannot call tenant APIs"),
        );
    }

    // Legacy 1-hour platform-runner delegations minted before execution grants
    // existed are broad user sessions with only `act.sub=platform-runner:<id>`.
    // They must not survive the upgrade. Ordinary delegated sessions (other
    // `act.sub`, e.g. service accounts/Tier-2) keep their existing behavior.
    if principal_kind == Some("delegated")
        && principal
            .as_ref()
            .and_then(|principal| principal.act_sub.as_deref())
            .is_some_and(|actor| actor.starts_with("platform-runner:"))
    {
        update_meta(&meta, |meta| {
            meta.error = Some("execution_grant_legacy_forbidden".into())
        });
        return error_response(
            StatusCode::UNAUTHORIZED,
            "execution_grant_legacy_forbidden",
            Some("legacy platform-runner delegations are retired; re-run the job with an exec-delegated grant"),
        );
    }

    // Per-execution delegated grants are data-plane only. The control plane
    // (IAM/keys/credentials/workflow/admin) is denied even if the minted scopes
    // are broad, and the grant row is checked against IAM on every request so
    // completion/release/runner revocation takes effect immediately.
    if principal_kind == Some("exec-delegated") {
        let Some(canonical) = canonical_policy_path(&path) else {
            update_meta(&meta, |meta| {
                meta.error = Some("execution_scope_forbidden".into())
            });
            return error_response(
                StatusCode::FORBIDDEN,
                "execution_scope_forbidden",
                Some("execution grants may only call canonical data-plane paths"),
            );
        };
        if !exec_delegated_request_allowed(&method_text, &path, &canonical) {
            update_meta(&meta, |meta| {
                meta.error = Some("execution_scope_forbidden".into())
            });
            return error_response(
                StatusCode::FORBIDDEN,
                "execution_scope_forbidden",
                Some("execution grants may only call data-plane dataset, storage, cache, stream, notification and inference APIs"),
            );
        }
        let grant = principal.as_ref();
        if !grant.is_some_and(|principal| exec_delegated_scopes_allowed(&principal.scopes)) {
            update_meta(&meta, |meta| {
                meta.error = Some("execution_scope_forbidden".into())
            });
            return error_response(
                StatusCode::FORBIDDEN,
                "execution_scope_forbidden",
                Some("execution grants must carry data-plane scopes only"),
            );
        }
        let grant_complete = grant
            .and_then(|principal| principal.jti.as_deref())
            .filter(|value| !value.is_empty())
            .is_some()
            && grant
                .and_then(|principal| principal.exec.as_deref())
                .filter(|value| !value.is_empty())
                .is_some()
            && grant
                .and_then(|principal| principal.runner_id.as_deref())
                .filter(|value| !value.is_empty())
                .is_some()
            && grant
                .and_then(|principal| principal.instance.as_deref())
                .filter(|value| !value.is_empty())
                .is_some();
        if !grant_complete {
            update_meta(&meta, |meta| meta.error = Some("invalid_token".into()));
            return error_response(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                Some("execution grant is missing its execution/runner/instance binding"),
            );
        }
        let token = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or("");
        if let Err(failure) = state.auth.verify_execution_grant(token).await {
            update_meta(&meta, |meta| meta.error = Some(failure.error.clone()));
            return error_response(failure.status, &failure.error, Some(failure.message.as_str()));
        }
        // Fall through: the normal scope check and central authorization still
        // apply, so the grant needs the concrete data-plane scope/action.
    }

    // Platform runner keys are shared system compute, not tenant credentials.
    // They may only reach the runner protocol, runner bootstrap/heartbeat, the
    // platform-namespaced queue and key verification. Workflow-service
    // authorizes each claim by runner id + queue + execution mode.
    if principal_kind == Some("platform-runner") {
        if !platform_runner_path_allowed(&path) {
            update_meta(&meta, |meta| {
                meta.error = Some("platform_runner_path_forbidden".into())
            });
            return error_response(
                StatusCode::FORBIDDEN,
                "platform_runner_path_forbidden",
                Some("platform runner keys may only call the runner protocol, runner bootstrap and the platform queue"),
            );
        }
        propagate_principal(
            request.headers_mut(),
            principal.as_ref(),
            Some(route.auth),
            &state.config.internal_secret,
        );
        return forward(&state, route, request, &meta, None).await;
    }

    // The session exchange is the boundary where a normal user proves platform
    // administrator status + a fresh second factor. IAM owns that decision.
    if is_platform_session {
        propagate_principal(
            request.headers_mut(),
            principal.as_ref(),
            Some(route.auth),
            &state.config.internal_secret,
        );
        return forward(&state, route, request, &meta, None).await;
    }

    if let Some(principal) = &principal {
        if route.auth != AuthMode::None {
            let action = if route.service.is_some() {
                action_for(route, &method_text, &path)
            } else {
                None
            };
            if !scope_allows(
                &principal.scopes,
                &path,
                &method_text,
                route.service.as_deref(),
                action.as_deref(),
            ) {
                update_meta(&meta, |meta| meta.error = Some("scope_denied".into()));
                return error_response(
                    StatusCode::FORBIDDEN,
                    "scope_denied",
                    Some(&format!(
                        "Credential scopes do not allow {} {}",
                        method_text.to_ascii_uppercase(),
                        path
                    )),
                );
            }
        }
    }

    if route.path == "/v1/inference" || route.path == "/v1/ai" {
        let tenant = principal
            .as_ref()
            .and_then(|principal| principal.org.clone().or_else(|| principal.account.clone()))
            .unwrap_or_else(|| ip.clone());
        let limit = u64::from(state.config.inference_rate_limit_per_min);
        if let LimitResult::Limited { retry_after } =
            state.quota.hit(&format!("inference:{tenant}"), limit)
        {
            update_meta(&meta, |meta| meta.error = Some("quota_exceeded".into()));
            let mut response = json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({
                    "error": "quota_exceeded",
                    "message": format!(
                        "Inference quota is {} requests/minute per tenant",
                        limit
                    ),
                    "retryAfter": retry_after,
                }),
            );
            if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
                response.headers_mut().insert("retry-after", value);
            }
            return response;
        }
    }

    propagate_principal(
        request.headers_mut(),
        principal.as_ref(),
        Some(route.auth),
        &state.config.internal_secret,
    );

    let mut audit_header = None;
    match state
        .authz
        .check(route, principal.as_ref(), &method_text, &path)
        .await
    {
        AuthzOutcome::Allow => {}
        AuthzOutcome::AuditWouldDeny { header } => audit_header = Some(header),
        AuthzOutcome::Unavailable => {
            update_meta(&meta, |meta| meta.error = Some("authz_unavailable".into()));
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "authz_unavailable",
                Some("authorization service unreachable"),
            );
        }
        AuthzOutcome::Denied {
            action,
            resource,
            reason,
        } => {
            update_meta(&meta, |meta| meta.error = Some("access_denied".into()));
            return json_response(
                StatusCode::FORBIDDEN,
                json!({
                    "error": "access_denied",
                    "message": format!("not authorized to perform {action} on {resource}"),
                    "action": action,
                    "resource": resource,
                    "reason": reason,
                }),
            );
        }
    }

    forward(&state, route, request, &meta, audit_header).await
}

async fn forward(
    state: &AppState,
    route: &RouteRule,
    request: Request,
    meta: &Option<MetaHandle>,
    audit_header: Option<String>,
) -> Response {
    let timeout = Duration::from_millis(route.timeout_ms(state.config.proxy_timeout_ms));
    let result = proxy_request(&state.client, &route.target, request, timeout).await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => {
            if matches!(error, ProxyError::Upstream(_)) {
                update_meta(meta, |meta| {
                    meta.error = Some("upstream_unavailable".into())
                });
            }
            proxy_error_response(&error)
        }
    };
    if let Some(header) = audit_header {
        if let Ok(value) = HeaderValue::from_str(&header) {
            response.headers_mut().insert("x-synapseone-authz", value);
        }
    }
    response
}

fn auth_failure_response(failure: AuthFailure) -> Response {
    error_response(
        failure.status,
        &failure.error,
        if failure.message.is_empty() {
            None
        } else {
            Some(&failure.message)
        },
    )
}

fn remote_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|connect_info| connect_info.0.ip())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn elapsed_ms(started: Instant) -> u64 {
    (started.elapsed().as_secs_f64() * 1000.0).round().max(0.0) as u64
}

/// Exposed for tests that need to assert the trust-proxy helper without
/// spinning an HTTP server.
#[cfg(test)]
pub fn resolve_client_ip(config: &Config, headers: &HeaderMap, remote: Option<IpAddr>) -> String {
    config
        .trust_proxy
        .client_ip(headers, remote)
        .unwrap_or_else(|| "anon".into())
}
