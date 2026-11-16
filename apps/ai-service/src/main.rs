// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOne AI service — LLM-assisted API testing agent.
//! The API key stays server-side (env); it is NEVER sent to the browser.

mod agent;
mod llm;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use agent::{run_agent, AgentConfig, AgentError, AgentFailure};
use llm::{LlmConfig, LlmError};

const VERSION: &str = "0.7.1";

#[derive(Clone)]
struct Config {
    port: u16,
    is_prod: bool,
    internal_secret: String,
    cors_origins: Vec<String>,
    base_url: String,
    api_key: String,
    decision_model: String,
    llm_model: String,
    llm_fallback_model: Option<String>,
    timeout_ms: u64,
    retries: u32,
    rate_limit: u32,
}

#[derive(Clone)]
struct AppState {
    config: Config,
    hits: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
}

fn env_u64(name: &str, fallback: u64, min: u64, max: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(fallback)
}

fn config_from_env() -> Config {
    let is_prod = std::env::var("NODE_ENV").as_deref() == Ok("production");
    let decision_model = std::env::var("AI_DECISION_MODEL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "inception/mercury-2.5".into());
    let llm_model = std::env::var("AI_LLM_MODEL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "liquid/lfm-2.5-2.6b:free".into());
    let fallback = std::env::var("AI_LLM_FALLBACK_MODEL")
        .unwrap_or_else(|_| decision_model.clone())
        .trim()
        .to_string();
    Config {
        port: env_u64("PORT", 4003, 1, 65535) as u16,
        is_prod,
        internal_secret: std::env::var("SYNAPSEONE_INTERNAL_SECRET").unwrap_or_default(),
        cors_origins: std::env::var("CORS_ORIGIN")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        base_url: std::env::var("AI_BASE_URL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "https://openrouter.ai/api/v1".into())
            .trim_end_matches('/')
            .to_string(),
        api_key: std::env::var("AI_API_KEY").unwrap_or_default(),
        decision_model,
        llm_model,
        llm_fallback_model: (!fallback.is_empty()).then_some(fallback),
        timeout_ms: env_u64("AI_TIMEOUT_MS", 20_000, 1_000, 300_000),
        retries: env_u64("AI_RETRIES", 2, 0, 3) as u32,
        rate_limit: env_u64("AI_RATE_LIMIT", 30, 1, 1_000) as u32,
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

async fn security_headers(request: Request, next: Next) -> Response {
    let hsts = std::env::var("HSTS_ENABLED").as_deref() == Ok("true");
    let incoming = header(request.headers(), "x-request-id")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
        .take(128)
        .collect::<String>();
    let request_id = if incoming.is_empty() {
        uuid_like()
    } else {
        incoming
    };
    let mut response = next.run(request).await;
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
    response
}

fn uuid_like() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:x}-{:x}", now.as_millis(), now.subsec_nanos())
}

async fn internal_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if !request.uri().path().starts_with("/v1/") {
        return next.run(request).await;
    }
    if state.config.internal_secret.is_empty() {
        if state.config.is_prod {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "misconfigured",
                Some("internal secret required in production".into()),
            );
        }
        return next.run(request).await;
    }
    if !verify_internal(request.headers(), &state.config.internal_secret) {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            Some("Missing or invalid internal credential".into()),
        );
    }
    next.run(request).await
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "service": "ai",
        "version": VERSION,
        "models": {
            "decision": state.config.decision_model,
            "llm": state.config.llm_model,
            "fallback": state.config.llm_fallback_model,
        },
        "configured": !state.config.api_key.is_empty(),
        "time": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
    .into_response()
}

async fn rate_limit(state: &AppState, principal: &str) -> bool {
    let mut hits = state.hits.lock().await;
    let now = Instant::now();
    let entry = hits
        .entry(principal.to_string())
        .or_insert((0, now + Duration::from_secs(60)));
    if entry.1 < now {
        *entry = (1, now + Duration::from_secs(60));
        return false;
    }
    entry.0 += 1;
    entry.0 > state.config.rate_limit
}

