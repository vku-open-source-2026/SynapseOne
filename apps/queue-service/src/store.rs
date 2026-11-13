// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseQueue persistence — Redis (sorted sets + hashes + Lua) in
//! production, in-memory fallback for development and tests.
//!
//! Delivery semantics are at-least-once: consuming leases a message for a
//! visibility timeout and returns a receipt. Ack removes it; nack (or an
//! expired lease) makes it available again. Messages that exhaust max attempts
//! move to the dead-letter set and can be replayed.
//!
//! The key names, envelope JSON and Lua scripts are byte-for-byte compatible
//! with the TypeScript implementation so a rolling deploy can mix Node and
//! Rust replicas against the same Valkey data.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::StreamExt;
use rand::RngCore;
use redis::aio::ConnectionManager;
use redis::{AsyncCommands, FromRedisValue};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tokio::sync::{oneshot, Mutex, Notify};

pub const MAX_SIGNAL_WAIT_MS: u64 = 25_000;
pub const QUEUE_PREFIX: &str = "synapseone:queue:v1:";

#[derive(Debug, Clone)]
pub struct QueueError {
    pub code: &'static str,
    pub message: String,
}

impl QueueError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub type Result<T> = std::result::Result<T, QueueError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueConfig {
    pub name: String,
    pub max_attempts: i64,
    pub visibility_timeout_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct InternalMessage {
    pub id: String,
    pub payload: Value,
    pub headers: Option<Value>,
    pub published_at: i64,
    pub available_at: Option<i64>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub dedupe_key: Option<String>,
    pub last_error: Option<String>,
    pub dead: bool,
    pub dead_at: Option<i64>,
    pub consumer: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConsumedMessage {
    pub message: InternalMessage,
    pub receipt: String,
    pub lease_expires_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct PublishInput {
    pub id: Option<String>,
    pub payload: Value,
    pub headers: Option<Value>,
    pub delay_seconds: i64,
    pub dedupe_key: Option<String>,
    pub max_attempts: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct PublishResult {
    pub id: String,
    pub duplicate: bool,
    pub message: InternalMessage,
}

#[derive(Debug, Clone)]
pub struct NackResult {
    pub id: String,
    pub state: &'static str,
    pub attempts: i64,
    pub available_at: Option<i64>,
    pub dead_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    pub queue: String,
    pub pending: i64,
    pub inflight: i64,
    pub dead: i64,
    pub published: i64,
    pub acked: i64,
    pub retried: i64,
    pub replayed: i64,
    pub max_attempts: i64,
    pub visibility_timeout_seconds: i64,
}

#[derive(Debug, Clone, Default)]
pub struct QueueOptions {
    pub max_attempts: Option<i64>,
    pub visibility_timeout_seconds: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Envelope {
    #[serde(default, deserialize_with = "de_i64")]
    published_at: i64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_opt_i64"
    )]
    available_at: Option<i64>,
    #[serde(default, deserialize_with = "de_i64")]
    attempts: i64,
    #[serde(default = "default_max_attempts", deserialize_with = "de_i64")]
    max_attempts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dedupe_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dead: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "de_opt_i64"
    )]
    dead_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consumer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<String>,
}

fn default_max_attempts() -> i64 {
    5
}

/// Accept both integer and floating-point JSON numbers (cjson may emit either)
/// plus numeric strings from older envelope versions.
fn de_i64<'de, D>(deserializer: D) -> std::result::Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(value_to_i64(&value).unwrap_or(0))
}

fn de_opt_i64<'de, D>(deserializer: D) -> std::result::Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(value_to_i64(&value))
}

