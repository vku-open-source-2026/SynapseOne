// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Environment configuration and fail-fast security validation.
//!
//! The Tier-1 gateway is the only public API surface, so weak defaults are
//! rejected in production rather than silently weakening the edge.

use std::net::IpAddr;
use std::time::Duration;

use axum::http::HeaderMap;

use crate::authz::AuthzMode;

pub const DEFAULT_PROXY_TIMEOUT_MS: u64 = 30_000;
pub const MAX_PROXY_TIMEOUT_MS: u64 = 300_000;
pub const DEFAULT_SESSION_CACHE_MS: u64 = 2_000;
pub const MAX_SESSION_CACHE_MS: u64 = 30_000;
pub const DEFAULT_AUTHZ_CACHE_MS: u64 = 30_000;
pub const MAX_AUTHZ_CACHE_MS: u64 = 300_000;
pub const DEFAULT_INFERENCE_LIMIT: u32 = 60;
pub const DEFAULT_AI_LIMIT: u32 = 30;
pub const DEFAULT_WORKFLOW_LIMIT: u32 = 120;
pub const MAX_RATE_LIMIT: u32 = 100_000;
pub const DEFAULT_QUOTA_CACHE_MS: u64 = 30_000;
pub const MAX_QUOTA_CACHE_MS: u64 = 300_000;

/// Accepted during the SynapseDX -> SynapseOne rebrand window.
pub const JWT_ISSUERS: [&str; 2] = ["synapseone-iam", "synapsedx-iam"];

#[derive(Clone, Debug)]
pub struct ReadyUpstream {
    pub name: String,
    pub url: String,
    /// Critical upstreams gate readiness; optional ones are reported but do
    /// not take the gateway out of rotation.
    pub required: bool,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub version: String,
    pub port: u16,
    pub is_prod: bool,
    pub iam_service_url: String,
    pub jwt_secret: String,
    pub jwt_issuers: Vec<String>,
    pub internal_secret: String,
    pub verify_api_key: bool,
    pub authz_mode: AuthzMode,
    pub authz_audit_ack: String,
    pub trust_proxy: TrustProxy,
    pub proxy_timeout_ms: u64,
    pub quota_defaults: crate::quotas::QuotaDefaults,
    pub quota_cache_ttl: Duration,
    pub session_cache_ttl: Duration,
    pub authz_cache_ttl: Duration,
    pub cors_origins: Vec<String>,
    pub hsts: bool,
    pub usage_enabled: bool,
    pub ready_upstreams: Vec<ReadyUpstream>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        apply_env_compat();
        let is_prod = std::env::var("NODE_ENV").as_deref() == Ok("production");
        let raw_jwt = env_string("IAM_JWT_SECRET");
        let jwt_secret = effective_jwt_secret(&raw_jwt, is_prod)?;

        let internal_secret = env_string("SYNAPSEONE_INTERNAL_SECRET");
        if internal_secret.is_empty() {
            if is_prod {
                return Err(
                    "[gateway] SYNAPSEONE_INTERNAL_SECRET must be set in production".into(),
                );
            }
            tracing::warn!(
                "[gateway][security] SYNAPSEONE_INTERNAL_SECRET not set — downstream services cannot tell gateway traffic apart (dev default). Set it in production."
            );
        }

        let verify_api_key = verify_api_key_from_env();
        // Production defaults to enforcement. A deployment can still roll out
        // in audit mode, but only with an explicit, owned override
        // (AUTHZ_AUDIT_ACK="owner=<name>;expires=<date>;reason=...").
        let authz_mode = if is_prod && std::env::var_os("AUTHZ_MODE").is_none() {
            AuthzMode::Enforce
        } else {
            AuthzMode::from_env()
        };
        let audit_ack = std::env::var("AUTHZ_AUDIT_ACK").unwrap_or_default();
        validate_security_config(
            is_prod,
            verify_api_key,
            authz_mode,
            std::env::var("AUTHZ_MODE_REQUIRED").as_deref() == Ok("true"),
            &audit_ack,
        )?;
        if is_prod && authz_mode == AuthzMode::Off {
            tracing::warn!(
                "[gateway][security] AUTHZ_MODE=off — central policy enforcement is disabled. Set AUTHZ_MODE=enforce before exposing multi-tenant administration."
            );
        }
        if is_prod && authz_mode == AuthzMode::Audit {
            tracing::warn!(
                "[gateway][security] AUTHZ_MODE=audit — policy denies are NOT enforced. Override owner: {audit_ack}"
            );
        }

