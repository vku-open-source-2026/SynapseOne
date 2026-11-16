// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseStream: topics, fan-out reads and consumer groups.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// Stream service handle.
#[derive(Clone)]
pub struct StreamService {
    client: Client,
}

impl StreamService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn topic(topic: &str) -> String {
        format!("/v1/stream/topics/{}", segment(topic))
    }

    fn group_path(topic: &str, group: &str) -> String {
        format!("{}/groups/{}", Self::topic(topic), segment(group))
    }

    pub async fn list_topics(&self) -> Result<Value> {
        self.client.get("/v1/stream/topics").await
    }

    pub async fn create_topic(
        &self,
        topic: &str,
        max_len: Option<u64>,
        min_id: Option<&str>,
        retention_ms: Option<u64>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(max_len) = max_len {
            body.insert("maxLen".to_string(), json!(max_len));
        }
        if let Some(min_id) = min_id {
            body.insert("minId".to_string(), json!(min_id));
        }
        if let Some(retention_ms) = retention_ms {
            body.insert("retentionMs".to_string(), json!(retention_ms));
        }
        self.client
            .put(Self::topic(topic), Value::Object(body))
            .await
    }

    pub async fn get_topic(&self, topic: &str) -> Result<Value> {
        self.client.get(Self::topic(topic)).await
    }

    pub async fn delete_topic(&self, topic: &str) -> Result<Value> {
        self.client.delete(Self::topic(topic)).await
    }

    pub async fn topic_stats(&self, topic: &str) -> Result<Value> {
        self.client
            .get(format!("{}/stats", Self::topic(topic)))
            .await
    }

    pub async fn publish(
        &self,
        topic: &str,
        payload: Value,
        key: Option<&str>,
        headers: Option<Value>,
        id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "payload": payload });
        if let Some(key) = key {
            body["key"] = json!(key);
        }
        if let Some(headers) = headers {
            body["headers"] = headers;
        }
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        self.client
            .post(format!("{}/events", Self::topic(topic)), body)
            .await
    }

    pub async fn publish_batch(&self, topic: &str, events: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/events:batch", Self::topic(topic)),
                json!({ "events": events }),
            )
            .await
    }

    pub async fn read(
        &self,
        topic: &str,
        from_id: Option<&str>,
        count: Option<u32>,
        block_ms: Option<u32>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(from_id) = from_id {
            body.insert("fromId".to_string(), json!(from_id));
        }
        if let Some(count) = count {
            body.insert("count".to_string(), json!(count));
        }
        if let Some(block_ms) = block_ms {
            body.insert("blockMs".to_string(), json!(block_ms));
        }
        self.client
            .post(format!("{}/read", Self::topic(topic)), Value::Object(body))
            .await
    }

    pub async fn range(
        &self,
        topic: &str,
        start: Option<&str>,
        end: Option<&str>,
        count: Option<u32>,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(start) = start {
            params.push(("start", start.to_string()));
        }
        if let Some(end) = end {
            params.push(("end", end.to_string()));
        }
        if let Some(count) = count {
            params.push(("count", count.to_string()));
        }
        let path = if params.is_empty() {
            format!("{}/range", Self::topic(topic))
        } else {
            format!("{}/range?{}", Self::topic(topic), query_string(&params))
        };
        self.client.get(path).await
    }

    pub async fn create_group(
        &self,
        topic: &str,
        group: &str,
        start_id: Option<&str>,
    ) -> Result<Value> {
        let body = match start_id {
            Some(start_id) => json!({ "startId": start_id }),
            None => json!({}),
        };
        self.client.put(Self::group_path(topic, group), body).await
    }

    pub async fn destroy_group(&self, topic: &str, group: &str) -> Result<Value> {
        self.client.delete(Self::group_path(topic, group)).await
    }

    pub async fn read_group(
        &self,
        topic: &str,
        group: &str,
        consumer: &str,
        count: Option<u32>,
        block_ms: Option<u32>,
        auto_ack: Option<bool>,
    ) -> Result<Value> {
        let mut body = json!({ "consumer": consumer });
        if let Some(count) = count {
            body["count"] = json!(count);
        }
        if let Some(block_ms) = block_ms {
            body["blockMs"] = json!(block_ms);
        }
        if let Some(auto_ack) = auto_ack {
            body["autoAck"] = json!(auto_ack);
        }
        self.client
            .post(format!("{}/read", Self::group_path(topic, group)), body)
            .await
    }

    pub async fn ack(&self, topic: &str, group: &str, ids: Vec<String>) -> Result<Value> {
        self.client
            .post(
                format!("{}/ack", Self::group_path(topic, group)),
                json!({ "ids": ids }),
            )
            .await
    }
}
