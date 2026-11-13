// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small helpers shared by the Rust port: JavaScript-compatible coercions,
//! header handling, timestamps and cursor encoding.

use axum::http::HeaderMap;
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use serde_json::{Number, Value};
use uuid::Uuid;

/// Legacy `x-synapsedx-*` fallback for the rebrand window.
pub fn header(headers: &HeaderMap, name: &str) -> String {
    let legacy = if let Some(rest) = name.strip_prefix("x-synapseone-") {
        format!("x-synapsedx-{rest}")
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

/// Headers that identify a cache tenant scope (never credentials).
pub const TENANT_HEADERS: [(&str, &str); 5] = [
    ("x-synapseone-org", "x-synapsedx-org"),
    ("x-synapseone-account", "x-synapsedx-account"),
    ("x-synapseone-user", "x-synapsedx-user"),
    ("x-synapseone-kind", "x-synapsedx-kind"),
    ("x-synapseone-tenant", "x-synapsedx-tenant"),
];

pub fn valid_header_value(value: &str) -> bool {
    value.len() <= 128 && !value.chars().any(|c| c.is_control())
}

/// Forward only tenant scope headers; returns None when the caller has none.
pub fn tenant_headers(headers: &HeaderMap) -> Option<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (primary, legacy) in TENANT_HEADERS {
        let raw = headers
            .get(primary)
            .or_else(|| headers.get(legacy))
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !raw.is_empty() && valid_header_value(raw) {
            out.push((primary.to_string(), raw.to_string()));
        }
    }
    let scoped = out.iter().any(|(name, _)| {
        matches!(
            name.as_str(),
            "x-synapseone-org"
                | "x-synapseone-account"
                | "x-synapseone-user"
                | "x-synapseone-tenant"
        )
    });
    scoped.then_some(out)
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn iso(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.parse` subset used by the service (ISO-8601 plus date-only input).
pub fn parse_js_date(raw: &str) -> Option<DateTime<Utc>> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc2822(text) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y/%m/%d") {
        let midnight = date.and_hms_opt(0, 0, 0)?;
        return Some(Utc.from_utc_datetime(&midnight));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f%z",
        "%Y-%m-%d %H:%M:%S%.f%z",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(dt) = NaiveDateTime::parse_from_str(text, format) {
            return Some(Utc.from_utc_datetime(&dt));
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let midnight = date.and_hms_opt(0, 0, 0)?;
        return Some(Utc.from_utc_datetime(&midnight));
    }
    None
}

/// JavaScript ToNumber for JSON values; None means NaN.
pub fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => js_number_string(text),
        Value::Array(items) => match items.len() {
            0 => Some(0.0),
            1 => js_number(&items[0]),
            _ => None,
        },
        Value::Object(_) => None,
    }
}

pub fn js_number_string(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok()
}

/// JavaScript String(value) for the cases the service serialises.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => js_number_to_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

pub fn js_number_to_string(number: &Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    if !value.is_finite() {
        return "null".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        return format!("{}", value as i64);
    }
    let mut text = format!("{value}");
    if !text.contains('.') && !text.contains('e') && !text.contains('E') {
        text.push_str(".0");
    }
    text
}

/// JS JSON.parse turns integral floats into integers and normalises -0.
pub fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            if number.is_f64() {
                if let Some(raw) = number.as_f64() {
                    if raw == 0.0 {
                        *value = Value::Number(Number::from(0));
                    } else if raw.is_finite()
                        && raw.fract() == 0.0
                        && raw >= i64::MIN as f64
                        && raw <= i64::MAX as f64
                    {
                        *value = Value::Number(Number::from(raw as i64));
                    }
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_numbers(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                normalize_numbers(item);
            }
        }
        _ => {}
    }
}

/// `a === b` / JSON.stringify comparison used by the in-memory query engine.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => {
            x.as_f64().unwrap_or(f64::NAN) == y.as_f64().unwrap_or(f64::NAN)
        }
        (Value::Array(_), Value::Array(_)) | (Value::Object(_), Value::Object(_)) => {
            serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
        }
        _ => false,
    }
}

/// JS `<`/`>` comparison; None means the values are not comparable.
pub fn compare_values(a: &Value, b: &Value) -> Option<i32> {
    if json_equal(a, b) {
        return Some(0);
    }
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let x = x.as_f64()?;
            let y = y.as_f64()?;
            Some(if x < y {
                -1
            } else if x > y {
                1
            } else {
                0
            })
        }
        (Value::String(x), Value::String(y)) => Some(match x.cmp(y) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        }),
        (Value::Bool(x), Value::Bool(y)) => Some(match (x, y) {
            (false, false) | (true, true) => 0,
            (false, true) => -1,
            (true, false) => 1,
        }),
        _ => None,
    }
}

pub fn random_id() -> String {
    Uuid::new_v4().to_string()
}

/// Express request-id style: base36 millis + random suffix.
pub fn request_id() -> String {
    let millis = Utc::now().timestamp_millis().max(0) as u64;
    let mut value = millis;
    let mut encoded = Vec::new();
    loop {
        let digit = (value % 36) as u8;
        encoded.push(match digit {
            0..=9 => b'0' + digit,
            _ => b'a' + (digit - 10),
        });
        value /= 36;
        if value == 0 {
            break;
        }
    }
    encoded.reverse();
    let mut suffix = random_id().replace('-', "");
    suffix.truncate(8);
    format!("{}-{}", String::from_utf8_lossy(&encoded), suffix)
}

pub fn sanitize_request_id(incoming: &str) -> String {
    incoming
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
        .take(128)
        .collect()
}

pub fn parse_cursor_json(raw: &str) -> Option<Value> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(raw))
        .ok()?;
    let text = String::from_utf8(decoded).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn encode_base64url_json(value: &Value) -> String {
    use base64::Engine;
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes())
}

pub fn env_first(primary: &str, legacy: &str) -> Option<String> {
    match std::env::var(primary) {
        Ok(value) if !value.is_empty() => Some(value),
        _ => std::env::var(legacy).ok().filter(|value| !value.is_empty()),
    }
}

pub fn env_string(name: &str, fallback: &str) -> String {
    let legacy = if let Some(rest) = name.strip_prefix("SYNAPSEONE_") {
        format!("SYNAPSEDX_{rest}")
    } else {
        name.to_string()
    };
    env_first(name, &legacy).unwrap_or_else(|| fallback.to_string())
}

pub fn env_u64(name: &str, fallback: u64) -> u64 {
    env_string(name, "").parse::<u64>().unwrap_or(fallback)
}

pub fn env_f64(name: &str, fallback: f64) -> f64 {
    env_string(name, "").parse::<f64>().unwrap_or(fallback)
}
