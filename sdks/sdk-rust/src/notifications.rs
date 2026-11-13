// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseNotifications: outbox, templates and preferences.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// Notifications service handle.
#[derive(Clone)]
pub struct NotificationsService {
    client: Client,
}

impl NotificationsService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn send(
        &self,
        recipient: Value,
        body: &str,
        channel: Option<&str>,
        channels: Option<Vec<String>>,
        subject: &str,
        data: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value> {
        let mut payload = json!({
            "recipient": recipient,
            "body": body,
            "subject": subject,
        });
        if let Some(channel) = channel {
            payload["channel"] = json!(channel);
        }
        if let Some(channels) = channels {
            payload["channels"] = json!(channels);
        }
        if let Some(data) = data {
            payload["data"] = data;
        }
        if let Some(idempotency_key) = idempotency_key {
            payload["idempotencyKey"] = json!(idempotency_key);
        }
        let request = crate::client::Request::post("/v1/notifications")
            .json(Some(payload))
            .maybe_idempotency(idempotency_key);
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn get(&self, notification_id: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/notifications/{}", segment(notification_id)))
            .await
    }

    pub async fn list(&self, status: Option<&str>, limit: u32) -> Result<Value> {
        let mut params = vec![("limit", limit.to_string())];
        if let Some(status) = status {
            params.push(("status", status.to_string()));
        }
        self.client
            .get(format!("/v1/notifications?{}", query_string(&params)))
            .await
    }

    pub async fn cancel(&self, notification_id: &str) -> Result<Value> {
        self.client
            .post(
                format!("/v1/notifications/{}/cancel", segment(notification_id)),
                json!({}),
            )
            .await
    }

    pub async fn get_preference(&self, recipient: &str) -> Result<Value> {
        self.client
            .get(format!(
                "/v1/notifications/preferences/{}",
                segment(recipient)
            ))
            .await
    }

    pub async fn set_preference(
        &self,
        recipient: &str,
        channels: Option<Vec<String>>,
        unsubscribed: Option<bool>,
    ) -> Result<Value> {
        let mut payload = serde_json::Map::new();
        if let Some(channels) = channels {
            payload.insert("channels".to_string(), json!(channels));
        }
        if let Some(unsubscribed) = unsubscribed {
            payload.insert("unsubscribed".to_string(), json!(unsubscribed));
        }
        self.client
            .put(
                format!("/v1/notifications/preferences/{}", segment(recipient)),
                Value::Object(payload),
            )
            .await
    }

    pub async fn unsubscribe(&self, recipient: &str) -> Result<Value> {
        self.client
            .post(
                "/v1/notifications/unsubscribe",
                json!({ "recipient": recipient }),
            )
            .await
    }
}
