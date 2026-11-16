// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseQueue: at-least-once queues, leases, retries and dead letters.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// Queue service handle.
#[derive(Clone)]
pub struct QueueService {
    client: Client,
}

impl QueueService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn path(queue: &str) -> String {
        format!("/v1/queue/queues/{}", segment(queue))
    }

    pub async fn list_queues(&self) -> Result<Value> {
        self.client.get("/v1/queue/queues").await
    }

    pub async fn create_queue(
        &self,
        queue: &str,
        max_attempts: Option<u32>,
        visibility_timeout_seconds: Option<u32>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(max_attempts) = max_attempts {
            body.insert("maxAttempts".to_string(), json!(max_attempts));
        }
        if let Some(visibility_timeout_seconds) = visibility_timeout_seconds {
            body.insert(
                "visibilityTimeoutSeconds".to_string(),
                json!(visibility_timeout_seconds),
            );
        }
        self.client
            .put(Self::path(queue), Value::Object(body))
            .await
    }

    pub async fn get_queue(&self, queue: &str) -> Result<Value> {
        self.client.get(Self::path(queue)).await
    }

    pub async fn delete_queue(&self, queue: &str) -> Result<Value> {
        self.client.delete(Self::path(queue)).await
    }

    pub async fn purge_queue(&self, queue: &str) -> Result<Value> {
        self.client
            .post(format!("{}/purge", Self::path(queue)), json!({}))
            .await
    }

    pub async fn queue_stats(&self, queue: &str) -> Result<Value> {
        self.client
            .get(format!("{}/stats", Self::path(queue)))
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn publish(
        &self,
        queue: &str,
        payload: Value,
        delay_seconds: Option<u32>,
        max_attempts: Option<u32>,
        headers: Option<Value>,
        id: Option<&str>,
        dedupe_key: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "payload": payload });
        if let Some(delay_seconds) = delay_seconds {
            body["delaySeconds"] = json!(delay_seconds);
        }
        if let Some(max_attempts) = max_attempts {
            body["maxAttempts"] = json!(max_attempts);
        }
        if let Some(headers) = headers {
            body["headers"] = headers;
        }
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        if let Some(dedupe_key) = dedupe_key {
            body["dedupeKey"] = json!(dedupe_key);
        }
        self.client
            .post(format!("{}/messages", Self::path(queue)), body)
            .await
    }

    pub async fn publish_batch(&self, queue: &str, messages: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/messages:batch", Self::path(queue)),
                json!({ "messages": messages }),
            )
            .await
    }

    pub async fn consume(
        &self,
        queue: &str,
        max_messages: Option<u32>,
        visibility_timeout_seconds: Option<u32>,
        consumer: Option<&str>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(max_messages) = max_messages {
            body.insert("maxMessages".to_string(), json!(max_messages));
        }
        if let Some(visibility_timeout_seconds) = visibility_timeout_seconds {
            body.insert(
                "visibilityTimeoutSeconds".to_string(),
                json!(visibility_timeout_seconds),
            );
        }
        if let Some(consumer) = consumer {
            body.insert("consumer".to_string(), json!(consumer));
        }
        self.client
            .post(
                format!("{}/consume", Self::path(queue)),
                Value::Object(body),
            )
            .await
    }

    pub async fn ack(&self, queue: &str, receipt: &str) -> Result<Value> {
        self.client
            .post(
                format!("{}/ack", Self::path(queue)),
                json!({ "receipt": receipt }),
            )
            .await
    }

    pub async fn ack_many(&self, queue: &str, receipts: Vec<String>) -> Result<Value> {
        self.client
            .post(
                format!("{}/ack", Self::path(queue)),
                json!({ "receipts": receipts }),
            )
            .await
    }

    pub async fn nack(
        &self,
        queue: &str,
        receipt: &str,
        requeue: bool,
        delay_seconds: Option<u32>,
        error: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "receipt": receipt, "requeue": requeue });
        if let Some(delay_seconds) = delay_seconds {
            body["delaySeconds"] = json!(delay_seconds);
        }
        if let Some(error) = error {
            body["error"] = json!(error);
        }
        self.client
            .post(format!("{}/nack", Self::path(queue)), body)
            .await
    }

    pub async fn heartbeat(
        &self,
        queue: &str,
        receipt: &str,
        visibility_timeout_seconds: Option<u32>,
    ) -> Result<Value> {
        let mut body = json!({ "receipt": receipt });
        if let Some(visibility_timeout_seconds) = visibility_timeout_seconds {
            body["visibilityTimeoutSeconds"] = json!(visibility_timeout_seconds);
        }
        self.client
            .post(format!("{}/heartbeat", Self::path(queue)), body)
            .await
    }

    pub async fn peek(&self, queue: &str, limit: Option<u32>, ready: bool) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if ready {
            params.push(("ready", "true".to_string()));
        }
        let path = if params.is_empty() {
            format!("{}/messages", Self::path(queue))
        } else {
            format!("{}/messages?{}", Self::path(queue), query_string(&params))
        };
        self.client.get(path).await
    }

    pub async fn dead_letters(&self, queue: &str, limit: Option<u32>) -> Result<Value> {
        let path = match limit {
            Some(limit) => format!(
                "{}/dead?{}",
                Self::path(queue),
                query_string(&[("limit", limit.to_string())])
            ),
            None => format!("{}/dead", Self::path(queue)),
        };
        self.client.get(path).await
    }

    pub async fn replay_dead(
        &self,
        queue: &str,
        message_id: &str,
        delay_seconds: Option<u32>,
        reset_attempts: bool,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(delay_seconds) = delay_seconds {
            body.insert("delaySeconds".to_string(), json!(delay_seconds));
        }
        if reset_attempts {
            body.insert("resetAttempts".to_string(), json!(true));
        }
        self.client
            .post(
                format!("{}/dead/{}/replay", Self::path(queue), segment(message_id)),
                Value::Object(body),
            )
            .await
    }

    pub async fn delete_dead(&self, queue: &str, message_id: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{}/dead/{}",
                Self::path(queue),
                segment(message_id)
            ))
            .await
    }
}
