// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP transport for the SynapseOne gateway.

use crate::error::{Error, Result};
use bytes::Bytes;
use http::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER,
    USER_AGENT,
};
use http::Method;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use url::form_urlencoded;

/// Public production gateway.
pub const DEFAULT_BASE_URL: &str = "https://api.synapseone.space";
/// Default request timeout, matching the Python SDK.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// Default number of attempts (first try + two retries).
pub const DEFAULT_MAX_ATTEMPTS: u32 = 3;
/// Base delay for exponential backoff.
pub const DEFAULT_RETRY_BASE: Duration = Duration::from_millis(200);

/// Characters left unescaped in a path segment, matching Python `quote(s, safe='')`.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Percent-encode one path segment.
pub fn segment(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT).to_string()
}

/// Build a query string (without the leading `?`).
pub fn query_string(params: &[(&str, String)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    serializer.finish()
}

/// Credentials accepted by the gateway.
#[derive(Clone, Default)]
pub struct Credentials {
    token: Option<String>,
    api_key: Option<String>,
}

impl Credentials {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn token(token: impl Into<String>) -> Self {
        Self {
            token: Some(token.into()),
            api_key: None,
        }
    }

    pub fn api_key(key: impl Into<String>) -> Self {
        Self {
            token: None,
            api_key: Some(key.into()),
        }
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    pub fn token_value(&self) -> Option<&str> {
        self.token.as_deref()
    }

    pub fn api_key_value(&self) -> Option<&str> {
        self.api_key.as_deref()
    }
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

struct Inner {
    base_url: String,
    credentials: Credentials,
    tenant: Option<String>,
    http: reqwest::Client,
    timeout: Duration,
    max_attempts: u32,
    retry_base: Duration,
    user_agent: String,
    default_headers: HeaderMap,
}

impl Clone for Inner {
    fn clone(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            credentials: self.credentials.clone(),
            tenant: self.tenant.clone(),
            http: self.http.clone(),
            timeout: self.timeout,
            max_attempts: self.max_attempts,
            retry_base: self.retry_base,
            user_agent: self.user_agent.clone(),
            default_headers: self.default_headers.clone(),
        }
    }
}

/// Async client for the SynapseOne gateway.
///
/// The client is cheap to clone: clones share the connection pool and the
/// immutable configuration.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.inner.base_url)
            .field("tenant", &self.inner.tenant)
            .finish()
    }
}

impl Client {
    /// Build a client with default transport settings.
    pub fn new(base_url: impl Into<String>, credentials: Credentials) -> Result<Self> {
        ClientBuilder::new(base_url)
            .credentials(credentials)
            .build()
    }