        let trust_proxy = parse_trust_proxy(std::env::var("TRUST_PROXY").ok().as_deref())?;
        if is_prod && trust_proxy == TrustProxy::Disabled {
            tracing::warn!(
                "[gateway][security] TRUST_PROXY is unset in production — per-IP limits will key on the TLS edge address. Set TRUST_PROXY=1 (nginx) or a CIDR list."
            );
        }

        let cors_origins = env_string("CORS_ORIGIN")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if cors_origins.is_empty() {
            tracing::warn!(
                "[gateway][security] CORS_ORIGIN not set — allowing all origins (dev default). Set it in production."
            );
        }

        let port = std::env::var("PORT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| std::env::var("GATEWAY_PORT").ok())
            .and_then(|value| value.trim().parse::<u16>().ok())
            .unwrap_or(8080);

        let proxy_timeout_ms = match std::env::var("PROXY_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
        {
            Some(value) if value.is_finite() && value > 0.0 => {
                (value.floor() as u64).min(MAX_PROXY_TIMEOUT_MS)
            }
            _ => DEFAULT_PROXY_TIMEOUT_MS,
        };

        let mut ai = service_quota_defaults("AI", DEFAULT_AI_LIMIT, Some("AI_RATE_LIMIT"));
        ai.tpd = Some(clamped_quota(std::env::var("AI_QUOTA_TOKENS_PER_DAY").ok().as_deref(), 1_000_000));
        let mut inference = service_quota_defaults("INFERENCE", DEFAULT_INFERENCE_LIMIT, Some("INFERENCE_RATE_LIMIT_PER_MIN"));
        inference.tpd = Some(clamped_quota(std::env::var("INFERENCE_QUOTA_TOKENS_PER_DAY").ok().as_deref(), 1_000_000));
        let mut workflow = service_quota_defaults("WORKFLOW", DEFAULT_WORKFLOW_LIMIT, None);
        workflow.eph = Some(clamped_quota_max(
            std::env::var("WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR").ok().as_deref(),
            1_000,
            1_000_000,
        ));
        workflow.concurrent = Some(clamped_quota(
            std::env::var("WORKFLOW_QUOTA_CONCURRENT").ok().as_deref(),
            10,
        ).min(1_000));
        let quota_defaults = crate::quotas::QuotaDefaults { ai, inference, workflow };
        let quota_cache_ttl = Duration::from_millis(clamped_ms(
            std::env::var("QUOTA_CACHE_TTL_MS").ok().as_deref(),
            DEFAULT_QUOTA_CACHE_MS,
            MAX_QUOTA_CACHE_MS,
        ));

        let session_cache_ttl = Duration::from_millis(clamped_ms(
            std::env::var("GATEWAY_SESSION_CACHE_MS").ok().as_deref(),
            DEFAULT_SESSION_CACHE_MS,
            MAX_SESSION_CACHE_MS,
        ));
        let authz_cache_ttl = Duration::from_millis(clamped_ms(
            std::env::var("AUTHZ_CACHE_TTL_MS").ok().as_deref(),
            DEFAULT_AUTHZ_CACHE_MS,
            MAX_AUTHZ_CACHE_MS,
        ));

        Ok(Self {
            version: std::env::var("SYNAPSEONE_BUILD_VERSION")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
            port,
            is_prod,
            iam_service_url: env_or("IAM_SERVICE_URL", "http://iam:4001"),
            jwt_secret,
            jwt_issuers: JWT_ISSUERS.iter().map(|value| value.to_string()).collect(),
            internal_secret,
            verify_api_key,
            authz_mode,
            authz_audit_ack: audit_ack,
            trust_proxy,
            proxy_timeout_ms,
            quota_defaults,
            quota_cache_ttl,
            session_cache_ttl,
            authz_cache_ttl,
            cors_origins,
            hsts: std::env::var("HSTS_ENABLED").as_deref() == Ok("true"),
            usage_enabled: crate::usage::is_usage_telemetry_enabled(),
            ready_upstreams: ready_upstreams_from_env(),
        })
    }
}

fn env_string(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn service_quota_defaults(prefix: &str, fallback_rpm: u32, legacy_rpm: Option<&str>) -> crate::quotas::ServiceDefaults {
    let preferred = std::env::var(format!("{prefix}_QUOTA_REQUESTS_PER_MIN")).ok();
    let legacy = legacy_rpm.and_then(|name| std::env::var(name).ok());
    let fallback = clamped_rate_limit(legacy.as_deref(), fallback_rpm);
    let rpm = u64::from(clamped_rate_limit(preferred.as_deref(), fallback));
    crate::quotas::ServiceDefaults {
        rpm,
        rp5h: clamped_quota(std::env::var(format!("{prefix}_QUOTA_REQUESTS_PER_5H")).ok().as_deref(), rpm * 300),
        rpd: clamped_quota(std::env::var(format!("{prefix}_QUOTA_REQUESTS_PER_DAY")).ok().as_deref(), rpm * 1_440),
        tpd: None,
        eph: None,
        concurrent: None,
    }
}

fn clamped_rate_limit(raw: Option<&str>, fallback: u32) -> u32 {
    match raw.and_then(|value| value.trim().parse::<f64>().ok()) {
        Some(value) if value.is_finite() => {
            (value.floor() as i64).clamp(1, MAX_RATE_LIMIT as i64) as u32
        }
        _ => fallback,
    }
}

fn clamped_quota(raw: Option<&str>, fallback: u64) -> u64 {
    clamped_quota_max(raw, fallback, 1_000_000_000)
}

fn clamped_quota_max(raw: Option<&str>, fallback: u64, max: u64) -> u64 {
    match raw.and_then(|value| value.trim().parse::<f64>().ok()) {
        Some(value) if value.is_finite() => {
            (value.floor() as i64).clamp(1, max as i64) as u64
        }
        _ => fallback,
    }
}

fn clamped_ms(raw: Option<&str>, fallback: u64, max: u64) -> u64 {
    match raw.and_then(|value| value.trim().parse::<f64>().ok()) {
        Some(value) if value.is_finite() => (value.floor().max(0.0) as u64).min(max),
        _ => fallback,
    }
}

/// Legacy env compatibility: prefer `SYNAPSEONE_*` but honour `SYNAPSEDX_*`
/// during the rebrand window. New names win when both are set.
pub fn apply_env_compat() {
    let legacy = std::env::vars()
        .filter(|(key, _)| key.starts_with("SYNAPSEDX_"))
        .collect::<Vec<_>>();
    for (key, value) in legacy {
        let next = format!("SYNAPSEONE_{}", &key["SYNAPSEDX_".len()..]);
        if std::env::var_os(&next).is_none() {
            std::env::set_var(next, value);
        }
    }
}

pub fn is_weak_jwt_secret(secret: &str) -> bool {
    secret.is_empty() || secret.contains("change_me") || secret.len() < 32
}

/// Returns the effective signing secret or fails closed in production.
pub fn effective_jwt_secret(raw: &str, is_prod: bool) -> Result<String, String> {
    if is_weak_jwt_secret(raw) {
        if is_prod {
            return Err(
                "[gateway] IAM_JWT_SECRET must be set to a random value ≥32 chars in production"
                    .into(),
            );
        }
        tracing::warn!(
            "[gateway][security] WARNING: IAM_JWT_SECRET is default/weak — dev only. Gateway and IAM must share the same strong secret."
        );
        if raw.is_empty() {
            return Ok("change_me_super_secret_32chars_min".into());
        }
    }
    Ok(raw.to_string())
}

/// `GATEWAY_VERIFY_APIKEY`: fail-closed by default. Only the exact string
/// `true` enables verification; an explicit `false` is rejected in production.
pub fn verify_api_key_from_env() -> bool {
    match std::env::var("GATEWAY_VERIFY_APIKEY") {
        Ok(raw) if raw.is_empty() => true,
        Ok(raw) => raw == "true",
        Err(_) => true,
    }
}

pub fn validate_security_config(
    is_prod: bool,
    verify_api_key: bool,
    authz_mode: AuthzMode,
    authz_mode_required: bool,
    audit_ack: &str,
) -> Result<(), String> {
    if is_prod && !verify_api_key {
        return Err(
            "[gateway] GATEWAY_VERIFY_APIKEY=false is forbidden in production (auth bypass). Set true."
                .into(),
        );
    }
    if is_prod && authz_mode_required && authz_mode == AuthzMode::Off {
        return Err(
            "[gateway] AUTHZ_MODE=off is forbidden when AUTHZ_MODE_REQUIRED=true. Set enforce (or a time-bounded audit override)."
                .into(),
        );
    }
    if is_prod && authz_mode == AuthzMode::Audit && audit_ack.trim().is_empty() {
        return Err(
            "[gateway] AUTHZ_MODE=audit is a rollout override. Set AUTHZ_MODE=enforce, or acknowledge it with AUTHZ_AUDIT_ACK='owner=<name>;expires=<YYYY-MM-DD>;reason=<why>'. \
             Audit mode never blocks a would-deny decision."
                .into(),
        );
    }
    if is_prod && authz_mode == AuthzMode::Audit {
        // An audit override without an owner and a future expiry is an
        // indefinite enforcement hole: reject it at boot, not in review.
        let ack = audit_ack.trim();
        let owner = ack.split(';').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key.trim() == "owner").then(|| value.trim()).filter(|v| !v.is_empty())
        });
        let expires = ack.split(';').find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key.trim() == "expires").then(|| value.trim().to_string())
        });
        let expiry_ok = expires.as_deref().is_some_and(|date| {
            let bytes = date.as_bytes();
            bytes.len() == 10
                && bytes[4] == b'-'
                && bytes[7] == b'-'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
                && date >= today_utc().as_str()
        });
        if owner.is_none() || !expiry_ok {
            return Err(
                "[gateway] AUTHZ_AUDIT_ACK must name an owner and a non-past expiry date: 'owner=<name>;expires=<YYYY-MM-DD>;reason=<why>'."
                    .into(),
            );
        }
    }
    Ok(())
}

