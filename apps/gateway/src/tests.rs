// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Behavioural tests ported from the TypeScript gateway test suite.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::app::{create_app, create_app_with_decider, create_app_with_state, resolve_client_ip};
use crate::auth::{verify_api_key_upstream, AuthService, Principal};
use crate::authz::{
    action_for, iam_principal, resource_for, verb_for_method, AuthzDecider, AuthzDecision,
    AuthzMode, BoxFuture,
};
use crate::config::{
    effective_jwt_secret, is_weak_jwt_secret, parse_trust_proxy, validate_security_config, Config,
    TrustEntry, TrustProxy,
};
use crate::headers::{propagate_principal, request_id, sanitize_request_id};
use crate::metrics::Metrics;
use crate::rate_limit::{LimitResult, RateLimiter};
use crate::routes::{
    compile_route_path, expand_env, find_route, load_routes, parse_routes_yaml, AuthMode, RouteRule,
};
use crate::scopes::{scope_allows, scope_requirement};
use crate::usage::{feature_for_route, is_usage_excluded, UsageEvent, UsageTelemetry};

const TEST_SECRET: &str = "gateway-test-secret-0123456789abcdef";
const TEST_INTERNAL: &str = "gateway-test-internal-secret";
const TEST_ISSUER: &str = "synapseone-iam";

// ---------- servers ----------

struct TestServer {
    base: String,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn spawn(router: Router) -> TestServer {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    TestServer {
        base: format!("http://{address}"),
        handle,
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap()
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn sign(claims: Value) -> String {
    let header = Header::new(Algorithm::HS256);
    encode(
        &header,
        &claims,
        &EncodingKey::from_secret(TEST_SECRET.as_bytes()),
    )
    .unwrap()
}

fn sign_with(claims: Value, secret: &str) -> String {
    let header = Header::new(Algorithm::HS256);
    encode(
        &header,
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

fn user_claims(sub: &str, org: &str) -> Value {
    json!({
        "sub": sub,
        "org": org,
        "kind": "user",
        "scopes": ["*"],
        "iss": TEST_ISSUER,
        "exp": now_ts() + 300,
    })
}

fn user_token(sub: &str, org: &str) -> String {
    sign(user_claims(sub, org))
}

fn platform_admin_claims(sub: &str) -> Value {
    json!({
        "sub": sub,
        "kind": "platform-admin",
        "scopes": ["*"],
        "iss": TEST_ISSUER,
        "exp": now_ts() + 300,
    })
}

fn step_up_claims() -> Value {
    json!({
        "sub": "user-1",
        "kind": "platform-step-up",
        "typ": "platform_step_up",
        "aud": "synapseone-platform-step-up",
        "iss": TEST_ISSUER,
        "exp": now_ts() + 300,
    })
}

// ---------- mock IAM ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VerifyMode {
    Ok,
    Revoked,
    Down,
}

#[derive(Clone, Debug)]
enum KeyMode {
    Valid {
        account: &'static str,
        org: &'static str,
        scopes: Vec<&'static str>,
    },
    Invalid,
    Error,
}

#[derive(Clone, Debug)]
enum AuthzMock {
    Allow(&'static str),
    Deny(&'static str),
    Error,
}

struct MockIamState {
    verify: Mutex<VerifyMode>,
    verify_hits: AtomicUsize,
    key: Mutex<KeyMode>,
    key_hits: AtomicUsize,
    key_internal: Mutex<Option<String>>,
    key_body: Mutex<Option<Value>>,
    authz: Mutex<AuthzMock>,
    authz_hits: AtomicUsize,
    authz_body: Mutex<Option<Value>>,
    authz_internal: Mutex<Option<String>>,
    session_hits: AtomicUsize,
    usage_events: Mutex<Vec<Value>>,
    usage_internal: Mutex<Option<String>>,
}

#[derive(Clone)]
struct MockIam {
    state: Arc<MockIamState>,
}

impl MockIam {
    async fn spawn() -> (TestServer, Self) {
        let state = Arc::new(MockIamState {
            verify: Mutex::new(VerifyMode::Ok),
            verify_hits: AtomicUsize::new(0),
            key: Mutex::new(KeyMode::Invalid),
            key_hits: AtomicUsize::new(0),
            key_internal: Mutex::new(None),
            key_body: Mutex::new(None),
            authz: Mutex::new(AuthzMock::Allow("policy-allow")),
            authz_hits: AtomicUsize::new(0),
            authz_body: Mutex::new(None),
            authz_internal: Mutex::new(None),
            session_hits: AtomicUsize::new(0),
            usage_events: Mutex::new(Vec::new()),
            usage_internal: Mutex::new(None),
        });
        let router = Router::new()
            .route("/v1/auth/verify", get(mock_verify))
            .route("/v1/keys/verify", post(mock_keys))
            .route("/internal/authorize", post(mock_authorize))
            .route("/v1/usage/ingest", post(mock_usage))
            .route("/v1/platform/session", post(mock_platform_session))
            .route(
                "/v1/platform/me",
                get(|| async { Json(json!({ "me": true })) }),
            )
            .route(
                "/v1/platform/admins",
                post(|| async { Json(json!({ "created": true })) }),
            )
            .route("/health", get(mock_health))
            .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))) })
            .with_state(state.clone());
        let server = spawn(router).await;
        (server, Self { state })
    }

    fn set_verify(&self, mode: VerifyMode) {
        *self.state.verify.lock().unwrap() = mode;
    }

    fn verify_hits(&self) -> usize {
        self.state.verify_hits.load(Ordering::SeqCst)
    }

    fn set_key(&self, mode: KeyMode) {
        *self.state.key.lock().unwrap() = mode;
    }

    fn key_hits(&self) -> usize {
        self.state.key_hits.load(Ordering::SeqCst)
    }

    fn key_internal(&self) -> Option<String> {
        self.state.key_internal.lock().unwrap().clone()
    }

    fn key_body(&self) -> Option<Value> {
        self.state.key_body.lock().unwrap().clone()
    }

    fn set_authz(&self, mode: AuthzMock) {
        *self.state.authz.lock().unwrap() = mode;
    }

    fn authz_hits(&self) -> usize {
        self.state.authz_hits.load(Ordering::SeqCst)
    }

    fn authz_body(&self) -> Option<Value> {
        self.state.authz_body.lock().unwrap().clone()
    }

    fn authz_internal(&self) -> Option<String> {
        self.state.authz_internal.lock().unwrap().clone()
    }

    fn session_hits(&self) -> usize {
        self.state.session_hits.load(Ordering::SeqCst)
    }

    fn usage_events(&self) -> Vec<Value> {
        self.state.usage_events.lock().unwrap().clone()
    }

    fn usage_internal(&self) -> Option<String> {
        self.state.usage_internal.lock().unwrap().clone()
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn mock_verify(State(state): State<Arc<MockIamState>>) -> Response {
    state.verify_hits.fetch_add(1, Ordering::SeqCst);
    match *state.verify.lock().unwrap() {
        VerifyMode::Ok => Json(json!({ "valid": true })).into_response(),
        VerifyMode::Revoked => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "valid": false, "error": "token_revoked" })),
        )
            .into_response(),
        VerifyMode::Down => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn mock_keys(
    State(state): State<Arc<MockIamState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    state.key_hits.fetch_add(1, Ordering::SeqCst);
    *state.key_internal.lock().unwrap() = header_value(&headers, "x-synapseone-internal");
    *state.key_body.lock().unwrap() = serde_json::from_slice(&body).ok();
    match state.key.lock().unwrap().clone() {
        KeyMode::Valid {
            account,
            org,
            scopes,
        } => Json(json!({
            "valid": true,
            "id": "key-1",
            "account_id": account,
            "org_id": org,
            "user_id": Value::Null,
            "scopes": scopes,
        }))
        .into_response(),
        KeyMode::Invalid => {
            (StatusCode::UNAUTHORIZED, Json(json!({ "valid": false }))).into_response()
        }
        KeyMode::Error => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "valid": false })),
        )
            .into_response(),
    }
}