    /// Build a client from `SYNAPSEONE_BASE_URL` (or `SYNAPSEDX_BASE_URL`)
    /// plus `SYNAPSEONE_TOKEN` / `SYNAPSEONE_API_KEY`.
    pub fn from_env() -> Result<Self> {
        let base = std::env::var("SYNAPSEONE_BASE_URL")
            .or_else(|_| std::env::var("SYNAPSEDX_BASE_URL"))
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let mut credentials = Credentials::default();
        if let Ok(token) = std::env::var("SYNAPSEONE_TOKEN") {
            if !token.trim().is_empty() {
                credentials.token = Some(token);
            }
        }
        if let Ok(key) = std::env::var("SYNAPSEONE_API_KEY") {
            if !key.trim().is_empty() {
                credentials.api_key = Some(key);
            }
        }
        Self::new(base, credentials)
    }

    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        ClientBuilder::new(base_url)
    }

    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    pub fn tenant(&self) -> Option<&str> {
        self.inner.tenant.as_deref()
    }

    /// Return a clone with a different bearer token.
    pub fn with_token(&self, token: impl Into<String>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.credentials.token = Some(token.into());
        Self {
            inner: Arc::new(inner),
        }
    }

    /// Return a clone with a different API key.
    pub fn with_api_key(&self, key: impl Into<String>) -> Self {
        let mut inner = (*self.inner).clone();
        inner.credentials.api_key = Some(key.into());
        Self {
            inner: Arc::new(inner),
        }
    }

    /// Send a JSON request and decode the JSON response.
    pub async fn request(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
    ) -> Result<Value> {
        let request = Request::new(method, path).json(body);
        self.send(request).await.map(|response| response.body)
    }

    pub async fn get(&self, path: impl Into<String>) -> Result<Value> {
        self.request(Method::GET, path, None).await
    }

    pub async fn post(&self, path: impl Into<String>, body: Value) -> Result<Value> {
        self.request(Method::POST, path, Some(body)).await
    }

    pub async fn put(&self, path: impl Into<String>, body: Value) -> Result<Value> {
        self.request(Method::PUT, path, Some(body)).await
    }

    pub async fn patch(&self, path: impl Into<String>, body: Value) -> Result<Value> {
        self.request(Method::PATCH, path, Some(body)).await
    }

    pub async fn delete(&self, path: impl Into<String>) -> Result<Value> {
        self.request(Method::DELETE, path, None).await
    }

    /// Send a request and return the raw body, headers and status.
    pub async fn send(&self, request: Request) -> Result<Response> {
        let attempts = request
            .max_attempts
            .unwrap_or(self.inner.max_attempts)
            .max(1);
        let retryable = request.retryable.unwrap_or_else(|| {
            matches!(
                request.method,
                Method::GET | Method::HEAD | Method::OPTIONS | Method::PUT | Method::DELETE
            ) || request.idempotency_key.is_some()
        });

        let mut last_error: Option<Error> = None;

        for attempt in 1..=attempts {
            match self.send_once(&request).await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    let should_retry = retryable
                        && attempt < attempts
                        && match &error {
                            Error::Network { .. } => true,
                            Error::Http { status, .. } => {
                                matches!(status, 429 | 502 | 503 | 504)
                            }
                            _ => false,
                        };

                    if !should_retry {
                        return Err(error);
                    }

                    let delay = match &error {
                        Error::Http {
                            status: 429,
                            retry_after,
                            ..
                        } => request
                            .retry_after
                            .or(*retry_after)
                            .unwrap_or_else(|| self.backoff(attempt)),
                        _ => self.backoff(attempt),
                    };
                    last_error = Some(error);
                    tokio::time::sleep(delay).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            Error::Config("request retries exhausted without an error".to_string())
        }))
    }

    fn backoff(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(10);
        let millis = self
            .inner
            .retry_base
            .as_millis()
            .saturating_mul(1u128 << shift)
            .min(30_000);
        Duration::from_millis(millis as u64)
    }

    async fn send_once(&self, request: &Request) -> Result<Response> {
        let path = if request.path.starts_with('/') {
            request.path.clone()
        } else {
            format!("/{}", request.path)
        };
        let url = format!("{}{}", self.inner.base_url, path);

        let mut builder = self
            .inner
            .http
            .request(request.method.clone(), &url)
            .timeout(request.timeout.unwrap_or(self.inner.timeout));

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(USER_AGENT, HeaderValue::from_str(&self.inner.user_agent)?);

        if let Some(token) = self.inner.credentials.token_value() {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }
        if let Some(key) = self.inner.credentials.api_key_value() {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(key)?,
            );
        }
        if let Some(tenant) = &self.inner.tenant {
            headers.insert(
                HeaderName::from_static("x-synapseone-tenant"),
                HeaderValue::from_str(tenant)?,
            );
        }
        if let Some(idempotency_key) = &request.idempotency_key {
            headers.insert(
                HeaderName::from_static("idempotency-key"),
                HeaderValue::from_str(idempotency_key)?,
            );
        }

        for (name, value) in &self.inner.default_headers {
            headers.insert(name, value.clone());
        }
        for (name, value) in &request.headers {
            headers.insert(name, value.clone());
        }

        if let Some(content_type) = &request.content_type {
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(content_type)?);
        } else if request.json_body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }

        builder = builder.headers(headers);

        if let Some(bytes) = &request.bytes_body {
            builder = builder.body(bytes.clone());
        } else if let Some(json) = &request.json_body {
            builder = builder.json(json);
        }

        let response = builder.send().await.map_err(|source| Error::Network {
            path: path.clone(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;

        let status = response.status();
        let response_headers = response.headers().clone();
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_retry_after);
        let bytes = response.bytes().await.map_err(|source| Error::Network {
            path: path.clone(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;

        if !status.is_success() {
            let body = serde_json::from_slice::<Value>(&bytes).ok();
            let code = body
                .as_ref()
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let message = body
                .as_ref()
                .and_then(|value| {
                    value
                        .get("message")
                        .or_else(|| value.get("detail"))
                        .and_then(Value::as_str)
                })
                .map(str::to_string)
                .unwrap_or_else(|| truncate(&String::from_utf8_lossy(&bytes), 500));
            return Err(Error::Http {
                status: status.as_u16(),
                path,
                message,
                code,
                body,
                base_url: self.inner.base_url.clone(),
                retry_after,
            });
        }

        let text = String::from_utf8_lossy(&bytes);
        let trimmed = text.trim_start();
        if looks_like_html(trimmed) {
            return Err(Error::NonJsonResponse {
                status: status.as_u16(),
                path,
                base_url: self.inner.base_url.clone(),
                body: truncate(trimmed, 256),
            });
        }

        let body = if bytes.is_empty() {
            Value::Null
        } else {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => value,
                Err(_) => Value::String(text.into_owned()),
            }
        };

        Ok(Response {
            status: status.as_u16(),
            headers: response_headers,
            retry_after,
            body,
        })
    }

    /// Convenience wrapper that deserializes into `T`.
    pub async fn request_typed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
    ) -> Result<T> {
        let value = self.request(method, path, body).await?;
        Ok(serde_json::from_value(value)?)
    }

    /// Send a request for a binary response (object download, attachment).
    pub async fn send_bytes(&self, request: Request) -> Result<BinaryResponse> {
        let path = if request.path.starts_with('/') {
            request.path.clone()
        } else {
            format!("/{}", request.path)
        };
        let url = format!("{}{}", self.inner.base_url, path);
        let mut builder = self
            .inner
            .http
            .request(request.method.clone(), &url)
            .timeout(request.timeout.unwrap_or(self.inner.timeout));

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        if let Some(token) = self.inner.credentials.token_value() {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))?,
            );
        }
        if let Some(key) = self.inner.credentials.api_key_value() {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                HeaderValue::from_str(key)?,
            );
        }
        if let Some(tenant) = &self.inner.tenant {
            headers.insert(
                HeaderName::from_static("x-synapseone-tenant"),
                HeaderValue::from_str(tenant)?,
            );
        }
        for (name, value) in &self.inner.default_headers {
            headers.insert(name, value.clone());
        }
        for (name, value) in &request.headers {
            headers.insert(name, value.clone());
        }
        if let Some(content_type) = &request.content_type {
            headers.insert(CONTENT_TYPE, HeaderValue::from_str(content_type)?);
        }
        builder = builder.headers(headers);
        if let Some(bytes) = &request.bytes_body {
            builder = builder.body(bytes.clone());
        }

        let response = builder.send().await.map_err(|source| Error::Network {
            path: path.clone(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;
        let status = response.status();
        let response_headers = response.headers().clone();
        let body = response.bytes().await.map_err(|source| Error::Network {
            path: path.clone(),
            base_url: self.inner.base_url.clone(),
            source,
        })?;

        if !status.is_success() {
            let parsed = serde_json::from_slice::<Value>(&body).ok();
            return Err(Error::Http {
                status: status.as_u16(),
                path,
                message: truncate(&String::from_utf8_lossy(&body), 500),
                code: parsed
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                body: parsed,
                base_url: self.inner.base_url.clone(),
                retry_after: None,
            });
        }

        Ok(BinaryResponse {
            status: status.as_u16(),
            headers: response_headers,
            body,
        })
    }
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    let seconds = value.trim().parse::<f64>().ok()?;
    Some(Duration::from_secs_f64(seconds.clamp(0.0, 30.0)))
}

fn looks_like_html(value: &str) -> bool {
    let head = value.get(..256).unwrap_or(value).to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// A JSON request with optional per-request overrides.
#[derive(Clone)]
pub struct Request {
    pub method: Method,
    pub path: String,
    pub json_body: Option<Value>,
    pub bytes_body: Option<Bytes>,
    pub content_type: Option<String>,
    pub timeout: Option<Duration>,
    pub headers: HeaderMap,
    pub max_attempts: Option<u32>,
    pub retryable: Option<bool>,
    pub idempotency_key: Option<String>,
    pub retry_after: Option<Duration>,
}

impl Request {
    pub fn new(method: Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            json_body: None,
            bytes_body: None,
            content_type: None,
            timeout: None,
            headers: HeaderMap::new(),
            max_attempts: None,
            retryable: None,
            idempotency_key: None,
            retry_after: None,
        }
    }

    pub fn get(path: impl Into<String>) -> Self {
        Self::new(Method::GET, path)
    }

    pub fn post(path: impl Into<String>) -> Self {
        Self::new(Method::POST, path)
    }

    pub fn json(mut self, body: Option<Value>) -> Self {
        self.json_body = body;
        self
    }

    pub fn bytes(mut self, bytes: impl Into<Bytes>, content_type: impl Into<String>) -> Self {
        self.bytes_body = Some(bytes.into());
        self.content_type = Some(content_type.into());
        self
    }

    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = Some(attempts.max(1));
        self
    }

    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = Some(retryable);
        self
    }

    pub fn idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// Set an idempotency key only when one is supplied.
    pub fn maybe_idempotency(mut self, key: Option<&str>) -> Self {
        if let Some(key) = key {
            self.idempotency_key = Some(key.to_string());
        }
        self
    }

    pub fn retry_after(mut self, delay: Duration) -> Self {
        self.retry_after = Some(delay);
        self
    }
}

