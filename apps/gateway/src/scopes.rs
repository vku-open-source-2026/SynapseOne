// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Per-route scope enforcement (issue #23).
//!
//! Scope grammar:
//!   `*`              full authority (org-member JWT default)
//!   `<service>:*`    every action in one service
//!   `*:read`         read every service
//!   `*:write`        write every service
//!   `<service>:<action>` exact HTTP action (`get`, `list`, `publish`, ...)

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

const SERVICE_BY_PREFIX: [(&str, &str); 36] = [
    ("/v1/orgs", "iam"),
    ("/v1/accounts", "iam"),
    ("/v1/roles", "iam"),
    ("/v1/users", "iam"),
    ("/v1/service-accounts", "iam"),
    ("/v1/policies", "iam"),
    ("/v1/managed-policies", "iam"),
    ("/v1/keys", "iam"),
    ("/v1/authorize", "iam"),
    ("/v1/audit", "iam"),
    ("/v1/usage", "iam"),
    ("/v1/scim", "iam"),
    ("/v1/workflows", "workflow"),
    ("/v1/workflow-runners", "workflow"),
    ("/v1/runner", "workflow"),
    ("/v1/templates", "workflow"),
    ("/v1/executions", "workflow"),
    ("/v1/credentials", "workflow"),
    ("/v1/human-tasks", "workflow"),
    ("/mcp", "workflow"),
    ("/webhook", "workflow"),
    ("/v1/ai", "ai"),
    ("/v1/inference-jobs", "inference"),
    ("/v1/inference", "inference"),
    ("/v1/lds", "lds"),
    ("/v1/base", "base"),
    ("/v1/search", "base"),
    ("/v1/faststore", "faststore"),
    ("/v1/queue", "queue"),
    ("/v1/stream", "stream"),
    ("/v1/warehouse", "warehouse"),
    ("/v1/ocs", "storage"),
    ("/v1/storage", "storage"),
    ("/v1/notifications", "notifications"),
    ("/v1/secrets", "secrets"),
    ("/v1/platform", "platform"),
];

const READ_ACTIONS: [&str; 10] = [
    "get", "head", "list", "read", "query", "peek", "stats", "consume", "search", "health",
];

const WRITE_ACTIONS: [&str; 26] = [
    "write",
    "create",
    "update",
    "delete",
    "put",
    "post",
    "patch",
    "publish",
    "ack",
    "nack",
    "heartbeat",
    "execute",
    "send",
    "rotate",
    "attach",
    "detach",
    "assign",
    "unassign",
    "activate",
    "deactivate",
    "ingest",
    "batch",
    "incr",
    "set",
    "del",
    "admin",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeRequirement {
    pub service: String,
    pub action: String,
    pub read: bool,
}

fn is_read_action(action: &str) -> bool {
    READ_ACTIONS.contains(&action)
}

fn is_write_action(action: &str) -> bool {
    WRITE_ACTIONS.contains(&action)
}

/// Resolve the service + action a request needs. `None` for unenforced paths.
/// `service_override` should be the route's declared service.
pub fn scope_requirement(
    pathname: &str,
    method: &str,
    service_override: Option<&str>,
) -> Option<ScopeRequirement> {
    let path = if pathname.is_empty() { "/" } else { pathname };
    if path == "/" || path == "/health" || path == "/ready" || path == "/metrics" {
        return None;
    }
    if path == "/v1/auth" || path.starts_with("/v1/auth/") {
        return None;
    }
    let mut service = service_override
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    if service.is_none() {
        for (prefix, name) in SERVICE_BY_PREFIX {
            if path == prefix || path.starts_with(&format!("{prefix}/")) {
                service = Some(name.to_string());
                break;
            }
        }
    }
    let service = service?;
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method.to_ascii_uppercase()
    };
    let read = method == "GET" || method == "HEAD" || method == "OPTIONS";
    Some(ScopeRequirement {
        service,
        action: if read { "read" } else { "write" }.into(),
        read,
    })
}

fn section_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{0,32}$").expect("scope section regex"))
}

/// Accept either the generic read/write scope or a concrete action verb. When
/// the gateway supplies the route's authz action (including per-path overrides
/// such as `platform:Admin`), that exact action is enforced so a
/// `platform:write` credential cannot call an admin-only endpoint.
pub fn scope_allows(
    scopes: &[String],
    pathname: &str,
    method: &str,
    service: Option<&str>,
    action_override: Option<&str>,
) -> bool {
    let requirement = if let Some(action) = action_override {
        let Some((service, verb)) = action.split_once(':') else {
            return false;
        };
        if service.is_empty() || verb.is_empty() {
            return false;
        }
        let action = verb.to_ascii_lowercase();
        let read = is_read_action(&action) || action == "read";
        ScopeRequirement {
            service: service.to_ascii_lowercase(),
            action,
            read,
        }
    } else {
        match scope_requirement(pathname, method, service) {
            Some(requirement) => requirement,
            None => return true,
        }
    };

    if scopes.iter().any(|scope| scope == "*") {
        return true;
    }
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method.to_ascii_uppercase()
    };
    let concrete = method.to_ascii_lowercase();
    let exact_override = action_override.is_some();
    let mut alternatives = HashSet::new();
    alternatives.insert(format!("{}:{}", requirement.service, requirement.action));
    alternatives.insert(format!("{}:{}", requirement.service, concrete));
    alternatives.insert(format!("{}:*", requirement.service));
    alternatives.insert(format!("*:{}", requirement.action));
    if !exact_override && !requirement.read {
        alternatives.insert("*:write".to_string());
    }
    // Legacy verb-style scopes (`faststore:get`) only cover their own verb.
    if is_read_action(&concrete) {
        alternatives.insert(format!("{}:read", requirement.service));
    }
    if !exact_override && is_write_action(&concrete) {
        alternatives.insert(format!("{}:write", requirement.service));
    }
    // Resource-action scopes: `/v1/workflows/:id/execute` -> `workflow:execute`.
    let last = pathname
        .split('/')
        .rfind(|segment| !segment.is_empty())
        .unwrap_or("");
    if section_regex().is_match(last) {
        alternatives.insert(format!("{}:{last}", requirement.service));
    }
    scopes.iter().any(|scope| alternatives.contains(scope))
}