async fn mock_authorize(
    State(state): State<Arc<MockIamState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    state.authz_hits.fetch_add(1, Ordering::SeqCst);
    *state.authz_internal.lock().unwrap() = header_value(&headers, "x-synapseone-internal");
    *state.authz_body.lock().unwrap() = serde_json::from_slice(&body).ok();
    match *state.authz.lock().unwrap() {
        AuthzMock::Allow(reason) => Json(json!({ "allowed": true, "reason": reason })),
        AuthzMock::Deny(reason) => Json(json!({ "allowed": false, "reason": reason })),
        AuthzMock::Error => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
    .into_response()
}

async fn mock_usage(
    State(state): State<Arc<MockIamState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    *state.usage_internal.lock().unwrap() = header_value(&headers, "x-synapseone-internal");
    if let Ok(value) = serde_json::from_slice::<Value>(&body) {
        if let Some(events) = value.get("events").and_then(Value::as_array) {
            state
                .usage_events
                .lock()
                .unwrap()
                .extend(events.iter().cloned());
        }
    }
    StatusCode::OK.into_response()
}

async fn mock_platform_session(State(state): State<Arc<MockIamState>>) -> Response {
    state.session_hits.fetch_add(1, Ordering::SeqCst);
    Json(json!({ "accessToken": "fake-platform-token" })).into_response()
}

async fn mock_health() -> Response {
    Json(json!({ "status": "ok", "version": "test" })).into_response()
}

// ---------- echo upstream ----------

struct UpstreamState {
    hits: AtomicUsize,
    headers: Mutex<HashMap<String, String>>,
    body: Mutex<Vec<u8>>,
    path: Mutex<String>,
    status: AtomicU16,
    delay_ms: AtomicU64,
}

struct Upstream {
    server: TestServer,
    state: Arc<UpstreamState>,
}

impl Upstream {
    async fn spawn() -> Self {
        let state = Arc::new(UpstreamState {
            hits: AtomicUsize::new(0),
            headers: Mutex::new(HashMap::new()),
            body: Mutex::new(Vec::new()),
            path: Mutex::new(String::new()),
            status: AtomicU16::new(200),
            delay_ms: AtomicU64::new(0),
        });
        let router = Router::new()
            .fallback(upstream_handler)
            .with_state(state.clone());
        Self {
            server: spawn(router).await,
            state,
        }
    }

    fn base(&self) -> &str {
        &self.server.base
    }

    fn hits(&self) -> usize {
        self.state.hits.load(Ordering::SeqCst)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.state.headers.lock().unwrap().get(name).cloned()
    }

    fn body(&self) -> Vec<u8> {
        self.state.body.lock().unwrap().clone()
    }

    fn path(&self) -> String {
        self.state.path.lock().unwrap().clone()
    }

    fn set_status(&self, status: u16) {
        self.state.status.store(status, Ordering::SeqCst);
    }

    fn set_delay(&self, delay_ms: u64) {
        self.state.delay_ms.store(delay_ms, Ordering::SeqCst);
    }
}

async fn upstream_handler(State(state): State<Arc<UpstreamState>>, request: Request) -> Response {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let path = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_default();
    *state.path.lock().unwrap() = path.clone();
    {
        let mut headers = state.headers.lock().unwrap();
        headers.clear();
        for (name, value) in request.headers() {
            if let Ok(value) = value.to_str() {
                headers.insert(name.as_str().to_string(), value.to_string());
            }
        }
    }
    let body = to_bytes(request.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let length = body.len();
    *state.body.lock().unwrap() = body.to_vec();
    let delay = state.state_delay();
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let status = StatusCode::from_u16(state.state_status()).unwrap_or(StatusCode::OK);
    (
        status,
        Json(json!({
            "ok": true,
            "upstream": true,
            "path": path,
            "bytes": length,
        })),
    )
        .into_response()
}

impl UpstreamState {
    fn state_delay(&self) -> u64 {
        self.delay_ms.load(Ordering::SeqCst)
    }

    fn state_status(&self) -> u16 {
        self.status.load(Ordering::SeqCst)
    }
}

// ---------- config / routes ----------

fn test_config(iam_base: &str) -> Config {
    Config {
        version: "0.7.1".into(),
        port: 0,
        is_prod: false,
        iam_service_url: iam_base.to_string(),
        jwt_secret: TEST_SECRET.into(),
        jwt_issuers: vec!["synapseone-iam".into(), "synapsedx-iam".into()],
        internal_secret: TEST_INTERNAL.into(),
        verify_api_key: true,
        authz_mode: AuthzMode::Off,
        trust_proxy: TrustProxy::Disabled,
        proxy_timeout_ms: 30_000,
        inference_rate_limit_per_min: 60,
        session_cache_ttl: Duration::from_secs(30),
        authz_cache_ttl: Duration::from_millis(30_000),
        cors_origins: vec![],
        hsts: false,
        usage_enabled: false,
        ready_upstreams: vec![],
    }
}

fn route(path: &str, target: &str, auth: AuthMode) -> RouteRule {
    RouteRule::new(path, target, auth).unwrap()
}

fn with_service(mut route: RouteRule, service: &str) -> RouteRule {
    route.service = Some(service.into());
    route
}

fn with_actions(mut route: RouteRule, actions: Vec<(&str, Option<&str>, &str)>) -> RouteRule {
    route.actions = actions
        .into_iter()
        .map(|(path, method, action)| crate::authz::ActionOverride {
            method: method.map(str::to_string),
            path: path.into(),
            action: action.into(),
        })
        .collect();
    route
}

fn with_timeout(mut route: RouteRule, timeout_ms: u64) -> RouteRule {
    route.timeout_ms = Some(timeout_ms);
    route
}

async fn spawn_gateway(config: Config, routes: Vec<RouteRule>) -> TestServer {
    spawn(create_app(config, routes).unwrap()).await
}

// ---------- routing tests ----------

#[test]
fn find_route_prefix_and_specificity() {
    let routes = vec![
        route("/v1/auth", "http://iam:4001", AuthMode::None),
        route("/v1/orgs", "http://iam:4001", AuthMode::Either),
        route("/v1/workflows", "http://workflow:4002", AuthMode::Either),
    ];
    assert_eq!(find_route(&routes, "/v1/orgs").unwrap().path, "/v1/orgs");
    assert_eq!(
        find_route(&routes, "/v1/auth/login").unwrap().path,
        "/v1/auth"
    );
    assert!(find_route(&routes, "/v1/organizations").is_none());
    assert!(find_route(&routes, "/nope").is_none());
    assert_eq!(
        find_route(&routes, "/v1/workflows/123/execute")
            .unwrap()
            .target,
        "http://workflow:4002"
    );
    let routes = vec![
        route("/v1/lds", "http://lds:4004", AuthMode::Either),
        route("/v1/lds/licenses", "http://lds:4004", AuthMode::None),
        route(
            "/v1/lds/datasources/*/entities/*",
            "http://lds:4004",
            AuthMode::None,
        ),
    ];
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/abc-123/entities")
            .unwrap()
            .auth,
        AuthMode::None
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/abc-123/entities/urn%3Ax%3Ay")
            .unwrap()
            .auth,
        AuthMode::None
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/abc-123/entities/e1/extra")
            .unwrap()
            .auth,
        AuthMode::None
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/abc-123/records")
            .unwrap()
            .auth,
        AuthMode::Either
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources//entities")
            .unwrap()
            .auth,
        AuthMode::Either
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/a/b/entities")
            .unwrap()
            .auth,
        AuthMode::Either
    );
    assert_eq!(
        find_route(&routes, "/v1/lds/licenses/sub").unwrap().auth,
        AuthMode::None
    );
    assert_eq!(find_route(&routes, "/v1/lds").unwrap().path, "/v1/lds");
    assert!(find_route(&routes, "/v1/ldsz").is_none());
    assert_eq!(
        find_route(&routes, "/v1/lds/licenses-extra").unwrap().path,
        "/v1/lds"
    );
    assert!(compile_route_path("/x/*//y").is_err());
    assert!(compile_route_path("x/*").is_err());
}

#[test]
fn routes_yaml_loads_and_validates() {
    let routes = load_routes().unwrap();
    assert!(routes.len() >= 42, "expected the full routes.yaml table");
    assert_eq!(
        find_route(&routes, "/v1/lds/datasources/x/entities/y")
            .unwrap()
            .auth,
        AuthMode::None
    );
    assert_eq!(
        find_route(&routes, "/v1/platform/me").unwrap().auth,
        AuthMode::Jwt
    );
    assert_eq!(
        find_route(&routes, "/webhook").unwrap().timeout_ms,
        Some(300_000)
    );
    for route in &routes {
        if route.auth != AuthMode::None {
            assert!(
                route
                    .service
                    .as_deref()
                    .is_some_and(|service| !service.is_empty()),
                "route {} has no service",
                route.path
            );
        }
    }
}

#[test]
fn routes_yaml_rejects_operator_typos() {
    let unknown_auth =
        parse_routes_yaml("routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: bogus\n");
    assert!(unknown_auth.unwrap_err().contains("invalid auth mode"));

    let timeout = parse_routes_yaml(
        "routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: none\n    timeoutMs: 100\n",
    );
    assert!(timeout.unwrap_err().contains("invalid timeoutMs"));

    let service = parse_routes_yaml(
        "routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: either\n    service: IAM\n",
    );
    assert!(service.unwrap_err().contains("invalid service"));

    let action = parse_routes_yaml(
        "routes:\n  - path: /v1/x\n    target: http://x:1\n    auth: either\n    service: iam\n    actions:\n      - { method: POST, path: /v1/x, action: bad }\n",
    );
    assert!(action.unwrap_err().contains("invalid action override"));

    let wildcard = parse_routes_yaml(
        "routes:\n  - path: /v1/x/*//y\n    target: http://x:1\n    auth: none\n",
    );
    assert!(wildcard.is_err());
}

#[test]
fn expand_env_uses_env_then_default() {
    std::env::set_var("SYNAPSEONE_GATEWAY_TEST_EXPAND", "from-env");
    assert_eq!(
        expand_env("${SYNAPSEONE_GATEWAY_TEST_EXPAND:http://default}"),
        "from-env"
    );
    std::env::remove_var("SYNAPSEONE_GATEWAY_TEST_EXPAND");
    assert_eq!(
        expand_env("${SYNAPSEONE_GATEWAY_TEST_EXPAND:http://default}"),
        "http://default"
    );
}

// ---------- header boundary ----------

#[test]
fn propagate_principal_anonymous_marker_and_stamping() {
    let mut headers = HeaderMap::new();
    headers.insert("x-synapseone-anon", HeaderValue::from_static("spoof"));
    propagate_principal(&mut headers, None, Some(AuthMode::None), "");
    assert_eq!(
        header_value(&headers, "x-synapseone-anon").as_deref(),
        Some("1")
    );

    let mut headers = HeaderMap::new();
    headers.insert("x-synapseone-anon", HeaderValue::from_static("spoof"));
    propagate_principal(&mut headers, None, Some(AuthMode::Either), "");
    assert!(headers.get("x-synapseone-anon").is_none());

    let principal = Principal {
        r#type: "jwt".into(),
        kind: Some("user".into()),
        sub: Some("u1".into()),
        org: Some("o1".into()),
        scopes: vec!["a".into(), "b".into()],
        ..Principal::default()
    };
    let mut headers = HeaderMap::new();
    propagate_principal(&mut headers, Some(&principal), Some(AuthMode::Either), "");
    assert_eq!(
        header_value(&headers, "x-synapseone-user").as_deref(),
        Some("u1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-org").as_deref(),
        Some("o1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-scopes").as_deref(),
        Some("a,b")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-kind").as_deref(),
        Some("user")
    );

    let api_key = Principal {
        r#type: "apikey".into(),
        org: Some("o1".into()),
        account: Some("a1".into()),
        scopes: vec!["x".into(), "y".into()],
        ..Principal::default()
    };
    let mut headers = HeaderMap::new();
    propagate_principal(&mut headers, Some(&api_key), Some(AuthMode::ApiKey), "");
    assert_eq!(
        header_value(&headers, "x-synapseone-kind").as_deref(),
        Some("apikey")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-org").as_deref(),
        Some("o1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-account").as_deref(),
        Some("a1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-scopes").as_deref(),
        Some("x,y")
    );
}

#[test]
fn propagate_principal_strips_spoofs_and_mirrors_legacy() {
    let mut headers = HeaderMap::new();
    headers.insert("x-synapseone-user", HeaderValue::from_static("mallory"));
    headers.insert("x-synapseone-kind", HeaderValue::from_static("user"));
    headers.insert("x-synapseone-internal", HeaderValue::from_static("forged"));
    headers.insert("x-synapseone-evil", HeaderValue::from_static("1"));
    headers.insert("x-synapsedx-user", HeaderValue::from_static("mallory"));
    headers.insert("x-synapsedx-org", HeaderValue::from_static("spoofed"));
    headers.insert("x-synapsedx-evil", HeaderValue::from_static("1"));
    headers.insert("x-synapsedx-tenant", HeaderValue::from_static("acme"));
    propagate_principal(&mut headers, None, Some(AuthMode::Either), "");
    assert!(headers.get("x-synapseone-user").is_none());
    assert!(headers.get("x-synapseone-kind").is_none());
    assert!(headers.get("x-synapseone-internal").is_none());
    assert!(headers.get("x-synapseone-evil").is_none());
    assert!(headers.get("x-synapsedx-evil").is_none());
    assert_eq!(
        header_value(&headers, "x-synapseone-tenant").as_deref(),
        Some("acme")
    );

    let principal = Principal {
        r#type: "jwt".into(),
        sub: Some("u1".into()),
        org: Some("o1".into()),
        ..Principal::default()
    };
    let mut headers = HeaderMap::new();
    headers.insert("x-synapsedx-user", HeaderValue::from_static("mallory"));
    headers.insert("x-synapsedx-org", HeaderValue::from_static("spoofed"));
    headers.insert("x-synapsedx-tenant", HeaderValue::from_static("acme"));
    propagate_principal(
        &mut headers,
        Some(&principal),
        Some(AuthMode::Either),
        "s3cret",
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-user").as_deref(),
        Some("u1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-org").as_deref(),
        Some("o1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-tenant").as_deref(),
        Some("acme")
    );
    assert_eq!(
        header_value(&headers, "x-synapsedx-user").as_deref(),
        Some("u1")
    );
    assert_eq!(
        header_value(&headers, "x-synapsedx-org").as_deref(),
        Some("o1")
    );
    assert_eq!(
        header_value(&headers, "x-synapseone-internal").as_deref(),
        Some("s3cret")
    );
    assert_eq!(
        header_value(&headers, "x-synapsedx-internal").as_deref(),
        Some("s3cret")
    );

    let platform = Principal {
        r#type: "jwt".into(),
        kind: Some("platform-admin".into()),
        sub: Some("u1".into()),
        scopes: vec!["platform:read".into()],
        ..Principal::default()
    };
    let mut headers = HeaderMap::new();
    propagate_principal(&mut headers, Some(&platform), Some(AuthMode::Jwt), "");
    assert_eq!(
        header_value(&headers, "x-synapseone-kind").as_deref(),
        Some("platform-admin")
    );
    assert!(headers.get("x-synapseone-org").is_none());
}

#[test]
fn request_id_sanitizes_and_generates() {
    assert_eq!(sanitize_request_id(" ab c\r\n\t! "), "abc");
    let long = "a".repeat(200);
    assert_eq!(sanitize_request_id(&long).len(), 128);
    let mut headers = HeaderMap::new();
    headers.insert("x-request-id", HeaderValue::from_static("client-123"));
    assert_eq!(request_id(&headers), "client-123");
    let generated = request_id(&HeaderMap::new());
    assert!(!generated.is_empty());
    assert!(generated
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || "._~-".contains(value)));
}