/// Decoded JSON response with status and headers.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub retry_after: Option<Duration>,
    pub body: Value,
}

/// Binary response.
#[derive(Debug, Clone)]
pub struct BinaryResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

/// Builder for [`Client`].
pub struct ClientBuilder {
    base_url: String,
    credentials: Credentials,
    tenant: Option<String>,
    timeout: Duration,
    max_attempts: u32,
    retry_base: Duration,
    user_agent: String,
    headers: HeaderMap,
    connect_timeout: Duration,
}

impl ClientBuilder {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            credentials: Credentials::default(),
            tenant: None,
            timeout: DEFAULT_TIMEOUT,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            retry_base: DEFAULT_RETRY_BASE,
            user_agent: format!("synapseone-rust/{}", env!("CARGO_PKG_VERSION")),
            headers: HeaderMap::new(),
            connect_timeout: Duration::from_secs(10),
        }
    }

    pub fn credentials(mut self, credentials: Credentials) -> Self {
        self.credentials = credentials;
        self
    }

    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.credentials.token = Some(token.into());
        self
    }

    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.credentials.api_key = Some(key.into());
        self
    }

    pub fn tenant(mut self, tenant: impl Into<String>) -> Self {
        self.tenant = Some(tenant.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    pub fn max_attempts(mut self, attempts: u32) -> Self {
        self.max_attempts = attempts.max(1);
        self
    }

    pub fn retry_base(mut self, delay: Duration) -> Self {
        self.retry_base = delay;
        self
    }

    pub fn user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    pub fn build(self) -> Result<Client> {
        let base_url = self.base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err(Error::Config("base_url is empty".to_string()));
        }
        let parsed = url::Url::parse(&base_url)
            .map_err(|error| Error::Config(format!("base_url is not a URL: {error}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::Config(format!(
                "base_url must be http(s), got {}",
                parsed.scheme()
            )));
        }

        let http = reqwest::Client::builder()
            .connect_timeout(self.connect_timeout)
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent(self.user_agent.clone())
            .build()
            .map_err(|source| Error::Network {
                path: String::new(),
                base_url: base_url.clone(),
                source,
            })?;

        Ok(Client {
            inner: Arc::new(Inner {
                base_url,
                credentials: self.credentials,
                tenant: self.tenant,
                http,
                timeout: self.timeout,
                max_attempts: self.max_attempts,
                retry_base: self.retry_base,
                user_agent: self.user_agent,
                default_headers: self.headers,
            }),
        })
    }
}
