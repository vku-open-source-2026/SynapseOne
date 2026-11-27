// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Notification rendering + provider adapters + retry policy.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::db::{NotificationRecord, PreferenceRecord};
use crate::ssrf::{resolve_webhook_target, WebhookTarget};

#[derive(Debug, Clone)]
pub struct DeliveryResult {
    pub ok: bool,
    pub error: Option<String>,
}

impl DeliveryResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(truncate(&message.into(), 300)),
        }
    }
}

fn template_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}").expect("template regex"))
}

/// Extract unique variable names from `{{var}}` placeholders.
pub fn extract_variables(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for caps in template_re().captures_iter(text) {
        let key = caps[1].to_string();
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// Reject malformed placeholders instead of silently storing them.
pub fn template_syntax_error(text: &str) -> Option<String> {
    if text.contains("{{") || text.contains("}}") {
        let stripped = template_re().replace_all(text, "");
        if stripped.contains("{{") || stripped.contains("}}") {
            return Some("malformed placeholder; use {{name}} with letters, digits, _, . or -".into());
        }
    }
    None
}

pub fn missing_variables(variables: &[String], data: &Value) -> Vec<String> {
    variables
        .iter()
        .filter(|key| {
            let mut current = data;
            for part in key.split('.') {
                match current.get(part) {
                    Some(next) if !next.is_null() => current = next,
                    _ => return true,
                }
            }
            false
        })
        .cloned()
        .collect()
}

/// Render `{{var}}` placeholders from the notification data. Unknown keys stay.
pub fn render_template(template: &str, data: &Value) -> String {
    template_re()
        .replace_all(template, |caps: &regex::Captures<'_>| {
            let key = &caps[1];
            let mut current = data;
            for part in key.split('.') {
                match current.get(part) {
                    Some(next) if !next.is_null() => current = next,
                    _ => return caps[0].to_string(),
                }
            }
            match current {
                Value::String(s) => s.clone(),
                Value::Null => caps[0].to_string(),
                other => other.to_string(),
            }
        })
        .into_owned()
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client")
    })
}

/// Build a one-shot client for a tenant-controlled webhook.
///
/// The URL keeps its original hostname, so reqwest still sends the matching
/// `Host` header and uses it for TLS SNI, but DNS resolution is replaced with
/// the addresses validated by `resolve_webhook_target`. Redirects stay
/// disabled: following one would require re-validating and re-pinning the new
/// hop, and the existing contract rejects webhook redirects. Proxies are
/// disabled for the same reason — a proxy would perform its own resolution and
/// defeat the pin.
fn webhook_client(target: &WebhookTarget) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .no_proxy();
    if !target.host_is_ip_literal() {
        builder = builder.resolve_to_addrs(target.dns_name(), target.addresses());
        // `url` preserves a trailing root dot while the guard strips it for
        // validation; pin both spellings so the client cannot fall back.
        if target.host() != target.dns_name() {
            builder = builder.resolve_to_addrs(target.host(), target.addresses());
        }
    }
    builder.build().map_err(|e| format!("http client: {e}"))
}

async fn post_json(
    client: &reqwest::Client,
    url: &str,
    body: &Value,
) -> Result<reqwest::Response, String> {
    client
        .post(url)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))
}

/// POST to a tenant webhook using only the validated, pinned addresses.
async fn post_json_webhook(
    target: &WebhookTarget,
    body: &Value,
) -> Result<reqwest::Response, String> {
    let client = webhook_client(target)?;
    post_json(&client, target.raw(), body).await
}

fn recipient_str<'a>(recipient: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| recipient.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

/// Consent decision shared by the local outbox and queue consumers.
///
/// An absent preference row means "no restriction" (the historical default).
/// An empty channel list also means all channels; a non-empty list is an
/// allowlist. `unsubscribed` always wins. This function is deliberately pure
/// so both delivery paths cannot drift apart again (audit F13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentDecision {
    Allowed,
    Unsubscribed,
    ChannelOptedOut,
}

impl ConsentDecision {
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allowed)
    }

    /// Stable machine-readable reason persisted on cancelled notifications.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Unsubscribed => "recipient_unsubscribed",
            Self::ChannelOptedOut => "recipient_channel_opted_out",
        }
    }
}

