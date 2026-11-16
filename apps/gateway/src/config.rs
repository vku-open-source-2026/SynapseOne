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
pub const MAX_INFERENCE_LIMIT: u32 = 100_000;

/// Accepted during the SynapseDX -> SynapseOne rebrand window.
pub const JWT_ISSUERS: [&str; 2] = ["synapseone-iam", "synapsedx-iam"];

#[derive(Clone, Debug)]
pub struct ReadyUpstream {
    pub name: String,
    pub url: String,
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
    pub trust_proxy: TrustProxy,
    pub proxy_timeout_ms: u64,
    pub inference_rate_limit_per_min: u32,
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
        let authz_mode = AuthzMode::from_env();
        validate_security_config(
            is_prod,
            verify_api_key,
            authz_mode,
            std::env::var("AUTHZ_MODE_REQUIRED").as_deref() == Ok("true"),
        )?;
        if is_prod && authz_mode == AuthzMode::Off {
            tracing::warn!(
                "[gateway][security] AUTHZ_MODE=off — central policy enforcement is disabled. Set audit/enforce before exposing multi-tenant administration."
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

        let inference_rate_limit_per_min = match std::env::var("INFERENCE_RATE_LIMIT_PER_MIN")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
        {
            Some(value) if value.is_finite() => {
                (value.floor() as i64).clamp(1, MAX_INFERENCE_LIMIT as i64) as u32
            }
            _ => DEFAULT_INFERENCE_LIMIT,
        };

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
            version: env!("CARGO_PKG_VERSION").to_string(),
            port,
            is_prod,
            iam_service_url: env_or("IAM_SERVICE_URL", "http://iam:4001"),
            jwt_secret,
            jwt_issuers: JWT_ISSUERS.iter().map(|value| value.to_string()).collect(),
            internal_secret,
            verify_api_key,
            authz_mode,
            trust_proxy,
            proxy_timeout_ms,
            inference_rate_limit_per_min,
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
) -> Result<(), String> {
    if is_prod && !verify_api_key {
        return Err(
            "[gateway] GATEWAY_VERIFY_APIKEY=false is forbidden in production (auth bypass). Set true."
                .into(),
        );
    }
    if is_prod && authz_mode_required && authz_mode == AuthzMode::Off {
        return Err(
            "[gateway] AUTHZ_MODE=off is forbidden when AUTHZ_MODE_REQUIRED=true. Set audit or enforce."
                .into(),
        );
    }
    Ok(())
}

fn ready_upstreams_from_env() -> Vec<ReadyUpstream> {
    let mut upstreams = vec![
        ready("iam", env_or("IAM_SERVICE_URL", "http://iam:4001")),
        ready(
            "workflow",
            env_or("WORKFLOW_SERVICE_URL", "http://workflow:4002"),
        ),
        ready("ai", env_or("AI_SERVICE_URL", "http://ai:4003")),
        ready("lds", env_or("LDS_SERVICE_URL", "http://lds:4004")),
        ready("base", env_or("BASE_SERVICE_URL", "http://base:4005")),
        ready(
            "faststore",
            env_or("FASTSTORE_SERVICE_URL", "http://faststore:4006"),
        ),
        ready("queue", env_or("QUEUE_SERVICE_URL", "http://queue:4007")),
    ];
    for (name, key) in [
        ("stream", "STREAM_SERVICE_URL"),
        ("warehouse", "WAREHOUSE_SERVICE_URL"),
        ("inference", "INFERENCE_SERVICE_URL"),
    ] {
        if let Some(url) = optional_env(key) {
            upstreams.push(ready(name, url));
        }
    }
    let ocs = std::env::var("OCS_SERVICE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| optional_env("STORAGE_SERVICE_URL"));
    if let Some(url) = ocs {
        upstreams.push(ready("ocs", url));
    }
    if let Some(url) = optional_env("NOTIFICATIONS_SERVICE_URL") {
        upstreams.push(ready("notifications", url));
    }
    upstreams
}

fn optional_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn ready(name: &str, url: String) -> ReadyUpstream {
    ReadyUpstream {
        name: name.to_string(),
        url,
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