// ---------- scopes ----------

#[test]
fn scope_rules_match_typescript_suite() {
    assert!(scope_allows(
        &["*".into()],
        "/v1/faststore/keys/a",
        "POST",
        None,
        None
    ));
    assert!(scope_allows(
        &["*:read".into()],
        "/v1/faststore/keys/a",
        "GET",
        None,
        None
    ));
    assert!(!scope_allows(
        &["*:read".into()],
        "/v1/faststore/keys/a",
        "PUT",
        None,
        None
    ));
    assert!(scope_allows(
        &["faststore:get".into()],
        "/v1/faststore/keys/a",
        "GET",
        None,
        None
    ));
    assert!(!scope_allows(
        &["faststore:get".into()],
        "/v1/faststore/keys/a",
        "PUT",
        None,
        None
    ));
    assert!(scope_allows(
        &["faststore:*".into()],
        "/v1/faststore/keys/a",
        "PUT",
        None,
        None
    ));
    assert!(scope_allows(
        &["faststore:write".into()],
        "/v1/faststore/keys/a",
        "POST",
        None,
        None
    ));
    assert!(!scope_allows(
        &["base:read".into()],
        "/v1/faststore/keys/a",
        "GET",
        None,
        None
    ));
    assert!(scope_allows(
        &["workflow:execute".into()],
        "/v1/workflows/w1/execute",
        "POST",
        None,
        None
    ));
    assert!(scope_allows(
        &["iam:write".into()],
        "/v1/orgs/o1/accounts",
        "POST",
        None,
        None
    ));
    assert!(!scope_allows(
        &["iam:read".into()],
        "/v1/orgs/o1/accounts",
        "POST",
        None,
        None
    ));
    assert!(scope_allows(&[], "/v1/auth/login", "POST", None, None));
    assert!(scope_allows(&[], "/health", "GET", None, None));

    for (path, method) in [
        ("/v1/ocs/buckets/b/objects/k", "PUT"),
        ("/v1/notifications", "POST"),
        ("/v1/warehouse/datasets", "POST"),
        ("/v1/secrets", "POST"),
        ("/v1/scim/tokens", "POST"),
        ("/v1/human-tasks", "POST"),
        ("/v1/search/reindex", "POST"),
        ("/v1/accounts/a1/credentials", "POST"),
    ] {
        assert!(
            !scope_allows(&["*:read".into()], path, method, None, None),
            "{method} {path}"
        );
    }
    assert!(scope_allows(
        &["storage:write".into()],
        "/v1/ocs/buckets/b/objects/k",
        "PUT",
        None,
        None
    ));
    assert!(scope_allows(
        &["notifications:write".into()],
        "/v1/notifications",
        "POST",
        None,
        None
    ));
    assert!(scope_allows(
        &["warehouse:write".into()],
        "/v1/warehouse/datasets",
        "POST",
        None,
        None
    ));
    assert!(scope_allows(
        &["workflow:write".into()],
        "/v1/accounts/a1/credentials",
        "POST",
        Some("workflow"),
        Some("workflow:Write")
    ));
    assert!(!scope_allows(
        &["iam:write".into()],
        "/v1/accounts/a1/credentials",
        "POST",
        Some("workflow"),
        Some("workflow:Write")
    ));
    assert!(!scope_allows(
        &["platform:write".into()],
        "/v1/platform/admins",
        "POST",
        Some("platform"),
        Some("platform:Admin")
    ));
    assert!(scope_allows(
        &["platform:admin".into()],
        "/v1/platform/admins",
        "POST",
        Some("platform"),
        Some("platform:Admin")
    ));
    assert!(scope_allows(
        &["platform:read".into()],
        "/v1/platform/me",
        "GET",
        Some("platform"),
        Some("platform:Read")
    ));

    let requirement =
        scope_requirement("/v1/accounts/a1/credentials", "POST", Some("workflow")).unwrap();
    assert_eq!(requirement.service, "workflow");
    assert_eq!(requirement.action, "write");
    assert!(!requirement.read);
    assert!(scope_requirement("/v1/auth/login", "POST", None).is_none());
    assert!(scope_requirement("/health", "GET", None).is_none());
}

