// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Pluggable stream engines: Valkey/Redis Streams in production, an in-memory
//! log for dev/tests.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use redis::aio::ConnectionManager;
use redis::streams::{
    StreamAddOptions, StreamAutoClaimOptions, StreamAutoClaimReply, StreamReadOptions,
    StreamReadReply, StreamTrimStrategy, StreamTrimmingMode,
};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct StreamError {
    pub code: &'static str,
    pub message: String,
}

impl StreamError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicConfig {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_len: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_ms: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub id: String,
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<Value>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Default)]
pub struct PublishInput {
    pub payload: Value,
    pub key: Option<String>,
    pub headers: Option<Value>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub from_id: Option<String>,
    pub count: Option<i64>,
    pub block_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct GroupReadOptions {
    pub consumer: String,
    pub count: Option<i64>,
    pub block_ms: Option<i64>,
    pub auto_ack: bool,
    /// Reclaim unacknowledged entries after this many milliseconds. `None` or
    /// zero disables reclaim; the API default is 30s.
    pub claim_idle_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerGroupInfo {
    pub name: String,
    pub consumers: usize,
    pub pending: usize,
    pub last_delivered_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicStats {
    pub topic: String,
    pub length: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_id: Option<String>,
    pub groups_count: usize,
    pub groups: Vec<ConsumerGroupInfo>,
}

#[derive(Clone)]
pub enum Engine {
    Memory(MemoryEngine),
    Redis(RedisEngine),
}

impl Engine {
    pub fn name(&self) -> &'static str {
        match self {
            Engine::Memory(_) => "memory",
            Engine::Redis(_) => "redis",
        }
    }

    pub async fn create_topic(
        &self,
        tenant: &str,
        name: &str,
        max_len: Option<i64>,
        min_id: Option<String>,
        retention_ms: Option<i64>,
    ) -> Result<TopicConfig, StreamError> {
        match self {
            Engine::Memory(engine) => engine
                .create_topic(tenant, name, max_len, min_id, retention_ms)
                .await,
            Engine::Redis(engine) => engine
                .create_topic(tenant, name, max_len, min_id, retention_ms)
                .await,
        }
    }

    pub async fn get_topic(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<TopicConfig>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.get_topic(tenant, name).await,
            Engine::Redis(engine) => engine.get_topic(tenant, name).await,
        }
    }

    pub async fn list_topics(&self, tenant: &str) -> Result<Vec<TopicConfig>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.list_topics(tenant).await,
            Engine::Redis(engine) => engine.list_topics(tenant).await,
        }
    }

    pub async fn delete_topic(&self, tenant: &str, name: &str) -> Result<bool, StreamError> {
        match self {
            Engine::Memory(engine) => engine.delete_topic(tenant, name).await,
            Engine::Redis(engine) => engine.delete_topic(tenant, name).await,
        }
    }

    pub async fn topic_stats(&self, tenant: &str, name: &str) -> Result<TopicStats, StreamError> {
        match self {
            Engine::Memory(engine) => engine.topic_stats(tenant, name).await,
            Engine::Redis(engine) => engine.topic_stats(tenant, name).await,
        }
    }

    pub async fn publish(
        &self,
        tenant: &str,
        topic: &str,
        input: PublishInput,
    ) -> Result<StreamEvent, StreamError> {
        match self {
            Engine::Memory(engine) => engine.publish(tenant, topic, input).await,
            Engine::Redis(engine) => engine.publish(tenant, topic, input).await,
        }
    }

    pub async fn publish_batch(
        &self,
        tenant: &str,
        topic: &str,
        inputs: Vec<PublishInput>,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.publish_batch(tenant, topic, inputs).await,
            Engine::Redis(engine) => engine.publish_batch(tenant, topic, inputs).await,
        }
    }

    pub async fn read(
        &self,
        tenant: &str,
        topic: &str,
        options: ReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.read(tenant, topic, options).await,
            Engine::Redis(engine) => engine.read(tenant, topic, options).await,
        }
    }

    pub async fn create_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        start_id: &str,
    ) -> Result<bool, StreamError> {
        match self {
            Engine::Memory(engine) => engine.create_group(tenant, topic, group, start_id).await,
            Engine::Redis(engine) => engine.create_group(tenant, topic, group, start_id).await,
        }
    }

    pub async fn destroy_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
    ) -> Result<bool, StreamError> {
        match self {
            Engine::Memory(engine) => engine.destroy_group(tenant, topic, group).await,
            Engine::Redis(engine) => engine.destroy_group(tenant, topic, group).await,
        }
    }

    pub async fn read_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        options: GroupReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.read_group(tenant, topic, group, options).await,
            Engine::Redis(engine) => engine.read_group(tenant, topic, group, options).await,
        }
    }

    pub async fn ack(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        ids: &[String],
    ) -> Result<i64, StreamError> {
        match self {
            Engine::Memory(engine) => engine.ack(tenant, topic, group, ids).await,
            Engine::Redis(engine) => engine.ack(tenant, topic, group, ids).await,
        }
    }

    pub async fn range(
        &self,
        tenant: &str,
        topic: &str,
        start: &str,
        end: &str,
        count: i64,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        match self {
            Engine::Memory(engine) => engine.range(tenant, topic, start, end, count).await,
            Engine::Redis(engine) => engine.range(tenant, topic, start, end, count).await,
        }
    }

}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn compare_ids(a: &str, b: &str) -> i64 {
    let parse = |value: &str| -> (i64, i64) {
        let mut parts = value.split('-');
        let ms = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let seq = parts.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        (ms, seq)
    };
    let (ms_a, seq_a) = parse(a);
    let (ms_b, seq_b) = parse(b);
    if ms_a != ms_b {
        ms_a - ms_b
    } else {
        seq_a - seq_b
    }
}

