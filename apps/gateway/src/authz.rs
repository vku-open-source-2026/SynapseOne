// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Central authorization point (AWS-style). After authentication every request
//! on a route that declares a `service` maps to `<service>:<Verb>` and an ARN,
//! then IAM decides for the verified principal.
//!
//!   AUTHZ_MODE=off      no policy check (tenant isolation only, legacy)
//!   AUTHZ_MODE=audit    decide + log/audit, never block (safe rollout)
//!   AUTHZ_MODE=enforce  deny → 403 access_denied; IAM down → 503

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::Principal;
use crate::metrics::Metrics;
use crate::routes::RouteRule;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthzMode {
    Off,
    Audit,
    Enforce,
}

impl AuthzMode {
    pub fn from_env() -> Self {
        let raw = std::env::var("AUTHZ_MODE")
            .unwrap_or_else(|_| "off".into())
            .trim()
            .to_ascii_lowercase();
        match raw.as_str() {
            "audit" => AuthzMode::Audit,
            "enforce" => AuthzMode::Enforce,
            _ => AuthzMode::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AuthzMode::Off => "off",
            AuthzMode::Audit => "audit",
            AuthzMode::Enforce => "enforce",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ActionOverride {
    pub method: Option<String>,
    pub path: String,
    pub action: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthzDecision {
    pub allowed: bool,
    pub reason: String,
}

/// Default verb from the HTTP method; routes override RPC-style POSTs.
pub fn verb_for_method(method: &str) -> &'static str {
    match method.to_ascii_uppercase().as_str() {
        "GET" | "HEAD" => "Read",
        "DELETE" => "Delete",
        _ => "Write",
    }
}

/// Same shape rules as route paths: `*` is one segment, trailing `/*` is the
/// rest (including none). Implemented without regex so a malformed operator
/// override cannot panic on the hot path.
pub fn match_override_path(pattern: &str, pathname: &str) -> bool {
    let pattern_segments = pattern.split('/').collect::<Vec<_>>();
    let path_segments = pathname.split('/').collect::<Vec<_>>();
    if pattern_segments.first().copied() != Some("") || path_segments.first().copied() != Some("") {
        return false;
    }
    let mut path_index = 1usize;
    for (index, segment) in pattern_segments.iter().enumerate() {
        if index == 0 {
            continue;
        }
        if *segment == "*" && index == pattern_segments.len() - 1 {
            return true;
        }
        let Some(candidate) = path_segments.get(path_index) else {
            return false;
        };
        if *segment == "*" {
            if candidate.is_empty() {
                return false;
            }
        } else if segment != candidate {
            return false;
        }
        path_index += 1;
    }
    path_index == path_segments.len()
}

pub fn action_for(route: &RouteRule, method: &str, pathname: &str) -> Option<String> {
    let service = route.service.as_ref()?;
    for action in &route.actions {
        if let Some(allowed_method) = &action.method {
            if !allowed_method.eq_ignore_ascii_case(method) {
                continue;
            }
        }
        if match_override_path(&action.path, pathname) {
            return Some(action.action.clone());
        }
    }
    Some(format!("{service}:{}", verb_for_method(method)))
}

fn clean_part(value: Option<&String>) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").expect("arn part regex"));
    match value {
        Some(value) if re.is_match(value) => value.clone(),
        _ => "-".into(),
    }
}

/// `arn:synapseone:<org>:<account>:<service>:<resource-path>` ('-' = none).
pub fn resource_for(
    service: Option<&str>,
    principal: Option<&Principal>,
    pathname: &str,
) -> String {
    let service = service.unwrap_or("unknown");
    let mut rest = pathname.strip_prefix("/v1/").unwrap_or(pathname);
    rest = rest.trim_start_matches('/');
    if rest == service {
        rest = "";
    } else if let Some(tail) = rest.strip_prefix(&format!("{service}/")) {
        rest = tail;
    }
    let rest = rest.chars().take(1500).collect::<String>();
    format!(
        "arn:synapseone:{}:{}:{service}:{rest}",
        clean_part(principal.and_then(|principal| principal.org.as_ref())),
        clean_part(principal.and_then(|principal| principal.account.as_ref())),
    )
}

/// Body sent to IAM `/internal/authorize`; `None` when the principal has no
/// verifiable identity (dev presence-only API keys).
pub fn iam_principal(principal: &Principal) -> Option<Value> {
    if principal.r#type == "apikey" {
        let key_id = principal.key_id.as_ref()?;
        let mut body = serde_json::Map::new();
        body.insert("kind".into(), json!("apikey"));
        body.insert("keyId".into(), json!(key_id));
        if let Some(account) = &principal.account {
            body.insert("account".into(), json!(account));
        }
        return Some(Value::Object(body));
    }
    let sub = principal.sub.as_ref()?;
    let mut body = serde_json::Map::new();
    body.insert(
        "kind".into(),
        json!(if principal.kind.as_deref() == Some("service-account") {
            "service-account"
        } else {
            "user"
        }),
    );
    body.insert("sub".into(), json!(sub));
    if let Some(org) = &principal.org {
        body.insert("org".into(), json!(org));
    }
    if let Some(account) = &principal.account {
        body.insert("account".into(), json!(account));
    }
    if !principal.scopes.is_empty() {
        body.insert("scopes".into(), json!(principal.scopes));
    }
    Some(Value::Object(body))
}

fn principal_key(principal: &Principal) -> String {
    if principal.r#type == "apikey" {
        return format!("k:{}", principal.key_id.clone().unwrap_or_default());
    }
    format!(
        "{}:{}:{}",
        principal.kind.clone().unwrap_or_else(|| "user".into()),
        principal.sub.clone().unwrap_or_default(),
        principal.scopes.join(",")
    )
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Injectable decision source; production talks to IAM, tests inject a stub.
pub trait AuthzDecider: Send + Sync {
    fn decide<'a>(
        &'a self,
        principal: Value,
        action: String,
        resource: String,
    ) -> BoxFuture<'a, Result<AuthzDecision, String>>;
}