// ---------- authz mapping ----------

#[test]
fn authz_actions_resources_and_principal_body() {
    assert_eq!(verb_for_method("GET"), "Read");
    assert_eq!(verb_for_method("HEAD"), "Read");
    assert_eq!(verb_for_method("DELETE"), "Delete");
    assert_eq!(verb_for_method("PUT"), "Write");
    assert_eq!(verb_for_method("PATCH"), "Write");

    let base = with_actions(
        with_service(route("/v1/base", "http://base", AuthMode::Either), "base"),
        vec![("/v1/base/collections/*/query", Some("POST"), "base:Read")],
    );
    assert_eq!(
        action_for(&base, "POST", "/v1/base/collections/users/query").as_deref(),
        Some("base:Read")
    );
    assert_eq!(
        action_for(&base, "POST", "/v1/base/collections/users/documents").as_deref(),
        Some("base:Write")
    );
    assert_eq!(
        action_for(&base, "GET", "/v1/base/collections/users/query").as_deref(),
        Some("base:Read")
    );
    assert!(action_for(
        &route("/v1/x", "http://x", AuthMode::Either),
        "GET",
        "/v1/x"
    )
    .is_none());

    let principal = Principal {
        r#type: "jwt".into(),
        sub: Some("u1".into()),
        org: Some("org-1".into()),
        ..Principal::default()
    };
    assert_eq!(
        resource_for(Some("base"), Some(&principal), "/v1/base/collections/users"),
        "arn:synapseone:org-1:-:base:collections/users"
    );
    assert_eq!(
        resource_for(Some("base"), Some(&principal), "/v1/base"),
        "arn:synapseone:org-1:-:base:"
    );
    assert_eq!(
        resource_for(Some("iam"), Some(&principal), "/v1/orgs/o1/users"),
        "arn:synapseone:org-1:-:iam:orgs/o1/users"
    );

    let key = Principal {
        r#type: "apikey".into(),
        key_id: Some("k1".into()),
        account: Some("a1".into()),
        ..Principal::default()
    };
    assert_eq!(
        iam_principal(&key),
        Some(json!({ "kind": "apikey", "keyId": "k1", "account": "a1" }))
    );
    assert_eq!(
        iam_principal(&Principal {
            r#type: "apikey".into(),
            ..Principal::default()
        }),
        None
    );
    let service_account = Principal {
        r#type: "jwt".into(),
        kind: Some("service-account".into()),
        sub: Some("s1".into()),
        scopes: vec!["x:*".into()],
        ..Principal::default()
    };
    let body = iam_principal(&service_account).unwrap();
    assert_eq!(body["kind"], "service-account");
    assert_eq!(body["scopes"], json!(["x:*"]));
    let user = Principal {
        r#type: "jwt".into(),
        sub: Some("u1".into()),
        ..Principal::default()
    };
    assert!(iam_principal(&user).unwrap().get("scopes").is_none());
}

// ---------- config / trust proxy ----------

#[test]
fn trust_proxy_and_config_guards() {
    assert!(parse_trust_proxy(Some("true"))
        .unwrap_err()
        .contains("forbidden"));
    assert_eq!(parse_trust_proxy(None).unwrap(), TrustProxy::Disabled);
    assert_eq!(parse_trust_proxy(Some("0")).unwrap(), TrustProxy::Disabled);
    assert_eq!(parse_trust_proxy(Some("1")).unwrap(), TrustProxy::Hops(1));
    assert_eq!(
        parse_trust_proxy(Some("loopback,172.16.0.0/12")).unwrap(),
        TrustProxy::List(vec![
            TrustEntry::Loopback,
            TrustEntry::Cidr("172.16.0.0".parse().unwrap(), 12)
        ])
    );
    assert!(parse_trust_proxy(Some("11")).is_err());
    assert!(parse_trust_proxy(Some("1.2.3.4/33")).is_err());
    assert!(parse_trust_proxy(Some("bogus")).is_err());

    let mut headers = HeaderMap::new();
    headers.insert(
        "x-forwarded-for",
        HeaderValue::from_static("198.51.100.99, 203.0.113.20"),
    );
    let remote = Some("127.0.0.1".parse().unwrap());
    let mut config = test_config("http://iam");
    config.trust_proxy = TrustProxy::Hops(1);
    assert_eq!(resolve_client_ip(&config, &headers, remote), "203.0.113.20");
    config.trust_proxy = TrustProxy::Disabled;
    assert_eq!(resolve_client_ip(&config, &headers, remote), "127.0.0.1");
    config.trust_proxy = parse_trust_proxy(Some("loopback,10.0.0.0/8")).unwrap();
    headers.insert(
        "x-forwarded-for",
        HeaderValue::from_static("203.0.113.5, 10.0.0.2"),
    );
    assert_eq!(resolve_client_ip(&config, &headers, remote), "203.0.113.5");

    assert!(is_weak_jwt_secret(""));
    assert!(is_weak_jwt_secret("change_me"));
    assert!(is_weak_jwt_secret("short"));
    assert!(!is_weak_jwt_secret(TEST_SECRET));
    assert!(effective_jwt_secret("", true).is_err());
    assert_eq!(
        effective_jwt_secret("", false).unwrap(),
        "change_me_super_secret_32chars_min"
    );
    assert_eq!(
        effective_jwt_secret(TEST_SECRET, true).unwrap(),
        TEST_SECRET
    );
    assert!(validate_security_config(true, false, AuthzMode::Off, false).is_err());
    assert!(validate_security_config(true, true, AuthzMode::Off, true).is_err());
    assert!(validate_security_config(true, true, AuthzMode::Audit, true).is_ok());
    assert!(validate_security_config(false, false, AuthzMode::Off, true).is_ok());
    let mut prod = test_config("http://127.0.0.1:1");
    prod.is_prod = true;
    prod.verify_api_key = false;
    assert!(create_app(prod, vec![]).is_err());
}

// ---------- rate limit / usage / metrics units ----------

#[test]
fn rate_limiter_window_and_retry_after() {
    let limiter = RateLimiter::new();
    let start = std::time::Instant::now();
    assert_eq!(limiter.hit_at("a", 2, start), LimitResult::Allowed);
    assert_eq!(limiter.hit_at("a", 2, start), LimitResult::Allowed);
    match limiter.hit_at("a", 2, start) {
        LimitResult::Limited { retry_after } => assert!(retry_after >= 1),
        LimitResult::Allowed => panic!("third request should be limited"),
    }
    assert_eq!(
        limiter.hit_at("b", 2, start),
        LimitResult::Allowed,
        "buckets are per key"
    );
    assert_eq!(
        limiter.hit_at("a", 2, start + Duration::from_secs(61)),
        LimitResult::Allowed
    );
}

#[test]
fn usage_feature_mapping_and_exclusions() {
    assert_eq!(feature_for_route("/v1/auth"), "auth");
    assert_eq!(feature_for_route("/v1/orgs"), "iam");
    assert_eq!(feature_for_route("/v1/roles"), "iam");
    assert_eq!(feature_for_route("/v1/workflows"), "workflows");
    assert_eq!(feature_for_route("/v1/executions"), "workflows");
    assert_eq!(feature_for_route("/webhook"), "workflows");
    assert_eq!(feature_for_route("/v1/lds/datasources/*/entities/*"), "lds");
    assert_eq!(feature_for_route("/v1/base"), "base");
    assert_eq!(feature_for_route("/v1/queue"), "queue");
    assert_eq!(feature_for_route("/v1/new-service"), "new-service");
    assert_eq!(feature_for_route("/"), "other");
    assert_eq!(feature_for_route("/mcp"), "other");
    assert!(is_usage_excluded("/v1/usage"));
    assert!(is_usage_excluded("/v1/usage/summary"));
    assert!(!is_usage_excluded("/v1/usagex"));
    assert!(!is_usage_excluded("/v1/workflows"));
}

#[test]
fn metrics_render_is_prometheus_compatible() {
    let metrics = Metrics::new();
    metrics.inc_request("/v1/orgs", "incoming");
    metrics.inc_authz("enforce", "allow");
    let output = metrics.render("0.7.1");
    assert!(output.contains("gateway_requests_total{route=\"/v1/orgs\",status=\"incoming\"} 1"));
    assert!(output.contains("gateway_authz_decisions_total{mode=\"enforce\",result=\"allow\"} 1"));
    assert!(output.contains("gateway_up 1"));
    assert!(output.contains("gateway_build_info{version=\"0.7.1\"} 1"));
}

