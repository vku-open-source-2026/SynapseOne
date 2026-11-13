// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SSRF guard for tenant-controlled outbound webhook URLs.
//!
//! Mirrors the TypeScript guard: the host string is normalized and every
//! resolved address is checked (DNS rebinding), so neither literal private IPs
//! nor public names that resolve to internal addresses can reach the Docker
//! network or the cloud metadata endpoint.

use std::net::IpAddr;

use url::Url;

const BLOCKED_EXACT_HOSTS: &[&str] = &[
    "localhost",
    "metadata.google.internal",
    "iam",
    "gateway",
    "workflow",
    "postgres",
    "valkey",
    "redis",
    "n8n",
    "s3",
    "minio",
    "ocs",
    "base",
    "lds",
    "faststore",
    "queue",
    "stream",
    "notifications",
    "inference",
    "ai",
    "console",
    "authentik-server",
    "authentik-worker",
];

const BLOCKED_SUFFIXES: &[&str] = &[
    ".localhost",
    ".local",
    ".internal",
    ".svc",
    ".cluster.local",
    ".invalid",
];

fn strip_host(host: &str) -> String {
    let mut h = host.trim().to_ascii_lowercase();
    if h.starts_with('[') && h.ends_with(']') && h.len() >= 2 {
        h = h[1..h.len() - 1].to_string();
    }
    while h.ends_with('.') {
        h.pop();
    }
    h
}

fn private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    a == 0
        || a == 127
        || a == 10
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (a == 192 && b == 88 && c == 99)
        || a >= 224
}

fn private_ipv6(ip: std::net::Ipv6Addr) -> bool {
    let h = ip.segments();
    if h.iter().all(|x| *x == 0) {
        return true;
    }
    if h[..7].iter().all(|x| *x == 0) && h[7] == 1 {
        return true;
    }
    if (h[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    if (h[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    if (h[0] & 0xff00) == 0xff00 {
        return true;
    }
    if h[0] == 0x2001 && h[1] == 0x0db8 {
        return true;
    }
    if h[0] == 0x2002 {
        return true;
    }
    // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d
    if let Some(v4) = ip.to_ipv4_mapped() {
        return private_ipv4(v4);
    }
    if h[0] == 0x0064 && h[1] == 0xff9b && h[2..6].iter().all(|x| *x == 0) {
        let addr = std::net::Ipv4Addr::new(
            ((h[6] >> 8) & 0xff) as u8,
            (h[6] & 0xff) as u8,
            ((h[7] >> 8) & 0xff) as u8,
            (h[7] & 0xff) as u8,
        );
        return private_ipv4(addr);
    }
    // ::/96 (IPv4-compatible, deprecated)
    if h[..6].iter().all(|x| *x == 0) {
        return true;
    }
    false
}

pub fn is_blocked_host(host: &str) -> bool {
    let h = strip_host(host);
    if h.is_empty() {
        return true;
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => private_ipv4(v4),
            IpAddr::V6(v6) => private_ipv6(v6),
        };
    }
    if BLOCKED_EXACT_HOSTS.contains(&h.as_str()) {
        return true;
    }
    if h == "metadata.google.internal" || h.ends_with(".metadata.google.internal") {
        return true;
    }
    BLOCKED_SUFFIXES
        .iter()
        .any(|suffix| h == suffix.trim_start_matches('.') || h.ends_with(suffix))
}

pub fn is_blocked_url(raw: &str) -> bool {
    let Ok(u) = Url::parse(raw) else {
        return true;
    };
    if u.scheme() != "http" && u.scheme() != "https" {
        return true;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return true;
    }
    let host = u.host_str().unwrap_or("");
    is_blocked_host(host)
}

async fn resolve_host(host: &str) -> Vec<String> {
    match tokio::net::lookup_host((host, 0u16)).await {
        Ok(addrs) => addrs.map(|a| a.ip().to_string()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Runtime SSRF check: sync host guard + DNS resolution of the hostname.
pub async fn assert_webhook_url_allowed(raw: &str) -> Result<(), String> {
    if is_blocked_url(raw) {
        return Err(format!(
            "blocked internal webhook URL ({})",
            truncate(raw, 120)
        ));
    }
    let Ok(u) = Url::parse(raw) else {
        return Err(format!("invalid webhook URL ({})", truncate(raw, 120)));
    };
    let host = strip_host(u.host_str().unwrap_or(""));
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    let addresses = resolve_host(&host).await;
    if addresses.is_empty() {
        // NXDOMAIN/offline: the fetch fails the same way.
        return Ok(());
    }
    for address in addresses {
        if address.parse::<IpAddr>().is_err() || is_blocked_host(&address) {
            return Err(format!(
                "blocked internal webhook URL ({host} resolved to {address})"
            ));
        }
    }
    Ok(())
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_loopback_and_metadata_targets() {
        for url in [
            "http://localhost:4001/v1/orgs",
            "http://127.0.0.1/",
            "http://10.0.0.5/",
            "http://172.16.0.1/",
            "http://192.168.1.10/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://iam:4001/v1/keys/verify",
            "http://notifications:4011/",
            "http://metadata.google.internal/",
            "file:///etc/passwd",
            "ftp://example.com/",
        ] {
            assert!(is_blocked_url(url), "expected blocked: {url}");
        }
        assert!(!is_blocked_url("https://hooks.example.com/abc"));
        assert!(is_blocked_host("gateway"));
    }
}