fn value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64)),
        Value::String(text) => text.parse::<f64>().ok().map(|value| value as i64),
        _ => None,
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn enc(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn dec(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn truthy(value: Option<&String>) -> Option<String> {
    value.filter(|text| !text.is_empty()).cloned()
}

fn to_message(
    id: &str,
    env_raw: Option<&str>,
    payload_raw: Option<&str>,
    headers_raw: Option<&str>,
) -> Option<InternalMessage> {
    let env_raw = env_raw?;
    let envelope: Envelope = serde_json::from_str(env_raw).ok()?;
    let payload = payload_raw.map(dec).unwrap_or(Value::Null);
    let headers = headers_raw.map(dec);
    Some(InternalMessage {
        id: id.to_string(),
        payload,
        headers,
        published_at: envelope.published_at,
        available_at: envelope.available_at,
        attempts: envelope.attempts,
        max_attempts: if envelope.max_attempts == 0 {
            5
        } else {
            envelope.max_attempts
        },
        dedupe_key: truthy(envelope.dedupe_key.as_ref()),
        last_error: truthy(envelope.last_error.as_ref()),
        dead: envelope.dead.unwrap_or(false),
        dead_at: envelope.dead_at,
        consumer: truthy(envelope.consumer.as_ref()),
    })
}

fn row_message(id: &str, row: &MemRow) -> InternalMessage {
    InternalMessage {
        id: id.to_string(),
        payload: dec(&row.payload),
        headers: row.headers.as_deref().map(dec),
        published_at: row.envelope.published_at,
        available_at: row.envelope.available_at,
        attempts: row.envelope.attempts,
        max_attempts: if row.envelope.max_attempts == 0 {
            5
        } else {
            row.envelope.max_attempts
        },
        dedupe_key: truthy(row.envelope.dedupe_key.as_ref()),
        last_error: truthy(row.envelope.last_error.as_ref()),
        dead: row.envelope.dead.unwrap_or(false),
        dead_at: row.envelope.dead_at,
        consumer: truthy(row.envelope.consumer.as_ref()),
    }
}

fn config_from(meta: &HashMap<String, String>, name: &str) -> QueueConfig {
    QueueConfig {
        name: name.to_string(),
        max_attempts: meta
            .get("max_attempts")
            .and_then(|value| value.parse().ok())
            .unwrap_or(5),
        visibility_timeout_seconds: meta
            .get("visibility_timeout")
            .and_then(|value| value.parse().ok())
            .unwrap_or(30),
        created_at: meta
            .get("created_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        updated_at: meta
            .get("updated_at")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/// Valkey is the deployed datastore; it speaks the Redis protocol, so the
/// client and the legacy env names stay unchanged. VALKEY_URL wins.
pub fn redis_url() -> Option<String> {
    [
        "QUEUE_VALKEY_URL",
        "VALKEY_URL",
        "QUEUE_REDIS_URL",
        "REDIS_URL",
    ]
    .iter()
    .find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

#[derive(Clone)]
pub enum Store {
    Memory(MemoryStore),
    Redis(Box<RedisStore>),
}

impl Store {
    pub fn memory() -> Self {
        Store::Memory(MemoryStore::new())
    }

    pub fn backend(&self) -> &'static str {
        match self {
            Store::Memory(_) => "memory",
            Store::Redis(_) => "redis",
        }
    }

    pub async fn ensure_queue(
        &self,
        tenant: &str,
        name: &str,
        opts: QueueOptions,
    ) -> Result<QueueConfig> {
        match self {
            Store::Memory(store) => store.ensure_queue(tenant, name, opts).await,
            Store::Redis(store) => store.ensure_queue(tenant, name, opts).await,
        }
    }

    pub async fn get_queue(&self, tenant: &str, name: &str) -> Result<Option<QueueConfig>> {
        match self {
            Store::Memory(store) => store.get_queue(tenant, name).await,
            Store::Redis(store) => store.get_queue(tenant, name).await,
        }
    }

    pub async fn list_queues(&self, tenant: &str) -> Result<Vec<QueueConfig>> {
        match self {
            Store::Memory(store) => store.list_queues(tenant).await,
            Store::Redis(store) => store.list_queues(tenant).await,
        }
    }

    pub async fn delete_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        match self {
            Store::Memory(store) => store.delete_queue(tenant, name).await,
            Store::Redis(store) => store.delete_queue(tenant, name).await,
        }
    }

    pub async fn purge_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        match self {
            Store::Memory(store) => store.purge_queue(tenant, name).await,
            Store::Redis(store) => store.purge_queue(tenant, name).await,
        }
    }

    pub async fn publish_message(
        &self,
        tenant: &str,
        name: &str,
        input: PublishInput,
    ) -> Result<PublishResult> {
        match self {
            Store::Memory(store) => store.publish_message(tenant, name, input).await,
            Store::Redis(store) => store.publish_message(tenant, name, input).await,
        }
    }

    pub async fn consume_messages(
        &self,
        tenant: &str,
        name: &str,
        max_messages: i64,
        visibility_timeout_seconds: i64,
        consumer: &str,
    ) -> Result<Vec<ConsumedMessage>> {
        match self {
            Store::Memory(store) => {
                store
                    .consume_messages(
                        tenant,
                        name,
                        max_messages,
                        visibility_timeout_seconds,
                        consumer,
                    )
                    .await
            }
            Store::Redis(store) => {
                store
                    .consume_messages(
                        tenant,
                        name,
                        max_messages,
                        visibility_timeout_seconds,
                        consumer,
                    )
                    .await
            }
        }
    }

    pub async fn ack_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
    ) -> Result<Option<String>> {
        match self {
            Store::Memory(store) => store.ack_message(tenant, name, receipt).await,
            Store::Redis(store) => store.ack_message(tenant, name, receipt).await,
        }
    }

    pub async fn nack_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        requeue: bool,
        delay_seconds: i64,
        error: Option<&str>,
    ) -> Result<Option<NackResult>> {
        match self {
            Store::Memory(store) => {
                store
                    .nack_message(tenant, name, receipt, requeue, delay_seconds, error)
                    .await
            }
            Store::Redis(store) => {
                store
                    .nack_message(tenant, name, receipt, requeue, delay_seconds, error)
                    .await
            }
        }
    }

    pub async fn heartbeat_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        visibility_timeout_seconds: i64,
    ) -> Result<Option<i64>> {
        match self {
            Store::Memory(store) => {
                store
                    .heartbeat_message(tenant, name, receipt, visibility_timeout_seconds)
                    .await
            }
            Store::Redis(store) => {
                store
                    .heartbeat_message(tenant, name, receipt, visibility_timeout_seconds)
                    .await
            }
        }
    }

    pub async fn peek_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        match self {
            Store::Memory(store) => store.peek_messages(tenant, name, limit).await,
            Store::Redis(store) => store.peek_messages(tenant, name, limit).await,
        }
    }

    pub async fn dead_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        match self {
            Store::Memory(store) => store.dead_messages(tenant, name, limit).await,
            Store::Redis(store) => store.dead_messages(tenant, name, limit).await,
        }
    }

    pub async fn replay_dead_message(
        &self,
        tenant: &str,
        name: &str,
        id: &str,
        delay_seconds: i64,
        reset_attempts: bool,
    ) -> Result<Option<InternalMessage>> {
        match self {
            Store::Memory(store) => {
                store
                    .replay_dead_message(tenant, name, id, delay_seconds, reset_attempts)
                    .await
            }
            Store::Redis(store) => {
                store
                    .replay_dead_message(tenant, name, id, delay_seconds, reset_attempts)
                    .await
            }
        }
    }

    pub async fn delete_dead_message(&self, tenant: &str, name: &str, id: &str) -> Result<bool> {
        match self {
            Store::Memory(store) => store.delete_dead_message(tenant, name, id).await,
            Store::Redis(store) => store.delete_dead_message(tenant, name, id).await,
        }
    }

    pub async fn queue_stats(&self, tenant: &str, name: &str) -> Result<Option<QueueStats>> {
        match self {
            Store::Memory(store) => store.queue_stats(tenant, name).await,
            Store::Redis(store) => store.queue_stats(tenant, name).await,
        }
    }

    /// Register a waiter *before* scanning the queue. The caller then consumes;
    /// if that scan is empty it awaits the signal, so work published in between
    /// is never missed (register-before-check).
    pub async fn arm_activity_signal(&self, tenant: &str, name: &str) -> Option<ActivitySignal> {
        match self {
            Store::Memory(store) => Some(store.arm_activity_signal(tenant, name)),
            Store::Redis(store) => store.arm_activity_signal(tenant, name).await,
        }
    }

    pub async fn next_activity_at(&self, tenant: &str, name: &str) -> Result<Option<i64>> {
        match self {
            Store::Memory(store) => store.next_activity_at(tenant, name).await,
            Store::Redis(store) => store.next_activity_at(tenant, name).await,
        }
    }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

fn q_prefix(tenant: &str) -> String {
    format!("{QUEUE_PREFIX}{tenant}:")
}

struct Keys {
    queues: String,
    meta: String,
    messages: String,
    payloads: String,
    headers: String,
    pending: String,
    inflight: String,
    receipts: String,
    dedupe: String,
    dead: String,
    prefix: String,
}

fn keys_for(tenant: &str, name: &str) -> Keys {
    let q = format!("{}q:{name}:", q_prefix(tenant));
    Keys {
        queues: format!("{}queues", q_prefix(tenant)),
        meta: format!("{q}meta"),
        messages: format!("{q}messages"),
        payloads: format!("{q}payloads"),
        headers: format!("{q}headers"),
        pending: format!("{q}pending"),
        inflight: format!("{q}inflight"),
        receipts: format!("{q}receipts"),
        dedupe: format!("{q}dedupe"),
        dead: format!("{q}dead"),
        prefix: q,
    }
}

fn signal_channel(tenant: &str, name: &str) -> String {
    format!("{}signal", keys_for(tenant, name).prefix)
}