/// Current UTC date as `YYYY-MM-DD` (no clock dependency beyond std + chrono).
fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn ready_upstreams_from_env() -> Vec<ReadyUpstream> {
    ready_upstreams_from(|name| std::env::var(name).ok())
}

/// Build the readiness list from an injected environment lookup. Keeping the
/// lookup injectable lets the tests cover optional service discovery without
/// mutating process-global environment variables.
fn ready_upstreams_from<F>(lookup: F) -> Vec<ReadyUpstream>
where
    F: Fn(&str) -> Option<String>,
{
    let read = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
    let env_or = |name: &str, fallback: &str| read(name).unwrap_or_else(|| fallback.to_string());
    let mut upstreams = vec![
        ready("iam", env_or("IAM_SERVICE_URL", "http://iam:4001"), true),
        ready(
            "workflow",
            env_or("WORKFLOW_SERVICE_URL", "http://workflow:4002"),
            true,
        ),
        ready("ai", env_or("AI_SERVICE_URL", "http://ai:4003"), false),
        ready("lds", env_or("LDS_SERVICE_URL", "http://lds:4004"), false),
        ready("base", env_or("BASE_SERVICE_URL", "http://base:4005"), true),
        ready(
            "faststore",
            env_or("FASTSTORE_SERVICE_URL", "http://faststore:4006"),
            false,
        ),
        ready("queue", env_or("QUEUE_SERVICE_URL", "http://queue:4007"), false),
    ];
    // Lakehouse is advertised at /v1/lakehouse. It is optional for gateway
    // liveness (a gateway restart cannot repair it), but it must be reported:
    // a configured-but-down Lakehouse sets optionalDegraded on /ready, exactly
    // like Stream/Warehouse/Inference.
    for (name, key) in [
        ("stream", "STREAM_SERVICE_URL"),
        ("warehouse", "WAREHOUSE_SERVICE_URL"),
        ("lakehouse", "LAKEHOUSE_SERVICE_URL"),
        ("inference", "INFERENCE_SERVICE_URL"),
    ] {
        if let Some(url) = read(key) {
            upstreams.push(ready(name, url, false));
        }
    }
    let ocs = read("OCS_SERVICE_URL").or_else(|| read("STORAGE_SERVICE_URL"));
    if let Some(url) = ocs {
        upstreams.push(ready("ocs", url, false));
    }
    if let Some(url) = read("NOTIFICATIONS_SERVICE_URL") {
        upstreams.push(ready("notifications", url, false));
    }
    upstreams
}