async fn agent_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let principal = {
        let user = header(&headers, "x-synapseone-user");
        let account = header(&headers, "x-synapseone-account");
        if !user.is_empty() {
            user
        } else if !account.is_empty() {
            format!("apikey:{account}")
        } else {
            header(&headers, "x-forwarded-for")
        }
    };
    if rate_limit(&state, &principal).await {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            Some("Too many agent requests, slow down".into()),
        );
    }
    if state.config.api_key.is_empty() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_not_configured",
            Some("AI_API_KEY is not set on the server".into()),
        );
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_json",
            Some("Request body is not valid JSON".into()),
        );
    };
    let question = payload
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("");
    if question.trim().is_empty() || question.chars().count() > 2000 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid_question",
            Some("question must be a 1..2000 char string".into()),
        );
    }
    let history = match payload.get("history") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .rev()
            .take(10)
            .rev()
            .filter_map(|item| item.as_object())
            .map(|item| {
                let role = if item.get("role").and_then(Value::as_str) == Some("user") {
                    "user"
                } else {
                    "ai"
                };
                let text = item
                    .get("text")
                    .map(|value| match value {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default()
                    .chars()
                    .take(500)
                    .collect::<String>();
                (role.to_string(), text)
            })
            .filter(|(_, text)| !text.is_empty())
            .collect(),
        Some(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "invalid_history",
                Some("history must be an array".into()),
            )
        }
    };

    let base = LlmConfig {
        base_url: state.config.base_url.clone(),
        api_key: state.config.api_key.clone(),
        model: String::new(),
        timeout_ms: state.config.timeout_ms,
        retries: state.config.retries,
    };
    let cfg = AgentConfig {
        decision: LlmConfig {
            model: state.config.decision_model.clone(),
            ..base.clone()
        },
        llm: LlmConfig {
            model: state.config.llm_model.clone(),
            ..base.clone()
        },
        llm_fallback: state.config.llm_fallback_model.as_ref().map(|model| LlmConfig {
            model: model.clone(),
            ..base
        }),
    };

    match run_agent(question, &cfg, &history).await {
        Ok(result) => Json(result).into_response(),
        Err(AgentFailure::Agent(AgentError { code, message })) => {
            json_error(StatusCode::BAD_GATEWAY, &code, Some(message))
        }
        Err(AgentFailure::Llm(LlmError { message, .. })) => {
            json_error(StatusCode::BAD_GATEWAY, "llm_error", Some(message))
        }
    }
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
        .route("/v1/ai/agent", post(agent_handler))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), internal_auth))
        .layer(middleware::from_fn(security_headers))
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
            eprintln!("[ai] SYNAPSEONE_INTERNAL_SECRET must be set in production");
            std::process::exit(1);
        }
        if config.api_key.is_empty() {
            eprintln!("[ai] AI_API_KEY must be set in production");
            std::process::exit(1);
        }
    }
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[ai][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production."
        );
    }
    if config.api_key.is_empty() {
        tracing::warn!("[ai][security] AI_API_KEY not set — /v1/ai/agent returns 503 (dev default).");
    }
    let state = AppState {
        config: config.clone(),
        hits: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = build_app(state);
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[ai] listening on :{} provider={}",
        config.port,
        config.base_url
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
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

    fn state() -> AppState {
        AppState {
            config: Config {
                port: 0,
                is_prod: false,
                internal_secret: String::new(),
                cors_origins: vec![],
                base_url: "https://openrouter.ai/api/v1".into(),
                api_key: "test-key".into(),
                decision_model: "a".into(),
                llm_model: "b".into(),
                llm_fallback_model: None,
                timeout_ms: 1000,
                retries: 0,
                rate_limit: 30,
            },
            hits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[tokio::test]
    async fn health_reports_models() {
        let app = build_app(state());
        let response = app
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
        assert_eq!(body["service"], "ai");
        assert_eq!(body["configured"], true);
        assert_eq!(body["models"]["decision"], "a");
    }

    #[tokio::test]
    async fn rejects_empty_question() {
        let app = build_app(state());
        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/v1/ai/agent")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"question":""}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
