// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Header trust boundary and request-id hygiene.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{HeaderMap, HeaderName, HeaderValue};

use crate::auth::Principal;
use crate::routes::AuthMode;

const CANONICAL_PREFIX: &str = "x-synapseone-";
const LEGACY_PREFIX: &str = "x-synapsedx-";

/// Xóa `x-synapseone-*` do client gửi (chống spoof), ghi lại từ principal đã
/// verify. `x-synapseone-tenant` is the one intentional pass-through: platform
/// callers (no principal) use it to select a tenant, and the SDKs document it.
/// Legacy `x-synapsedx-tenant` is normalised into the canonical name.
pub fn propagate_principal(
    headers: &mut HeaderMap,
    principal: Option<&Principal>,
    route_auth: Option<AuthMode>,
    internal_secret: &str,
) {
    let legacy_tenant = headers.get("x-synapsedx-tenant").cloned();
    let remove = headers
        .keys()
        .filter(|name| {
            let value = name.as_str();
            (value.starts_with(CANONICAL_PREFIX) && value != "x-synapseone-tenant")
                || (value.starts_with(LEGACY_PREFIX) && value != "x-synapsedx-tenant")
        })
        .cloned()
        .collect::<Vec<_>>();
    for name in remove {
        headers.remove(name);
    }

    if let Some(tenant) = legacy_tenant {
        if !headers.contains_key("x-synapseone-tenant") {
            headers.insert("x-synapseone-tenant", tenant);
        }
    }

    // Service-to-service credential: set AFTER stripping client input but
    // BEFORE the principal check — unauthenticated routes need it too.
    if !internal_secret.is_empty() {
        insert(headers, "x-synapseone-internal", internal_secret);
    }

    if let Some(principal) = principal {
        if principal.r#type == "jwt" {
            if let Some(sub) = &principal.sub {
                insert(headers, "x-synapseone-user", sub);
            }
            if let Some(org) = &principal.org {
                insert(headers, "x-synapseone-org", org);
            }
            if let Some(account) = &principal.account {
                insert(headers, "x-synapseone-account", account);
            }
            if !principal.scopes.is_empty() {
                insert(headers, "x-synapseone-scopes", &principal.scopes.join(","));
            }
            insert(
                headers,
                "x-synapseone-kind",
                principal.kind.as_deref().unwrap_or("user"),
            );
        } else if principal.r#type == "apikey" {
            insert(headers, "x-synapseone-kind", "apikey");
            if let Some(org) = &principal.org {
                insert(headers, "x-synapseone-org", org);
            }
            if let Some(account) = &principal.account {
                insert(headers, "x-synapseone-account", account);
            }
            // A user-bound API key (verified IAM `user_id`) acts **for that
            // user**: stamp the owner so workflow/audit/data-plane attribution
            // and owner-only policies see the real user. `kind` stays `apikey`
            // so the credential keeps machine semantics. Account-level keys have
            // no owner and remain pure machines (no `x-synapseone-user`).
            // Client-supplied user headers were stripped above.
            if let Some(owner) = principal.owner.as_ref().filter(|value| !value.is_empty()) {
                insert(headers, "x-synapseone-user", owner);
            }
            if !principal.scopes.is_empty() {
                insert(headers, "x-synapseone-scopes", &principal.scopes.join(","));
            }
        }
    } else if route_auth == Some(AuthMode::None) {
        // Public route with no credential: marker distinguishes a public
        // anonymous visitor from marker-less internal platform context.
        insert(headers, "x-synapseone-anon", "1");
    }

    // Mirror canonical headers onto the legacy prefix for rolling deploys.
    // Values were stripped above, so this cannot amplify client identity.
    for name in [
        "user", "org", "account", "scopes", "kind", "internal", "anon",
    ] {
        if let Some(value) = headers.get(format!("x-synapseone-{name}")).cloned() {
            headers.insert(HeaderName::from_static(legacy_static(name)), value);
        }
    }
}

fn legacy_static(name: &str) -> &'static str {
    match name {
        "user" => "x-synapsedx-user",
        "org" => "x-synapsedx-org",
        "account" => "x-synapsedx-account",
        "scopes" => "x-synapsedx-scopes",
        "kind" => "x-synapsedx-kind",
        "internal" => "x-synapsedx-internal",
        "anon" => "x-synapsedx-anon",
        _ => "x-synapsedx-kind",
    }
}

fn insert(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

pub fn sanitize_request_id(incoming: &str) -> String {
    incoming
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || "._~-".contains(*value))
        .take(128)
        .collect()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Client IDs are kept when sane; otherwise generate a traceable unique id.
pub fn request_id(headers: &HeaderMap) -> String {
    let incoming = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(sanitize_request_id)
        .unwrap_or_default();
    if !incoming.is_empty() {
        return incoming;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{}",
        base36(now),
        base36(0x9e37_79b9_7f4a_7c15 ^ counter)
    )
}

fn base36(mut value: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        output.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).unwrap_or_else(|_| "0".into())
}

pub const SECURITY_HEADERS: [(&str, &str); 4] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    (
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
    ),
];

pub const HSTS_HEADER: (&str, &str) = (
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
);
