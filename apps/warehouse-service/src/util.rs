// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small helpers shared by the HTTP layer, the store and the rollup writer.
//! They intentionally mirror the JavaScript coercions used by the TypeScript
//! service so request bodies keep the same meaning.

use axum::http::HeaderMap;
use chrono::{DateTime, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde_json::Value;

/// Read a header, honouring the `SYNAPSEDX_*`/`x-synapsedx-*` rebrand window.
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

/// JavaScript `String(value ?? '')` for the value shapes accepted by the API.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// JavaScript truthiness.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `Number(value)`; `None` means NaN.
pub fn number_value(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => Some(0.0),
        Some(Value::Bool(flag)) => Some(if *flag { 1.0 } else { 0.0 }),
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => {
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok().filter(|value| value.is_finite())
            }
        }
        Some(Value::Array(items)) => match items.as_slice() {
            [] => Some(0.0),
            [item] => number_value(Some(item)),
            _ => None,
        },
        Some(Value::Object(_)) => None,
    }
}

/// Remove control characters and cap a string, like the rollup normaliser.
pub fn clean_text(value: Option<&Value>, max: usize) -> String {
    js_string(value)
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max)
        .collect()
}

pub fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Parse the ISO timestamps accepted by `new Date(string)` in the TS service.
pub fn parse_date(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| Utc.from_utc_datetime(&naive));
    }
    None
}
