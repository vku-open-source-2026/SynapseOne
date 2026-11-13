// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Routing table: YAML loading, wildcard compilation and longest-specificity
//! matching. The semantics mirror the TypeScript gateway one-for-one.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::authz::ActionOverride;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    None,
    Jwt,
    ApiKey,
    Either,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::None => "none",
            AuthMode::Jwt => "jwt",
            AuthMode::ApiKey => "apikey",
            AuthMode::Either => "either",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(AuthMode::None),
            "jwt" => Some(AuthMode::Jwt),
            "apikey" => Some(AuthMode::ApiKey),
            "either" => Some(AuthMode::Either),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub enum CompiledPath {
    Static { path: String, specificity: usize },
    Wildcard { regex: Regex, specificity: usize },
}

impl CompiledPath {
    pub fn matches(&self, pathname: &str) -> bool {
        match self {
            CompiledPath::Static { path, .. } => {
                pathname == path || pathname.starts_with(&format!("{path}/"))
            }
            CompiledPath::Wildcard { regex, .. } => regex.is_match(pathname),
        }
    }

    pub fn specificity(&self) -> usize {
        match self {
            CompiledPath::Static { specificity, .. }
            | CompiledPath::Wildcard { specificity, .. } => *specificity,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RouteRule {
    pub path: String,
    pub target: String,
    pub auth: AuthMode,
    pub timeout_ms: Option<u64>,
    pub service: Option<String>,
    pub actions: Vec<ActionOverride>,
    pub compiled: CompiledPath,
}

impl RouteRule {
    pub fn new(
        path: impl Into<String>,
        target: impl Into<String>,
        auth: AuthMode,
    ) -> Result<Self, String> {
        let path = path.into();
        let compiled = compile_route_path(&path)?;
        Ok(Self {
            path,
            target: target.into(),
            auth,
            timeout_ms: None,
            service: None,
            actions: Vec::new(),
            compiled,
        })
    }

    pub fn timeout_ms(&self, global_default: u64) -> u64 {
        self.timeout_ms.unwrap_or(global_default)
    }
}

#[derive(Debug, Deserialize)]
struct RawRoute {
    path: String,
    target: String,
    auth: String,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    service: Option<String>,
    #[serde(default)]
    actions: Vec<ActionOverride>,
}

#[derive(Debug, Deserialize)]
struct RawDoc {
    #[serde(default)]
    routes: Vec<RawRoute>,
}

/// Route path syntax:
///  - static prefixes match exactly or as a prefix (`/v1/orgs` + `/v1/orgs/...`,
///    like `/v1/organizations` does NOT match);
///  - a `*` segment matches exactly one non-empty path segment;
///  - a trailing `/*` matches any remainder, including none.
///
/// Specificity is literal character count, so static rules shadow shorter
/// prefixes and wildcard rules win only for their exact shape.
pub fn compile_route_path(path: &str) -> Result<CompiledPath, String> {
    if !path.contains('*') {
        return Ok(CompiledPath::Static {
            path: path.to_string(),
            specificity: path.len(),
        });
    }
    if path.contains("//") || !path.starts_with('/') {
        return Err(format!("[gateway] invalid wildcard route path '{path}'"));
    }
    let segments = path.split('/').collect::<Vec<_>>();
    let mut literal = 0usize;
    let mut pattern = String::from("^");
    for (index, segment) in segments.iter().enumerate() {
        if index == 0 {
            continue;
        }
        if *segment == "*" && index == segments.len() - 1 {
            pattern.push_str("(?:/.*)?");
            literal += 1;
        } else if *segment == "*" {
            pattern.push_str("/[^/]+");
            literal += 1;
        } else {
            if segment.is_empty() {
                return Err(format!(
                    "[gateway] invalid wildcard route path '{path}' (empty segment)"
                ));
            }
            pattern.push('/');
            pattern.push_str(&regex::escape(segment));
            literal += segment.len();
        }
    }
    pattern.push('$');
    let regex = Regex::new(&pattern)
        .map_err(|error| format!("[gateway] invalid wildcard route path '{path}': {error}"))?;
    Ok(CompiledPath::Wildcard {
        regex,
        specificity: literal,
    })
}

/// Highest specificity wins; ties keep the earlier route in the table.
pub fn find_route<'a>(routes: &'a [RouteRule], pathname: &str) -> Option<&'a RouteRule> {
    let mut best: Option<&RouteRule> = None;
    let mut best_score = None;
    for route in routes {
        if !route.compiled.matches(pathname) {
            continue;
        }
        let score = route.compiled.specificity();
        if best_score.is_none_or(|current| score > current) {
            best = Some(route);
            best_score = Some(score);
        }
    }
    best
}

fn expand_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\$\{([^:}]+)(?::([^}]*))?\}").expect("env regex"))
}

/// `${NAME:default}` expansion; a set env var (even empty) wins over default.
pub fn expand_env(input: &str) -> String {
    expand_regex()
        .replace_all(input, |captures: &regex::Captures<'_>| {
            let key = &captures[1];
            match std::env::var(key) {
                Ok(value) => value,
                Err(_) => captures
                    .get(2)
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default(),
            }
        })
        .into_owned()
}

