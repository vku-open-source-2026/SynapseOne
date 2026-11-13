// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Notification rendering + provider adapters + retry policy.

use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::{json, Value};

use crate::db::NotificationRecord;
use crate::ssrf::assert_webhook_url_allowed;

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

async fn post_json(url: &str, body: &Value) -> Result<reqwest::Response, String> {
    client()
        .post(url)
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))
}

fn recipient_str<'a>(recipient: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| recipient.get(*key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
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
            if !allow_private {
                if let Err(error) = assert_webhook_url_allowed(url).await {
                    return DeliveryResult::fail(error);
                }
            }
            let body = json!({
                "id": notification.id,
                "subject": subject,
                "body": text,
                "data": notification.metadata,
                "tenant": notification.tenant,
            });
            match post_json(url, &body).await {
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
            match post_json(&relay, &body).await {
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
            match post_json(&relay, &body).await {
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
            match post_json(&relay, &body).await {
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

    #[test]
    fn backoff_is_capped() {
        assert_eq!(backoff_seconds(1), 5);
        assert_eq!(backoff_seconds(2), 10);
        assert_eq!(backoff_seconds(20), 3600);
    }
}