// ---- in-memory engine ----

#[derive(Default)]
struct MemoryState {
    topics: HashMap<String, TopicConfig>,
    streams: HashMap<String, Vec<StreamEvent>>,
    groups: HashMap<String, HashMap<String, GroupState>>,
    last_timestamp: i64,
    sequence: i64,
}

#[derive(Clone)]
struct GroupState {
    last_delivered_id: String,
    consumers: std::collections::HashSet<String>,
    pending: HashMap<String, (String, i64)>,
}

#[derive(Clone, Default)]
pub struct MemoryEngine {
    state: std::sync::Arc<Mutex<MemoryState>>,
}

impl MemoryEngine {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(tenant: &str, name: &str) -> String {
        format!("{tenant}:{name}")
    }

    fn next_id(state: &mut MemoryState, custom: Option<&str>) -> Result<String, StreamError> {
        if let Some(custom) = custom {
            let valid = !custom.is_empty()
                && custom
                    .split('-')
                    .count()
                    == 2
                && custom.split('-').all(|part| part.parse::<u64>().is_ok());
            if !valid {
                return Err(StreamError::new(
                    "invalid",
                    "Custom stream ID must match <milliseconds>-<sequence>",
                ));
            }
            return Ok(custom.to_string());
        }
        let now = now_ms();
        if now == state.last_timestamp {
            state.sequence += 1;
        } else {
            state.last_timestamp = now;
            state.sequence = 0;
        }
        Ok(format!("{}-{}", state.last_timestamp, state.sequence))
    }

    pub async fn create_topic(
        &self,
        tenant: &str,
        name: &str,
        max_len: Option<i64>,
        min_id: Option<String>,
        retention_ms: Option<i64>,
    ) -> Result<TopicConfig, StreamError> {
        let mut state = self.state.lock().await;
        let key = Self::key(tenant, name);
        let existing = state.topics.get(&key).cloned();
        let now = now_ms();
        let topic = TopicConfig {
            name: name.to_string(),
            max_len: max_len
                .map(|value| value.max(0))
                .or(existing.as_ref().and_then(|topic| topic.max_len)),
            min_id: min_id.or(existing.as_ref().and_then(|topic| topic.min_id.clone())),
            retention_ms: retention_ms
                .map(|value| value.max(0))
                .or(existing.as_ref().and_then(|topic| topic.retention_ms)),
            created_at: existing.as_ref().map(|topic| topic.created_at).unwrap_or(now),
            updated_at: now,
        };
        state.topics.insert(key.clone(), topic.clone());
        state.streams.entry(key).or_default();
        Ok(topic)
    }