/// Opaque, unguessable lease receipt (144 bits, base64url).
fn new_receipt() -> String {
    let mut bytes = [0u8; 18];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("rcpt_{}", URL_SAFE_NO_PAD.encode(bytes))
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

struct MemRow {
    envelope: Envelope,
    payload: String,
    headers: Option<String>,
}

struct MemQueue {
    config: QueueConfig,
    messages: HashMap<String, MemRow>,
    pending: HashMap<String, i64>,
    inflight: HashMap<String, (String, i64)>,
    receipts: HashMap<String, String>,
    dedupe: HashMap<String, String>,
    dead: HashMap<String, i64>,
    counters: Counters,
    #[allow(dead_code)]
    seq: i64,
}

#[derive(Default)]
struct Counters {
    published: i64,
    acked: i64,
    retried: i64,
    dead: i64,
    replayed: i64,
}

#[derive(Default)]
struct MemoryState {
    queues: HashMap<String, MemQueue>,
}

fn mem_key(tenant: &str, name: &str) -> String {
    format!("{tenant}\u{0}{name}")
}

/// Approximate JavaScript's default `localeCompare` for the queue-name
/// alphabet: case-insensitive first, then byte order for a stable tie-break.
fn queue_name_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

#[derive(Clone, Default)]
pub struct MemoryStore {
    state: Arc<Mutex<MemoryState>>,
    signals: Arc<StdMutex<HashMap<String, Arc<Notify>>>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn signal_for(&self, tenant: &str, name: &str) -> Arc<Notify> {
        let key = mem_key(tenant, name);
        let mut signals = self.signals.lock().expect("signal registry");
        signals
            .entry(key)
            .or_insert_with(|| Arc::new(Notify::new()))
            .clone()
    }

    fn announce(&self, tenant: &str, name: &str) {
        let key = mem_key(tenant, name);
        let notify = self
            .signals
            .lock()
            .expect("signal registry")
            .get(&key)
            .cloned();
        if let Some(notify) = notify {
            notify.notify_waiters();
        }
    }

    fn arm_activity_signal(&self, tenant: &str, name: &str) -> ActivitySignal {
        let notify = self.signal_for(tenant, name);
        let mut notified = Box::pin(notify.notified_owned());
        // Register before the caller scans so a publish in the gap wakes us.
        notified.as_mut().enable();
        ActivitySignal::Memory { notified }
    }

    async fn ensure_queue(
        &self,
        tenant: &str,
        name: &str,
        opts: QueueOptions,
    ) -> Result<QueueConfig> {
        let key = mem_key(tenant, name);
        let now = now_ms();
        let mut state = self.state.lock().await;
        let queue = state.queues.entry(key).or_insert_with(|| MemQueue {
            config: QueueConfig {
                name: name.to_string(),
                max_attempts: opts.max_attempts.unwrap_or(5),
                visibility_timeout_seconds: opts.visibility_timeout_seconds.unwrap_or(30),
                created_at: now,
                updated_at: now,
            },
            messages: HashMap::new(),
            pending: HashMap::new(),
            inflight: HashMap::new(),
            receipts: HashMap::new(),
            dedupe: HashMap::new(),
            dead: HashMap::new(),
            counters: Counters::default(),
            seq: 0,
        });
        if opts.max_attempts.is_some() || opts.visibility_timeout_seconds.is_some() {
            if let Some(value) = opts.max_attempts {
                queue.config.max_attempts = value;
            }
            if let Some(value) = opts.visibility_timeout_seconds {
                queue.config.visibility_timeout_seconds = value;
            }
            queue.config.updated_at = now;
        }
        Ok(queue.config.clone())
    }

    async fn get_queue(&self, tenant: &str, name: &str) -> Result<Option<QueueConfig>> {
        let state = self.state.lock().await;
        Ok(state
            .queues
            .get(&mem_key(tenant, name))
            .map(|queue| queue.config.clone()))
    }

    async fn list_queues(&self, tenant: &str) -> Result<Vec<QueueConfig>> {
        let prefix = format!("{tenant}\u{0}");
        let state = self.state.lock().await;
        let mut queues = state
            .queues
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(_, queue)| queue.config.clone())
            .collect::<Vec<_>>();
        queues.sort_by(|a, b| queue_name_cmp(&a.name, &b.name));
        Ok(queues)
    }

    async fn delete_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        let mut state = self.state.lock().await;
        Ok(state.queues.remove(&mem_key(tenant, name)).is_some())
    }

    async fn purge_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(false);
        };
        queue.messages.clear();
        queue.pending.clear();
        queue.inflight.clear();
        queue.receipts.clear();
        queue.dedupe.clear();
        queue.dead.clear();
        queue.counters = Counters::default();
        queue.seq = 0;
        queue.config.updated_at = now_ms();
        Ok(true)
    }

    async fn publish_message(
        &self,
        tenant: &str,
        name: &str,
        input: PublishInput,
    ) -> Result<PublishResult> {
        let config = self
            .ensure_queue(tenant, name, QueueOptions::default())
            .await?;
        let now = now_ms();
        let delay_ms = (input.delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let available_at = now + delay_ms;
        let max_attempts = input.max_attempts.unwrap_or(config.max_attempts);
        let id = input
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let key = mem_key(tenant, name);

        let result = {
            let mut state = self.state.lock().await;
            let queue = state.queues.get_mut(&key).expect("queue ensured");
            if let Some(dedupe_key) = input.dedupe_key.as_deref() {
                if let Some(existing) = queue.dedupe.get(dedupe_key) {
                    if let Some(row) = queue.messages.get(existing) {
                        return Ok(PublishResult {
                            id: existing.clone(),
                            duplicate: true,
                            message: row_message(existing, row),
                        });
                    }
                }
            }
            if queue.messages.contains_key(&id) {
                return Err(QueueError::new(
                    "conflict",
                    format!("message '{id}' already exists"),
                ));
            }
            let envelope = Envelope {
                published_at: now,
                available_at: Some(available_at),
                attempts: 0,
                max_attempts,
                dedupe_key: input.dedupe_key.clone(),
                ..Envelope::default()
            };
            let row = MemRow {
                envelope,
                payload: enc(&input.payload),
                headers: input.headers.as_ref().map(enc),
            };
            let message = row_message(&id, &row);
            queue.messages.insert(id.clone(), row);
            queue.pending.insert(id.clone(), available_at);
            if let Some(dedupe_key) = input.dedupe_key.clone() {
                queue.dedupe.insert(dedupe_key, id.clone());
            }
            queue.counters.published += 1;
            PublishResult {
                id: id.clone(),
                duplicate: false,
                message,
            }
        };
        if !result.duplicate {
            self.announce(tenant, name);
        }
        Ok(result)
    }

    async fn reclaim_expired(&self, tenant: &str, name: &str, now: i64) -> Result<i64> {
        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(0);
        };
        let expired = queue
            .inflight
            .iter()
            .filter(|(_, (_, deadline))| *deadline <= now)
            .map(|(receipt, (id, _))| (receipt.clone(), id.clone()))
            .collect::<Vec<_>>();
        let mut reclaimed = 0;
        for (receipt, id) in expired {
            reclaimed += 1;
            queue.inflight.remove(&receipt);
            queue.receipts.remove(&receipt);
            let Some(row) = queue.messages.get_mut(&id) else {
                continue;
            };
            if row.envelope.dead.unwrap_or(false) {
                continue;
            }
            row.envelope.receipt = None;
            row.envelope.consumer = None;
            row.envelope.available_at = Some(now);
            queue.pending.insert(id, now);
        }
        Ok(reclaimed)
    }

    async fn consume_messages(
        &self,
        tenant: &str,
        name: &str,
        max_messages: i64,
        visibility_timeout_seconds: i64,
        consumer: &str,
    ) -> Result<Vec<ConsumedMessage>> {
        self.ensure_queue(tenant, name, QueueOptions::default())
            .await?;
        let now = now_ms();
        self.reclaim_expired(tenant, name, now).await?;

        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(Vec::new());
        };
        let mut ready = queue
            .pending
            .iter()
            .filter(|(_, available_at)| **available_at <= now)
            .map(|(id, available_at)| (id.clone(), *available_at))
            .collect::<Vec<_>>();
        ready.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        ready.truncate(max_messages.max(0) as usize);

        let mut out = Vec::new();
        for (id, _) in ready {
            queue.pending.remove(&id);
            let Some(row) = queue.messages.get_mut(&id) else {
                continue;
            };
            row.envelope.attempts += 1;
            row.envelope.available_at = None;
            let receipt = new_receipt();
            let deadline = now + visibility_timeout_seconds * 1000;
            row.envelope.receipt = Some(receipt.clone());
            row.envelope.consumer = Some(consumer.to_string());
            let message = row_message(&id, row);
            queue
                .inflight
                .insert(receipt.clone(), (id.clone(), deadline));
            queue.receipts.insert(receipt.clone(), id);
            out.push(ConsumedMessage {
                message,
                receipt,
                lease_expires_at: deadline,
            });
        }
        Ok(out)
    }

    async fn ack_message(&self, tenant: &str, name: &str, receipt: &str) -> Result<Option<String>> {
        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(None);
        };
        let Some(id) = queue.receipts.remove(receipt) else {
            return Ok(None);
        };
        queue.inflight.remove(receipt);
        queue.messages.remove(&id);
        queue.counters.acked += 1;
        Ok(Some(id))
    }

    async fn nack_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        requeue: bool,
        delay_seconds: i64,
        error: Option<&str>,
    ) -> Result<Option<NackResult>> {
        let delay_ms = (delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let now = now_ms();
        let result = {
            let mut state = self.state.lock().await;
            let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
                return Ok(None);
            };
            let Some(id) = queue.receipts.remove(receipt) else {
                return Ok(None);
            };
            queue.inflight.remove(receipt);
            let Some(row) = queue.messages.get_mut(&id) else {
                return Ok(None);
            };
            row.envelope.receipt = None;
            row.envelope.consumer = None;
            if let Some(error) = error {
                if !error.is_empty() {
                    row.envelope.last_error = Some(error.to_string());
                }
            }
            let attempts = row.envelope.attempts;
            let max_attempts = if row.envelope.max_attempts == 0 {
                5
            } else {
                row.envelope.max_attempts
            };
            if !requeue || attempts >= max_attempts {
                row.envelope.dead = Some(true);
                row.envelope.dead_at = Some(now);
                queue.dead.insert(id.clone(), now);
                queue.counters.dead += 1;
                NackResult {
                    id,
                    state: "dead",
                    attempts,
                    available_at: None,
                    dead_at: Some(now),
                }
            } else {
                let available_at = now + delay_ms;
                row.envelope.available_at = Some(available_at);
                queue.pending.insert(id.clone(), available_at);
                queue.counters.retried += 1;
                NackResult {
                    id,
                    state: "retry",
                    attempts,
                    available_at: Some(available_at),
                    dead_at: None,
                }
            }
        };
        if result.state != "dead" {
            self.announce(tenant, name);
        }
        Ok(Some(result))
    }

    async fn heartbeat_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        visibility_timeout_seconds: i64,
    ) -> Result<Option<i64>> {
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let deadline = now_ms() + visibility_timeout_seconds * 1000;
        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(None);
        };
        match queue.inflight.get_mut(receipt) {
            Some(entry) => {
                entry.1 = deadline;
                Ok(Some(deadline))
            }
            None => Ok(None),
        }
    }

    async fn peek_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(Vec::new());
        }
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let state = self.state.lock().await;
        let Some(queue) = state.queues.get(&mem_key(tenant, name)) else {
            return Ok(Vec::new());
        };
        let mut pending = queue
            .pending
            .iter()
            .map(|(id, available_at)| (id.clone(), *available_at))
            .collect::<Vec<_>>();
        pending.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        pending.truncate(limit.max(0) as usize);
        Ok(pending
            .into_iter()
            .filter_map(|(id, _)| queue.messages.get(&id).map(|row| row_message(&id, row)))
            .collect())
    }

    async fn dead_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(Vec::new());
        }
        let state = self.state.lock().await;
        let Some(queue) = state.queues.get(&mem_key(tenant, name)) else {
            return Ok(Vec::new());
        };
        let mut dead = queue
            .dead
            .iter()
            .map(|(id, at)| (id.clone(), *at))
            .collect::<Vec<_>>();
        dead.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        dead.truncate(limit.max(0) as usize);
        Ok(dead
            .into_iter()
            .filter_map(|(id, _)| queue.messages.get(&id).map(|row| row_message(&id, row)))
            .collect())
    }

    async fn replay_dead_message(
        &self,
        tenant: &str,
        name: &str,
        id: &str,
        delay_seconds: i64,
        reset_attempts: bool,
    ) -> Result<Option<InternalMessage>> {
        let delay_ms = (delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let now = now_ms();
        let message = {
            let mut state = self.state.lock().await;
            let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
                return Ok(None);
            };
            let Some(row) = queue.messages.get_mut(id) else {
                return Ok(None);
            };
            if !row.envelope.dead.unwrap_or(false) {
                return Ok(None);
            }
            row.envelope.dead = None;
            row.envelope.dead_at = None;
            row.envelope.last_error = None;
            row.envelope.receipt = None;
            row.envelope.consumer = None;
            if reset_attempts {
                row.envelope.attempts = 0;
            }
            let available_at = now + delay_ms;
            row.envelope.available_at = Some(available_at);
            let message = row_message(id, row);
            queue.dead.remove(id);
            queue.pending.insert(id.to_string(), available_at);
            queue.counters.replayed += 1;
            message
        };
        self.announce(tenant, name);
        Ok(Some(message))
    }

    async fn delete_dead_message(&self, tenant: &str, name: &str, id: &str) -> Result<bool> {
        let mut state = self.state.lock().await;
        let Some(queue) = state.queues.get_mut(&mem_key(tenant, name)) else {
            return Ok(false);
        };
        if queue.dead.remove(id).is_none() {
            return Ok(false);
        }
        queue.messages.remove(id);
        Ok(true)
    }

    async fn queue_stats(&self, tenant: &str, name: &str) -> Result<Option<QueueStats>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(None);
        }
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let state = self.state.lock().await;
        let Some(queue) = state.queues.get(&mem_key(tenant, name)) else {
            return Ok(None);
        };
        Ok(Some(QueueStats {
            queue: name.to_string(),
            pending: queue.pending.len() as i64,
            inflight: queue.inflight.len() as i64,
            dead: queue.dead.len() as i64,
            published: queue.counters.published,
            acked: queue.counters.acked,
            retried: queue.counters.retried,
            replayed: queue.counters.replayed,
            max_attempts: queue.config.max_attempts,
            visibility_timeout_seconds: queue.config.visibility_timeout_seconds,
        }))
    }

    async fn next_activity_at(&self, tenant: &str, name: &str) -> Result<Option<i64>> {
        let state = self.state.lock().await;
        let Some(queue) = state.queues.get(&mem_key(tenant, name)) else {
            return Ok(None);
        };
        let mut earliest: Option<i64> = None;
        for at in queue.pending.values() {
            earliest = Some(earliest.map_or(*at, |current| current.min(*at)));
        }
        for (_, deadline) in queue.inflight.values() {
            earliest = Some(earliest.map_or(*deadline, |current| current.min(*deadline)));
        }
        Ok(earliest)
    }
}