fn candidate_paths() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("GATEWAY_ROUTES_PATH") {
        if !value.trim().is_empty() {
            candidates.push(value);
        }
    }
    candidates.push("./routes.yaml".to_string());
    candidates.push("/app/routes.yaml".to_string());
    candidates.push(format!("{}/routes.yaml", env!("CARGO_MANIFEST_DIR")));
    candidates
}

/// Load the routing table. A missing/unparsable file tries the next candidate;
/// once a file parses, operator typos (unknown auth, malformed wildcard) are
/// fatal instead of silently falling back to the dev defaults.
pub fn load_routes() -> Result<Vec<RouteRule>, String> {
    for candidate in candidate_paths() {
        let Ok(raw) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        let expanded = expand_env(&raw);
        let document = serde_yaml::from_str::<RawDoc>(&expanded)
            .map_err(|error| format!("[gateway] invalid routes file '{candidate}': {error}"))?;
        let mut routes = Vec::with_capacity(document.routes.len());
        for raw_route in document.routes {
            let auth = AuthMode::parse(&raw_route.auth).ok_or_else(|| {
                format!(
                    "[gateway] invalid auth mode '{}' for path '{}' (want none|jwt|apikey|either)",
                    raw_route.auth, raw_route.path
                )
            })?;
            let compiled = compile_route_path(&raw_route.path)?;
            routes.push(RouteRule {
                path: raw_route.path,
                target: raw_route.target,
                auth,
                timeout_ms: raw_route.timeout_ms,
                service: raw_route.service,
                actions: raw_route.actions,
                compiled,
            });
        }
        validate_routes(&routes)?;
        return Ok(routes);
    }
    Ok(fallback_routes())
}

fn fallback_routes() -> Vec<RouteRule> {
    let iam = std::env::var("IAM_SERVICE_URL").unwrap_or_else(|_| "http://iam:4001".into());
    let workflow =
        std::env::var("WORKFLOW_SERVICE_URL").unwrap_or_else(|_| "http://workflow:4002".into());
    [
        ("/v1/auth", iam.clone(), AuthMode::None),
        ("/v1/orgs", iam, AuthMode::Either),
        ("/v1/workflows", workflow, AuthMode::Either),
    ]
    .into_iter()
    .filter_map(|(path, target, auth)| RouteRule::new(path, target, auth).ok())
    .collect()
}

fn service_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]{0,31}$").expect("service regex"))
}

fn action_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z][a-z0-9-]*:[A-Za-z]+$").expect("action regex"))
}

/// Precompile matchers and fail fast on operator typos: an unknown auth mode
/// would 401 everything silently and a malformed wildcard would throw later.
pub fn validate_routes(routes: &[RouteRule]) -> Result<(), String> {
    for route in routes {
        if !route.path.starts_with('/') {
            return Err(format!(
                "[gateway] invalid route path '{}' (must start with /)",
                route.path
            ));
        }
        compile_route_path(&route.path)?;
        if let Some(timeout) = route.timeout_ms {
            if !(1_000..=300_000).contains(&timeout) {
                return Err(format!(
                    "[gateway] invalid timeoutMs '{}' for path '{}' (want 1000..300000)",
                    timeout, route.path
                ));
            }
        }
        if let Some(service) = &route.service {
            if !service_regex().is_match(service) {
                return Err(format!(
                    "[gateway] invalid service '{service}' for path '{}'",
                    route.path
                ));
            }
        }
        for action in &route.actions {
            if !action.path.starts_with('/') || !action_regex().is_match(&action.action) {
                return Err(format!(
                    "[gateway] invalid action override on '{}': path={} action={}",
                    route.path, action.path, action.action
                ));
            }
        }
    }
    Ok(())
}

/// Parse and validate routes from an in-memory YAML document (tests, callers
/// that pre-fetch configuration).
#[cfg(test)]
pub fn parse_routes_yaml(raw: &str) -> Result<Vec<RouteRule>, String> {
    let document = serde_yaml::from_str::<RawDoc>(&expand_env(raw))
        .map_err(|error| format!("[gateway] invalid routes.yaml: {error}"))?;
    let mut routes = Vec::with_capacity(document.routes.len());
    for raw_route in document.routes {
        let auth = AuthMode::parse(&raw_route.auth).ok_or_else(|| {
            format!(
                "[gateway] invalid auth mode '{}' for path '{}' (want none|jwt|apikey|either)",
                raw_route.auth, raw_route.path
            )
        })?;
        let compiled = compile_route_path(&raw_route.path)?;
        routes.push(RouteRule {
            path: raw_route.path,
            target: raw_route.target,
            auth,
            timeout_ms: raw_route.timeout_ms,
            service: raw_route.service,
            actions: raw_route.actions,
            compiled,
        });
    }
    validate_routes(&routes)?;
    Ok(routes)
}
