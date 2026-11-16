// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Data-plane mutation audit trail (#32).
//!
//! Every non-GET /v1/* request produces one bounded audit event with the actor,
//! tenant, action, resource and result. Events are buffered in memory and
//! shipped to IAM's internal ingest endpoint in batches. An unavailable audit
//! sink must never fail a data write.
//!
//! Privacy: request bodies, query strings, Authorization headers and values of
//! secret-looking path parameters are never recorded.

use std::sync::{Mutex, OnceLock};

use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::{json, Map, Value};

const MAX_BUFFER: usize = 1000;
const MAX_BATCH: usize = 100;
const POST_TIMEOUT_MS: u64 = 3000;

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

fn env_compat(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    let rest = name.strip_prefix("SYNAPSEONE_")?;
    std::env::var(format!("SYNAPSEDX_{rest}"))
        .ok()
        .filter(|value| !value.is_empty())
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
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Gateway-stamped principal (the gateway strips spoofed client headers).
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
    while let Some(c) = chars.next() {
        if c == '{' {
            out.push(':');
            for next in chars.by_ref() {
                if next == '}' {
                    break;
                }
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

const MUTATION_VERBS: &[&str] = &[
    "batch",
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

/// Stable action name, e.g. `queue:queues.messages:create`.
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
    let mut statics: Vec<&str> = rest
        .iter()
        .copied()
        .filter(|segment| !segment.starts_with(':'))
        .collect();
    let mut verb = match method {
        "POST" => "create",
        "PUT" | "PATCH" => "update",
        _ => "delete",
    };
    if let Some(tail) = statics.last().copied() {
        if MUTATION_VERBS.contains(&tail) && (statics.len() > 1 || rest.len() > statics.len()) {
            verb = tail;
            statics.pop();
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
    if let Ok(url) = std::env::var("AUDIT_INGEST_URL") {
        if !url.is_empty() {
            return url;
        }
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
    if let Some(secret) = env_compat("SYNAPSEONE_INTERNAL_SECRET") {
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

/// Build the bounded `params` context for an audit event. Sensitive parameter
/// names are masked; values are truncated to 128 printable characters.
pub fn route_params(route: &str, path: &str) -> Value {
    let mut out = Map::new();
    let route_segments = route.split('/').collect::<Vec<_>>();
    let path_segments = path.split('/').collect::<Vec<_>>();
    for (index, segment) in route_segments.iter().enumerate() {
        let Some(name) = segment.strip_prefix(':') else {
            continue;
        };
        let Some(value) = path_segments.get(index) else {
            continue;
        };
        let value = clean(value, 128);
        if value.is_empty() {
            continue;
        }
        let masked = {
            let lower = name.to_lowercase();
            [
                "pass",
                "secret",
                "token",
                "key",
                "credential",
                "auth",
                "email",
                "phone",
                "session",
            ]
            .iter()
            .any(|needle| lower.contains(needle))
        };
        out.insert(
            clean(name, 32),
            Value::String(if masked { "***".into() } else { value }),
        );
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_matches_the_typescript_shape() {
        assert_eq!(
            mutation_action(
                "queue",
                "POST",
                "/v1/queue/queues/:queue/messages",
                "/v1/queue/queues/jobs/messages"
            ),
            "queue:queues.messages:create"
        );
        assert_eq!(
            mutation_action(
                "queue",
                "POST",
                "/v1/queue/queues/:queue/purge",
                "/v1/queue/queues/missing/purge"
            ),
            "queue:queues:purge"
        );
        assert_eq!(
            mutation_action(
                "queue",
                "POST",
                "/v1/queue/queues/:queue/dead/:id/replay",
                "/v1/queue/queues/jobs/dead/abc/replay"
            ),
            "queue:queues.dead:replay"
        );
        assert!(!is_read_only_post(
            "POST",
            "/v1/queue/queues/:queue/messages:batch"
        ));
    }

    #[test]
    fn express_route_normalizes_matchit_params() {
        assert_eq!(
            express_route("/v1/queue/queues/{queue}/dead/{id}"),
            "/v1/queue/queues/:queue/dead/:id"
        );
    }

    #[test]
    fn params_are_extracted_and_masked() {
        let params = route_params(
            "/v1/queue/queues/:queue/dead/:id",
            "/v1/queue/queues/jobs/dead/abc",
        );
        assert_eq!(params["queue"], "jobs");
        assert_eq!(params["id"], "abc");
    }
}