fn ready(name: &str, url: String, required: bool) -> ReadyUpstream {
    ReadyUpstream {
        name: name.to_string(),
        url,
        required,
    }
}

// ---------- TRUST_PROXY (#41) ----------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrustEntry {
    Ip(IpAddr),
    Cidr(IpAddr, u8),
    Loopback,
    LinkLocal,
    UniqueLocal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrustProxy {
    Disabled,
    Hops(u8),
    List(Vec<TrustEntry>),
}

/// Accepts unset/''/0/false, an integer hop count 1..10, or a comma list of
/// IPs/CIDRs/names. Rejects a blanket `true`: trusting every peer lets any
/// client spoof `X-Forwarded-For` and forge another client's rate-limit bucket.
pub fn parse_trust_proxy(raw: Option<&str>) -> Result<TrustProxy, String> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty() || value == "0" || value.eq_ignore_ascii_case("false") {
        return Ok(TrustProxy::Disabled);
    }
    if value.eq_ignore_ascii_case("true") {
        return Err(
            "[gateway] TRUST_PROXY=true is forbidden (any peer could spoof X-Forwarded-For). Use a hop count or a CIDR list."
                .into(),
        );
    }
    if value.chars().all(|c| c.is_ascii_digit()) {
        let hops = value
            .parse::<u8>()
            .map_err(|_| "[gateway] TRUST_PROXY hop count must be 1..10".to_string())?;
        if !(1..=10).contains(&hops) {
            return Err("[gateway] TRUST_PROXY hop count must be 1..10".into());
        }
        return Ok(TrustProxy::Hops(hops));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || ".:/,_- ".contains(c))
    {
        return Err(
            "[gateway] TRUST_PROXY must be a hop count or a comma-separated IP/CIDR list".into(),
        );
    }
    let mut entries = Vec::new();
    for part in value.split(',') {
        let item = part.trim();
        if item.is_empty() {
            return Err(
                "[gateway] TRUST_PROXY must be a hop count or a comma-separated IP/CIDR list"
                    .into(),
            );
        }
        entries.push(parse_trust_entry(item)?);
    }
    if entries.is_empty() {
        return Err(
            "[gateway] TRUST_PROXY must be a hop count or a comma-separated IP/CIDR list".into(),
        );
    }
    Ok(TrustProxy::List(entries))
}