fn usage_event(index: u64) -> UsageEvent {
    UsageEvent {
        created_at: "2026-01-01T00:00:00.000Z".into(),
        request_id: format!("rid-{index}"),
        feature: "iam".into(),
        route: "/v1/orgs".into(),
        method: "GET".into(),
        path: "/v1/orgs".into(),
        status: 200,
        duration_ms: 1,
        auth_kind: "user".into(),
        org_id: Some("o1".into()),
        account_id: None,
        user_id: Some("u1".into()),
        error: None,
    }
}

#[tokio::test]
async fn usage_buffers_and_flushes_to_iam() {
    let (iam, mock) = MockIam::spawn().await;
    let telemetry = UsageTelemetry::new(http(), &iam.base, "internal-usage", true);
    telemetry.enqueue(usage_event(1));
    telemetry.enqueue(usage_event(2));
    assert_eq!(telemetry.buffer_size(), 2);
    telemetry.flush_now().await;
    assert_eq!(telemetry.buffer_size(), 0);
    assert_eq!(mock.usage_events().len(), 2);
    assert_eq!(mock.usage_internal().as_deref(), Some("internal-usage"));

    let dead = UsageTelemetry::new(http(), "http://127.0.0.1:1", "", true);
    dead.enqueue(usage_event(3));
    dead.flush_now().await;
    assert_eq!(dead.buffer_size(), 1, "failed batches stay buffered");
}

// ---------- live gateway tests ----------