    pub async fn get_topic(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<TopicConfig>, StreamError> {
        Ok(self.state.lock().await.topics.get(&Self::key(tenant, name)).cloned())
    }

    pub async fn list_topics(&self, tenant: &str) -> Result<Vec<TopicConfig>, StreamError> {
        let state = self.state.lock().await;
        let prefix = format!("{tenant}:");
        Ok(state
            .topics
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, topic)| topic.clone())
            .collect())
    }

    pub async fn delete_topic(&self, tenant: &str, name: &str) -> Result<bool, StreamError> {
        let mut state = self.state.lock().await;
        let key = Self::key(tenant, name);
        let deleted = state.topics.remove(&key).is_some();
        state.streams.remove(&key);
        state.groups.remove(&key);
        Ok(deleted)
    }

    pub async fn topic_stats(&self, tenant: &str, name: &str) -> Result<TopicStats, StreamError> {
        let state = self.state.lock().await;
        let key = Self::key(tenant, name);
        let events = state.streams.get(&key).cloned().unwrap_or_default();
        let groups = state.groups.get(&key).cloned().unwrap_or_default();
        let group_infos = groups
            .iter()
            .map(|(group_name, group)| ConsumerGroupInfo {
                name: group_name.clone(),
                consumers: group.consumers.len(),
                pending: group.pending.len(),
                last_delivered_id: group.last_delivered_id.clone(),
            })
            .collect::<Vec<_>>();
        Ok(TopicStats {
            topic: name.to_string(),
            length: events.len() as i64,
            first_id: events.first().map(|event| event.id.clone()),
            last_id: events.last().map(|event| event.id.clone()),
            groups_count: group_infos.len(),
            groups: group_infos,
        })
    }

    pub async fn publish(
        &self,
        tenant: &str,
        topic_name: &str,
        input: PublishInput,
    ) -> Result<StreamEvent, StreamError> {
        let mut state = self.state.lock().await;
        let key = Self::key(tenant, topic_name);
        if !state.topics.contains_key(&key) {
            let now = now_ms();
            state.topics.insert(
                key.clone(),
                TopicConfig {
                    name: topic_name.to_string(),
                    max_len: None,
                    min_id: None,
                    retention_ms: None,
                    created_at: now,
                    updated_at: now,
                },
            );
        }
        let topic = state.topics.get(&key).cloned().unwrap();
        let id = Self::next_id(&mut state, input.id.as_deref())?;
        let event = StreamEvent {
            id,
            payload: input.payload,
            key: input.key,
            headers: input.headers,
            timestamp: now_ms(),
        };
        let events = state.streams.entry(key).or_default();
        events.push(event.clone());
        if let Some(max_len) = topic.max_len {
            if max_len > 0 && events.len() as i64 > max_len {
                let drop = events.len() - max_len as usize;
                events.drain(0..drop);
            }
        }
        Ok(event)
    }

    pub async fn publish_batch(
        &self,
        tenant: &str,
        topic: &str,
        inputs: Vec<PublishInput>,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let mut events = Vec::with_capacity(inputs.len());
        for input in inputs {
            events.push(self.publish(tenant, topic, input).await?);
        }
        Ok(events)
    }

    pub async fn read(
        &self,
        tenant: &str,
        topic: &str,
        options: ReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let state = self.state.lock().await;
        let events = state
            .streams
            .get(&Self::key(tenant, topic))
            .cloned()
            .unwrap_or_default();
        let from_id = options.from_id.unwrap_or_else(|| "0-0".into());
        let count = options.count.filter(|value| *value > 0).unwrap_or(100) as usize;
        let filtered = if from_id == "0-0" || from_id == "0" {
            events
        } else {
            events
                .into_iter()
                .filter(|event| compare_ids(&event.id, &from_id) > 0)
                .collect()
        };
        Ok(filtered.into_iter().take(count).collect())
    }

    pub async fn create_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        start_id: &str,
    ) -> Result<bool, StreamError> {
        let mut state = self.state.lock().await;
        let key = Self::key(tenant, topic);
        if !state.topics.contains_key(&key) {
            let now = now_ms();
            state.topics.insert(
                key.clone(),
                TopicConfig {
                    name: topic.to_string(),
                    max_len: None,
                    min_id: None,
                    retention_ms: None,
                    created_at: now,
                    updated_at: now,
                },
            );
        }
        if state
            .groups
            .get(&key)
            .is_some_and(|groups| groups.contains_key(group))
        {
            return Err(StreamError::new(
                "conflict",
                format!("Consumer group '{group}' already exists"),
            ));
        }
        let initial = if start_id == "$" {
            state
                .streams
                .get(&key)
                .and_then(|events| events.last())
                .map(|event| event.id.clone())
                .unwrap_or_else(|| "0-0".into())
        } else if start_id.is_empty() {
            "0-0".into()
        } else {
            start_id.to_string()
        };
        let groups = state.groups.entry(key.clone()).or_default();
        groups.insert(
            group.to_string(),
            GroupState {
                last_delivered_id: initial,
                consumers: Default::default(),
                pending: Default::default(),
            },
        );
        Ok(true)
    }

    pub async fn destroy_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
    ) -> Result<bool, StreamError> {
        let mut state = self.state.lock().await;
        let Some(groups) = state.groups.get_mut(&Self::key(tenant, topic)) else {
            return Ok(false);
        };
        Ok(groups.remove(group).is_some())
    }

    pub async fn read_group(
        &self,
        tenant: &str,
        topic: &str,
        group_name: &str,
        options: GroupReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let mut state = self.state.lock().await;
        let key = Self::key(tenant, topic);
        let events = state.streams.get(&key).cloned().unwrap_or_default();
        let Some(group) = state
            .groups
            .get_mut(&key)
            .and_then(|groups| groups.get_mut(group_name))
        else {
            return Err(StreamError::new(
                "not_found",
                format!("Consumer group '{group_name}' not found"),
            ));
        };
        // A pending entry that is no longer in the stream was trimmed by
        // maxLen/minId/retention. Surfacing that as a recovery error is safer
        // than silently skipping the event and letting the consumer believe it
        // processed the full history.
        let retained: std::collections::HashSet<&str> =
            events.iter().map(|event| event.id.as_str()).collect();
        let mut missing: Vec<String> = group
            .pending
            .keys()
            .filter(|id| !retained.contains(id.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            // Drop the unrecoverable ids from the PEL so the group can make
            // progress after the operator sees the gap (Redis XAUTOCLAIM does
            // this itself). The error is reported once, not forever.
            for id in &missing {
                group.pending.remove(id);
            }
            missing.truncate(20);
            return Err(retention_gap_error(missing));
        }
        group.consumers.insert(options.consumer.clone());
        let count = options.count.filter(|value| *value > 0).unwrap_or(10) as usize;
        let now = now_ms();
        if !options.auto_ack {
            if let Some(idle_ms) = options.claim_idle_ms.filter(|value| *value > 0) {
                let mut reclaimed = Vec::new();
                for event in &events {
                    if reclaimed.len() >= count {
                        break;
                    }
                    if let Some((_, delivered_at)) = group.pending.get(&event.id) {
                        if now.saturating_sub(*delivered_at) >= idle_ms {
                            group
                                .pending
                                .insert(event.id.clone(), (options.consumer.clone(), now));
                            reclaimed.push(event.clone());
                        }
                    }
                }
                if !reclaimed.is_empty() {
                    return Ok(reclaimed);
                }
            }
        }
        let last = group.last_delivered_id.clone();
        let eligible: Vec<StreamEvent> = events
            .into_iter()
            .filter(|event| compare_ids(&event.id, &last) > 0)
            .take(count)
            .collect();
        for event in &eligible {
            group.last_delivered_id = event.id.clone();
            if !options.auto_ack {
                group
                    .pending
                    .insert(event.id.clone(), (options.consumer.clone(), now));
            }
        }
        Ok(eligible)
    }

    pub async fn ack(
        &self,
        tenant: &str,
        topic: &str,
        group_name: &str,
        ids: &[String],
    ) -> Result<i64, StreamError> {
        let mut state = self.state.lock().await;
        let Some(group) = state
            .groups
            .get_mut(&Self::key(tenant, topic))
            .and_then(|groups| groups.get_mut(group_name))
        else {
            return Err(StreamError::new(
                "not_found",
                format!("Consumer group '{group_name}' not found"),
            ));
        };
        let mut acked = 0;
        for id in ids {
            if group.pending.remove(id).is_some() {
                acked += 1;
            }
        }
        Ok(acked)
    }

    pub async fn range(
        &self,
        tenant: &str,
        topic: &str,
        start: &str,
        end: &str,
        count: i64,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let state = self.state.lock().await;
        let events = state
            .streams
            .get(&Self::key(tenant, topic))
            .cloned()
            .unwrap_or_default();
        let mut filtered: Vec<StreamEvent> = events
            .into_iter()
            .filter(|event| start == "-" || compare_ids(&event.id, start) >= 0)
            .filter(|event| end == "+" || compare_ids(&event.id, end) <= 0)
            .collect();
        filtered.truncate(count.max(0) as usize);
        Ok(filtered)
    }
}