fn parse_trust_entry(item: &str) -> Result<TrustEntry, String> {
    match item.to_ascii_lowercase().as_str() {
        "loopback" => return Ok(TrustEntry::Loopback),
        "linklocal" => return Ok(TrustEntry::LinkLocal),
        "uniquelocal" => return Ok(TrustEntry::UniqueLocal),
        _ => {}
    }
    if let Some((addr, prefix)) = item.split_once('/') {
        let addr = addr
            .trim()
            .parse::<IpAddr>()
            .map_err(|_| format!("[gateway] TRUST_PROXY has an invalid CIDR '{item}'"))?;
        let prefix = prefix
            .trim()
            .parse::<u8>()
            .map_err(|_| format!("[gateway] TRUST_PROXY has an invalid CIDR '{item}'"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(format!(
                "[gateway] TRUST_PROXY has an invalid CIDR prefix in '{item}'"
            ));
        }
        return Ok(TrustEntry::Cidr(addr, prefix));
    }
    item.parse::<IpAddr>()
        .map(TrustEntry::Ip)
        .map_err(|_| format!("[gateway] TRUST_PROXY has an invalid address '{item}'"))
}

impl TrustProxy {
    /// Resolve the client IP exactly like Express `proxy-addr`:
    /// `addrs = [socket, ...x-forwarded-for reversed]`.
    pub fn client_ip(&self, headers: &HeaderMap, remote: Option<IpAddr>) -> Option<String> {
        let forwarded = forwarded_for(headers);
        match self {
            TrustProxy::Disabled => remote.map(|ip| ip.to_string()),
            TrustProxy::Hops(hops) => {
                let mut addrs: Vec<String> = Vec::with_capacity(forwarded.len() + 1);
                if let Some(ip) = remote {
                    addrs.push(ip.to_string());
                }
                addrs.extend(forwarded.iter().rev().cloned());
                if addrs.is_empty() {
                    return None;
                }
                let offset = if remote.is_some() { 0 } else { 1 };
                let index = (usize::from(*hops)).saturating_sub(offset);
                Some(addrs[index.min(addrs.len() - 1)].clone())
            }
            TrustProxy::List(entries) => {
                let mut addrs: Vec<String> = Vec::with_capacity(forwarded.len() + 1);
                if let Some(ip) = remote {
                    addrs.push(ip.to_string());
                }
                addrs.extend(forwarded.iter().rev().cloned());
                if addrs.is_empty() {
                    return None;
                }
                for (index, addr) in addrs.iter().enumerate() {
                    if index == addrs.len() - 1 {
                        return Some(addr.clone());
                    }
                    if !trusts(entries, addr) {
                        return Some(addr.clone());
                    }
                }
                addrs.last().cloned()
            }
        }
    }
}

fn forwarded_for(headers: &HeaderMap) -> Vec<String> {
    let mut values = Vec::new();
    for header in headers.get_all("x-forwarded-for") {
        let Ok(text) = header.to_str() else {
            continue;
        };
        for part in text.split(',') {
            let item = part.trim();
            if !item.is_empty() {
                values.push(item.to_string());
            }
        }
    }
    values
}

pub fn normalize_ip_text(value: &str) -> Option<IpAddr> {
    let value = value.trim();
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((addr, _port)) = rest.split_once("]:") {
            return addr.parse::<IpAddr>().ok();
        }
        if let Some(addr) = rest.strip_suffix(']') {
            return addr.parse::<IpAddr>().ok();
        }
    }
    if let Some((addr, port)) = value.rsplit_once(':') {
        if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
            return addr.parse::<IpAddr>().ok();
        }
    }
    None
}