// ---------------------------------------------------------------------------
// Activity signals (long-poll)
// ---------------------------------------------------------------------------

/// A parked long-poll waiter. Dropping it cancels the underlying subscription.
pub enum ActivitySignal {
    Memory {
        notified: std::pin::Pin<Box<tokio::sync::futures::OwnedNotified>>,
    },
    Redis {
        signalled: oneshot::Receiver<()>,
        cancel: Option<oneshot::Sender<()>>,
    },
}

impl ActivitySignal {
    /// Wait until a publish is announced or the budget elapses.
    pub async fn wait(mut self, duration: Duration) {
        match &mut self {
            ActivitySignal::Memory { notified } => {
                tokio::select! {
                    _ = notified.as_mut() => {},
                    _ = tokio::time::sleep(duration) => {},
                }
            }
            ActivitySignal::Redis { signalled, .. } => {
                tokio::select! {
                    _ = signalled => {},
                    _ = tokio::time::sleep(duration) => {},
                }
            }
        }
    }
}

impl Drop for ActivitySignal {
    fn drop(&mut self) {
        if let ActivitySignal::Redis { cancel, .. } = self {
            if let Some(cancel) = cancel.take() {
                let _ = cancel.send(());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Valkey / Redis store
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RedisStore {
    client: redis::Client,
    conn: ConnectionManager,
}

fn map_redis_error(error: redis::RedisError) -> QueueError {
    let message = error.to_string();
    let upper = message.to_uppercase();
    if upper.contains("ECONNREFUSED")
        || upper.contains("ECONNRESET")
        || upper.contains("NR_CLOSED")
        || upper.contains("CONNECTION IS CLOSED")
        || upper.contains("READONLY")
    {
        QueueError::new("storage_unavailable", "queue backend is unavailable")
    } else {
        QueueError::new("internal", message)
    }
}

async fn redis_call<T>(future: impl Future<Output = redis::RedisResult<T>>) -> Result<T> {
    future.await.map_err(map_redis_error)
}

impl RedisStore {
    pub async fn connect(url: &str) -> std::result::Result<Self, String> {
        let client = redis::Client::open(url).map_err(|error| error.to_string())?;
        let conn = ConnectionManager::new(client.clone())
            .await
            .map_err(|error| error.to_string())?;
        let mut ping = conn.clone();
        redis::cmd("PING")
            .query_async::<String>(&mut ping)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self { client, conn })
    }

    async fn eval<T: FromRedisValue>(
        &self,
        script: &str,
        keys: &[String],
        args: &[String],
    ) -> Result<T> {
        let mut conn = self.conn.clone();
        let mut command = redis::cmd("EVAL");
        command.arg(script).arg(keys.len());
        for key in keys {
            command.arg(key.as_str());
        }
        for arg in args {
            command.arg(arg.as_str());
        }
        redis_call(command.query_async(&mut conn)).await
    }

    async fn hset_fields(&self, key: &str, fields: &[(&str, String)]) -> Result<()> {
        let mut conn = self.conn.clone();
        let mut command = redis::cmd("HSET");
        command.arg(key);
        for (field, value) in fields {
            command.arg(*field).arg(value.as_str());
        }
        let _: i64 = redis_call(command.query_async(&mut conn)).await?;
        Ok(())
    }

    async fn ensure_queue(
        &self,
        tenant: &str,
        name: &str,
        opts: QueueOptions,
    ) -> Result<QueueConfig> {
        let keys = keys_for(tenant, name);
        let now = now_ms().to_string();
        let mut conn = self.conn.clone();
        let exists = redis_call(conn.exists::<_, i64>(&keys.meta)).await?;
        if exists == 0 {
            let fields = vec![
                ("max_attempts", opts.max_attempts.unwrap_or(5).to_string()),
                (
                    "visibility_timeout",
                    opts.visibility_timeout_seconds.unwrap_or(30).to_string(),
                ),
                ("created_at", now.clone()),
                ("updated_at", now.clone()),
                ("published", "0".to_string()),
                ("acked", "0".to_string()),
                ("retried", "0".to_string()),
                ("dead", "0".to_string()),
                ("replayed", "0".to_string()),
                ("receipt_seq", "0".to_string()),
            ];
            self.hset_fields(&keys.meta, &fields).await?;
        } else if opts.max_attempts.is_some() || opts.visibility_timeout_seconds.is_some() {
            let mut fields: Vec<(&str, String)> = vec![("updated_at", now.clone())];
            if let Some(value) = opts.max_attempts {
                fields.push(("max_attempts", value.to_string()));
            }
            if let Some(value) = opts.visibility_timeout_seconds {
                fields.push(("visibility_timeout", value.to_string()));
            }
            self.hset_fields(&keys.meta, &fields).await?;
        }
        redis_call(conn.sadd::<_, _, i64>(&keys.queues, name)).await?;
        let meta = redis_call(conn.hgetall::<_, HashMap<String, String>>(&keys.meta)).await?;
        Ok(config_from(&meta, name))
    }

    async fn get_queue(&self, tenant: &str, name: &str) -> Result<Option<QueueConfig>> {
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let meta = redis_call(conn.hgetall::<_, HashMap<String, String>>(&keys.meta)).await?;
        if meta.is_empty() {
            return Ok(None);
        }
        Ok(Some(config_from(&meta, name)))
    }

    async fn list_queues(&self, tenant: &str) -> Result<Vec<QueueConfig>> {
        let prefix = q_prefix(tenant);
        let mut conn = self.conn.clone();
        let names = redis_call(conn.smembers::<_, Vec<String>>(format!("{prefix}queues"))).await?;
        let mut configs = Vec::new();
        for name in names {
            let meta = redis_call(
                conn.hgetall::<_, HashMap<String, String>>(keys_for(tenant, &name).meta),
            )
            .await?;
            if !meta.is_empty() {
                configs.push(config_from(&meta, &name));
            }
        }
        configs.sort_by(|a, b| queue_name_cmp(&a.name, &b.name));
        Ok(configs)
    }

    async fn delete_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let found = redis_call(conn.exists::<_, i64>(&keys.meta)).await? == 1;
        let keys_to_delete = scan_keys(&self.conn, &format!("{}*", keys.prefix)).await?;
        if !keys_to_delete.is_empty() {
            redis_call(conn.del::<_, i64>(keys_to_delete)).await?;
        }
        redis_call(conn.srem::<_, _, i64>(&keys.queues, name)).await?;
        Ok(found)
    }

    async fn purge_queue(&self, tenant: &str, name: &str) -> Result<bool> {
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        if redis_call(conn.exists::<_, i64>(&keys.meta)).await? != 1 {
            return Ok(false);
        }
        let to_delete = vec![
            keys.messages.clone(),
            keys.payloads.clone(),
            keys.headers.clone(),
            keys.pending.clone(),
            keys.inflight.clone(),
            keys.receipts.clone(),
            keys.dedupe.clone(),
            keys.dead.clone(),
        ];
        redis_call(conn.del::<_, i64>(to_delete)).await?;
        let fields = vec![
            ("published", "0".to_string()),
            ("acked", "0".to_string()),
            ("retried", "0".to_string()),
            ("dead", "0".to_string()),
            ("replayed", "0".to_string()),
            ("receipt_seq", "0".to_string()),
            ("updated_at", now_ms().to_string()),
        ];
        self.hset_fields(&keys.meta, &fields).await?;
        Ok(true)
    }

    async fn publish_message(
        &self,
        tenant: &str,
        name: &str,
        input: PublishInput,
    ) -> Result<PublishResult> {
        let config = self
            .ensure_queue(tenant, name, QueueOptions::default())
            .await?;
        let now = now_ms();
        let delay_ms = (input.delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let available_at = now + delay_ms;
        let max_attempts = input.max_attempts.unwrap_or(config.max_attempts);
        let id = input
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let keys = keys_for(tenant, name);
        let envelope = Envelope {
            published_at: now,
            available_at: Some(available_at),
            attempts: 0,
            max_attempts,
            dedupe_key: input.dedupe_key.clone(),
            ..Envelope::default()
        };
        let envelope_json = serde_json::to_string(&envelope)
            .map_err(|error| QueueError::new("internal", error.to_string()))?;
        let eval_keys = vec![
            keys.messages.clone(),
            keys.payloads.clone(),
            keys.headers.clone(),
            keys.dedupe.clone(),
            keys.pending.clone(),
            keys.meta.clone(),
            keys.queues.clone(),
        ];
        let args = vec![
            id.clone(),
            envelope_json,
            input.dedupe_key.clone().unwrap_or_default(),
            available_at.to_string(),
            name.to_string(),
            enc(&input.payload),
            input.headers.as_ref().map(enc).unwrap_or_default(),
        ];
        let out: Vec<String> = self.eval(PUBLISH_LUA, &eval_keys, &args).await?;
        let result_id = out.first().cloned().unwrap_or_else(|| id.clone());
        let duplicate = out.get(1).map(|value| value == "1").unwrap_or(false);
        let message = self
            .get_message(tenant, name, &result_id)
            .await?
            .ok_or_else(|| {
                QueueError::new("conflict", "message could not be read after publish")
            })?;
        if !duplicate {
            self.announce(tenant, name);
        }
        Ok(PublishResult {
            id: result_id,
            duplicate,
            message,
        })
    }

    async fn get_message(
        &self,
        tenant: &str,
        name: &str,
        id: &str,
    ) -> Result<Option<InternalMessage>> {
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let (env, payload, headers): (Option<String>, Option<String>, Option<String>) = redis_call(
            redis::pipe()
                .cmd("HGET")
                .arg(&keys.messages)
                .arg(id)
                .cmd("HGET")
                .arg(&keys.payloads)
                .arg(id)
                .cmd("HGET")
                .arg(&keys.headers)
                .arg(id)
                .query_async(&mut conn),
        )
        .await?;
        Ok(to_message(
            id,
            env.as_deref(),
            payload.as_deref(),
            headers.as_deref(),
        ))
    }

    async fn load_messages(
        &self,
        tenant: &str,
        name: &str,
        ids: &[String],
    ) -> Result<Vec<InternalMessage>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let mut env_cmd = redis::cmd("HMGET");
        env_cmd.arg(&keys.messages);
        for id in ids {
            env_cmd.arg(id.as_str());
        }
        let envs: Vec<Option<String>> = redis_call(env_cmd.query_async(&mut conn)).await?;
        let mut payload_cmd = redis::cmd("HMGET");
        payload_cmd.arg(&keys.payloads);
        for id in ids {
            payload_cmd.arg(id.as_str());
        }
        let payloads: Vec<Option<String>> = redis_call(payload_cmd.query_async(&mut conn)).await?;
        let mut headers_cmd = redis::cmd("HMGET");
        headers_cmd.arg(&keys.headers);
        for id in ids {
            headers_cmd.arg(id.as_str());
        }
        let headers: Vec<Option<String>> = redis_call(headers_cmd.query_async(&mut conn)).await?;

        Ok(ids
            .iter()
            .enumerate()
            .filter_map(|(index, id)| {
                to_message(
                    id,
                    envs.get(index).and_then(|value| value.as_deref()),
                    payloads.get(index).and_then(|value| value.as_deref()),
                    headers.get(index).and_then(|value| value.as_deref()),
                )
            })
            .collect())
    }

    async fn reclaim_expired(&self, tenant: &str, name: &str, now: i64) -> Result<i64> {
        let keys = keys_for(tenant, name);
        let eval_keys = vec![
            keys.inflight.clone(),
            keys.receipts.clone(),
            keys.messages.clone(),
            keys.pending.clone(),
        ];
        let args = vec![now.to_string()];
        self.eval(RECLAIM_LUA, &eval_keys, &args).await
    }

    async fn consume_messages(
        &self,
        tenant: &str,
        name: &str,
        max_messages: i64,
        visibility_timeout_seconds: i64,
        consumer: &str,
    ) -> Result<Vec<ConsumedMessage>> {
        self.ensure_queue(tenant, name, QueueOptions::default())
            .await?;
        let now = now_ms();
        self.reclaim_expired(tenant, name, now).await?;
        let keys = keys_for(tenant, name);
        let receipts = (0..max_messages.max(1))
            .map(|_| new_receipt())
            .collect::<Vec<_>>();
        let receipts_json = serde_json::to_string(&receipts)
            .map_err(|error| QueueError::new("internal", error.to_string()))?;
        let eval_keys = vec![
            keys.pending.clone(),
            keys.messages.clone(),
            keys.inflight.clone(),
            keys.receipts.clone(),
            keys.meta.clone(),
        ];
        let args = vec![
            now.to_string(),
            max_messages.to_string(),
            (visibility_timeout_seconds * 1000).to_string(),
            consumer.to_string(),
            receipts_json,
        ];
        let rows: Vec<Vec<String>> = self.eval(CONSUME_LUA, &eval_keys, &args).await?;
        let ids = rows
            .iter()
            .filter_map(|row| row.first().cloned())
            .collect::<Vec<_>>();
        let messages = self.load_messages(tenant, name, &ids).await?;
        let by_id = messages
            .into_iter()
            .map(|message| (message.id.clone(), message))
            .collect::<HashMap<_, _>>();
        Ok(rows
            .iter()
            .filter_map(|row| {
                let id = row.first()?;
                let message = by_id.get(id)?.clone();
                Some(ConsumedMessage {
                    message,
                    receipt: row.get(1)?.clone(),
                    lease_expires_at: row.get(2)?.parse().ok()?,
                })
            })
            .collect())
    }

    async fn ack_message(&self, tenant: &str, name: &str, receipt: &str) -> Result<Option<String>> {
        let keys = keys_for(tenant, name);
        let eval_keys = vec![
            keys.messages.clone(),
            keys.payloads.clone(),
            keys.headers.clone(),
            keys.receipts.clone(),
            keys.inflight.clone(),
            keys.meta.clone(),
        ];
        let args = vec![receipt.to_string()];
        let id: String = self.eval(ACK_LUA, &eval_keys, &args).await?;
        Ok((!id.is_empty()).then_some(id))
    }

    async fn nack_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        requeue: bool,
        delay_seconds: i64,
        error: Option<&str>,
    ) -> Result<Option<NackResult>> {
        let delay_ms = (delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let now = now_ms();
        let keys = keys_for(tenant, name);
        let eval_keys = vec![
            keys.messages.clone(),
            keys.receipts.clone(),
            keys.inflight.clone(),
            keys.pending.clone(),
            keys.dead.clone(),
            keys.meta.clone(),
        ];
        let args = vec![
            receipt.to_string(),
            now.to_string(),
            delay_ms.to_string(),
            error.unwrap_or("").to_string(),
            if requeue { "1" } else { "0" }.to_string(),
        ];
        let raw: Vec<String> = self.eval(NACK_LUA, &eval_keys, &args).await?;
        if raw.is_empty() {
            return Ok(None);
        }
        let state = raw.get(1).cloned().unwrap_or_default();
        let attempts = raw.get(2).and_then(|value| value.parse().ok()).unwrap_or(0);
        let when = raw
            .get(3)
            .and_then(|value| value.parse().ok())
            .unwrap_or(now);
        if state == "dead" {
            Ok(Some(NackResult {
                id: raw.first().cloned().unwrap_or_default(),
                state: "dead",
                attempts,
                available_at: None,
                dead_at: Some(when),
            }))
        } else {
            self.announce(tenant, name);
            Ok(Some(NackResult {
                id: raw.first().cloned().unwrap_or_default(),
                state: "retry",
                attempts,
                available_at: Some(when),
                dead_at: None,
            }))
        }
    }

    async fn heartbeat_message(
        &self,
        tenant: &str,
        name: &str,
        receipt: &str,
        visibility_timeout_seconds: i64,
    ) -> Result<Option<i64>> {
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let deadline = now_ms() + visibility_timeout_seconds * 1000;
        let keys = keys_for(tenant, name);
        let eval_keys = vec![keys.receipts.clone(), keys.inflight.clone()];
        let args = vec![receipt.to_string(), deadline.to_string()];
        let out: String = self.eval(HEARTBEAT_LUA, &eval_keys, &args).await?;
        Ok((!out.is_empty()).then(|| out.parse().unwrap_or(deadline)))
    }

    async fn peek_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(Vec::new());
        }
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let ids: Vec<String> = redis_call(conn.zrangebyscore_limit::<_, _, _, Vec<String>>(
            &keys.pending,
            "-inf",
            "+inf",
            0,
            limit.max(0) as isize,
        ))
        .await?;
        self.load_messages(tenant, name, &ids).await
    }

