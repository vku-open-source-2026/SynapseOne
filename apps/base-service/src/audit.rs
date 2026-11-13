// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Data-plane mutation audit trail (#32).
//!
//! Every non-GET `/v1/*` request produces one bounded audit event with actor,
//! tenant, action, resource and result. Events are buffered in memory and
//! shipped to IAM's internal ingest endpoint in batches; an unavailable audit
//! sink never fails a data write. Request bodies, query strings and
//! secret-looking path values are never recorded.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, Method};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::util::header;
use crate::Config;

const MAX_BUFFER: usize = 1000;
const MAX_BATCH: usize = 100;
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
    pub actor_type: &'static str,
    pub actor_id: String,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub action: String,
    pub resource: String,
    pub result: &'static str,
    pub status_code: u16,
    pub request_id: String,
    pub context: Value,
}

#[derive(Debug, Clone)]
pub struct Actor {
    pub actor_type: &'static str,
    pub actor_id: String,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Clone)]
pub struct Audit {
    enabled: bool,
    ingest_url: String,
    internal_secret: String,
    buffer: Arc<Mutex<Vec<AuditEvent>>>,
    flushing: Arc<Mutex<bool>>,
    warned_at: Arc<AtomicU64>,
    client: reqwest::Client,
}

impl Audit {
    pub fn from_config(config: &Config) -> Self {
        Self::new(
            config.audit_enabled,
            config.audit_ingest_url(),
            config.internal_secret.clone(),
        )
    }

