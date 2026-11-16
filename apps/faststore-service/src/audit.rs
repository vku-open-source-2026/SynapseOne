// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Data-plane mutation audit trail (#32).
//!
//! Every non-GET `/v1/*` request produces one bounded audit event with the
//! actor, tenant, action, resource and result. Events are buffered in memory and
//! shipped to IAM's internal ingest endpoint in batches, using the same
//! best-effort model as gateway usage telemetry: an unavailable audit sink must
//! never fail a data write.
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

pub const MUTATING_METHODS: &[&str] = &["POST", "PUT", "PATCH", "DELETE"];
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
    let filtered: String = value
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    filtered.trim().chars().take(max).collect()
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

/// Stable action name, e.g. `base:collections.documents:create`.
pub fn mutation_action(service: &str, method: &str, route_path: &str, path: &str) -> String {
    let route = if route_path.is_empty() {
        path
    } else {
        route_path
    };
    let stripped = route.strip_prefix("/v1/").unwrap_or(route);
    let all: Vec<&str> = stripped
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

fn is_sensitive_param(name: &str) -> bool {
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
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Express `req.params`, with secret-looking names masked and values bounded.
pub fn sanitized_params(route_path: &str, path: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let route_segments: Vec<&str> = route_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let path_segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if route_segments.len() != path_segments.len() {
        return out;
    }
    for (route, actual) in route_segments.iter().zip(path_segments.iter()) {
        let Some(name) = route.strip_prefix(':') else {
            continue;
        };
        if actual.is_empty() {
            continue;
        }
        let value = if is_sensitive_param(name) {
            "***".to_string()
        } else {
            clean(&percent_decode(actual), 128)
        };
        out.insert(clean(name, 32), Value::String(value));
    }
    out
}

pub fn record(event: AuditEvent) {
    if !audit_enabled() {
        return;
    }
    let Ok(mut events) = buffer().lock() else {
        return;
    };
    events.push(event);
    if events.len() > MAX_BUFFER {
        let drop = events.len() - MAX_BUFFER;
        events.drain(0..drop);
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
        let Ok(mut events) = buffer().lock() else {
            return;
        };
        if events.is_empty() {
            return;
        }
        let take = events.len().min(MAX_BATCH);
        events.drain(0..take).collect::<Vec<_>>()
    };
    let client = reqwest::Client::new();
    let mut request = client
        .post(ingest_url())
        .timeout(std::time::Duration::from_millis(POST_TIMEOUT_MS))
        .json(&json!({ "events": batch }));
    if let Ok(secret) = std::env::var("SYNAPSEONE_INTERNAL_SECRET") {
        if !secret.is_empty() {
            request = request.header("x-synapseone-internal", secret);
        }
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
        if let Ok(mut events) = buffer().lock() {
            for event in batch.into_iter().rev() {
                events.insert(0, event);
            }
            if events.len() > MAX_BUFFER {
                let drop = events.len() - MAX_BUFFER;
                events.drain(0..drop);
            }
        }
    }
}

#[cfg(test)]
pub fn events() -> Vec<AuditEvent> {
    buffer()
        .lock()
        .map(|events| events.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_matches_the_typescript_shape() {
        assert_eq!(
            mutation_action(
                "faststore",
                "PUT",
                "/v1/faststore/keys/:key",
                "/v1/faststore/keys/audit:key"
            ),
            "faststore:keys:update"
        );
        assert_eq!(
            mutation_action(
                "faststore",
                "POST",
                "/v1/faststore/locks/:name/acquire",
                "/v1/faststore/locks/job/acquire"
            ),
            "faststore:locks:acquire"
        );
        assert_eq!(
            mutation_action(
                "faststore",
                "POST",
                "/v1/faststore/batch",
                "/v1/faststore/batch"
            ),
            "faststore:batch:create"
        );
    }

    #[test]
    fn sensitive_params_are_masked() {
        let params = sanitized_params("/v1/faststore/keys/:key", "/v1/faststore/keys/session%3A1");
        assert_eq!(params.get("key"), Some(&Value::String("***".into())));
        let field = sanitized_params(
            "/v1/faststore/hashes/:key/:field",
            "/v1/faststore/hashes/users:1/name",
        );
        assert_eq!(field.get("field"), Some(&Value::String("name".into())));
        assert_eq!(field.get("key"), Some(&Value::String("***".into())));
    }

    #[test]
    fn express_route_normalizes_matchit_params() {
        assert_eq!(
            express_route("/v1/faststore/hashes/{key}/{field}"),
            "/v1/faststore/hashes/:key/:field"
        );
    }

    #[test]
    fn read_only_posts_are_detected() {
        assert!(is_read_only_post(
            "POST",
            "/v1/faststore/sets/:key/contains"
        ));
        assert!(is_read_only_post("POST", "/v1/faststore/zsets/:key/score"));
        assert!(is_read_only_post("POST", "/v1/faststore/zsets/:key/rank"));
        assert!(!is_read_only_post("POST", "/v1/faststore/keys/:key/incr"));
        assert!(!is_read_only_post("PUT", "/v1/faststore/keys/:key"));
    }
}