pub fn consent_decision(preference: Option<&PreferenceRecord>, channel: &str) -> ConsentDecision {
    let Some(preference) = preference else {
        return ConsentDecision::Allowed;
    };
    if preference.unsubscribed {
        return ConsentDecision::Unsubscribed;
    }
    if !preference.channels.is_empty()
        && !preference
            .channels
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(channel))
    {
        return ConsentDecision::ChannelOptedOut;
    }
    ConsentDecision::Allowed
}

/// Deliver one notification through the configured provider adapter.
pub async fn deliver(notification: &NotificationRecord) -> DeliveryResult {
    let text = render_template(&notification.body, &notification.metadata);
    let subject = render_template(&notification.subject, &notification.metadata);
    match notification.channel.as_str() {
        "webhook" => {
            let Some(url) = recipient_str(&notification.recipient, &["url", "webhookUrl"]) else {
                return DeliveryResult::fail("webhook recipient.url must be an http(s) URL");
            };
            if !url.to_ascii_lowercase().starts_with("http://")
                && !url.to_ascii_lowercase().starts_with("https://")
            {
                return DeliveryResult::fail("webhook recipient.url must be an http(s) URL");
            }
            let allow_private = env_bool("NOTIFICATIONS_WEBHOOK_ALLOW_PRIVATE")
                && std::env::var("NODE_ENV").as_deref() != Ok("production");
            let body = json!({
                "id": notification.id,
                "subject": subject,
                "body": text,
                "data": notification.metadata,
                "tenant": notification.tenant,
            });
            let response = if allow_private {
                post_json(client(), url, &body).await
            } else {
                // Validate and pin in one step. The HTTP client must never
                // perform a second, unvalidated DNS lookup (DNS rebinding).
                match resolve_webhook_target(url).await {
                    Ok(target) => post_json_webhook(&target, &body).await,
                    Err(error) => return DeliveryResult::fail(error),
                }
            };
            match response {
                Ok(response) => {
                    let status = response.status();
                    if status.is_redirection() {
                        return DeliveryResult::fail(format!("webhook redirect rejected ({status})"));
                    }
                    if status.is_success() {
                        DeliveryResult::ok()
                    } else {
                        DeliveryResult::fail(format!("webhook {status}"))
                    }
                }
                Err(error) => DeliveryResult::fail(error),
            }
        }
        "email" => {
            let relay = std::env::var("NOTIFICATIONS_EMAIL_RELAY_URL").unwrap_or_default();
            if relay.is_empty() {
                return DeliveryResult::fail("NOTIFICATIONS_EMAIL_RELAY_URL is not configured");
            }
            let Some(to) = recipient_str(&notification.recipient, &["email"]) else {
                return DeliveryResult::fail("email recipient missing");
            };
            let body = json!({
                "to": to,
                "subject": subject,
                "body": text,
                "notificationId": notification.id,
            });
            match post_json(client(), &relay, &body).await {
                Ok(response) if response.status().is_success() => DeliveryResult::ok(),
                Ok(response) => DeliveryResult::fail(format!("email relay {}", response.status())),
                Err(error) => DeliveryResult::fail(error),
            }
        }
        "sms" => {
            let relay = std::env::var("NOTIFICATIONS_SMS_RELAY_URL").unwrap_or_default();
            if relay.is_empty() {
                return DeliveryResult::fail("NOTIFICATIONS_SMS_RELAY_URL is not configured");
            }
            let Some(to) = recipient_str(&notification.recipient, &["phone"]) else {
                return DeliveryResult::fail("sms recipient missing");
            };
            let body = json!({
                "to": to,
                "body": text,
                "notificationId": notification.id,
            });
            match post_json(client(), &relay, &body).await {
                Ok(response) if response.status().is_success() => DeliveryResult::ok(),
                Ok(response) => DeliveryResult::fail(format!("sms relay {}", response.status())),
                Err(error) => DeliveryResult::fail(error),
            }
        }
        "push" => {
            let relay = std::env::var("NOTIFICATIONS_PUSH_RELAY_URL").unwrap_or_default();
            let token = recipient_str(&notification.recipient, &["pushToken", "token"]);
            let (false, Some(token)) = (relay.is_empty(), token) else {
                return DeliveryResult::fail("push relay/token not configured");
            };
            let body = json!({
                "token": token,
                "subject": subject,
                "body": text,
                "notificationId": notification.id,
            });
            match post_json(client(), &relay, &body).await {
                Ok(response) if response.status().is_success() => DeliveryResult::ok(),
                Ok(response) => DeliveryResult::fail(format!("push relay {}", response.status())),
                Err(error) => DeliveryResult::fail(error),
            }
        }
        "log" => {
            if std::env::var("NODE_ENV").as_deref() == Ok("production") {
                return DeliveryResult::fail("log channel is disabled in production");
            }
            tracing::info!(
                target: "notifications",
                "[log] {} {}: {}",
                notification.tenant,
                subject,
                text
            );
            DeliveryResult::ok()
        }
        other => DeliveryResult::fail(format!("unknown channel '{other}'")),
    }
}