    async fn dead_messages(
        &self,
        tenant: &str,
        name: &str,
        limit: i64,
    ) -> Result<Vec<InternalMessage>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(Vec::new());
        }
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let ids: Vec<String> =
            redis_call(conn.zrevrange::<_, Vec<String>>(&keys.dead, 0, limit.max(1) as isize - 1))
                .await?;
        self.load_messages(tenant, name, &ids).await
    }

    async fn replay_dead_message(
        &self,
        tenant: &str,
        name: &str,
        id: &str,
        delay_seconds: i64,
        reset_attempts: bool,
    ) -> Result<Option<InternalMessage>> {
        let delay_ms = (delay_seconds.max(0) as f64 * 1000.0).round() as i64;
        let now = now_ms();
        let keys = keys_for(tenant, name);
        let eval_keys = vec![
            keys.messages.clone(),
            keys.dead.clone(),
            keys.pending.clone(),
            keys.meta.clone(),
        ];
        let args = vec![
            id.to_string(),
            now.to_string(),
            delay_ms.to_string(),
            if reset_attempts { "1" } else { "0" }.to_string(),
        ];
        let ok: i64 = self.eval(REPLAY_LUA, &eval_keys, &args).await?;
        if ok != 1 {
            return Ok(None);
        }
        self.announce(tenant, name);
        self.get_message(tenant, name, id).await
    }

    async fn delete_dead_message(&self, tenant: &str, name: &str, id: &str) -> Result<bool> {
        let keys = keys_for(tenant, name);
        let eval_keys = vec![
            keys.messages.clone(),
            keys.payloads.clone(),
            keys.headers.clone(),
            keys.dead.clone(),
        ];
        let args = vec![id.to_string()];
        let removed: i64 = self.eval(DELETE_DEAD_LUA, &eval_keys, &args).await?;
        Ok(removed == 1)
    }

    async fn queue_stats(&self, tenant: &str, name: &str) -> Result<Option<QueueStats>> {
        if self.get_queue(tenant, name).await?.is_none() {
            return Ok(None);
        }
        self.reclaim_expired(tenant, name, now_ms()).await?;
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let meta = redis_call(conn.hgetall::<_, HashMap<String, String>>(&keys.meta)).await?;
        if meta.is_empty() {
            return Ok(None);
        }
        let pending = redis_call(conn.zcard::<_, i64>(&keys.pending)).await?;
        let inflight = redis_call(conn.zcard::<_, i64>(&keys.inflight)).await?;
        let dead = redis_call(conn.zcard::<_, i64>(&keys.dead)).await?;
        Ok(Some(QueueStats {
            queue: name.to_string(),
            pending,
            inflight,
            dead,
            published: meta
                .get("published")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            acked: meta
                .get("acked")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            retried: meta
                .get("retried")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            replayed: meta
                .get("replayed")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            max_attempts: meta
                .get("max_attempts")
                .and_then(|value| value.parse().ok())
                .unwrap_or(5),
            visibility_timeout_seconds: meta
                .get("visibility_timeout")
                .and_then(|value| value.parse().ok())
                .unwrap_or(30),
        }))
    }

    async fn next_activity_at(&self, tenant: &str, name: &str) -> Result<Option<i64>> {
        let keys = keys_for(tenant, name);
        let mut conn = self.conn.clone();
        let pending: Vec<(String, f64)> = redis_call(
            redis::cmd("ZRANGE")
                .arg(&keys.pending)
                .arg(0)
                .arg(0)
                .arg("WITHSCORES")
                .query_async(&mut conn),
        )
        .await?;
        let mut conn = self.conn.clone();
        let inflight: Vec<(String, f64)> = redis_call(
            redis::cmd("ZRANGE")
                .arg(&keys.inflight)
                .arg(0)
                .arg(0)
                .arg("WITHSCORES")
                .query_async(&mut conn),
        )
        .await?;
        let earliest = pending
            .iter()
            .chain(inflight.iter())
            .map(|(_, score)| *score as i64)
            .min();
        Ok(earliest)
    }

    async fn arm_activity_signal(&self, tenant: &str, name: &str) -> Option<ActivitySignal> {
        let channel = signal_channel(tenant, name);
        // Bound the subscription setup so a degraded pub/sub backend degrades
        // to a short poll instead of holding the request past its budget.
        let subscription = tokio::time::timeout(Duration::from_secs(1), async {
            let mut pubsub = self.client.get_async_pubsub().await.ok()?;
            pubsub.subscribe(&channel).await.ok()?;
            Some(pubsub)
        })
        .await;
        let Ok(Some(mut pubsub)) = subscription else {
            return None;
        };
        let (signal_tx, signal_rx) = oneshot::channel();
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        tokio::spawn(async move {
            let mut stream = pubsub.on_message();
            let message = tokio::select! {
                _ = &mut cancel_rx => None,
                message = stream.next() => message,
            };
            if message.is_some() {
                let _ = signal_tx.send(());
            }
        });
        Some(ActivitySignal::Redis {
            signalled: signal_rx,
            cancel: Some(cancel_tx),
        })
    }

    fn announce(&self, tenant: &str, name: &str) {
        let channel = signal_channel(tenant, name);
        let mut conn = self.conn.clone();
        let payload = now_ms().to_string();
        tokio::spawn(async move {
            let _: redis::RedisResult<i64> = redis::cmd("PUBLISH")
                .arg(channel)
                .arg(payload)
                .query_async(&mut conn)
                .await;
        });
    }
}

