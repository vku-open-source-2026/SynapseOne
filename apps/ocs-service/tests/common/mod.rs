// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared helpers for SynapseOCS integration tests.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::Router;
use bytes::Bytes;
use serde_json::Value;
use synapseone_ocs::{build_app, Backend, Config, FileBackend};
use tempfile::TempDir;
use tower::ServiceExt;

pub fn tenant_headers(org: &str, sub: &str) -> Vec<(String, String)> {
    vec![
        ("x-synapseone-user".into(), sub.into()),
        ("x-synapseone-org".into(), org.into()),
        ("x-synapseone-kind".into(), "user".into()),
    ]
}

pub fn default_headers() -> Vec<(String, String)> {
    tenant_headers("org-a", "user-1")
}

pub fn with_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    headers.push((name.into(), value.into()));
}

pub fn test_config() -> Config {
    Config::for_test()
}

pub fn fs_app() -> (Router, TempDir) {
    fs_app_with(|_| {})
}

pub fn fs_app_with(configure: impl FnOnce(&mut Config)) -> (Router, TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = Backend::Fs(FileBackend::new(dir.path()).expect("fs backend"));
    let mut config = test_config();
    configure(&mut config);
    (build_app(backend, config), dir)
}

pub fn app_with_dir(dir: &TempDir, configure: impl FnOnce(&mut Config)) -> Router {
    let backend = Backend::Fs(FileBackend::new(dir.path()).expect("fs backend"));
    let mut config = test_config();
    configure(&mut config);
    build_app(backend, config)
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn header(&self, name: &str) -> String {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    }
}

pub async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Vec<u8>>,
    headers: Vec<(String, String)>,
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let request = builder
        .body(Body::from(body.unwrap_or_default()))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    TestResponse {
        status,
        headers,
        body,
    }
}

pub async fn json_request(
    app: &Router,
    method: &str,
    uri: &str,
    body: &Value,
    headers: Vec<(String, String)>,
) -> TestResponse {
    let mut headers = headers;
    headers.push(("content-type".into(), "application/json".into()));
    request(
        app,
        method,
        uri,
        Some(body.to_string().into_bytes()),
        headers,
    )
    .await
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}
