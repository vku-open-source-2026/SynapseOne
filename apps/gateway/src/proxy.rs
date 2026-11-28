// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Streaming reverse proxy. Request and response bodies are never collected in
//! memory; hop-by-hop headers are stripped in both directions.

use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode};
use axum::response::IntoResponse;
use http_body::Body as HttpBody;
use serde_json::json;

#[derive(Debug)]
pub enum ProxyError {
    Timeout,
    Upstream(String),
    EdgeNotConfigured,
}

/// Remove a literal pathname prefix only at a path-segment boundary. The query
/// substring is copied byte-for-byte, including repeated/encoded parameters.
pub fn rewrite_path_and_query(path_and_query: &str, prefix: &str) -> Result<String, &'static str> {
    let (pathname, query) = match path_and_query.split_once('?') {
        Some((pathname, query)) => (pathname, Some(query)),
        None => (path_and_query, None),
    };
    let rewritten = if pathname == prefix {
        "/".to_string()
    } else if let Some(rest) = pathname.strip_prefix(prefix) {
        if !rest.starts_with('/') {
            return Err("stripPrefix does not match a path-segment boundary");
        }
        rest.to_string()
    } else {
        return Err("stripPrefix does not match the request pathname");
    };
    Ok(match query {
        Some(query) => format!("{rewritten}?{query}"),
        None => rewritten,
    })
}

fn edge_admin_token(env_name: &str) -> Result<String, ProxyError> {
    let token = std::env::var(env_name).unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        return Err(ProxyError::EdgeNotConfigured);
    }
    Ok(token.to_string())
}

pub async fn proxy_request(
    client: &reqwest::Client,
    target: &str,
    request: Request<Body>,
    timeout: Duration,
    strip_prefix: Option<&str>,
    admin_token_env: Option<&str>,
) -> Result<Response<Body>, ProxyError> {
    let (parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let path_and_query = match strip_prefix {
        Some(prefix) => rewrite_path_and_query(path_and_query, prefix)
            .map_err(|message| ProxyError::Upstream(message.to_string()))?,
        None => path_and_query.to_string(),
    };
    let url = format!("{}{}", target.trim_end_matches('/'), path_and_query);
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|error| ProxyError::Upstream(error.to_string()))?;
    let admin_token = match admin_token_env {
        Some(env_name) => Some(edge_admin_token(env_name)?),
        None => None,
    };

    let has_body = method != reqwest::Method::HEAD && !body.is_end_stream();
    let mut headers = parts.headers;
    strip_hop_by_hop(&mut headers);
    headers.remove("host");
    if let Some(token) = admin_token {
        headers.remove("authorization");
        headers.remove("x-api-key");
        let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| ProxyError::EdgeNotConfigured)?;
        headers.insert("authorization", authorization);
    }
    let mut upstream = client.request(method.clone(), url).headers(headers);
    if has_body {
        upstream = upstream.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let response = match tokio::time::timeout(timeout, upstream.send()).await {
        Err(_) => return Err(ProxyError::Timeout),
        Ok(Err(error)) => {
            let message = if admin_token_env.is_some() {
                // Edge credentials must never appear in proxy errors or logs,
                // even if a lower-level client includes request metadata.
                "edge upstream request failed".to_string()
            } else {
                error.to_string()
            };
            return Err(ProxyError::Upstream(message));
        }
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
        ProxyError::EdgeNotConfigured => (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({
                "error": "edge_not_configured",
                "message": "edge management is not configured",
            })),
        )
            .into_response(),
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

#[cfg(test)]
mod tests {
    use super::rewrite_path_and_query;

    #[test]
    fn rewrite_preserves_query_and_requires_a_prefix_boundary() {
        assert_eq!(
            rewrite_path_and_query(
                "/v1/platform/edge/dns/zones/example.com?type=TXT&value=a%2Fb&type=MX",
                "/v1/platform/edge/dns",
            )
            .unwrap(),
            "/zones/example.com?type=TXT&value=a%2Fb&type=MX"
        );
        assert_eq!(
            rewrite_path_and_query("/v1/platform/edge/dns?dryRun=1", "/v1/platform/edge/dns")
                .unwrap(),
            "/?dryRun=1"
        );
        assert_eq!(
            rewrite_path_and_query("/v1/platform/edge/dns", "/v1/platform/edge/dns").unwrap(),
            "/"
        );
        assert!(rewrite_path_and_query(
            "/v1/platform/edge/dns-other/zones?x=1",
            "/v1/platform/edge/dns",
        )
        .is_err());
        assert!(
            rewrite_path_and_query("/v1/platform/edge/tunnel", "/v1/platform/edge/dns").is_err()
        );
    }
}