async fn scan_keys(conn: &ConnectionManager, pattern: &str) -> Result<Vec<String>> {
    let mut conn = conn.clone();
    let mut cursor = "0".to_string();
    let mut keys = Vec::new();
    loop {
        let (next, batch): (String, Vec<String>) = redis_call(
            redis::cmd("SCAN")
                .arg(&cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(500)
                .query_async(&mut conn),
        )
        .await?;
        keys.extend(batch);
        cursor = next;
        if cursor == "0" {
            break;
        }
    }
    Ok(keys)
}

// ---------------------------------------------------------------------------
// Lua scripts — kept byte-for-byte identical to the TypeScript store so
// mixed Node/Rust replicas observe the same semantics.
// ---------------------------------------------------------------------------

const PUBLISH_LUA: &str = r#"
  if ARGV[3] ~= '' then
    local existing = redis.call('HGET', KEYS[4], ARGV[3])
    if existing and redis.call('HEXISTS', KEYS[1], existing) == 1 then
      return {existing, '1'}
    end
  end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[6])
  if ARGV[7] ~= '' then redis.call('HSET', KEYS[3], ARGV[1], ARGV[7]) end
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
  if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], ARGV[3], ARGV[1]) end
  redis.call('HINCRBY', KEYS[6], 'published', 1)
  redis.call('SADD', KEYS[7], ARGV[5])
  return {ARGV[1], '0'}