pub fn backoff_seconds(attempt: usize) -> i64 {
    let base = std::env::var("NOTIFICATIONS_RETRY_BASE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5)
        .max(1);
    let exponent = attempt.saturating_sub(1).min(20) as u32;
    base.saturating_mul(2i64.saturating_pow(exponent))
        .min(3600)
}

fn env_bool(name: &str) -> bool {
    std::env::var(name).as_deref() == Ok("true")
}

pub fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_nested_placeholders_and_keeps_unknown() {
        let data = json!({"city": "Hanoi", "profile": {"name": "ACME"}});
        assert_eq!(
            render_template("Flood in {{ city }} at {{profile.name}} ({{missing}})", &data),
            "Flood in Hanoi at ACME ({{missing}})"
        );
        assert_eq!(render_template("{{a}}", &json!({"a": 2.5})), "2.5");
    }

    fn preference(channels: &[&str], unsubscribed: bool) -> PreferenceRecord {
        PreferenceRecord {
            tenant: "org:test".into(),
            recipient: "user:u1".into(),
            channels: channels.iter().map(|channel| channel.to_string()).collect(),
            unsubscribed,
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn consent_matrix_is_shared_for_every_channel() {
        for channel in crate::db::CHANNELS {
            // No row and an empty allowlist both mean all channels.
            assert_eq!(consent_decision(None, channel), ConsentDecision::Allowed);
            assert_eq!(
                consent_decision(Some(&preference(&[], false)), channel),
                ConsentDecision::Allowed
            );
            // A non-empty list only permits its members.
            assert_eq!(
                consent_decision(Some(&preference(&[channel], false)), channel),
                ConsentDecision::Allowed
            );
            assert_eq!(
                consent_decision(Some(&preference(&["email"], false)), channel),
                if *channel == "email" {
                    ConsentDecision::Allowed
                } else {
                    ConsentDecision::ChannelOptedOut
                }
            );
            // Unsubscribe overrides any channel allowlist.
            assert_eq!(
                consent_decision(Some(&preference(&[channel], true)), channel),
                ConsentDecision::Unsubscribed
            );
        }
        assert_eq!(
            consent_decision(Some(&preference(&["email"], false)), "LOG"),
            ConsentDecision::ChannelOptedOut
        );
        assert_eq!(
            consent_decision(Some(&preference(&["EMAIL"], false)), "email"),
            ConsentDecision::Allowed
        );
    }

    #[test]
    fn backoff_is_capped() {
        assert_eq!(backoff_seconds(1), 5);
        assert_eq!(backoff_seconds(2), 10);
        assert_eq!(backoff_seconds(20), 3600);
    }

    #[tokio::test]
    async fn webhook_client_connects_only_to_the_pinned_address_and_keeps_host() {
        use std::sync::Arc;

        use axum::http::HeaderMap;
        use axum::routing::post;
        use axum::{Json, Router};
        use tokio::net::TcpListener;

        let hosts = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let captured = hosts.clone();
        let app = Router::new().route(
            "/hook",
            post(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    let host = headers
                        .get("host")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    captured.lock().await.push(host);
                    Json(json!({"ok": true}))
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let target = crate::ssrf::WebhookTarget::for_test(
            &format!("http://rebind.example:{port}/hook"),
            "rebind.example",
            "rebind.example",
            vec![format!("127.0.0.1:{port}").parse().unwrap()],
        );
        let response = post_json_webhook(&target, &json!({"hello": "world"}))
            .await
            .expect("pinned request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let seen = hosts.lock().await;
        assert_eq!(seen.as_slice(), &[format!("rebind.example:{port}")]);
    }
}
