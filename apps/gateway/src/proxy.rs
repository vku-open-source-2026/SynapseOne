// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Streaming reverse proxy. Request and response bodies are never collected in
//! memory; hop-by-hop headers are stripped in both directions.

use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, Request, Response, StatusCode};
use axum::response::IntoResponse;
use http_body::Body as HttpBody;
use serde_json::json;

#[derive(Debug)]
pub enum ProxyError {
    Timeout,
    Upstream(String),
}

pub async fn proxy_request(
    client: &reqwest::Client,
    target: &str,
    request: Request<Body>,
    timeout: Duration,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let url = format!("{}{}", target.trim_end_matches('/'), path_and_query);
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|error| ProxyError::Upstream(error.to_string()))?;

    let has_body = method != reqwest::Method::HEAD && !body.is_end_stream();
    let mut headers = parts.headers;
    strip_hop_by_hop(&mut headers);
    headers.remove("host");
    let mut upstream = client.request(method.clone(), url).headers(headers);
    if has_body {
        upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let response = match tokio::time::timeout(timeout, upstream.send()).await {
        Err(_) => return Err(ProxyError::Timeout),
        Ok(Err(error)) => return Err(ProxyError::Upstream(error.to_string())),
        Ok(Ok(response)) => response,
    };

    let status = response.status();
    let mut response_headers = response.headers().clone();
    strip_hop_by_hop(&mut response_headers);

    let no_body = method == reqwest::Method::HEAD
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_MODIFIED
        || response_headers
            .get("content-length")
            .and_then(|value| value.to_str().ok())
            == Some("0");
    let body = if no_body {
        Body::empty()
    } else {
        Body::from_stream(response.bytes_stream())
    };

    let mut output = Response::new(body);
    *output.status_mut() = status;
    *output.headers_mut() = response_headers;
    Ok(output)
}

pub fn proxy_error_response(error: &ProxyError) -> Response<Body> {
    match error {
        ProxyError::Timeout => (
            StatusCode::GATEWAY_TIMEOUT,
            axum::Json(json!({
                "error": "gateway_timeout",
                "message": "upstream timed out",
            })),
        )
            .into_response(),
        ProxyError::Upstream(message) => {
            tracing::error!("[gateway] proxy upstream failed: {message}");
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({
                    "error": "bad_gateway",
                    "message": "upstream unavailable",
                })),
            )
                .into_response()
        }
    }
}

const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// RFC 7230 hop-by-hop removal, including headers nominated by `Connection`.
pub fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let mut nominated = Vec::new();
    if let Some(connection) = headers
        .get("connection")
        .and_then(|value| value.to_str().ok())
    {
        for token in connection
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if let Ok(name) = HeaderName::from_bytes(token.as_bytes()) {
                nominated.push(name);
            }
        }
    }
    for name in nominated {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
    }
}