pub struct IamDecider {
    client: reqwest::Client,
    iam_base: String,
    internal_secret: String,
}

impl IamDecider {
    pub fn new(
        client: reqwest::Client,
        iam_base: impl Into<String>,
        internal_secret: impl Into<String>,
    ) -> Self {
        Self {
            client,
            iam_base: iam_base.into().trim_end_matches('/').to_string(),
            internal_secret: internal_secret.into(),
        }
    }
}

impl AuthzDecider for IamDecider {
    fn decide<'a>(
        &'a self,
        principal: Value,
        action: String,
        resource: String,
    ) -> BoxFuture<'a, Result<AuthzDecision, String>> {
        Box::pin(async move {
            let mut request = self
                .client
                .post(format!("{}/internal/authorize", self.iam_base))
                .timeout(Duration::from_secs(3))
                .json(&json!({
                    "principal": principal,
                    "action": action,
                    "resource": resource,
                }));
            if !self.internal_secret.is_empty() {
                request = request.header("x-synapseone-internal", &self.internal_secret);
            }
            let response = request.send().await.map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("iam_status_{}", response.status().as_u16()));
            }
            let body: Value = response.json().await.map_err(|error| error.to_string())?;
            Ok(AuthzDecision {
                allowed: body.get("allowed") == Some(&Value::Bool(true)),
                reason: body
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            })
        })
    }
}

struct CacheEntry {
    decision: AuthzDecision,
    expires: Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthzOutcome {
    Allow,
    AuditWouldDeny {
        header: String,
    },
    Denied {
        action: String,
        resource: String,
        reason: String,
    },
    Unavailable,
}

pub struct AuthzService {
    pub mode: AuthzMode,
    cache_ttl: Duration,
    cache: Mutex<HashMap<String, CacheEntry>>,
    order: Mutex<VecDeque<String>>,
    decider: Arc<dyn AuthzDecider>,
    metrics: Arc<Metrics>,
}

const CACHE_MAX: usize = 10_000;

impl AuthzService {
    pub fn new(
        mode: AuthzMode,
        cache_ttl: Duration,
        decider: Arc<dyn AuthzDecider>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            mode,
            cache_ttl,
            cache: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
            decider,
            metrics,
        }
    }

    pub async fn check(
        &self,
        route: &RouteRule,
        principal: Option<&Principal>,
        method: &str,
        pathname: &str,
    ) -> AuthzOutcome {
        if self.mode == AuthzMode::Off
            || route.service.is_none()
            || route.auth == crate::routes::AuthMode::None
            || principal.is_none()
            || method.eq_ignore_ascii_case("OPTIONS")
        {
            return AuthzOutcome::Allow;
        }
        let Some(principal) = principal else {
            return AuthzOutcome::Allow;
        };
        let Some(body) = iam_principal(principal) else {
            return AuthzOutcome::Allow;
        };
        let Some(action) = action_for(route, method, pathname) else {
            return AuthzOutcome::Allow;
        };
        let resource = resource_for(route.service.as_deref(), Some(principal), pathname);
        let key = format!("{}|{action}|{resource}", principal_key(principal));
        let cached = {
            let now = Instant::now();
            let mut cache = self.cache.lock().expect("authz cache");
            match cache.get(&key) {
                Some(entry) if entry.expires > now => Some(entry.decision.clone()),
                Some(_) => {
                    cache.remove(&key);
                    None
                }
                None => None,
            }
        };
        let decision = match cached {
            Some(decision) => decision,
            None => match self
                .decider
                .decide(body, action.clone(), resource.clone())
                .await
            {
                Ok(decision) => {
                    if !self.cache_ttl.is_zero() {
                        let now = Instant::now();
                        let mut cache = self.cache.lock().expect("authz cache");
                        if cache.len() >= CACHE_MAX {
                            let mut order = self.order.lock().expect("authz order");
                            if let Some(oldest) = order.pop_front() {
                                cache.remove(&oldest);
                            }
                        }
                        if cache
                            .insert(
                                key.clone(),
                                CacheEntry {
                                    decision: decision.clone(),
                                    expires: now + self.cache_ttl,
                                },
                            )
                            .is_none()
                        {
                            self.order.lock().expect("authz order").push_back(key);
                        }
                    }
                    decision
                }
                Err(_) => {
                    self.metrics.inc_authz(self.mode.as_str(), "error");
                    return if self.mode == AuthzMode::Enforce {
                        AuthzOutcome::Unavailable
                    } else {
                        AuthzOutcome::Allow
                    };
                }
            },
        };
        if decision.allowed {
            self.metrics.inc_authz(self.mode.as_str(), "allow");
            return AuthzOutcome::Allow;
        }
        self.metrics.inc_authz(self.mode.as_str(), "deny");
        if self.mode == AuthzMode::Audit {
            tracing::warn!(
                "[gateway][authz] audit would-deny {action} on {resource} ({})",
                decision.reason
            );
            return AuthzOutcome::AuditWouldDeny {
                header: format!("would-deny; action={action}; reason={}", decision.reason),
            };
        }
        AuthzOutcome::Denied {
            action,
            resource,
            reason: decision.reason,
        }
    }
}