"#;

const RECLAIM_LUA: &str = r#"
      local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      for _, receipt in ipairs(expired) do
        local id = redis.call('HGET', KEYS[2], receipt)
        redis.call('ZREM', KEYS[1], receipt)
        redis.call('HDEL', KEYS[2], receipt)
        if id then
          local raw = redis.call('HGET', KEYS[3], id)
          if raw then
            local env = cjson.decode(raw)
            if not env.dead then
              env.receipt = nil
              env.consumer = nil
              env.available_at = tonumber(ARGV[1])
              redis.call('HSET', KEYS[3], id, cjson.encode(env))
              redis.call('ZADD', KEYS[4], ARGV[1], id)
            end
          end
        end
      end
      return #expired
"#;

const CONSUME_LUA: &str = r#"
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  local receipts = cjson.decode(ARGV[5])
  local ri = 0
  local out = {}
  for _, id in ipairs(ids) do
    local raw = redis.call('HGET', KEYS[2], id)
    if raw then
      redis.call('ZREM', KEYS[1], id)
      local env = cjson.decode(raw)
      env.attempts = (env.attempts or 0) + 1
      env.available_at = nil
      ri = ri + 1
      local receipt = receipts[ri]
      env.receipt = receipt
      env.consumer = ARGV[4]
      local deadline = tonumber(ARGV[1]) + tonumber(ARGV[3])
      redis.call('HSET', KEYS[2], id, cjson.encode(env))
      redis.call('ZADD', KEYS[3], deadline, receipt)
      redis.call('HSET', KEYS[4], receipt, id)
      table.insert(out, {id, receipt, tostring(deadline)})
    else
      redis.call('ZREM', KEYS[1], id)
    end
  end
  return out
