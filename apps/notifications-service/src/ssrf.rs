// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SSRF guard for tenant-controlled outbound webhook URLs.
//!
//! Mirrors the TypeScript guard: the host string is normalized and every
//! resolved address is checked (DNS rebinding), so neither literal private IPs
//! nor public names that resolve to internal addresses can reach the Docker
//! network or the cloud metadata endpoint.
//!
//! Validation alone is not enough: resolving a public address and then letting
//! the HTTP client resolve the hostname again leaves a DNS-rebinding window.
//! [`resolve_webhook_target`] therefore returns the validated socket addresses
//! and the delivery client pins them through reqwest's DNS override, keeping
//! the original URL host for the `Host` header and TLS SNI.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;

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

/// A validated webhook destination. `addresses` are the only socket addresses
/// the delivery client may connect to; `host` is retained for the `Host`
/// header and TLS SNI.
#[derive(Debug, Clone)]
pub struct WebhookTarget {
    /// Original URL string, preserved byte-for-byte for signed webhook URLs.
    raw: String,
    /// Hostname exactly as the URL parser presents it (lower-cased by `url`).
    host: String,
    /// Normalized hostname without IPv6 brackets or a trailing root dot.
    dns_name: String,
    addresses: Vec<SocketAddr>,
}

impl WebhookTarget {
    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn dns_name(&self) -> &str {
        &self.dns_name
    }

    pub fn addresses(&self) -> &[SocketAddr] {
        &self.addresses
    }

    pub fn host_is_ip_literal(&self) -> bool {
        self.dns_name.parse::<IpAddr>().is_ok()
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        raw: &str,
        host: &str,
        dns_name: &str,
        addresses: Vec<SocketAddr>,
    ) -> Self {
        Self {
            raw: raw.into(),
            host: host.into(),
            dns_name: dns_name.into(),
            addresses,
        }
    }
}

/// Injectable DNS lookup so tests can model an alternating/rebinding resolver.
pub type ResolveFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<SocketAddr>, String>> + Send + 'a>>;

pub trait HostResolver: Send + Sync {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

pub struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host, port))
                .await
                .map_err(|error| {
                    format!("webhook hostname could not be resolved ({host}): {error}")
                })?;
            Ok(addrs.collect())
        })
    }
}

/// Resolve and validate a tenant-controlled webhook URL exactly once.
///
/// This is the fail-closed runtime guard: malformed URLs, blocked literal
/// hosts, DNS failures and empty answers are rejected. Every returned address
/// is validated, and the caller must pin the connection to them (see
/// `delivery::post_json_webhook`).
pub async fn resolve_webhook_target(raw: &str) -> Result<WebhookTarget, String> {
    resolve_webhook_target_with(raw, &SystemResolver).await
}

