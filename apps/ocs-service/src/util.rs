// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared HTTP helpers: gateway principal/tenant extraction, JavaScript-style
//! value coercion, bounded bodies and JSON error envelopes.

use axum::body::Body;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};
use url::form_urlencoded;

pub fn header(headers: &HeaderMap, name: &str) -> String {
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

/// Header lookup that keeps the difference between "missing" and "present but
/// empty" (`??` semantics used for explicit tenant headers).
pub fn header_opt(headers: &HeaderMap, name: &str) -> Option<String> {
    let legacy = if name.starts_with("x-synapseone-") {
        name.replacen("x-synapseone-", "x-synapsedx-", 1)
    } else {
        name.to_string()
    };
    headers
        .get(name)
        .or_else(|| headers.get(&legacy))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub sub: String,
    pub org: Option<String>,
    pub account: Option<String>,
    pub kind: Option<String>,
}

fn clean(value: String) -> Option<String> {
    if !value.is_empty() && value.chars().count() <= 128 {
        Some(value)
    } else {
        None
    }
}

pub fn principal_from_headers(headers: &HeaderMap) -> Option<Principal> {
    let user = header(headers, "x-synapseone-user");
    if !user.is_empty() {
        return Some(Principal {
            sub: user,
            org: clean(header(headers, "x-synapseone-org")),
            account: clean(header(headers, "x-synapseone-account")),
            kind: clean(header(headers, "x-synapseone-kind")),
        });
    }
    let kind = clean(header(headers, "x-synapseone-kind"));
    let account = clean(header(headers, "x-synapseone-account"));
    let org = clean(header(headers, "x-synapseone-org"));
    if kind.is_some() || account.is_some() || org.is_some() {
        let sub = match &account {
            Some(account) => format!("apikey:{account}"),
            None => format!(
                "{}:unknown",
                kind.clone().unwrap_or_else(|| "principal".into())
            ),
        };
        return Some(Principal {
            sub,
            org,
            account,
            kind: Some(kind.unwrap_or_else(|| "apikey".into())),
        });
    }
    None
}

fn valid_explicit_tenant(value: &str) -> bool {
    let len = value.chars().count();
    (1..=128).contains(&len)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// Canonical tenant: org-wide first, then account, then user.
pub fn resolve_tenant(headers: &HeaderMap, raw_query: Option<&str>) -> Option<String> {
    let principal = principal_from_headers(headers);
    if let Some(principal) = &principal {
        if let Some(org) = &principal.org {
            return Some(format!("org:{org}"));
        }
        if let Some(account) = &principal.account {
            return Some(format!("account:{account}"));
        }
        if !principal.sub.is_empty() {
            return Some(format!("user:{}", principal.sub));
        }
    }
    let explicit = header_opt(headers, "x-synapseone-tenant").or_else(|| {
        raw_query.and_then(|raw| {
            form_urlencoded::parse(raw.as_bytes())
                .find(|(key, _)| key == "tenant")
                .map(|(_, value)| value.into_owned())
        })
    })?;
    valid_explicit_tenant(&explicit).then_some(explicit)
}

pub fn verify_internal(headers: &HeaderMap, secret: &str) -> bool {
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

pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|v| v != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn js_value_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(js_value_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value || '')` semantics for request fields.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(value) if !js_truthy(value) => String::new(),
        Some(value) => js_value_string(value),
    }
}

/// `String(value || fallback)` semantics.
pub fn js_string_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if js_truthy(value) => js_value_string(value),
        _ => fallback.into(),
    }
}

/// Bare `String(value)` semantics (null becomes `"null"`, undefined `""`).
pub fn js_coerce_string(value: Option<&Value>) -> String {
    match value {
        None => String::new(),
        Some(value) => js_value_string(value),
    }
}

pub fn parse_js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return u128::from_str_radix(hex, 16).ok().map(|value| value as f64);
    }
    if trimmed.eq_ignore_ascii_case("infinity") || trimmed == "+Infinity" {
        return Some(f64::INFINITY);
    }
    if trimmed == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    trimmed.parse::<f64>().ok()
}

/// `Number(value)` semantics. `None` means NaN (or undefined for missing).
pub fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => parse_js_number(text),
        Value::Array(_) | Value::Object(_) => None,
    }
}

pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

#[derive(Clone, Debug, Default)]
pub struct QueryParams {
    pairs: Vec<(String, String)>,
}

impl QueryParams {
    pub fn parse(raw: Option<&str>) -> Self {
        let pairs = raw
            .map(|raw| {
                form_urlencoded::parse(raw.as_bytes())
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        Self { pairs }
    }

    pub fn first(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Express exposes repeated query values as an array; non-string-specific
    /// reads such as `String(req.query.prefix || '')` join them with commas.
    pub fn js_string(&self, name: &str) -> String {
        let values = self
            .pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .collect::<Vec<_>>();
        match values.as_slice() {
            [] => String::new(),
            [value] => (*value).to_string(),
            _ => values.join(","),
        }
    }

    /// Only a single scalar value is visible to `typeof x === 'string'` checks.
    pub fn single(&self, name: &str) -> Option<&str> {
        let mut values = self
            .pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_str());
        let first = values.next()?;
        if values.next().is_some() {
            None
        } else {
            Some(first)
        }
    }
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn backend(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "backend_error", message)
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn into_response(self) -> Response {
        error_response(self.status, &self.code, Some(self.message), self.details)
    }
}

pub fn error_response(
    status: StatusCode,
    code: &str,
    message: Option<String>,
    details: Option<Value>,
) -> Response {
    let mut body = Map::new();
    body.insert("error".into(), Value::String(code.into()));
    if let Some(message) = message {
        body.insert(
            "message".into(),
            Value::String(truncate_chars(&message, 300)),
        );
    }
    if let Some(details) = details {
        body.insert("details".into(), details);
    }
    (status, axum::Json(Value::Object(body))).into_response()
}

pub fn json_error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    error_response(status, code, Some(message.into()), None)
}

pub fn backend_error(message: impl Into<String>) -> Response {
    ApiError::backend(message).into_response()
}

/// Express' error middleware maps any 413 to the object-size envelope.
pub fn object_too_large(max_object_bytes: usize) -> Response {
    json_error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "object_too_large",
        format!("max object size is {max_object_bytes} bytes"),
    )
}

#[allow(clippy::result_large_err)]
pub async fn read_body_limited(
    body: Body,
    limit: usize,
    max_object_bytes: usize,
) -> Result<bytes::Bytes, Response> {
    axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| object_too_large(max_object_bytes))
}

fn looks_like_json(headers: &HeaderMap) -> bool {
    let content_type = header(headers, "content-type")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    content_type == "application/json" || content_type.ends_with("+json")
}

/// Parse the JSON request body like `express.json({ limit: '1mb' })`.
/// Non-JSON content types are ignored (Express leaves `req.body` empty).
#[allow(clippy::result_large_err)]
pub async fn read_json(
    headers: &HeaderMap,
    body: Body,
    max_object_bytes: usize,
) -> Result<Value, Response> {
    if !looks_like_json(headers) {
        return Ok(Value::Object(Map::new()));
    }
    let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(object_too_large(max_object_bytes)),
    };
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        tracing::error!("[storage] invalid JSON body: {error}");
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal", None, None)
    })
}

pub fn content_type(headers: &HeaderMap) -> String {
    header(headers, "content-type")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

pub fn media_type_or_default(headers: &HeaderMap) -> String {
    let value = content_type(headers);
    if value.is_empty() {
        "application/octet-stream".into()
    } else {
        value
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn epoch_iso() -> String {
    chrono::DateTime::<Utc>::from_timestamp(0, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// JavaScript `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Lenient base64url decoding, matching Node's `Buffer.from(value, 'base64url')`
/// which ignores non-alphabet bytes and accepts padding / standard alphabet.
pub fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut cleaned = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '+' | '/' | '=' => {
                cleaned.push(character)
            }
            _ => {}
        }
    }
    let mut normalized = cleaned.replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(normalized)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn js_number_matches_number_coercion() {
        assert_eq!(parse_js_number(""), Some(0.0));
        assert_eq!(parse_js_number(" 42 "), Some(42.0));
        assert_eq!(parse_js_number("0x10"), Some(16.0));
        assert_eq!(parse_js_number("1e3"), Some(1000.0));
        assert!(parse_js_number("abc").is_none());
        assert_eq!(js_number(Some(&json!(null))), Some(0.0));
        assert_eq!(js_number(Some(&json!(true))), Some(1.0));
        assert_eq!(js_number(Some(&json!("10"))), Some(10.0));
    }

    #[test]
    fn js_string_coercion() {
        assert_eq!(js_string(Some(&json!(null))), "");
        assert_eq!(js_string(Some(&json!(0))), "");
        assert_eq!(js_string(Some(&json!(false))), "");
        assert_eq!(js_string(Some(&json!(12))), "12");
        assert_eq!(js_string(Some(&json!(["a", "b"]))), "a,b");
        assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
    }

    #[test]
    fn encode_uri_component_matches_js() {
        assert_eq!(encode_uri_component("a b/c"), "a%20b%2Fc");
        assert_eq!(encode_uri_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_uri_component("AZaz09-_.!~*'()"), "AZaz09-_.!~*'()");
    }
}
