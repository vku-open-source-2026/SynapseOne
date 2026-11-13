// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Data-plane mutation audit trail.
//!
//! Every non-GET `/v1/*` mutation produces one bounded audit event with the
//! actor, tenant, action, resource and result. Events are buffered in memory
//! and shipped to IAM's internal ingest endpoint in batches. An unavailable
//! audit sink never fails a data write.

use std::sync::{Mutex, OnceLock};

use axum::extract::{MatchedPath, Request};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;
use serde_json::{json, Value};

const MAX_BUFFER: usize = 1000;
const MAX_BATCH: usize = 100;
const POST_TIMEOUT_MS: u64 = 3000;

#[derive(Debug, Clone)]
pub struct RequestId(pub String);

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
        .filter(|ch| !ch.is_control())
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

/// Normalize an axum/matchit route pattern to the Express `:param` shape.
pub fn express_route(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut chars = path.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '{' {
            out.push(':');
            for next in chars.by_ref() {
                if next == '}' {
                    break;
                }
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

const MUTATION_VERBS: &[&str] = &[
    "batch",
    "run",
    "pause",
    "resume",
    "purge",
    "ack",
    "nack",
    "heartbeat",
    "replay",
    "expire",
    "incr",
    "push",
    "pop",
    "trim",
    "add",
    "remove",
    "acquire",
    "release",
    "extend",
    "execute",
    "activate",
    "deactivate",
    "rotate",
    "start",
    "callback",
    "login",
    "logout",
    "refresh",
    "verify",
    "reset",
    "change",
    "ingest",
    "publish",
];

const READ_TAILS: &[&str] = &[
    "query",
    "vector-search",
    "contains",
    "score",
    "rank",
    "read",
    "search",
];

/// Stable action name, e.g. `warehouse:datasets:create`.
pub fn mutation_action(service: &str, method: &str, route_path: &str, path: &str) -> String {
    let route = if route_path.is_empty() {
        path
    } else {
        route_path
    };
    let all = route
        .trim_start_matches("/v1/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mount = all.first().copied().unwrap_or(service);
    let is_mount =
        mount == service || mount == format!("{service}s") || mount == format!("{service}-service");
    let rest = if is_mount {
        all[1..].to_vec()
    } else {
        all.clone()
    };
    let mut statics = rest
        .iter()
        .copied()
        .filter(|segment| !segment.starts_with(':'))
        .collect::<Vec<_>>();
    let mut verb = match method {
        "POST" => "create",
        "PUT" | "PATCH" => "update",
        _ => "delete",
    };
    if statics
        .last()
        .is_some_and(|tail| MUTATION_VERBS.contains(tail))
        && (statics.len() > 1 || rest.len() > statics.len())
    {
        if let Some(tail) = statics.pop() {
            verb = tail;
        }
    }
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

pub fn is_read_only_post(method: &str, route_path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    route_path
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .map(|tail| READ_TAILS.contains(&tail))
        .unwrap_or(false)
}

pub fn record(event: AuditEvent) {
    if !audit_enabled() {
        return;
    }
    let mut buffer = buffer().lock().expect("audit buffer");
    buffer.push(event);
    if buffer.len() > MAX_BUFFER {
        let drop = buffer.len() - MAX_BUFFER;
        buffer.drain(0..drop);
    }
}

fn ingest_url() -> String {
    if let Some(url) = std::env::var("AUDIT_INGEST_URL")
        .ok()
        .filter(|url| !url.is_empty())
    {
        return url;
    }
    let base = std::env::var("IAM_SERVICE_URL")
        .unwrap_or_else(|_| "http://iam:4001".into())
        .trim_end_matches('/')
        .to_string();
    format!("{base}/v1/audit/ingest")
}

/// Flush at most one batch; failures are re-buffered (bounded).
pub async fn flush_now() {
    if !audit_enabled() {
        return;
    }
    let batch = {
        let mut buffer = buffer().lock().expect("audit buffer");
        if buffer.is_empty() {
            return;
        }
        let take = buffer.len().min(MAX_BATCH);
        buffer.drain(0..take).collect::<Vec<_>>()
    };
    let client = reqwest::Client::new();
    let mut request = client
        .post(ingest_url())
        .timeout(std::time::Duration::from_millis(POST_TIMEOUT_MS))
        .json(&json!({ "events": batch }));
    if let Some(secret) = std::env::var("SYNAPSEONE_INTERNAL_SECRET")
        .ok()
        .filter(|secret| !secret.is_empty())
    {
        request = request.header("x-synapseone-internal", secret);
    }
    let failure = match request.send().await {
        Ok(response) if response.status().is_success() => None,
        Ok(response) => Some(format!("IAM audit ingest HTTP {}", response.status())),
        Err(error) => Some(error.to_string()),
    };
    if let Some(error) = failure {
        tracing::warn!(
            "[audit] ingest failed ({error}); keeping {} event(s)",
            batch.len()
        );
        let mut buffer = buffer().lock().expect("audit buffer");
        for event in batch.into_iter().rev() {
            buffer.insert(0, event);
        }
        if buffer.len() > MAX_BUFFER {
            let drop = buffer.len() - MAX_BUFFER;
            buffer.drain(0..drop);
        }
    }
}

#[cfg(test)]
pub fn events() -> Vec<AuditEvent> {
    buffer().lock().expect("audit buffer").clone()
}

#[cfg(test)]
pub fn clear() {
    buffer().lock().expect("audit buffer").clear();
}

pub async fn middleware(request: Request, next: Next) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| express_route(matched.as_str()))
        .unwrap_or_else(|| path.clone());
    let mutating = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE")
        && path.starts_with("/v1")
        && !is_read_only_post(&method, &route);
    if !mutating || !audit_enabled() {
        return next.run(request).await;
    }
    let headers = request.headers().clone();
    let request_id = request
        .extensions()
        .get::<RequestId>()
        .map(|id| id.0.clone())
        .unwrap_or_default();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let result = if status < 400 {
        "allowed"
    } else if status < 500 {
        "denied"
    } else {
        "error"
    };
    let (actor_type, actor_id, org_id, account_id) = audit_actor(&headers);
    let action = mutation_action("warehouse", &method, &route, &path);
    record(AuditEvent {
        actor_type,
        actor_id,
        org_id,
        account_id,
        action,
        resource: format!("warehouse:{route}"),
        result: result.into(),
        status_code: status,
        request_id,
        context: json!({
            "service": "warehouse",
            "method": method,
            "route": route,
            "params": {},
            "result": result,
        }),
    });
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_matches_the_typescript_shape() {
        assert_eq!(
            mutation_action(
                "warehouse",
                "POST",
                "/v1/warehouse/datasets/:id/rows",
                "/v1/warehouse/datasets/city_incidents/rows"
            ),
            "warehouse:datasets.rows:create"
        );
        assert_eq!(
            mutation_action(
                "warehouse",
                "POST",
                "/v1/warehouse/jobs/:id/run",
                "/v1/warehouse/jobs/job-1/run"
            ),
            "warehouse:jobs:run"
        );
        assert!(is_read_only_post("POST", "/v1/warehouse/query"));
    }

    #[test]
    fn express_route_normalizes_matchit_params() {
        assert_eq!(
            express_route("/v1/warehouse/datasets/{id}/rows"),
            "/v1/warehouse/datasets/:id/rows"
        );
    }
}