// ---- Valkey / Redis Streams engine ----

#[derive(Clone)]
pub struct RedisEngine {
    client: redis::Client,
    conn: ConnectionManager,
}

/// Recovery-visible error for pending entries whose payload was trimmed.
pub fn retention_gap_error(ids: Vec<String>) -> StreamError {
    StreamError::new(
        "retention_gap",
        format!(
            "{} pending stream entr{} no longer retained (trimmed by maxLen/minId/retention); rebuild or reset the consumer group before continuing: {}",
            ids.len(),
            if ids.len() == 1 { "y" } else { "ies" },
            ids.join(", ")
        ),
    )
}

fn map_error(error: redis::RedisError) -> StreamError {
    let message = error.to_string();
    if message.to_uppercase().contains("BUSYGROUP") {
        return StreamError::new("conflict", "Consumer group already exists");
    }
    if message.to_uppercase().contains("NOGROUP")
        || message.to_lowercase().contains("no such key")
    {
        return StreamError::new("not_found", "Topic or consumer group not found");
    }
    if message.contains("ECONNREFUSED")
        || message.contains("ECONNRESET")
        || message.contains("Connection")
        || message.contains("READONLY")
    {
        return StreamError::new(
            "storage_unavailable",
            "Stream storage backend is unavailable",
        );
    }
    StreamError::new("invalid", message)
}