pub async fn resolve_webhook_target_with<R: HostResolver>(
    raw: &str,
    resolver: &R,
) -> Result<WebhookTarget, String> {
    if is_blocked_url(raw) {
        return Err(format!(
            "blocked internal webhook URL ({})",
            truncate(raw, 120)
        ));
    }
    let Ok(u) = Url::parse(raw) else {
        return Err(format!("invalid webhook URL ({})", truncate(raw, 120)));
    };
    let host = u.host_str().unwrap_or("").trim().to_ascii_lowercase();
    let dns_name = strip_host(&host);
    if dns_name.is_empty() {
        return Err(format!("invalid webhook URL ({})", truncate(raw, 120)));
    }
    let port = u
        .port_or_known_default()
        .ok_or_else(|| format!("invalid webhook URL ({})", truncate(raw, 120)))?;

    if let Ok(ip) = dns_name.parse::<IpAddr>() {
        // Literal addresses were already checked by `is_blocked_url`; re-check
        // after normalization so bracket/zone variants cannot slip through.
        if is_blocked_host(&ip.to_string()) {
            return Err(format!(
                "blocked internal webhook URL ({})",
                truncate(raw, 120)
            ));
        }
        return Ok(WebhookTarget {
            raw: raw.to_string(),
            host,
            dns_name,
            addresses: vec![SocketAddr::new(ip, port)],
        });
    }

    let resolved = resolver.resolve(&dns_name, port).await?;
    let mut addresses = Vec::with_capacity(resolved.len());
    for address in resolved {
        let ip = address.ip();
        if is_blocked_host(&ip.to_string()) {
            return Err(format!(
                "blocked internal webhook URL ({dns_name} resolved to {ip})"
            ));
        }
        let address = SocketAddr::new(
            ip,
            if address.port() == 0 {
                port
            } else {
                address.port()
            },
        );
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    if addresses.is_empty() {
        // Fail closed: an answer with no usable address must not fall through
        // to a second, unvalidated resolution inside the HTTP client.
        return Err(format!(
            "webhook hostname resolved to no addresses ({dns_name})"
        ));
    }
    Ok(WebhookTarget {
        raw: raw.to_string(),
        host,
        dns_name,
        addresses,
    })
}

/// Backwards-compatible validation-only entry point.
#[allow(dead_code)]
pub async fn assert_webhook_url_allowed(raw: &str) -> Result<(), String> {
    resolve_webhook_target(raw).await.map(|_| ())
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

    #[tokio::test]
    async fn pins_the_validated_answer_instead_of_asking_dns_twice() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct AlternatingResolver {
            calls: AtomicUsize,
        }

        impl HostResolver for AlternatingResolver {
            fn resolve<'a>(&'a self, _host: &'a str, port: u16) -> ResolveFuture<'a> {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                let ip: IpAddr = if call == 0 {
                    "93.184.216.34".parse().unwrap()
                } else {
                    // A rebinding resolver would hand the client loopback on
                    // the second lookup. The guard must never ask twice.
                    "127.0.0.1".parse().unwrap()
                };
                Box::pin(async move { Ok(vec![SocketAddr::new(ip, port)]) })
            }
        }

        let resolver = AlternatingResolver {
            calls: AtomicUsize::new(0),
        };
        let target = resolve_webhook_target_with("https://rebind.example/hook", &resolver)
            .await
            .expect("public answer allowed");
        assert_eq!(resolver.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            target.addresses(),
            &[SocketAddr::new("93.184.216.34".parse().unwrap(), 443)]
        );
        assert!(target
            .addresses()
            .iter()
            .all(|address| !is_blocked_host(&address.ip().to_string())));
        // The original hostname survives for Host/SNI.
        assert_eq!(target.host(), "rebind.example");
    }

    struct StaticResolver(Vec<SocketAddr>);

    impl HostResolver for StaticResolver {
        fn resolve<'a>(&'a self, _host: &'a str, _port: u16) -> ResolveFuture<'a> {
            let addresses = self.0.clone();
            Box::pin(async move { Ok(addresses) })
        }
    }

    #[tokio::test]
    async fn fails_closed_for_unresolvable_or_private_answers() {
        let empty = StaticResolver(vec![]);
        assert!(
            resolve_webhook_target_with("https://empty.example/hook", &empty)
                .await
                .is_err(),
            "an empty DNS answer must not fall through to a second resolution"
        );

        let private = StaticResolver(vec![SocketAddr::new("10.0.0.7".parse().unwrap(), 443)]);
        let error = resolve_webhook_target_with("https://private.example/hook", &private)
            .await
            .expect_err("private answer blocked");
        assert!(error.contains("10.0.0.7"));
    }

    #[tokio::test]
    async fn literal_public_address_is_pinned_without_dns() {
        let target = resolve_webhook_target("http://93.184.216.34:8080/hook")
            .await
            .expect("public literal allowed");
        assert_eq!(
            target.addresses(),
            &[SocketAddr::new("93.184.216.34".parse().unwrap(), 8080)]
        );
        assert!(resolve_webhook_target("http://127.0.0.1/").await.is_err());
        assert!(resolve_webhook_target("http://[::1]/").await.is_err());
    }
}