#[tokio::test]
async fn health_root_metrics_and_404_shapes() {
    let upstream = Upstream::spawn().await;
    let routes = vec![
        with_service(route("/v1/orgs", upstream.base(), AuthMode::Either), "iam"),
        route("/v1/keys", upstream.base(), AuthMode::Either),
    ];
    let gateway = spawn_gateway(test_config("http://127.0.0.1:1"), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/health", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let headers = response.headers().clone();
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
    assert!(headers.get("x-powered-by").is_none());
    assert!(headers.get("x-request-id").is_some());
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "gateway");
    assert_eq!(body["schemaVersion"], "1");
    assert_eq!(body["dependencies"], json!([]));

    let response = client
        .get(format!("{}/no-such-route", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert!(response.headers().get("x-request-id").is_some());
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "not_found");

    // Internal service-to-service endpoints are never reachable publicly.
    let response = client
        .get(format!("{}/v1/keys/verify", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);

    let response = client
        .post(format!("{}/health", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);

    let response = client
        .get(format!("{}/", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["name"], "SynapseOne Gateway (Tier-1 PaaS)");
    assert!(body["routes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|route| route["path"] == "/v1/orgs"));

    // Route resolution feeds the Prometheus counter.
    let _ = client
        .get(format!("{}/v1/orgs", gateway.base))
        .send()
        .await
        .unwrap();
    let response = client
        .get(format!("{}/metrics", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert!(response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("text/plain"));
    let body = response.text().await.unwrap();
    assert!(body.contains("gateway_requests_total{route=\"/v1/orgs\",status=\"incoming\"} 1"));
}

#[tokio::test]
async fn request_id_is_sanitized_forwarded_and_returned() {
    let upstream = Upstream::spawn().await;
    let routes = vec![route("/v1/auth", upstream.base(), AuthMode::None)];
    let gateway = spawn_gateway(test_config("http://127.0.0.1:1"), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("x-request-id", "client-123")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers().get("x-request-id").unwrap(),
        "client-123"
    );
    assert_eq!(
        upstream.header("x-request-id").as_deref(),
        Some("client-123")
    );

    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("x-request-id", "bad id!!")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers().get("x-request-id").unwrap(), "badid");
}

#[tokio::test]
async fn jwt_auth_gate_and_principal_stamping() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let routes = vec![
        with_service(route("/v1/orgs", upstream.base(), AuthMode::Either), "iam"),
        route("/v1/auth", upstream.base(), AuthMode::None),
    ];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "unauthorized"
    );

    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", "Bearer not-a-jwt")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    // `either` falls through to API-key verification, using Bearer as the key.
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid_api_key"
    );

    let bad_signature = sign_with(
        user_claims("u1", "o1"),
        "wrong-secret-0123456789abcdef0123456789",
    );
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {bad_signature}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let wrong_issuer = sign(json!({
        "sub": "u1", "org": "o1", "iss": "evil", "exp": now_ts() + 300
    }));
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {wrong_issuer}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let missing_issuer = sign(json!({
        "sub": "u1", "org": "o1", "exp": now_ts() + 300
    }));
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {missing_issuer}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let expired = sign(json!({
        "sub": "u1", "org": "o1", "iss": TEST_ISSUER, "exp": now_ts() - 10
    }));
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {expired}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let token = user_token("tenant-user-1", "org-1");
    let response = client
        .get(format!("{}/v1/orgs/o1/users?x=1", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .header("x-synapseone-user", "mallory")
        .header("x-synapseone-org", "spoofed")
        .header("x-synapseone-internal", "forged")
        .header("x-synapsedx-org", "legacy-spoof")
        .header("x-synapseone-tenant", "client-tenant")
        .header("x-synapseone-anon", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response_request_id = response
        .headers()
        .get("x-request-id")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(
        upstream.header("x-synapseone-user").as_deref(),
        Some("tenant-user-1")
    );
    assert_eq!(
        upstream.header("x-synapseone-org").as_deref(),
        Some("org-1")
    );
    assert_eq!(
        upstream.header("x-synapseone-kind").as_deref(),
        Some("user")
    );
    assert_eq!(upstream.header("x-synapseone-scopes").as_deref(), Some("*"));
    assert_eq!(
        upstream.header("x-synapseone-internal").as_deref(),
        Some(TEST_INTERNAL)
    );
    assert_eq!(
        upstream.header("x-synapsedx-user").as_deref(),
        Some("tenant-user-1")
    );
    assert_eq!(
        upstream.header("x-synapsedx-internal").as_deref(),
        Some(TEST_INTERNAL)
    );
    assert_eq!(
        upstream.header("x-synapseone-tenant").as_deref(),
        Some("client-tenant")
    );
    assert!(upstream.header("x-synapseone-anon").is_none());
    assert_eq!(
        upstream.header("x-request-id").as_deref(),
        Some(response_request_id.as_str())
    );
    assert_eq!(mock.verify_hits(), 1, "session result is cached");

    let _ = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        mock.verify_hits(),
        1,
        "second request uses the session cache"
    );

    // Service accounts are machine credentials and skip session introspection.
    let service_account = sign(json!({
        "sub": "sa1", "kind": "service-account", "org": "org-1",
        "scopes": ["*"], "iss": TEST_ISSUER, "exp": now_ts() + 300
    }));
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {service_account}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(mock.verify_hits(), 1);

    // Revoked sessions fail closed.
    mock.set_verify(VerifyMode::Revoked);
    let revoked = user_token("tenant-user-2", "org-1");
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {revoked}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "token_revoked");
    assert!(body["message"].as_str().unwrap().contains("revoked"));

    // IAM outage fails closed on protected routes.
    mock.set_verify(VerifyMode::Down);
    let down = user_token("tenant-user-3", "org-1");
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {down}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "iam_unavailable"
    );

    // A step-up token is never an access token, even on a public route.
    let step_up = sign(step_up_claims());
    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("authorization", format!("Bearer {step_up}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "invalid_token");
    assert!(body["message"].as_str().unwrap().contains("step-up"));
}

#[tokio::test]
async fn public_routes_optional_auth_and_anon_marker() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let routes = vec![route("/v1/auth", upstream.base(), AuthMode::None)];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.header("x-synapseone-anon").as_deref(), Some("1"));
    assert_eq!(upstream.header("x-synapsedx-anon").as_deref(), Some("1"));
    assert_eq!(
        upstream.header("x-synapseone-internal").as_deref(),
        Some(TEST_INTERNAL)
    );

    let token = user_token("u1", "o1");
    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.header("x-synapseone-user").as_deref(), Some("u1"));
    assert!(upstream.header("x-synapseone-anon").is_none());

    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("authorization", "Bearer garbage")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.header("x-synapseone-anon").as_deref(), Some("1"));

    mock.set_key(KeyMode::Valid {
        account: "a1",
        org: "o1",
        scopes: vec!["*"],
    });
    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .header("x-api-key", "good-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        upstream.header("x-synapseone-kind").as_deref(),
        Some("apikey")
    );
    assert!(upstream.header("x-synapseone-anon").is_none());
}

#[tokio::test]
async fn api_key_verification_and_fail_closed() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let routes = vec![
        with_service(
            route("/v1/faststore", upstream.base(), AuthMode::Either),
            "faststore",
        ),
        with_service(
            route("/v1/apikey", upstream.base(), AuthMode::ApiKey),
            "faststore",
        ),
    ];
    mock.set_key(KeyMode::Valid {
        account: "a1",
        org: "o1",
        scopes: vec!["faststore:*"],
    });
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("x-api-key", "good-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        upstream.header("x-synapseone-kind").as_deref(),
        Some("apikey")
    );
    assert_eq!(upstream.header("x-synapseone-org").as_deref(), Some("o1"));
    assert_eq!(
        upstream.header("x-synapseone-account").as_deref(),
        Some("a1")
    );
    assert_eq!(
        upstream.header("x-synapseone-scopes").as_deref(),
        Some("faststore:*")
    );
    assert!(upstream.header("x-synapseone-user").is_none());
    assert_eq!(mock.key_internal().as_deref(), Some(TEST_INTERNAL));
    assert_eq!(mock.key_body().unwrap()["apiKey"], "good-key");
    assert!(mock.key_hits() >= 1);

    // MCP/CLI clients may use Bearer <api-key> on `either` routes.
    let response = client
        .get(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("authorization", "Bearer good-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    mock.set_key(KeyMode::Invalid);
    let response = client
        .get(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("x-api-key", "bad-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid_api_key"
    );

    // IAM HTTP errors are treated as invalid keys (same as TS); network
    // failures are 503 iam_unavailable.
    mock.set_key(KeyMode::Error);
    let response = client
        .get(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("x-api-key", "bad-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    let response = client
        .get(format!("{}/v1/apikey", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "missing_api_key");
    assert_eq!(body["message"], "X-API-Key required");

    let dead_config = test_config("http://127.0.0.1:1");
    let dead_gateway = spawn_gateway(
        dead_config,
        vec![with_service(
            route("/v1/faststore", upstream.base(), AuthMode::Either),
            "faststore",
        )],
    )
    .await;
    let response = client
        .get(format!("{}/v1/faststore/keys/a", dead_gateway.base))
        .header("x-api-key", "key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "iam_unavailable"
    );
}

#[tokio::test]
async fn api_key_verification_can_be_disabled_in_dev_only() {
    let upstream = Upstream::spawn().await;
    let mut config = test_config("http://127.0.0.1:1");
    config.verify_api_key = false;
    let routes = vec![route("/v1/unverified", upstream.base(), AuthMode::ApiKey)];
    let gateway = spawn_gateway(config, routes).await;
    let response = http()
        .get(format!("{}/v1/unverified/x", gateway.base))
        .header("x-api-key", "unverified")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        upstream.header("x-synapseone-kind").as_deref(),
        Some("apikey")
    );
    assert!(upstream.header("x-synapseone-account").is_none());
}

#[tokio::test]
async fn verify_api_key_upstream_direct() {
    let (iam, mock) = MockIam::spawn().await;
    mock.set_key(KeyMode::Valid {
        account: "a1",
        org: "o1",
        scopes: vec!["*"],
    });
    let info = verify_api_key_upstream(&http(), &iam.base, "k", "s3cret")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(info.id.as_deref(), Some("key-1"));
    assert_eq!(info.account_id.as_deref(), Some("a1"));
    assert_eq!(info.org_id.as_deref(), Some("o1"));
    assert_eq!(info.user_id, None);
    assert_eq!(info.scopes, vec!["*"]);
    assert_eq!(mock.key_internal().as_deref(), Some("s3cret"));

    mock.set_key(KeyMode::Invalid);
    assert!(verify_api_key_upstream(&http(), &iam.base, "bad", "")
        .await
        .unwrap()
        .is_none());
    let error = verify_api_key_upstream(&http(), "http://127.0.0.1:1", "k", "")
        .await
        .unwrap_err();
    assert!(error.contains("iam_unreachable"));
}

#[tokio::test]
async fn session_revocation_cache_and_fail_closed() {
    let (iam, mock) = MockIam::spawn().await;
    let config = test_config(&iam.base);
    let service = AuthService::new(&config, http());
    let claims = json!({ "kind": "user", "sub": "u1" });
    assert!(service
        .validate_jwt_session("tok-active", &claims)
        .await
        .is_none());
    assert!(service
        .validate_jwt_session("tok-active", &claims)
        .await
        .is_none());
    assert_eq!(mock.verify_hits(), 1);

    mock.set_verify(VerifyMode::Revoked);
    let rejected = service
        .validate_jwt_session("tok-revoked", &claims)
        .await
        .unwrap();
    assert_eq!(rejected.status, 401);
    assert_eq!(rejected.error, "token_revoked");
    let revoked_hits = mock.verify_hits();
    assert!(service
        .validate_jwt_session("tok-revoked", &claims)
        .await
        .is_some());
    assert_eq!(
        mock.verify_hits(),
        revoked_hits,
        "negative result is cached"
    );

    mock.set_verify(VerifyMode::Down);
    let rejected = service
        .validate_jwt_session("tok-down", &claims)
        .await
        .unwrap();
    assert_eq!(rejected.status, 503);
    assert_eq!(rejected.error, "iam_unavailable");
    let down_hits = mock.verify_hits();
    assert!(service
        .validate_jwt_session("tok-down", &claims)
        .await
        .is_some());
    assert_eq!(
        mock.verify_hits(),
        down_hits,
        "IAM outage is cached briefly"
    );

    let hits = mock.verify_hits();
    assert!(service
        .validate_jwt_session(
            "tok-sa",
            &json!({ "kind": "service-account", "sub": "sa1" })
        )
        .await
        .is_none());
    assert_eq!(mock.verify_hits(), hits);
    let rejected = service
        .validate_jwt_session("tok-nosub", &json!({ "kind": "user" }))
        .await
        .unwrap();
    assert_eq!(rejected.error, "invalid_token");
    service.clear_session_cache();
}

#[tokio::test]
async fn scope_denied_for_read_only_api_key() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    mock.set_key(KeyMode::Valid {
        account: "a1",
        org: "o1",
        scopes: vec!["faststore:get"],
    });
    let routes = vec![with_service(
        route("/v1/faststore", upstream.base(), AuthMode::Either),
        "faststore",
    )];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();
    let response = client
        .get(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("x-api-key", "k")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response = client
        .put(format!("{}/v1/faststore/keys/a", gateway.base))
        .header("x-api-key", "k")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "scope_denied");
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("PUT /v1/faststore/keys/a"));
    assert_eq!(upstream.hits(), 1);
}

#[tokio::test]
async fn inference_quota_per_tenant() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    mock.set_key(KeyMode::Valid {
        account: "a1",
        org: "o1",
        scopes: vec!["*"],
    });
    let mut config = test_config(&iam.base);
    config.inference_rate_limit_per_min = 2;
    let routes = vec![with_actions(
        with_service(
            route("/v1/inference", upstream.base(), AuthMode::Either),
            "inference",
        ),
        vec![("/v1/inference/*", Some("POST"), "inference:Invoke")],
    )];
    let gateway = spawn_gateway(config, routes).await;
    let client = http();
    let hit = || {
        client
            .post(format!("{}/v1/inference/chat/completions", gateway.base))
            .header("x-api-key", "k")
            .json(&json!({}))
            .send()
    };
    assert_eq!(hit().await.unwrap().status(), 200);
    assert_eq!(hit().await.unwrap().status(), 200);
    let limited = hit().await.unwrap();
    assert_eq!(limited.status(), 429);
    assert!(
        limited
            .headers()
            .get("retry-after")
            .unwrap()
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            >= 1
    );
    let body: Value = limited.json().await.unwrap();
    assert_eq!(body["error"], "quota_exceeded");
    assert!(body["retryAfter"].as_u64().unwrap() >= 1);
}

#[tokio::test]
async fn proxy_timeout_and_upstream_error_shapes() {
    let upstream = Upstream::spawn().await;
    let mut timeout_route = route("/v1/slow", upstream.base(), AuthMode::None);
    timeout_route = with_timeout(timeout_route, 1_000);
    let routes = vec![
        route("/v1/down", "http://127.0.0.1:1", AuthMode::None),
        timeout_route,
    ];
    let gateway = spawn_gateway(test_config("http://127.0.0.1:1"), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/down", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "bad_gateway");
    assert_eq!(body["message"], "upstream unavailable");

    upstream.set_delay(2_000);
    let response = client
        .get(format!("{}/v1/slow", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 504);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "gateway_timeout");
}

#[tokio::test]
async fn proxy_streams_body_paths_queries_and_strips_hop_headers() {
    let upstream = Upstream::spawn().await;
    let routes = vec![route("/v1/echo", upstream.base(), AuthMode::None)];
    let gateway = spawn_gateway(test_config("http://127.0.0.1:1"), routes).await;
    let client = http();

    let payload = vec![b'a'; 256 * 1024];
    let response = client
        .post(format!("{}/v1/echo/items?q=1&x=2", gateway.base))
        .header("content-type", "application/octet-stream")
        .header("connection", "x-remove-me")
        .header("x-remove-me", "1")
        .header("te", "trailers")
        .header("proxy-authorization", "secret")
        .body(payload.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["bytes"], 256 * 1024);
    assert_eq!(upstream.body(), payload);
    assert_eq!(upstream.path(), "/v1/echo/items?q=1&x=2");
    assert!(upstream.header("x-remove-me").is_none());
    assert!(upstream.header("te").is_none());
    assert!(upstream.header("proxy-authorization").is_none());
    assert!(upstream.header("connection").is_none());
    assert!(upstream.header("x-request-id").is_some());

    upstream.set_status(418);
    let response = client
        .get(format!("{}/v1/echo/teapot", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 418);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["ok"], true);

    // No global JSON parser: malformed JSON is forwarded byte-for-byte.
    upstream.set_status(200);
    let raw = br#"{"broken": "#.to_vec();
    let response = client
        .post(format!("{}/v1/echo/raw", gateway.base))
        .header("content-type", "application/json")
        .body(raw.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.body(), raw);
}

#[tokio::test]
async fn platform_session_and_platform_admin_rules() {
    let (iam, mock) = MockIam::spawn().await;
    let routes = vec![
        with_actions(
            with_service(route("/v1/platform", &iam.base, AuthMode::Jwt), "platform"),
            vec![
                ("/v1/platform/session", Some("POST"), "platform:Read"),
                ("/v1/platform/admins", Some("POST"), "platform:Admin"),
            ],
        ),
        with_service(route("/v1/orgs", &iam.base, AuthMode::Either), "iam"),
    ];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();

    let response = client
        .get(format!("{}/v1/platform/me", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "unauthorized"
    );
    let response = client
        .get(format!("{}/v1/platform/me", gateway.base))
        .header("authorization", "Bearer garbage")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid_token"
    );

    let tenant = user_token("tenant-user-1", "org-1");
    let response = client
        .post(format!("{}/v1/platform/session", gateway.base))
        .header("authorization", format!("Bearer {tenant}"))
        .json(&json!({ "code": "000000" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap()["accessToken"],
        "fake-platform-token"
    );
    assert_eq!(mock.session_hits(), 1);

    let response = client
        .get(format!("{}/v1/platform/me", gateway.base))
        .header("authorization", format!("Bearer {tenant}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "platform_admin_required"
    );

    let admin = sign(platform_admin_claims("admin-1"));
    let response = client
        .get(format!("{}/v1/platform/me", gateway.base))
        .header("authorization", format!("Bearer {admin}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["me"], true);

    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {admin}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "platform_token_tenant_forbidden"
    );

    let step_up = sign(step_up_claims());
    let response = client
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {step_up}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "invalid_token"
    );
}

#[tokio::test]
async fn jwt_accepts_both_rebrand_issuers() {
    let (iam, _mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let routes = vec![with_service(
        route("/v1/orgs", upstream.base(), AuthMode::Either),
        "iam",
    )];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let token = sign(json!({
        "sub": "u1",
        "org": "o1",
        "kind": "user",
        "scopes": ["*"],
        "iss": "synapsedx-iam",
        "exp": now_ts() + 300,
    }));
    let response = http()
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(upstream.header("x-synapseone-user").as_deref(), Some("u1"));
}

#[tokio::test]
async fn auth_edge_limit_exempts_verify_hot_path() {
    let (iam, _mock) = MockIam::spawn().await;
    let routes = vec![route("/v1/auth", &iam.base, AuthMode::None)];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();
    for index in 0..120 {
        let response = client
            .get(format!("{}/v1/auth/login", gateway.base))
            .send()
            .await
            .unwrap();
        assert_ne!(response.status(), 429, "request {index}");
    }
    let response = client
        .get(format!("{}/v1/auth/login", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "rate_limited"
    );
    // Tier-2 calls /v1/auth/verify on every request; it must not share the
    // brute-force bucket.
    let response = client
        .get(format!("{}/v1/auth/verify", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn platform_edge_limit_and_exact_path_exemption() {
    let (iam, _mock) = MockIam::spawn().await;
    let routes = vec![with_service(
        route("/v1/platform", &iam.base, AuthMode::Jwt),
        "platform",
    )];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();
    let admin = sign(platform_admin_claims("admin-rate"));
    for index in 0..120 {
        let response = client
            .get(format!("{}/v1/platform/foo", gateway.base))
            .header("authorization", format!("Bearer {admin}"))
            .send()
            .await
            .unwrap();
        assert_ne!(response.status(), 429, "request {index}");
    }
    let response = client
        .get(format!("{}/v1/platform/foo", gateway.base))
        .header("authorization", format!("Bearer {admin}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    // Express mounts the limiter on '/v1/platform/', not the exact path.
    let response = client
        .get(format!("{}/v1/platform", gateway.base))
        .header("authorization", format!("Bearer {admin}"))
        .send()
        .await
        .unwrap();
    assert_ne!(response.status(), 429);
}

#[tokio::test]
async fn platform_admin_action_override_is_enforced() {
    let (iam, _mock) = MockIam::spawn().await;
    let routes = vec![with_actions(
        with_service(route("/v1/platform", &iam.base, AuthMode::Jwt), "platform"),
        vec![
            ("/v1/platform/session", Some("POST"), "platform:Read"),
            ("/v1/platform/admins", Some("POST"), "platform:Admin"),
        ],
    )];
    let gateway = spawn_gateway(test_config(&iam.base), routes).await;
    let client = http();

    let writer = sign(json!({
        "sub": "admin-writer",
        "kind": "platform-admin",
        "scopes": ["platform:write"],
        "iss": TEST_ISSUER,
        "exp": now_ts() + 300,
    }));
    let response = client
        .post(format!("{}/v1/platform/admins", gateway.base))
        .header("authorization", format!("Bearer {writer}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "scope_denied"
    );

    let admin = sign(json!({
        "sub": "admin-owner",
        "kind": "platform-admin",
        "scopes": ["platform:admin"],
        "iss": TEST_ISSUER,
        "exp": now_ts() + 300,
    }));
    let response = client
        .post(format!("{}/v1/platform/admins", gateway.base))
        .header("authorization", format!("Bearer {admin}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["created"], true);
}

// ---------- authz service integration ----------

struct StaticDecider {
    decision: Mutex<Result<AuthzDecision, String>>,
    calls: AtomicUsize,
}

impl StaticDecider {
    fn new(decision: Result<AuthzDecision, String>) -> Arc<Self> {
        Arc::new(Self {
            decision: Mutex::new(decision),
            calls: AtomicUsize::new(0),
        })
    }
}

impl AuthzDecider for StaticDecider {
    fn decide<'a>(
        &'a self,
        _principal: Value,
        _action: String,
        _resource: String,
    ) -> BoxFuture<'a, Result<AuthzDecision, String>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.decision.lock().unwrap().clone()
        })
    }
}

#[tokio::test]
async fn authz_audit_enforce_and_cache() {
    let (iam, _mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let base_route = with_service(route("/v1/base", upstream.base(), AuthMode::Either), "base");
    let token = user_token("u1", "o1");

    let deny = StaticDecider::new(Ok(AuthzDecision {
        allowed: false,
        reason: "implicit-deny".into(),
    }));
    let mut audit_config = test_config(&iam.base);
    audit_config.authz_mode = AuthzMode::Audit;
    let audit_gateway = spawn(
        create_app_with_decider(audit_config, vec![base_route.clone()], deny.clone()).unwrap(),
    )
    .await;
    let response = http()
        .post(format!(
            "{}/v1/base/collections/c/documents",
            audit_gateway.base
        ))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let header = response
        .headers()
        .get("x-synapseone-authz")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(header.contains("would-deny; action=base:Write"));
    assert_eq!(deny.calls.load(Ordering::SeqCst), 1);

    let enforce_decider = StaticDecider::new(Ok(AuthzDecision {
        allowed: false,
        reason: "implicit-deny".into(),
    }));
    let mut enforce_config = test_config(&iam.base);
    enforce_config.authz_mode = AuthzMode::Enforce;
    let enforce_gateway = spawn(
        create_app_with_decider(enforce_config, vec![base_route.clone()], enforce_decider).unwrap(),
    )
    .await;
    let response = http()
        .post(format!(
            "{}/v1/base/collections/c/documents",
            enforce_gateway.base
        ))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "access_denied");
    assert_eq!(body["action"], "base:Write");
    assert_eq!(
        body["resource"],
        "arn:synapseone:o1:-:base:collections/c/documents"
    );

    let allow = StaticDecider::new(Ok(AuthzDecision {
        allowed: true,
        reason: "policy-allow".into(),
    }));
    let mut cache_config = test_config(&iam.base);
    cache_config.authz_mode = AuthzMode::Enforce;
    let cache_gateway = spawn(
        create_app_with_decider(cache_config, vec![base_route.clone()], allow.clone()).unwrap(),
    )
    .await;
    for _ in 0..2 {
        let response = http()
            .get(format!(
                "{}/v1/base/collections/c/documents",
                cache_gateway.base
            ))
            .header("authorization", format!("Bearer {token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    assert_eq!(allow.calls.load(Ordering::SeqCst), 1);
    let other = user_token("u2", "o1");
    let response = http()
        .get(format!(
            "{}/v1/base/collections/c/documents",
            cache_gateway.base
        ))
        .header("authorization", format!("Bearer {other}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(allow.calls.load(Ordering::SeqCst), 2);

    let broken = StaticDecider::new(Err("down".into()));
    let mut error_config = test_config(&iam.base);
    error_config.authz_mode = AuthzMode::Enforce;
    let error_gateway =
        spawn(create_app_with_decider(error_config, vec![base_route.clone()], broken).unwrap())
            .await;
    let response = http()
        .get(format!(
            "{}/v1/base/collections/c/documents",
            error_gateway.base
        ))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "authz_unavailable"
    );

    let audit_broken = StaticDecider::new(Err("down".into()));
    let mut audit_error_config = test_config(&iam.base);
    audit_error_config.authz_mode = AuthzMode::Audit;
    let audit_error_gateway = spawn(
        create_app_with_decider(audit_error_config, vec![base_route.clone()], audit_broken)
            .unwrap(),
    )
    .await;
    let response = http()
        .get(format!(
            "{}/v1/base/collections/c/documents",
            audit_error_gateway.base
        ))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "audit fails open when IAM is down");

    let skipped = StaticDecider::new(Err("should not run".into()));
    let mut skip_config = test_config(&iam.base);
    skip_config.authz_mode = AuthzMode::Enforce;
    let skip_routes = vec![
        route("/v1/auth", upstream.base(), AuthMode::None),
        route("/v1/noservice", upstream.base(), AuthMode::Either),
    ];
    let skip_gateway =
        spawn(create_app_with_decider(skip_config, skip_routes, skipped.clone()).unwrap()).await;
    let response = http()
        .get(format!("{}/v1/auth/login", skip_gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response = http()
        .get(format!("{}/v1/noservice", skip_gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(skipped.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn authz_calls_iam_with_action_resource_and_secret() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let mut config = test_config(&iam.base);
    config.authz_mode = AuthzMode::Enforce;
    let routes = vec![with_actions(
        with_service(route("/v1/base", upstream.base(), AuthMode::Either), "base"),
        vec![("/v1/base/collections/*/query", Some("POST"), "base:Read")],
    )];
    let gateway = spawn_gateway(config, routes).await;
    let token = user_token("u1", "org-1");
    let response = http()
        .post(format!("{}/v1/base/collections/users/query", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = mock.authz_body().unwrap();
    assert_eq!(body["action"], "base:Read");
    assert_eq!(
        body["resource"],
        "arn:synapseone:org-1:-:base:collections/users/query"
    );
    assert_eq!(body["principal"]["sub"], "u1");
    assert_eq!(body["principal"]["kind"], "user");
    assert_eq!(mock.authz_internal().as_deref(), Some(TEST_INTERNAL));
    assert_eq!(mock.authz_hits(), 1);
}

#[tokio::test]
async fn authz_iam_deny_and_unavailable() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let base_route = with_service(route("/v1/base", upstream.base(), AuthMode::Either), "base");
    let mut config = test_config(&iam.base);
    config.authz_mode = AuthzMode::Enforce;
    let gateway = spawn_gateway(config, vec![base_route.clone()]).await;
    mock.set_authz(AuthzMock::Deny("implicit-deny"));
    let token = user_token("u-deny", "o1");
    let response = http()
        .post(format!("{}/v1/base/collections/c/documents", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "access_denied");
    assert_eq!(body["reason"], "implicit-deny");

    let mut error_config = test_config(&iam.base);
    error_config.authz_mode = AuthzMode::Enforce;
    let error_gateway = spawn_gateway(error_config, vec![base_route]).await;
    mock.set_authz(AuthzMock::Error);
    let token = user_token("u-error", "o1");
    let response = http()
        .get(format!(
            "{}/v1/base/collections/c/documents",
            error_gateway.base
        ))
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "authz_unavailable"
    );
    assert!(mock.authz_hits() >= 2);
}

#[tokio::test]
async fn usage_event_records_authenticated_request() {
    let (iam, mock) = MockIam::spawn().await;
    let upstream = Upstream::spawn().await;
    let mut config = test_config(&iam.base);
    config.usage_enabled = true;
    let routes = vec![with_service(
        route("/v1/orgs", upstream.base(), AuthMode::Either),
        "iam",
    )];
    let (router, state) = create_app_with_state(config, routes).unwrap();
    let gateway = spawn(router).await;
    let token = user_token("usage-user", "usage-org");
    let response = http()
        .get(format!("{}/v1/orgs", gateway.base))
        .header("authorization", format!("Bearer {token}"))
        .header("x-request-id", "rid-usage")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let _: Value = response.json().await.unwrap();
    state.usage.flush_now().await;
    let events = mock.usage_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["requestId"], "rid-usage");
    assert_eq!(events[0]["feature"], "iam");
    assert_eq!(events[0]["route"], "/v1/orgs");
    assert_eq!(events[0]["method"], "GET");
    assert_eq!(events[0]["path"], "/v1/orgs");
    assert_eq!(events[0]["status"], 200);
    assert_eq!(events[0]["authKind"], "user");
    assert_eq!(events[0]["orgId"], "usage-org");
    assert_eq!(events[0]["userId"], "usage-user");
    assert_eq!(events[0]["error"], Value::Null);
    assert_eq!(mock.usage_internal().as_deref(), Some(TEST_INTERNAL));
}

#[tokio::test]
async fn rate_limit_uses_trusted_forwarded_client_ip() {
    let mut config = test_config("http://127.0.0.1:1");
    config.ready_upstreams = vec![];
    config.trust_proxy = parse_trust_proxy(Some("1")).unwrap();
    let gateway = spawn_gateway(config, vec![]).await;
    let client = http();

    for index in 0..31 {
        let response = client
            .get(format!("{}/ready", gateway.base))
            .header("x-forwarded-for", "203.0.113.10")
            .send()
            .await
            .unwrap();
        if index < 30 {
            assert_eq!(response.status(), 200, "request {index}");
        } else {
            assert_eq!(response.status(), 429);
        }
    }
    // Another real client has an independent bucket.
    let response = client
        .get(format!("{}/ready", gateway.base))
        .header("x-forwarded-for", "203.0.113.20")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // A spoofed left-most entry cannot poison the real client's bucket; the
    // trusted hop is the right-most X-Forwarded-For value.
    let response = client
        .get(format!("{}/ready", gateway.base))
        .header("x-forwarded-for", "198.51.100.99, 203.0.113.20")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
}

// ---------- readiness / CORS ----------

#[tokio::test]
async fn ready_probes_versions_and_reports_degraded() {
    let (iam, _mock) = MockIam::spawn().await;
    let mut config = test_config(&iam.base);
    config.ready_upstreams = vec![crate::config::ReadyUpstream {
        name: "iam".into(),
        url: iam.base.clone(),
    }];
    let routes = vec![route("/v1/auth", &iam.base, AuthMode::None)];
    let gateway = spawn_gateway(config, routes).await;
    let response = http()
        .get(format!("{}/ready", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "ready");
    assert_eq!(body["upstreams"][0]["name"], "iam");
    assert_eq!(body["upstreams"][0]["version"], "test");
    assert_eq!(body["upstreams"][0]["status"], 200);

    let mut degraded_config = test_config(&iam.base);
    degraded_config.ready_upstreams = vec![
        crate::config::ReadyUpstream {
            name: "iam".into(),
            url: iam.base.clone(),
        },
        crate::config::ReadyUpstream {
            name: "dead".into(),
            url: "http://127.0.0.1:1".into(),
        },
    ];
    let degraded = spawn_gateway(
        degraded_config,
        vec![route("/v1/auth", &iam.base, AuthMode::None)],
    )
    .await;
    let response = http()
        .get(format!("{}/ready", degraded.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["upstreams"][1]["error"], "unreachable");
}

#[tokio::test]
async fn ready_rate_limit_is_thirty_per_minute() {
    let mut config = test_config("http://127.0.0.1:1");
    config.ready_upstreams = vec![];
    let gateway = spawn_gateway(config, vec![]).await;
    let client = http();
    for index in 0..30 {
        let response = client
            .get(format!("{}/ready", gateway.base))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "request {index}");
    }
    let response = client
        .get(format!("{}/ready", gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "rate_limited"
    );
}

#[tokio::test]
async fn cors_allowed_origins_and_preflight() {
    let mut config = test_config("http://127.0.0.1:1");
    config.cors_origins = vec!["https://console.example".into()];
    let gateway = spawn_gateway(config, vec![]).await;
    let client = http();
    let response = client
        .get(format!("{}/health", gateway.base))
        .header("origin", "https://console.example")
        .send()
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://console.example"
    );
    let response = client
        .get(format!("{}/health", gateway.base))
        .header("origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get("access-control-allow-origin")
        .is_none());

    let response = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/v1/orgs", gateway.base),
        )
        .header("origin", "https://console.example")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "authorization,x-api-key")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "https://console.example"
    );
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-headers")
            .unwrap(),
        "authorization,x-api-key"
    );
    assert_eq!(
        response.headers().get("x-content-type-options").unwrap(),
        "nosniff"
    );

    let default_gateway = spawn_gateway(test_config("http://127.0.0.1:1"), vec![]).await;
    let response = http()
        .get(format!("{}/health", default_gateway.base))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "*"
    );
}
