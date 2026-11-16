// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Data-plane mutation audit trail.
//!
//! Every non-GET `/v1/*` request produces one bounded audit event with the
//! actor, tenant, action, resource and result. Events are buffered in memory
//! (bounded) and logged through `tracing`; request bodies, query strings and
//! secret-looking path values are never recorded.

use std::sync::{Mutex, OnceLock};

use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::Value;

const MAX_BUFFER: usize = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub actor_type: String,
    pub actor_id: String,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub action: String,
    pub resource: String,
    pub result: String,
    pub status_code: u16,
    pub request_id: String,
    pub context: Value,
}

fn buffer() -> &'static Mutex<Vec<AuditEvent>> {
    static BUFFER: OnceLock<Mutex<Vec<AuditEvent>>> = OnceLock::new();
    BUFFER.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn audit_enabled() -> bool {
    std::env::var("AUDIT_TRAIL").as_deref() != Ok("false")
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

fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn audit_actor(headers: &HeaderMap) -> (String, String, Option<String>, Option<String>) {
    let user = clean(&header(headers, "x-synapseone-user"), 128);
    let org = clean(&header(headers, "x-synapseone-org"), 128);
    let account = clean(&header(headers, "x-synapseone-account"), 128);
    let kind = clean(&header(headers, "x-synapseone-kind"), 32).to_lowercase();
    let org = (!org.is_empty()).then_some(org);
    let account = (!account.is_empty()).then_some(account);
    if !user.is_empty() {
        let actor_type = if kind == "apikey" || kind == "service-account" {
            "service"
        } else {
            "user"
        };
        return (actor_type.into(), user, org, account);
    }
    if let Some(account) = account.clone() {
        return (
            "apikey".into(),
            format!("apikey:{account}"),
            org,
            Some(account),
        );
    }
    ("anonymous".into(), String::new(), org, account)
}

pub fn express_route(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut chars = path.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '{' {
            out.push(':');
            for next in chars.by_ref() {
                if next == '}' {
                    break;
                }
                out.push(next);
            }
        } else {
            out.push(character);
        }
    }
    out
}

pub fn mutation_action(service: &str, method: &str, route_path: &str, path: &str) -> String {
    let route = if route_path.is_empty() {
        path
    } else {
        route_path
    };
    let all: Vec<&str> = route
        .trim_start_matches("/v1/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mount = all.first().copied().unwrap_or(service);
    let is_mount =
        mount == service || mount == format!("{service}s") || mount == format!("{service}-service");
    let rest: Vec<&str> = if is_mount {
        all[1..].to_vec()
    } else {
        all.clone()
    };
    let statics: Vec<&str> = rest
        .iter()
        .copied()
        .filter(|segment| !segment.starts_with(':'))
        .collect();
    let verb = match method {
        "POST" => "create",
        "PUT" | "PATCH" => "update",
        _ => "delete",
    };
    let resource = if statics.is_empty() {
        mount.to_string()
    } else {
        statics
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(".")
    };
    format!("{service}:{resource}:{verb}")
}

pub fn record(event: AuditEvent) {
    tracing::info!(
        target: "audit",
        actor_type = %event.actor_type,
        actor_id = %event.actor_id,
        action = %event.action,
        resource = %event.resource,
        result = %event.result,
        status = event.status_code,
        "audit"
    );
    if let Ok(mut buffer) = buffer().lock() {
        if buffer.len() >= MAX_BUFFER {
            buffer.remove(0);
        }
        buffer.push(event);
    }
}

pub fn events() -> Vec<AuditEvent> {
    buffer()
        .lock()
        .map(|buffer| buffer.clone())
        .unwrap_or_default()
}

pub fn clear() {
    if let Ok(mut buffer) = buffer().lock() {
        buffer.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn actor_is_derived_from_stamped_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-synapseone-user", HeaderValue::from_static("user-7"));
        headers.insert("x-synapseone-org", HeaderValue::from_static("org-a"));
        headers.insert("x-synapseone-account", HeaderValue::from_static("acct-1"));
        headers.insert("x-synapseone-kind", HeaderValue::from_static("user"));
        let (actor_type, actor_id, org, account) = audit_actor(&headers);
        assert_eq!(actor_type, "user");
        assert_eq!(actor_id, "user-7");
        assert_eq!(org.as_deref(), Some("org-a"));
        assert_eq!(account.as_deref(), Some("acct-1"));

        let mut api_key = HeaderMap::new();
        api_key.insert("x-synapseone-account", HeaderValue::from_static("acct-1"));
        let (actor_type, actor_id, _, _) = audit_actor(&api_key);
        assert_eq!(actor_type, "apikey");
        assert_eq!(actor_id, "apikey:acct-1");
    }

    #[test]
    fn route_patterns_and_actions_are_stable() {
        assert_eq!(
            express_route("/v1/storage/objects/{*key}"),
            "/v1/storage/objects/:*key"
        );
        assert_eq!(
            mutation_action(
                "storage",
                "PUT",
                "/v1/storage/objects/:*key",
                "/v1/storage/objects/a/b"
            ),
            "storage:objects:update"
        );
        assert_eq!(
            mutation_action(
                "storage",
                "DELETE",
                "/v1/ocs/buckets/:bucket",
                "/v1/ocs/buckets/docs"
            ),
            "storage:ocs.buckets:delete"
        );
    }
}