"#;

const ACK_LUA: &str = r#"
  local id = redis.call('HGET', KEYS[4], ARGV[1])
  if not id then return '' end
  redis.call('HDEL', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('HDEL', KEYS[3], id)
  redis.call('HINCRBY', KEYS[6], 'acked', 1)
  return id
"#;

const NACK_LUA: &str = r#"
  local id = redis.call('HGET', KEYS[2], ARGV[1])
  if not id then return {} end
  local raw = redis.call('HGET', KEYS[1], id)
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  if not raw then return {} end
  local env = cjson.decode(raw)
  env.receipt = nil
  env.consumer = nil
  if ARGV[4] ~= '' then env.last_error = ARGV[4] end
  local max = tonumber(env.max_attempts or 5)
  if ARGV[5] == '0' or (env.attempts or 0) >= max then
    env.dead = true
    env.dead_at = tonumber(ARGV[2])
    redis.call('HSET', KEYS[1], id, cjson.encode(env))
    redis.call('ZADD', KEYS[5], ARGV[2], id)
    redis.call('HINCRBY', KEYS[6], 'dead', 1)
    return {id, 'dead', tostring(env.attempts or 0), ARGV[2]}
  else
    local available = tonumber(ARGV[2]) + tonumber(ARGV[3])
    env.available_at = available
    redis.call('HSET', KEYS[1], id, cjson.encode(env))
    redis.call('ZADD', KEYS[4], available, id)
    redis.call('HINCRBY', KEYS[6], 'retried', 1)
    return {id, 'retry', tostring(env.attempts or 0), tostring(available)}
  end
"#;

const HEARTBEAT_LUA: &str = r#"
  local id = redis.call('HGET', KEYS[1], ARGV[1])
  if not id then return '' end
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
  return ARGV[2]
"#;

const REPLAY_LUA: &str = r#"
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local env = cjson.decode(raw)
  if not env.dead then return 0 end
  env.dead = nil
  env.dead_at = nil
  env.last_error = nil
  env.receipt = nil
  env.consumer = nil
  if ARGV[4] == '1' then env.attempts = 0 end
  local available = tonumber(ARGV[2]) + tonumber(ARGV[3])
  env.available_at = available
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(env))
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZADD', KEYS[3], available, ARGV[1])
  redis.call('HINCRBY', KEYS[4], 'replayed', 1)
  return 1
"#;

const DELETE_DEAD_LUA: &str = r#"
  local removed = redis.call('ZREM', KEYS[4], ARGV[1])
  if removed == 0 then return 0 end
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[3], ARGV[1])
  return 1
"#;