fn meta_key(tenant: &str) -> String {
    format!("synapseone:stream:v1:{tenant}:topics")
}

fn stream_key(tenant: &str, topic: &str) -> String {
    format!("synapseone:stream:v1:{tenant}:t:{topic}:events")
}

impl RedisEngine {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let client = redis::Client::open(url).map_err(|e| e.to_string())?;
        let conn = ConnectionManager::new(client.clone())
            .await
            .map_err(|e| e.to_string())?;
        let mut ping = conn.clone();
        let _: String = redis::cmd("PING")
            .query_async(&mut ping)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self { client, conn })
    }

    fn parse_event(id: String, fields: HashMap<String, redis::Value>) -> StreamEvent {
        let mut payload = Value::Null;
        let mut key = None;
        let mut headers = None;
        for (field, value) in fields {
            let text = redis::from_redis_value::<String>(&value).unwrap_or_default();
            match field.as_str() {
                "payload" => {
                    payload = serde_json::from_str(&text).unwrap_or(Value::String(text));
                }
                "key" => key = (!text.is_empty()).then_some(text),
                "headers" => headers = serde_json::from_str(&text).ok(),
                _ => {}
            }
        }
        let timestamp = id
            .split('-')
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(now_ms);
        StreamEvent {
            id,
            payload,
            key,
            headers,
            timestamp,
        }
    }

    fn parse_reply(reply: Option<StreamReadReply>) -> Vec<StreamEvent> {
        let Some(reply) = reply else {
            return Vec::new();
        };
        reply
            .keys
            .into_iter()
            .flat_map(|key| key.ids.into_iter())
            .map(|id| Self::parse_event(id.id, id.map))
            .collect()
    }

    fn add_options(topic: &TopicConfig) -> StreamAddOptions {
        let mut options = StreamAddOptions::default();
        if let Some(max_len) = topic.max_len.filter(|value| *value > 0) {
            options = options.trim(StreamTrimStrategy::maxlen(
                StreamTrimmingMode::Approx,
                max_len as usize,
            ));
        }
        options
    }

    fn items(input: &PublishInput) -> Vec<(&'static str, String)> {
        let mut items = vec![(
            "payload",
            serde_json::to_string(&input.payload)
                .unwrap_or_else(|_| "null".to_string()),
        )];
        if let Some(key) = &input.key {
            items.push(("key", key.clone()));
        }
        if let Some(headers) = &input.headers {
            items.push((
                "headers",
                serde_json::to_string(headers).unwrap_or_else(|_| "{}".to_string()),
            ));
        }
        items
    }

    pub async fn create_topic(
        &self,
        tenant: &str,
        name: &str,
        max_len: Option<i64>,
        min_id: Option<String>,
        retention_ms: Option<i64>,
    ) -> Result<TopicConfig, StreamError> {
        let mut conn = self.conn.clone();
        let meta = meta_key(tenant);
        let existing_raw: Option<String> = conn.hget(&meta, name).await.map_err(map_error)?;
        let existing: Option<TopicConfig> = existing_raw
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok());
        let now = now_ms();
        let topic = TopicConfig {
            name: name.to_string(),
            max_len: max_len
                .map(|value| value.max(0))
                .or(existing.as_ref().and_then(|topic| topic.max_len)),
            min_id: min_id.or(existing.as_ref().and_then(|topic| topic.min_id.clone())),
            retention_ms: retention_ms
                .map(|value| value.max(0))
                .or(existing.as_ref().and_then(|topic| topic.retention_ms)),
            created_at: existing.as_ref().map(|topic| topic.created_at).unwrap_or(now),
            updated_at: now,
        };
        let encoded = serde_json::to_string(&topic).map_err(|e| StreamError::new("invalid", e.to_string()))?;
        let _: i64 = conn.hset(&meta, name, encoded).await.map_err(map_error)?;
        Ok(topic)
    }

    pub async fn get_topic(
        &self,
        tenant: &str,
        name: &str,
    ) -> Result<Option<TopicConfig>, StreamError> {
        let mut conn = self.conn.clone();
        let raw: Option<String> = conn
            .hget(meta_key(tenant), name)
            .await
            .map_err(map_error)?;
        Ok(raw.as_deref().and_then(|raw| serde_json::from_str(raw).ok()))
    }

    pub async fn list_topics(&self, tenant: &str) -> Result<Vec<TopicConfig>, StreamError> {
        let mut conn = self.conn.clone();
        let map: HashMap<String, String> = conn
            .hgetall(meta_key(tenant))
            .await
            .map_err(map_error)?;
        Ok(map
            .values()
            .filter_map(|raw| serde_json::from_str::<TopicConfig>(raw).ok())
            .collect())
    }

    pub async fn delete_topic(&self, tenant: &str, name: &str) -> Result<bool, StreamError> {
        let mut conn = self.conn.clone();
        let meta = meta_key(tenant);
        let key = stream_key(tenant, name);
        let hdel: i64 = conn.hdel(&meta, name).await.map_err(map_error)?;
        let _: i64 = conn.del(&key).await.map_err(map_error)?;
        Ok(hdel > 0)
    }

    pub async fn topic_stats(&self, tenant: &str, name: &str) -> Result<TopicStats, StreamError> {
        let mut conn = self.conn.clone();
        let key = stream_key(tenant, name);
        let length: i64 = conn.xlen(&key).await.map_err(map_error)?;
        let mut first_id = None;
        let mut last_id = None;
        if length > 0 {
            let first: redis::streams::StreamRangeReply =
                conn.xrange_count(&key, "-", "+", 1).await.map_err(map_error)?;
            first_id = first.ids.first().map(|id| id.id.clone());
            let last: redis::streams::StreamRangeReply = conn
                .xrevrange_count(&key, "+", "-", 1)
                .await
                .map_err(map_error)?;
            last_id = last.ids.first().map(|id| id.id.clone());
        }
        let raw_groups: redis::Value = redis::cmd("XINFO")
            .arg("GROUPS")
            .arg(&key)
            .query_async(&mut conn)
            .await
            .unwrap_or(redis::Value::Nil);
        let mut groups = Vec::new();
        if let redis::Value::Array(items) = raw_groups {
            for item in items {
                if let redis::Value::Array(fields) = item {
                    let mut map: HashMap<String, String> = HashMap::new();
                    let mut index = 0;
                    while index + 1 < fields.len() {
                        let name = redis::from_redis_value::<String>(&fields[index]).unwrap_or_default();
                        let value =
                            redis::from_redis_value::<String>(&fields[index + 1]).unwrap_or_default();
                        map.insert(name, value);
                        index += 2;
                    }
                    groups.push(ConsumerGroupInfo {
                        name: map.get("name").cloned().unwrap_or_default(),
                        consumers: map
                            .get("consumers")
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0),
                        pending: map
                            .get("pending")
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0),
                        last_delivered_id: map
                            .get("last-delivered-id")
                            .cloned()
                            .unwrap_or_else(|| "0-0".into()),
                    });
                }
            }
        }
        Ok(TopicStats {
            topic: name.to_string(),
            length,
            first_id,
            last_id,
            groups_count: groups.len(),
            groups,
        })
    }

    pub async fn publish(
        &self,
        tenant: &str,
        topic_name: &str,
        input: PublishInput,
    ) -> Result<StreamEvent, StreamError> {
        let mut conn = self.conn.clone();
        let topic = self.get_topic(tenant, topic_name).await?;
        let key = stream_key(tenant, topic_name);
        let id_arg = input.id.clone().unwrap_or_else(|| "*".into());
        let items = Self::items(&input);
        let options = topic
            .as_ref()
            .map(Self::add_options)
            .unwrap_or_default();
        let id: String = conn
            .xadd_options(&key, &id_arg, &items, &options)
            .await
            .map_err(map_error)?;
        let timestamp = id
            .split('-')
            .next()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(now_ms);
        Ok(StreamEvent {
            id,
            payload: input.payload,
            key: input.key,
            headers: input.headers,
            timestamp,
        })
    }

    pub async fn publish_batch(
        &self,
        tenant: &str,
        topic: &str,
        inputs: Vec<PublishInput>,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let mut events = Vec::with_capacity(inputs.len());
        for input in inputs {
            events.push(self.publish(tenant, topic, input).await?);
        }
        Ok(events)
    }

    pub async fn read(
        &self,
        tenant: &str,
        topic: &str,
        options: ReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let key = stream_key(tenant, topic);
        let count = options.count.filter(|value| *value > 0).unwrap_or(100);
        let from_id = options.from_id.unwrap_or_else(|| "0-0".into());
        let mut read_options = StreamReadOptions::default().count(count as usize);
        let mut conn = if options.block_ms.filter(|value| *value > 0).is_some() {
            read_options = read_options.block(options.block_ms.unwrap() as usize);
            self.client
                .get_multiplexed_async_connection()
                .await
                .map_err(|e| map_error(e))?
        } else {
            let mut manager = self.conn.clone();
            let reply: Option<StreamReadReply> = manager
                .xread_options(&[&key], &[&from_id], &read_options)
                .await
                .map_err(map_error)?;
            return Ok(Self::parse_reply(reply));
        };
        let reply: Option<StreamReadReply> = conn
            .xread_options(&[&key], &[&from_id], &read_options)
            .await
            .map_err(map_error)?;
        Ok(Self::parse_reply(reply))
    }

    pub async fn create_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        start_id: &str,
    ) -> Result<bool, StreamError> {
        let mut conn = self.conn.clone();
        let key = stream_key(tenant, topic);
        let result: redis::RedisResult<String> = redis::cmd("XGROUP")
            .arg("CREATE")
            .arg(&key)
            .arg(group)
            .arg(start_id)
            .arg("MKSTREAM")
            .query_async(&mut conn)
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error) => Err(map_error(error)),
        }
    }

    pub async fn destroy_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
    ) -> Result<bool, StreamError> {
        let mut conn = self.conn.clone();
        let key = stream_key(tenant, topic);
        let result: i64 = redis::cmd("XGROUP")
            .arg("DESTROY")
            .arg(&key)
            .arg(group)
            .query_async(&mut conn)
            .await
            .map_err(map_error)?;
        Ok(result == 1)
    }

    pub async fn read_group(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        options: GroupReadOptions,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let key = stream_key(tenant, topic);
        let count = options.count.filter(|value| *value > 0).unwrap_or(10);
        let mut read_options = StreamReadOptions::default()
            .count(count as usize)
            .group(group, &options.consumer);
        if options.auto_ack {
            read_options = read_options.noack();
        }
        if let Some(block) = options.block_ms.filter(|value| *value > 0) {
            read_options = read_options.block(block as usize);
        }
        if !options.auto_ack {
            if let Some(idle_ms) = options.claim_idle_ms.filter(|value| *value > 0) {
                let mut conn = self.conn.clone();
                let mut cursor = "0-0".to_string();
                let mut collected = Vec::new();
                // XAUTOCLAIM scans a bounded window and returns the next
                // cursor. Walk it so a PEL larger than one window is not
                // starved forever (bounded to 10 pages per read).
                for _ in 0..10 {
                    let claim_options =
                        StreamAutoClaimOptions::default().count(count.max(1) as usize);
                    let claimed: StreamAutoClaimReply = conn
                        .xautoclaim_options(
                            &key,
                            group,
                            &options.consumer,
                            idle_ms,
                            &cursor,
                            claim_options,
                        )
                        .await
                        .map_err(map_error)?;
                    if !claimed.deleted_ids.is_empty() {
                        return Err(retention_gap_error(claimed.deleted_ids));
                    }
                    for entry in claimed.claimed {
                        collected.push(Self::parse_event(entry.id, entry.map));
                        if collected.len() >= count as usize {
                            break;
                        }
                    }
                    cursor = claimed.next_stream_id;
                    if cursor == "0-0" || collected.len() >= count as usize {
                        break;
                    }
                }
                if !collected.is_empty() {
                    return Ok(collected);
                }
            }
        }
        let ids = [">"];
        if options.block_ms.filter(|value| *value > 0).is_some() {
            let mut conn = self
                .client
                .get_multiplexed_async_connection()
                .await
                .map_err(map_error)?;
            let reply: Option<StreamReadReply> = conn
                .xread_options(&[&key], &ids, &read_options)
                .await
                .map_err(map_error)?;
            return Ok(Self::parse_reply(reply));
        }
        let mut conn = self.conn.clone();
        let reply: Option<StreamReadReply> = conn
            .xread_options(&[&key], &ids, &read_options)
            .await
            .map_err(map_error)?;
        Ok(Self::parse_reply(reply))
    }

    pub async fn ack(
        &self,
        tenant: &str,
        topic: &str,
        group: &str,
        ids: &[String],
    ) -> Result<i64, StreamError> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.clone();
        let key = stream_key(tenant, topic);
        let count: i64 = conn
            .xack(&key, group, ids)
            .await
            .map_err(map_error)?;
        Ok(count)
    }

    pub async fn range(
        &self,
        tenant: &str,
        topic: &str,
        start: &str,
        end: &str,
        count: i64,
    ) -> Result<Vec<StreamEvent>, StreamError> {
        let mut conn = self.conn.clone();
        let key = stream_key(tenant, topic);
        let reply: redis::streams::StreamRangeReply = conn
            .xrange_count(&key, start, end, count.max(0) as usize)
            .await
            .map_err(map_error)?;
        Ok(reply
            .ids
            .into_iter()
            .map(|id| Self::parse_event(id.id, id.map))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn memory_topic_lifecycle_and_group_read() {
        let engine = Engine::Memory(MemoryEngine::new());
        engine
            .create_topic("tenant-a", "telemetry", Some(1000), None, None)
            .await
            .unwrap();
        let first = engine
            .publish(
                "tenant-a",
                "telemetry",
                PublishInput {
                    payload: json!({"temp": 24.5}),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let second = engine
            .publish(
                "tenant-a",
                "telemetry",
                PublishInput {
                    payload: json!({"temp": 25.1}),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(compare_ids(&second.id, &first.id) > 0);
        let events = engine
            .read(
                "tenant-a",
                "telemetry",
                ReadOptions {
                    from_id: Some(first.id.clone()),
                    count: Some(10),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, second.id);

        engine
            .create_group("tenant-a", "telemetry", "workers", "0-0")
            .await
            .unwrap();
        let group_events = engine
            .read_group(
                "tenant-a",
                "telemetry",
                "workers",
                GroupReadOptions {
                    consumer: "worker-a".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: Some(30_000),
                },
            )
            .await
            .unwrap();
        assert_eq!(group_events.len(), 2);
        let acked = engine
            .ack(
                "tenant-a",
                "telemetry",
                "workers",
                &[first.id.clone(), second.id.clone()],
            )
            .await
            .unwrap();
        assert_eq!(acked, 2);
    }

    #[tokio::test]
    async fn memory_delete_topic_removes_events() {
        let engine = Engine::Memory(MemoryEngine::new());
        engine
            .create_topic("tenant-a", "jobs", None, None, None)
            .await
            .unwrap();
        assert!(engine.delete_topic("tenant-a", "jobs").await.unwrap());
        assert!(engine.get_topic("tenant-a", "jobs").await.unwrap().is_none());
        assert!(engine
            .read("tenant-a", "jobs", ReadOptions::default())
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn id_ordering_is_numeric() {
        assert!(compare_ids("10-1", "9-99") > 0);
        assert!(compare_ids("10-2", "10-1") > 0);
    }

    #[tokio::test]
    async fn memory_group_reclaims_an_unacked_batch_after_idle_timeout() {
        let engine = Engine::Memory(MemoryEngine::new());
        engine
            .create_topic("tenant-a", "jobs", None, None, None)
            .await
            .unwrap();
        let published = engine
            .publish(
                "tenant-a",
                "jobs",
                PublishInput {
                    payload: json!({"job": 1}),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        engine
            .create_group("tenant-a", "jobs", "workers", "0-0")
            .await
            .unwrap();
        let first = engine
            .read_group(
                "tenant-a",
                "jobs",
                "workers",
                GroupReadOptions {
                    consumer: "worker-a".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: Some(1),
                },
            )
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let retried = engine
            .read_group(
                "tenant-a",
                "jobs",
                "workers",
                GroupReadOptions {
                    consumer: "worker-b".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: Some(1),
                },
            )
            .await
            .unwrap();
        assert_eq!(retried.len(), 1);
        assert_eq!(retried[0].id, published.id);
        let acked = engine
            .ack("tenant-a", "jobs", "workers", &[published.id])
            .await
            .unwrap();
        assert_eq!(acked, 1);
    }

    #[tokio::test]
    async fn memory_reports_a_retention_gap_for_trimmed_pending_entries() {
        let engine = Engine::Memory(MemoryEngine::new());
        engine
            .create_topic("tenant-a", "audit", Some(2), None, None)
            .await
            .unwrap();
        for value in 1..=2 {
            engine
                .publish(
                    "tenant-a",
                    "audit",
                    PublishInput {
                        payload: json!({ "n": value }),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        engine
            .create_group("tenant-a", "audit", "workers", "0-0")
            .await
            .unwrap();
        let delivered = engine
            .read_group(
                "tenant-a",
                "audit",
                "workers",
                GroupReadOptions {
                    consumer: "worker-a".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(delivered.len(), 2);
        for value in 3..=4 {
            engine
                .publish(
                    "tenant-a",
                    "audit",
                    PublishInput {
                        payload: json!({ "n": value }),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }
        let error = engine
            .read_group(
                "tenant-a",
                "audit",
                "workers",
                GroupReadOptions {
                    consumer: "worker-b".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: Some(1),
                },
            )
            .await
            .expect_err("trimmed pending entries must surface as a recovery error");
        assert_eq!(error.code, "retention_gap");
        assert!(error.message.contains("no longer retained"));
        let recovered = engine
            .read_group(
                "tenant-a",
                "audit",
                "workers",
                GroupReadOptions {
                    consumer: "worker-b".into(),
                    count: Some(10),
                    block_ms: None,
                    auto_ack: false,
                    claim_idle_ms: Some(1),
                },
            )
            .await
            .unwrap();
        assert_eq!(recovered.len(), 2, "the group must continue after the gap");
    }
}