    pub fn new(enabled: bool, ingest_url: String, internal_secret: String) -> Self {
        Self {
            enabled,
            ingest_url,
            internal_secret,
            buffer: Arc::new(Mutex::new(Vec::new())),
            flushing: Arc::new(Mutex::new(false)),
            warned_at: Arc::new(AtomicU64::new(0)),
            client: reqwest::Client::new(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub async fn events(&self) -> Vec<AuditEvent> {
        self.buffer.lock().await.clone()
    }

    pub async fn clear(&self) {
        self.buffer.lock().await.clear();
        *self.flushing.lock().await = false;
        self.warned_at.store(0, Ordering::Relaxed);
    }

    pub async fn record(&self, event: AuditEvent) {
        if !self.enabled {
            return;
        }
        let mut buffer = self.buffer.lock().await;
        buffer.push(event);
        if buffer.len() > MAX_BUFFER {
            let excess = buffer.len() - MAX_BUFFER;
            buffer.drain(0..excess);
        }
    }

    /// Flush at most one batch; failures are re-buffered (bounded).
    pub async fn flush_now(&self) {
        if !self.enabled {
            return;
        }
        {
            let mut flushing = self.flushing.lock().await;
            if *flushing {
                return;
            }
            *flushing = true;
        }
        let batch: Vec<AuditEvent> = {
            let mut buffer = self.buffer.lock().await;
            if buffer.is_empty() {
                *self.flushing.lock().await = false;
                return;
            }
            let take = buffer.len().min(MAX_BATCH);
            buffer.drain(0..take).collect()
        };
        let mut request = self
            .client
            .post(&self.ingest_url)
            .timeout(Duration::from_secs(3))
            .header("content-type", "application/json")
            .json(&json!({"events": batch}));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let result = request.send().await;
        let failed = match result {
            Ok(response) if response.status().is_success() => {
                let _ = response.text().await;
                false
            }
            Ok(response) => {
                let _ = response.text().await;
                true
            }
            Err(_) => true,
        };
        if failed {
            let mut buffer = self.buffer.lock().await;
            for event in batch.into_iter().rev() {
                buffer.insert(0, event);
            }
            if buffer.len() > MAX_BUFFER {
                let excess = buffer.len() - MAX_BUFFER;
                let start = buffer.len() - excess;
                buffer.drain(start..);
            }
            let previous = self.warned_at.load(Ordering::Relaxed);
            let current = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            if current.saturating_sub(previous) > 60 {
                self.warned_at.store(current, Ordering::Relaxed);
                tracing::warn!(
                    "[audit] ingest failed; keeping {} buffered event(s)",
                    buffer.len()
                );
            }
        }
        *self.flushing.lock().await = false;
    }
}

fn clean(value: &str, max: usize) -> String {
    let filtered: String = value
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    filtered.trim().chars().take(max).collect()
}

pub fn audit_actor(headers: &HeaderMap) -> Actor {
    let user = clean(&header(headers, "x-synapseone-user"), 128);
    let org = clean(&header(headers, "x-synapseone-org"), 128);
    let account = clean(&header(headers, "x-synapseone-account"), 128);
    let kind = clean(&header(headers, "x-synapseone-kind"), 32).to_lowercase();
    let org_id = if org.is_empty() { None } else { Some(org) };
    let account_id = if account.is_empty() {
        None
    } else {
        Some(account)
    };
    if !user.is_empty() {
        return Actor {
            actor_type: if kind == "apikey" || kind == "service-account" {
                "service"
            } else {
                "user"
            },
            actor_id: user,
            org_id,
            account_id,
        };
    }
    if let Some(account) = &account_id {
        return Actor {
            actor_type: "apikey",
            actor_id: format!("apikey:{account}"),
            org_id,
            account_id,
        };
    }
    Actor {
        actor_type: "anonymous",
        actor_id: String::new(),
        org_id,
        account_id,
    }
}

fn sensitive_name() -> &'static Regex {
    use std::sync::OnceLock;
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    SENSITIVE.get_or_init(|| {
        Regex::new(r"(?i)(pass|secret|token|key|credential|auth|email|phone|session)")
            .expect("sensitive regex")
    })
}

/// Stable action name, e.g. `base:collections.documents:create`.
pub fn mutation_action(service: &str, route_path: &str, method: &Method) -> String {
    let normalized = route_path.replace('{', ":").replace('}', "");
    let all: Vec<&str> = normalized
        .trim_start_matches('/')
        .strip_prefix("v1/")
        .unwrap_or(normalized.trim_start_matches('/'))
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mount = all.first().copied().unwrap_or(service);
    let plural = format!("{service}s");
    let suffixed = format!("{service}-service");
    let is_mount = mount == service || mount == plural.as_str() || mount == suffixed.as_str();
    let rest: Vec<&str> = if is_mount {
        all.iter().skip(1).copied().collect()
    } else {
        all.clone()
    };
    let mut statics: Vec<&str> = rest
        .iter()
        .copied()
        .filter(|segment| !segment.starts_with(':'))
        .collect();
    let mut verb = match method {
        &Method::POST => "create",
        &Method::PUT | &Method::PATCH => "update",
        _ => "delete",
    };
    let tail = statics.last().copied();
    if let Some(tail) = tail {
        if MUTATION_VERBS.contains(&tail) && (statics.len() > 1 || rest.len() > statics.len()) {
            verb = tail;
            statics.pop();
        }
    }
    let resource = if statics.is_empty() {
        if mount.is_empty() {
            "root".to_string()
        } else {
            mount.to_string()
        }
    } else {
        statics
            .iter()
            .take(3)
            .copied()
            .collect::<Vec<_>>()
            .join(".")
    };
    format!("{service}:{resource}:{verb}")
}

pub fn is_read_only_post(route_path: &str) -> bool {
    let tail = route_path
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .unwrap_or("");
    READ_TAILS.contains(&tail)
}

pub fn route_params(route_path: &str, actual_path: &str) -> Value {
    let mut params = Map::new();
    let pattern: Vec<&str> = route_path.split('/').collect();
    let actual: Vec<&str> = actual_path.split('/').collect();
    for (pattern_segment, actual_segment) in pattern.iter().zip(actual.iter()) {
        let name = if let Some(name) = pattern_segment.strip_prefix(':') {
            name
        } else if pattern_segment.starts_with('{') && pattern_segment.ends_with('}') {
            &pattern_segment[1..pattern_segment.len() - 1]
        } else {
            continue;
        };
        if actual_segment.is_empty() {
            continue;
        }
        let value = percent_decode_str(actual_segment)
            .decode_utf8_lossy()
            .to_string();
        let cleaned_name = clean(name, 32);
        let cleaned_value = if sensitive_name().is_match(name) {
            "***".to_string()
        } else {
            clean(&value, 128)
        };
        params.insert(cleaned_name, Value::String(cleaned_value));
    }
    Value::Object(params)
}

#[allow(clippy::too_many_arguments)]
pub fn build_event(
    service: &str,
    headers: &HeaderMap,
    method: &Method,
    route_path: &str,
    actual_path: &str,
    request_id: &str,
    status_code: u16,
) -> AuditEvent {
    let actor = audit_actor(headers);
    let normalized_route = route_path.replace('{', ":").replace('}', "");
    let result = if status_code < 400 {
        "allowed"
    } else if status_code < 500 {
        "denied"
    } else {
        "error"
    };
    AuditEvent {
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        org_id: actor.org_id,
        account_id: actor.account_id,
        action: mutation_action(service, &normalized_route, method),
        resource: clean(&format!("{service}:{normalized_route}"), 512),
        result,
        status_code,
        request_id: clean(request_id, 128),
        context: json!({
            "service": service,
            "method": method.as_str(),
            "route": clean(&normalized_route, 256),
            "params": route_params(route_path, actual_path),
            "result": result,
        }),
    }
}