fn trusts(entries: &[TrustEntry], value: &str) -> bool {
    let Some(ip) = normalize_ip_text(value) else {
        return false;
    };
    entries.iter().any(|entry| match entry {
        TrustEntry::Ip(expected) => *expected == ip,
        TrustEntry::Cidr(base, prefix) => cidr_contains(*base, *prefix, ip),
        TrustEntry::Loopback => ip.is_loopback(),
        TrustEntry::LinkLocal => is_link_local(ip),
        TrustEntry::UniqueLocal => is_unique_local(ip),
    })
}

fn is_link_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 169 && v4.octets()[1] == 254,
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

fn is_unique_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
        }
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn cidr_contains(base: IpAddr, prefix: u8, candidate: IpAddr) -> bool {
    match (base, candidate) {
        (IpAddr::V4(base), IpAddr::V4(candidate)) => {
            prefix_bits_match(&base.octets(), &candidate.octets(), u32::from(prefix))
        }
        (IpAddr::V6(base), IpAddr::V6(candidate)) => {
            prefix_bits_match(&base.octets(), &candidate.octets(), u32::from(prefix))
        }
        _ => false,
    }
}

fn prefix_bits_match(base: &[u8], candidate: &[u8], prefix: u32) -> bool {
    let full = (prefix / 8) as usize;
    let rest = (prefix % 8) as u8;
    if base[..full] != candidate[..full] {
        return false;
    }
    if rest == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - rest);
    (base[full] & mask) == (candidate[full] & mask)
}

#[cfg(test)]
mod tests {
    use super::{clamped_quota_max, ready_upstreams_from};

    #[test]
    fn workflow_execution_clamp_matches_iam_and_typescript() {
        assert_eq!(clamped_quota_max(Some("5000000"), 1_000, 1_000_000), 1_000_000);
        assert_eq!(clamped_quota_max(Some("500"), 1_000, 1_000_000), 500);
    }

    #[test]
    fn lakehouse_is_reported_only_when_configured_and_never_critical() {
        let without = ready_upstreams_from(|_| None);
        assert!(!without.iter().any(|upstream| upstream.name == "lakehouse"));

        let with = ready_upstreams_from(|name| match name {
            "LAKEHOUSE_SERVICE_URL" => Some("http://lakehouse:4013".to_string()),
            _ => None,
        });
        let lakehouse = with
            .iter()
            .find(|upstream| upstream.name == "lakehouse")
            .expect("configured Lakehouse must be probed");
        assert_eq!(lakehouse.url, "http://lakehouse:4013");
        assert!(!lakehouse.required, "Lakehouse degradation must not evict the gateway");

        let blank = ready_upstreams_from(|name| match name {
            "LAKEHOUSE_SERVICE_URL" => Some("   ".to_string()),
            _ => None,
        });
        assert!(!blank.iter().any(|upstream| upstream.name == "lakehouse"));
    }
}
