// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Faststore persistence — Valkey/Redis in production, in-memory
//! fallback for development and tests. Keys are always tenant-scoped by the
//! caller and keep the exact namespace used by the TypeScript implementation so
//! a rolling deploy sees the existing cache entries:
//!
//! * value keys: `synapseone:faststore:v1:<tenant>:<key>`
//! * lock keys:  `synapseone:faststore:v1:<tenant>:__lock__:<name>`

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::FromRedisValue;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

pub const MAX_SCAN_KEYS: usize = 10_000;

pub const KEY_PREFIX: &str = "synapseone:faststore:v1:";
pub const LOCK_SEGMENT: &str = "__lock__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FaststoreError {
    KeyExists(String),
    NotFound(String),
    WrongType(String),
    NotANumber(String),
    StorageUnavailable(String),
    Internal(String),
}

#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    pub ttl_seconds: Option<i64>,
    pub if_not_exists: bool,
    pub if_exists: bool,
}

#[derive(Debug, Clone)]
pub struct ScannedKey {
    pub key: String,
    pub kind: &'static str,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ScanResult {
    pub keys: Vec<ScannedKey>,
    pub cursor: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct Stats {
    pub keys: usize,
    pub by_type: BTreeMap<&'static str, usize>,
}

#[derive(Debug, Clone)]
pub struct ValueEntry {
    pub kind: &'static str,
    pub value: Value,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct HashAll {
    pub values: Map<String, Value>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct FieldValue {
    pub found: bool,
    pub value: Option<Value>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ZMember {
    pub member: Value,
    pub score: f64,
}

/// Tenant key namespace: org-wide when present, else account-wide, else per user.
pub fn tenant_key(tenant: &str, key: &str) -> String {
    format!("{KEY_PREFIX}{tenant}:{key}")
}

pub fn lock_key(tenant: &str, name: &str) -> String {
    format!("{KEY_PREFIX}{tenant}:{LOCK_SEGMENT}:{name}")
}

pub fn encode_value(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

pub fn decode_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn ttl_from_millis(remaining_ms: i64) -> Option<i64> {
    Some((remaining_ms.max(0) as u64).div_ceil(1000) as i64)
}

fn relative_key<'a>(full: &'a str, base: &str) -> &'a str {
    full.strip_prefix(base).unwrap_or(full)
}

pub fn number_json(number: f64) -> Value {
    if number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_992.0 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

fn js_sort_key(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items.iter().map(js_sort_key).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn sort_decoded(values: &mut [Value]) -> Vec<Value> {
    values.sort_by_key(js_sort_key);
    values.to_vec()
}

fn escape_glob(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(character);
    }
    out
}

/// JavaScript `Array.prototype.slice` bounds for `start`/`stop` (inclusive stop
/// semantics used by the REST API; `stop == -1` means "to the end").
fn slice_bounds(len: usize, start: i64, stop: i64) -> (usize, usize) {
    let normalize = |index: i64| -> usize {
        if index < 0 {
            (len as i64 + index).max(0) as usize
        } else {
            index.min(len as i64) as usize
        }
    };
    let begin = normalize(start);
    let end_raw = if stop == -1 { len as i64 } else { stop + 1 };
    let end = normalize(end_raw);
    if end < begin {
        (begin, begin)
    } else {
        (begin, end)
    }
}

fn decode_object(raw: HashMap<String, String>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut fields: Vec<(String, String)> = raw.into_iter().collect();
    fields.sort_by(|left, right| left.0.cmp(&right.0));
    for (field, value) in fields {
        out.insert(field, decode_value(&value));
    }
    out
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub enum Store {
    Memory(MemoryStore),
    Redis(Box<RedisStore>),
}

impl Store {
    pub fn name(&self) -> &'static str {
        match self {
            Store::Memory(_) => "memory",
            Store::Redis(_) => "redis",
        }
    }

    pub async fn connect(url: Option<&str>) -> Result<Self, String> {
        match url {
            Some(url) if !url.trim().is_empty() => match RedisStore::connect(url).await {
                Ok(store) => Ok(Store::Redis(Box::new(store))),
                Err(error) => Err(error),
            },
            _ => Ok(Store::Memory(MemoryStore::new())),
        }
    }

    pub async fn set_value(
        &self,
        tenant: &str,
        key: &str,
        value: &Value,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.set_value(tenant, key, value, opts).await,
            Store::Redis(store) => store.set_value(tenant, key, value, opts).await,
        }
    }

    pub async fn get_value(
        &self,
        tenant: &str,
        key: &str,
    ) -> Result<Option<ValueEntry>, FaststoreError> {
        match self {
            Store::Memory(store) => store.get_value(tenant, key).await,
            Store::Redis(store) => store.get_value(tenant, key).await,
        }
    }

    pub async fn delete_key(&self, tenant: &str, key: &str) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.delete_key(tenant, key).await,
            Store::Redis(store) => store.delete_key(tenant, key).await,
        }
    }

    pub async fn expire_key(
        &self,
        tenant: &str,
        key: &str,
        ttl_seconds: i64,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.expire_key(tenant, key, ttl_seconds).await,
            Store::Redis(store) => store.expire_key(tenant, key, ttl_seconds).await,
        }
    }

    pub async fn ttl_key(&self, tenant: &str, key: &str) -> Result<Option<i64>, FaststoreError> {
        match self {
            Store::Memory(store) => store.ttl_key(tenant, key).await,
            Store::Redis(store) => store.ttl_key(tenant, key).await,
        }
    }

    pub async fn incr_value(
        &self,
        tenant: &str,
        key: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        match self {
            Store::Memory(store) => store.incr_value(tenant, key, by, ttl_seconds).await,
            Store::Redis(store) => store.incr_value(tenant, key, by, ttl_seconds).await,
        }
    }

    pub async fn scan_keys(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ScanResult, FaststoreError> {
        match self {
            Store::Memory(store) => store.scan_keys(tenant, prefix, limit, cursor).await,
            Store::Redis(store) => store.scan_keys(tenant, prefix, limit, cursor).await,
        }
    }

    pub async fn tenant_stats(&self, tenant: &str) -> Result<Stats, FaststoreError> {
        match self {
            Store::Memory(store) => store.tenant_stats(tenant).await,
            Store::Redis(store) => store.tenant_stats(tenant).await,
        }
    }

    pub async fn h_set_fields(
        &self,
        tenant: &str,
        key: &str,
        values: &Map<String, Value>,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.h_set_fields(tenant, key, values, opts).await,
            Store::Redis(store) => store.h_set_fields(tenant, key, values, opts).await,
        }
    }

    pub async fn h_get_all(
        &self,
        tenant: &str,
        key: &str,
    ) -> Result<Option<HashAll>, FaststoreError> {
        match self {
            Store::Memory(store) => store.h_get_all(tenant, key).await,
            Store::Redis(store) => store.h_get_all(tenant, key).await,
        }
    }

    pub async fn h_get_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<FieldValue, FaststoreError> {
        match self {
            Store::Memory(store) => store.h_get_field(tenant, key, field).await,
            Store::Redis(store) => store.h_get_field(tenant, key, field).await,
        }
    }

    pub async fn h_del_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.h_del_field(tenant, key, field).await,
            Store::Redis(store) => store.h_del_field(tenant, key, field).await,
        }
    }

    pub async fn h_incr_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        match self {
            Store::Memory(store) => {
                store
                    .h_incr_field(tenant, key, field, by, ttl_seconds)
                    .await
            }
            Store::Redis(store) => {
                store
                    .h_incr_field(tenant, key, field, by, ttl_seconds)
                    .await
            }
        }
    }

    pub async fn h_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.h_len(tenant, key).await,
            Store::Redis(store) => store.h_len(tenant, key).await,
        }
    }

    pub async fn l_push(
        &self,
        tenant: &str,
        key: &str,
        values: &[Value],
        side: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.l_push(tenant, key, values, side, ttl_seconds).await,
            Store::Redis(store) => store.l_push(tenant, key, values, side, ttl_seconds).await,
        }
    }

    pub async fn l_pop(
        &self,
        tenant: &str,
        key: &str,
        side: &str,
        count: usize,
    ) -> Result<Vec<Value>, FaststoreError> {
        match self {
            Store::Memory(store) => store.l_pop(tenant, key, side, count).await,
            Store::Redis(store) => store.l_pop(tenant, key, side, count).await,
        }
    }

    pub async fn l_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<Vec<Value>, FaststoreError> {
        match self {
            Store::Memory(store) => store.l_range(tenant, key, start, stop).await,
            Store::Redis(store) => store.l_range(tenant, key, start, stop).await,
        }
    }

    pub async fn l_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.l_len(tenant, key).await,
            Store::Redis(store) => store.l_len(tenant, key).await,
        }
    }

    pub async fn l_trim(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.l_trim(tenant, key, start, stop).await,
            Store::Redis(store) => store.l_trim(tenant, key, start, stop).await,
        }
    }

    pub async fn s_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.s_add(tenant, key, members, ttl_seconds).await,
            Store::Redis(store) => store.s_add(tenant, key, members, ttl_seconds).await,
        }
    }

    pub async fn s_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.s_rem(tenant, key, members).await,
            Store::Redis(store) => store.s_rem(tenant, key, members).await,
        }
    }

    pub async fn s_members(&self, tenant: &str, key: &str) -> Result<Vec<Value>, FaststoreError> {
        match self {
            Store::Memory(store) => store.s_members(tenant, key).await,
            Store::Redis(store) => store.s_members(tenant, key).await,
        }
    }

    pub async fn s_is_member(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.s_is_member(tenant, key, member).await,
            Store::Redis(store) => store.s_is_member(tenant, key, member).await,
        }
    }

    pub async fn s_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.s_card(tenant, key).await,
            Store::Redis(store) => store.s_card(tenant, key).await,
        }
    }

    pub async fn z_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[ZMember],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_add(tenant, key, members, ttl_seconds).await,
            Store::Redis(store) => store.z_add(tenant, key, members, ttl_seconds).await,
        }
    }

    pub async fn z_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_rem(tenant, key, members).await,
            Store::Redis(store) => store.z_rem(tenant, key, members).await,
        }
    }

    pub async fn z_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
        rev: bool,
    ) -> Result<Vec<ZMember>, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_range(tenant, key, start, stop, rev).await,
            Store::Redis(store) => store.z_range(tenant, key, start, stop, rev).await,
        }
    }

    pub async fn z_score(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<Option<f64>, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_score(tenant, key, member).await,
            Store::Redis(store) => store.z_score(tenant, key, member).await,
        }
    }

    pub async fn z_rank(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        rev: bool,
    ) -> Result<Option<i64>, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_rank(tenant, key, member, rev).await,
            Store::Redis(store) => store.z_rank(tenant, key, member, rev).await,
        }
    }

    pub async fn z_incr_by(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        by: f64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_incr_by(tenant, key, member, by, ttl_seconds).await,
            Store::Redis(store) => store.z_incr_by(tenant, key, member, by, ttl_seconds).await,
        }
    }

    pub async fn z_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        match self {
            Store::Memory(store) => store.z_card(tenant, key).await,
            Store::Redis(store) => store.z_card(tenant, key).await,
        }
    }

    pub async fn acquire_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.acquire_lock(tenant, name, token, ttl_ms).await,
            Store::Redis(store) => store.acquire_lock(tenant, name, token, ttl_ms).await,
        }
    }

    pub async fn release_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.release_lock(tenant, name, token).await,
            Store::Redis(store) => store.release_lock(tenant, name, token).await,
        }
    }

    pub async fn extend_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        match self {
            Store::Memory(store) => store.extend_lock(tenant, name, token, ttl_ms).await,
            Store::Redis(store) => store.extend_lock(tenant, name, token, ttl_ms).await,
        }
    }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum MemValue {
    String(String),
    Hash(BTreeMap<String, String>),
    List(Vec<String>),
    Set(BTreeSet<String>),
    ZSet(BTreeMap<String, f64>),
}

impl MemValue {
    fn kind(&self) -> &'static str {
        match self {
            MemValue::String(_) => "string",
            MemValue::Hash(_) => "hash",
            MemValue::List(_) => "list",
            MemValue::Set(_) => "set",
            MemValue::ZSet(_) => "zset",
        }
    }
}

#[derive(Clone)]
struct MemEntry {
    value: MemValue,
    expires_at: Option<Instant>,
}

#[derive(Clone)]
struct MemLock {
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
struct MemoryState {
    entries: BTreeMap<String, MemEntry>,
    locks: BTreeMap<String, MemLock>,
}

#[derive(Clone)]
pub struct MemoryStore {
    inner: Arc<Mutex<MemoryState>>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryState::default())),
        }
    }

    fn expiry_from(ttl_seconds: Option<i64>) -> Option<Instant> {
        match ttl_seconds {
            Some(ttl) if ttl > 0 => Some(Instant::now() + Duration::from_secs(ttl as u64)),
            _ => None,
        }
    }

    fn entry_ttl(entry: &MemEntry) -> Option<i64> {
        entry.expires_at.map(|expires_at| {
            let remaining = expires_at.saturating_duration_since(Instant::now());
            ttl_from_millis(remaining.as_millis() as i64).unwrap_or(0)
        })
    }

    async fn set_value(
        &self,
        tenant: &str,
        key: &str,
        value: &Value,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if opts.if_not_exists && existed {
            return Err(FaststoreError::KeyExists(format!(
                "key '{key}' already exists"
            )));
        }
        if opts.if_exists && !existed {
            return Err(FaststoreError::NotFound(format!("key '{key}' not found")));
        }
        state.entries.insert(
            full,
            MemEntry {
                value: MemValue::String(encode_value(value)),
                expires_at: Self::expiry_from(opts.ttl_seconds),
            },
        );
        Ok(!existed)
    }

    async fn get_value(
        &self,
        tenant: &str,
        key: &str,
    ) -> Result<Option<ValueEntry>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(None);
        };
        let ttl_seconds = Self::entry_ttl(entry);
        let value = match &entry.value {
            MemValue::String(raw) => decode_value(raw),
            MemValue::Hash(fields) => {
                let mut map = Map::new();
                for (field, raw) in fields {
                    map.insert(field.clone(), decode_value(raw));
                }
                Value::Object(map)
            }
            MemValue::List(items) => {
                Value::Array(items.iter().map(|raw| decode_value(raw)).collect())
            }
            MemValue::Set(items) => {
                let mut decoded: Vec<Value> = items.iter().map(|raw| decode_value(raw)).collect();
                Value::Array(sort_decoded(&mut decoded))
            }
            MemValue::ZSet(items) => {
                let mut sorted: Vec<(&String, &f64)> = items.iter().collect();
                sorted.sort_by(|left, right| {
                    left.1
                        .partial_cmp(right.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| left.0.cmp(right.0))
                });
                Value::Array(
                    sorted
                        .into_iter()
                        .map(|(member, score)| {
                            json!({"member": decode_value(member), "score": number_json(*score)})
                        })
                        .collect(),
                )
            }
        };
        Ok(Some(ValueEntry {
            kind: entry.value.kind(),
            value,
            ttl_seconds,
        }))
    }

    async fn delete_key(&self, tenant: &str, key: &str) -> Result<bool, FaststoreError> {
        let mut state = self.inner.lock().await;
        Ok(state.entries.remove(&tenant_key(tenant, key)).is_some())
    }

    async fn expire_key(
        &self,
        tenant: &str,
        key: &str,
        ttl_seconds: i64,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(false);
        };
        entry.expires_at = Self::expiry_from(Some(ttl_seconds));
        Ok(true)
    }

    async fn ttl_key(&self, tenant: &str, key: &str) -> Result<Option<i64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(None);
        };
        Ok(Some(Self::entry_ttl(entry).unwrap_or(-1)))
    }

    async fn incr_value(
        &self,
        tenant: &str,
        key: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let previous_expiry = match live_entry(&mut state, &full) {
            Some(entry) => match &entry.value {
                MemValue::String(raw) => Some((raw.clone(), entry.expires_at)),
                other => {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not string",
                        other.kind()
                    )))
                }
            },
            None => None,
        };
        let (raw, previous_expiry) = match previous_expiry {
            Some((raw, expiry)) => (raw, expiry),
            None => ("0".to_string(), None),
        };
        let current = raw.parse::<f64>().map_err(|_| {
            FaststoreError::NotANumber(format!("key '{key}' does not hold a number"))
        })?;
        let next = current + by as f64;
        let expires_at = match ttl_seconds {
            Some(ttl) => Self::expiry_from(Some(ttl)),
            None => previous_expiry,
        };
        state.entries.insert(
            full,
            MemEntry {
                value: MemValue::String(encode_value(&number_json(next))),
                expires_at,
            },
        );
        Ok(next)
    }

    async fn all_tenant_keys(&self, tenant: &str, prefix: &str) -> (Vec<String>, bool) {
        let mut state = self.inner.lock().await;
        purge_expired(&mut state);
        let base = format!("{KEY_PREFIX}{tenant}:");
        let mut keys: Vec<String> = state
            .entries
            .keys()
            .filter(|full| full.starts_with(&base) && relative_key(full, &base).starts_with(prefix))
            .cloned()
            .collect();
        keys.sort();
        let truncated = keys.len() > MAX_SCAN_KEYS;
        keys.truncate(MAX_SCAN_KEYS);
        (keys, truncated)
    }

    async fn scan_keys(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ScanResult, FaststoreError> {
        let (keys, truncated) = self.all_tenant_keys(tenant, prefix).await;
        let offset = cursor
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let base = format!("{KEY_PREFIX}{tenant}:");
        let page: Vec<String> = keys.iter().skip(offset).take(limit).cloned().collect();
        let mut scanned = Vec::new();
        {
            let mut state = self.inner.lock().await;
            for full in &page {
                if let Some(entry) = live_entry(&mut state, full) {
                    scanned.push(ScannedKey {
                        key: relative_key(full, &base).to_string(),
                        kind: entry.value.kind(),
                        ttl_seconds: Self::entry_ttl(entry),
                    });
                }
            }
        }
        let next = offset + page.len();
        let cursor = if next < keys.len() {
            Some(next.to_string())
        } else {
            None
        };
        Ok(ScanResult {
            keys: scanned,
            cursor,
            truncated,
        })
    }

    async fn tenant_stats(&self, tenant: &str) -> Result<Stats, FaststoreError> {
        let (keys, _) = self.all_tenant_keys(tenant, "").await;
        let mut by_type: BTreeMap<&'static str, usize> = BTreeMap::new();
        for name in ["string", "hash", "list", "set", "zset"] {
            by_type.insert(name, 0);
        }
        {
            let mut state = self.inner.lock().await;
            for full in &keys {
                if let Some(entry) = live_entry(&mut state, full) {
                    *by_type.entry(entry.value.kind()).or_insert(0) += 1;
                }
            }
        }
        let total = by_type.values().sum();
        Ok(Stats {
            keys: total,
            by_type,
        })
    }

    async fn h_set_fields(
        &self,
        tenant: &str,
        key: &str,
        values: &Map<String, Value>,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if opts.if_not_exists && existed {
            return Err(FaststoreError::KeyExists(format!(
                "key '{key}' already exists"
            )));
        }
        if opts.if_exists && !existed {
            return Err(FaststoreError::NotFound(format!("key '{key}' not found")));
        }
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::Hash(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not hash",
                        entry.value.kind()
                    )));
                }
            }
        }
        {
            let entry = state
                .entries
                .entry(full.clone())
                .or_insert_with(|| MemEntry {
                    value: MemValue::Hash(BTreeMap::new()),
                    expires_at: None,
                });
            if !matches!(entry.value, MemValue::Hash(_)) {
                return Err(FaststoreError::WrongType(format!(
                    "key holds {}, not hash",
                    entry.value.kind()
                )));
            }
            if let MemValue::Hash(fields) = &mut entry.value {
                for (field, value) in values {
                    fields.insert(field.clone(), encode_value(value));
                }
            }
            if let Some(ttl) = opts.ttl_seconds {
                entry.expires_at = Self::expiry_from(Some(ttl));
            }
        }
        Ok(!existed)
    }

    async fn h_get_all(&self, tenant: &str, key: &str) -> Result<Option<HashAll>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(None);
        };
        let MemValue::Hash(fields) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not hash",
                entry.value.kind()
            )));
        };
        let mut values = Map::new();
        for (field, raw) in fields {
            values.insert(field.clone(), decode_value(raw));
        }
        Ok(Some(HashAll {
            values,
            ttl_seconds: Self::entry_ttl(entry),
        }))
    }

    async fn h_get_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<FieldValue, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(FieldValue {
                found: false,
                value: None,
                ttl_seconds: None,
            });
        };
        let MemValue::Hash(fields) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not hash",
                entry.value.kind()
            )));
        };
        let raw = fields.get(field);
        Ok(FieldValue {
            found: raw.is_some(),
            value: raw.map(|raw| decode_value(raw)),
            ttl_seconds: Self::entry_ttl(entry),
        })
    }

    async fn h_del_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(false);
        };
        let MemValue::Hash(fields) = &mut entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not hash",
                entry.value.kind()
            )));
        };
        let removed = fields.remove(field).is_some();
        if fields.is_empty() {
            state.entries.remove(&full);
        }
        Ok(removed)
    }

    async fn h_incr_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::Hash(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not hash",
                        entry.value.kind()
                    )));
                }
            }
        }
        let entry = state.entries.entry(full).or_insert_with(|| MemEntry {
            value: MemValue::Hash(BTreeMap::new()),
            expires_at: None,
        });
        if !matches!(entry.value, MemValue::Hash(_)) {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not hash",
                entry.value.kind()
            )));
        }
        let MemValue::Hash(fields) = &mut entry.value else {
            unreachable!();
        };
        let raw = fields
            .get(field)
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let current = raw.parse::<f64>().map_err(|_| {
            FaststoreError::NotANumber(format!("field '{field}' does not hold a number"))
        })?;
        let next = current + by as f64;
        fields.insert(field.to_string(), encode_value(&number_json(next)));
        if let Some(ttl) = ttl_seconds {
            entry.expires_at = Self::expiry_from(Some(ttl));
        }
        Ok(next)
    }

    async fn h_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::Hash(fields) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not hash",
                entry.value.kind()
            )));
        };
        Ok(fields.len())
    }

    async fn l_push(
        &self,
        tenant: &str,
        key: &str,
        values: &[Value],
        side: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::List(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not list",
                        entry.value.kind()
                    )));
                }
            }
        }
        let entry = state.entries.entry(full).or_insert_with(|| MemEntry {
            value: MemValue::List(Vec::new()),
            expires_at: None,
        });
        if !matches!(entry.value, MemValue::List(_)) {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not list",
                entry.value.kind()
            )));
        }
        let MemValue::List(items) = &mut entry.value else {
            unreachable!();
        };
        let encoded: Vec<String> = values.iter().map(encode_value).collect();
        if side == "left" {
            for value in encoded {
                items.insert(0, value);
            }
        } else {
            items.extend(encoded);
        }
        if let Some(ttl) = ttl_seconds {
            entry.expires_at = Self::expiry_from(Some(ttl));
        }
        Ok(items.len())
    }

    async fn l_pop(
        &self,
        tenant: &str,
        key: &str,
        side: &str,
        count: usize,
    ) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(Vec::new());
        };
        let MemValue::List(items) = &mut entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not list",
                entry.value.kind()
            )));
        };
        let drained: Vec<String> = if side == "left" {
            let take = count.min(items.len());
            items.drain(0..take).collect()
        } else {
            let take = count.min(items.len());
            let split = items.len() - take;
            items.drain(split..).collect()
        };
        if items.is_empty() {
            state.entries.remove(&full);
        }
        Ok(drained.iter().map(|raw| decode_value(raw)).collect())
    }

    async fn l_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(Vec::new());
        };
        let MemValue::List(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not list",
                entry.value.kind()
            )));
        };
        let (begin, end) = slice_bounds(items.len(), start, stop);
        Ok(items[begin..end]
            .iter()
            .map(|raw| decode_value(raw))
            .collect())
    }

    async fn l_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::List(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not list",
                entry.value.kind()
            )));
        };
        Ok(items.len())
    }

    async fn l_trim(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(false);
        };
        let MemValue::List(items) = &mut entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not list",
                entry.value.kind()
            )));
        };
        let (begin, end) = slice_bounds(items.len(), start, stop);
        *items = items[begin..end].to_vec();
        if items.is_empty() {
            state.entries.remove(&full);
        }
        Ok(true)
    }

    async fn s_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::Set(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not set",
                        entry.value.kind()
                    )));
                }
            }
        }
        let entry = state.entries.entry(full).or_insert_with(|| MemEntry {
            value: MemValue::Set(BTreeSet::new()),
            expires_at: None,
        });
        if !matches!(entry.value, MemValue::Set(_)) {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not set",
                entry.value.kind()
            )));
        }
        let MemValue::Set(items) = &mut entry.value else {
            unreachable!();
        };
        let mut added = 0;
        for member in members {
            if items.insert(encode_value(member)) {
                added += 1;
            }
        }
        if let Some(ttl) = ttl_seconds {
            entry.expires_at = Self::expiry_from(Some(ttl));
        }
        Ok(added)
    }

    async fn s_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::Set(items) = &mut entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not set",
                entry.value.kind()
            )));
        };
        let mut removed = 0;
        for member in members {
            if items.remove(&encode_value(member)) {
                removed += 1;
            }
        }
        if items.is_empty() {
            state.entries.remove(&full);
        }
        Ok(removed)
    }

    async fn s_members(&self, tenant: &str, key: &str) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(Vec::new());
        };
        let MemValue::Set(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not set",
                entry.value.kind()
            )));
        };
        let mut decoded: Vec<Value> = items.iter().map(|raw| decode_value(raw)).collect();
        Ok(sort_decoded(&mut decoded))
    }

    async fn s_is_member(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(false);
        };
        let MemValue::Set(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not set",
                entry.value.kind()
            )));
        };
        Ok(items.contains(&encode_value(member)))
    }

    async fn s_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::Set(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not set",
                entry.value.kind()
            )));
        };
        Ok(items.len())
    }

    async fn z_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[ZMember],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::ZSet(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not zset",
                        entry.value.kind()
                    )));
                }
            }
        }
        let entry = state.entries.entry(full).or_insert_with(|| MemEntry {
            value: MemValue::ZSet(BTreeMap::new()),
            expires_at: None,
        });
        if !matches!(entry.value, MemValue::ZSet(_)) {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        }
        let MemValue::ZSet(items) = &mut entry.value else {
            unreachable!();
        };
        let mut added = 0;
        for member in members {
            let encoded = encode_value(&member.member);
            if !items.contains_key(&encoded) {
                added += 1;
            }
            items.insert(encoded, member.score);
        }
        if let Some(ttl) = ttl_seconds {
            entry.expires_at = Self::expiry_from(Some(ttl));
        }
        Ok(added)
    }

    async fn z_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry_mut(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::ZSet(items) = &mut entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        };
        let mut removed = 0;
        for member in members {
            if items.remove(&encode_value(member)).is_some() {
                removed += 1;
            }
        }
        if items.is_empty() {
            state.entries.remove(&full);
        }
        Ok(removed)
    }

    async fn z_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
        rev: bool,
    ) -> Result<Vec<ZMember>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(Vec::new());
        };
        let MemValue::ZSet(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        };
        let mut sorted: Vec<(&String, &f64)> = items.iter().collect();
        sorted.sort_by(|left, right| {
            left.1
                .partial_cmp(right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(right.0))
        });
        if rev {
            sorted.reverse();
        }
        let (begin, end) = slice_bounds(sorted.len(), start, stop);
        Ok(sorted[begin..end]
            .iter()
            .map(|(member, score)| ZMember {
                member: decode_value(member),
                score: **score,
            })
            .collect())
    }

    async fn z_score(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<Option<f64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(None);
        };
        let MemValue::ZSet(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        };
        Ok(items.get(&encode_value(member)).copied())
    }

    async fn z_rank(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        rev: bool,
    ) -> Result<Option<i64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(None);
        };
        let MemValue::ZSet(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        };
        let mut sorted: Vec<(&String, &f64)> = items.iter().collect();
        sorted.sort_by(|left, right| {
            left.1
                .partial_cmp(right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(right.0))
        });
        if rev {
            sorted.reverse();
        }
        let encoded = encode_value(member);
        Ok(sorted
            .iter()
            .position(|(candidate, _)| **candidate == encoded)
            .map(|index| index as i64))
    }

    async fn z_incr_by(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        by: f64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let existed = live_entry(&mut state, &full).is_some();
        if existed {
            if let Some(entry) = live_entry(&mut state, &full) {
                if !matches!(entry.value, MemValue::ZSet(_)) {
                    return Err(FaststoreError::WrongType(format!(
                        "key holds {}, not zset",
                        entry.value.kind()
                    )));
                }
            }
        }
        let entry = state.entries.entry(full).or_insert_with(|| MemEntry {
            value: MemValue::ZSet(BTreeMap::new()),
            expires_at: None,
        });
        if !matches!(entry.value, MemValue::ZSet(_)) {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        }
        let MemValue::ZSet(items) = &mut entry.value else {
            unreachable!();
        };
        let encoded = encode_value(member);
        let next = items.get(&encoded).copied().unwrap_or(0.0) + by;
        items.insert(encoded, next);
        if let Some(ttl) = ttl_seconds {
            entry.expires_at = Self::expiry_from(Some(ttl));
        }
        Ok(next)
    }

    async fn z_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut state = self.inner.lock().await;
        let Some(entry) = live_entry(&mut state, &full) else {
            return Ok(0);
        };
        let MemValue::ZSet(items) = &entry.value else {
            return Err(FaststoreError::WrongType(format!(
                "key holds {}, not zset",
                entry.value.kind()
            )));
        };
        Ok(items.len())
    }

    async fn acquire_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let mut state = self.inner.lock().await;
        let now = Instant::now();
        if let Some(existing) = state.locks.get(&full) {
            if existing.expires_at > now {
                return Ok(false);
            }
        }
        state.locks.insert(
            full,
            MemLock {
                token: token.to_string(),
                expires_at: now + Duration::from_millis(ttl_ms.max(0) as u64),
            },
        );
        Ok(true)
    }

    async fn release_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let mut state = self.inner.lock().await;
        let now = Instant::now();
        match state.locks.get(&full) {
            Some(existing) if existing.token == token && existing.expires_at > now => {
                state.locks.remove(&full);
                Ok(true)
            }
            Some(existing) if existing.expires_at <= now => {
                state.locks.remove(&full);
                Ok(false)
            }
            _ => Ok(false),
        }
    }

    async fn extend_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let mut state = self.inner.lock().await;
        let now = Instant::now();
        match state.locks.get_mut(&full) {
            Some(existing) if existing.token == token && existing.expires_at > now => {
                existing.expires_at = now + Duration::from_millis(ttl_ms.max(0) as u64);
                Ok(true)
            }
            Some(existing) if existing.expires_at <= now => {
                state.locks.remove(&full);
                Ok(false)
            }
            _ => Ok(false),
        }
    }
}

fn purge_expired(state: &mut MemoryState) {
    let now = Instant::now();
    state
        .entries
        .retain(|_, entry| entry.expires_at.map(|at| at > now).unwrap_or(true));
    state.locks.retain(|_, lock| lock.expires_at > now);
}

fn live_entry<'a>(state: &'a mut MemoryState, full: &str) -> Option<&'a MemEntry> {
    let expired = {
        let entry = state.entries.get(full)?;
        entry
            .expires_at
            .map(|at| at <= Instant::now())
            .unwrap_or(false)
    };
    if expired {
        state.entries.remove(full);
        return None;
    }
    state.entries.get(full)
}

fn live_entry_mut<'a>(state: &'a mut MemoryState, full: &str) -> Option<&'a mut MemEntry> {
    let expired = {
        let entry = state.entries.get(full)?;
        entry
            .expires_at
            .map(|at| at <= Instant::now())
            .unwrap_or(false)
    };
    if expired {
        state.entries.remove(full);
        return None;
    }
    state.entries.get_mut(full)
}

// ---------------------------------------------------------------------------
// Redis / Valkey backend
// ---------------------------------------------------------------------------

const INCR_SCRIPT: &str = r"
local v = redis.call('GET', KEYS[1])
if v == false then v = '0' end
if tonumber(v) == nil then return redis.error_reply('NOT_A_NUMBER') end
local out = redis.call('INCRBY', KEYS[1], ARGV[1])
if ARGV[2] ~= '' then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return out";

const RELEASE_LOCK: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0";

const EXTEND_LOCK: &str = r"
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0";

#[derive(Clone)]
pub struct RedisStore {
    conn: ConnectionManager,
}

impl RedisStore {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let client = redis::Client::open(url).map_err(|error| error.to_string())?;
        // Match the TypeScript client: a short connect timeout and no endless
        // retry loop, so an unreachable Valkey falls back to memory in dev and
        // fails closed quickly in production.
        let config = ConnectionManagerConfig::new()
            .set_number_of_retries(0)
            .set_connection_timeout(Duration::from_millis(2000));
        let mut conn = ConnectionManager::new_with_config(client, config)
            .await
            .map_err(|error| error.to_string())?;
        let _: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self { conn })
    }

    async fn query<T: FromRedisValue>(&self, cmd: &redis::Cmd) -> Result<T, FaststoreError> {
        let mut conn = self.conn.clone();
        cmd.query_async(&mut conn).await.map_err(map_redis_error)
    }

    async fn expire_with(
        &self,
        full: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<(), FaststoreError> {
        if let Some(ttl) = ttl_seconds {
            if ttl > 0 {
                let _: i64 = self.query(redis::cmd("EXPIRE").arg(full).arg(ttl)).await?;
            } else {
                let _: i64 = self.query(redis::cmd("PERSIST").arg(full)).await?;
            }
        }
        Ok(())
    }

    async fn raw_ttl(&self, full: &str) -> Result<i64, FaststoreError> {
        self.query(redis::cmd("TTL").arg(full)).await
    }

    async fn key_type(&self, full: &str) -> Result<String, FaststoreError> {
        self.query(redis::cmd("TYPE").arg(full)).await
    }

    async fn set_value(
        &self,
        tenant: &str,
        key: &str,
        value: &Value,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let existed: i64 = self.query(redis::cmd("EXISTS").arg(&full)).await?;
        let existed = existed == 1;
        if opts.if_not_exists && existed {
            return Err(FaststoreError::KeyExists(format!(
                "key '{key}' already exists"
            )));
        }
        if opts.if_exists && !existed {
            return Err(FaststoreError::NotFound(format!("key '{key}' not found")));
        }
        let mut cmd = redis::cmd("SET");
        cmd.arg(&full).arg(encode_value(value));
        if opts.if_not_exists {
            cmd.arg("NX");
        } else if opts.if_exists {
            cmd.arg("XX");
        }
        if let Some(ttl) = opts.ttl_seconds {
            if ttl > 0 {
                cmd.arg("EX").arg(ttl);
            }
        }
        let result: Option<String> = self.query(&cmd).await?;
        if result.is_none() {
            return Err(if opts.if_not_exists {
                FaststoreError::KeyExists(format!("key '{key}' already exists"))
            } else {
                FaststoreError::NotFound(format!("key '{key}' not found"))
            });
        }
        Ok(!existed)
    }

    async fn get_value(
        &self,
        tenant: &str,
        key: &str,
    ) -> Result<Option<ValueEntry>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(None);
        }
        let ttl = self.raw_ttl(&full).await?;
        let ttl_seconds = (ttl >= 0).then_some(ttl);
        let value = match kind.as_str() {
            "string" => {
                let raw: Option<String> = self.query(redis::cmd("GET").arg(&full)).await?;
                match raw {
                    Some(raw) => decode_value(&raw),
                    None => return Ok(None),
                }
            }
            "hash" => {
                let raw: HashMap<String, String> =
                    self.query(redis::cmd("HGETALL").arg(&full)).await?;
                Value::Object(decode_object(raw))
            }
            "list" => {
                let raw: Vec<String> = self
                    .query(redis::cmd("LRANGE").arg(&full).arg(0).arg(-1))
                    .await?;
                Value::Array(raw.iter().map(|item| decode_value(item)).collect())
            }
            "set" => {
                let raw: Vec<String> = self.query(redis::cmd("SMEMBERS").arg(&full)).await?;
                let mut decoded: Vec<Value> = raw.iter().map(|item| decode_value(item)).collect();
                Value::Array(sort_decoded(&mut decoded))
            }
            "zset" => {
                let raw: Vec<String> = self
                    .query(
                        redis::cmd("ZRANGE")
                            .arg(&full)
                            .arg(0)
                            .arg(-1)
                            .arg("WITHSCORES"),
                    )
                    .await?;
                Value::Array(parse_zrange(&raw, true))
            }
            other => {
                return Err(FaststoreError::WrongType(format!(
                    "unsupported key type '{other}'"
                )))
            }
        };
        Ok(Some(ValueEntry {
            kind: match kind.as_str() {
                "string" => "string",
                "hash" => "hash",
                "list" => "list",
                "set" => "set",
                _ => "zset",
            },
            value,
            ttl_seconds,
        }))
    }

    async fn delete_key(&self, tenant: &str, key: &str) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let removed: i64 = self.query(redis::cmd("DEL").arg(&full)).await?;
        Ok(removed > 0)
    }

    async fn expire_key(
        &self,
        tenant: &str,
        key: &str,
        ttl_seconds: i64,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let changed: i64 = if ttl_seconds == 0 {
            self.query(redis::cmd("PERSIST").arg(&full)).await?
        } else {
            self.query(redis::cmd("EXPIRE").arg(&full).arg(ttl_seconds))
                .await?
        };
        Ok(changed == 1)
    }

    async fn ttl_key(&self, tenant: &str, key: &str) -> Result<Option<i64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let ttl = self.raw_ttl(&full).await?;
        if ttl == -2 {
            return Ok(None);
        }
        Ok(Some(if ttl == -1 { -1 } else { ttl }))
    }

    async fn incr_value(
        &self,
        tenant: &str,
        key: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let ttl = match ttl_seconds {
            Some(ttl) if ttl > 0 => ttl.to_string(),
            _ => String::new(),
        };
        let value: i64 = self
            .query(
                redis::cmd("EVAL")
                    .arg(INCR_SCRIPT)
                    .arg(1)
                    .arg(&full)
                    .arg(by)
                    .arg(ttl),
            )
            .await?;
        Ok(value as f64)
    }

    async fn all_tenant_keys(
        &self,
        tenant: &str,
        prefix: &str,
    ) -> Result<(Vec<String>, bool), FaststoreError> {
        let base = format!("{KEY_PREFIX}{tenant}:");
        let pattern = format!("{base}{}*", escape_glob(prefix));
        let mut cursor = "0".to_string();
        let mut out: Vec<String> = Vec::new();
        loop {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(500);
            let (next, batch): (String, Vec<String>) = self.query(&cmd).await?;
            cursor = next;
            for key in batch {
                out.push(key);
                if out.len() >= MAX_SCAN_KEYS {
                    out.sort();
                    return Ok((out, true));
                }
            }
            if cursor == "0" {
                break;
            }
        }
        out.sort();
        Ok((out, false))
    }

    async fn scan_keys(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ScanResult, FaststoreError> {
        let (keys, truncated) = self.all_tenant_keys(tenant, prefix).await?;
        let offset = cursor
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let base = format!("{KEY_PREFIX}{tenant}:");
        let page: Vec<String> = keys.iter().skip(offset).take(limit).cloned().collect();
        let mut scanned = Vec::new();
        for full in &page {
            if let Ok(Some(meta)) = self.meta_for(full, &full[base.len()..]).await {
                scanned.push(meta);
            }
        }
        let next = offset + page.len();
        let cursor = if next < keys.len() {
            Some(next.to_string())
        } else {
            None
        };
        Ok(ScanResult {
            keys: scanned,
            cursor,
            truncated,
        })
    }

    async fn meta_for(&self, full: &str, key: &str) -> Result<Option<ScannedKey>, FaststoreError> {
        let kind = self.key_type(full).await?;
        if kind == "none" {
            return Ok(None);
        }
        let ttl = self.raw_ttl(full).await?;
        let mapped = match kind.as_str() {
            "string" | "hash" | "list" | "set" | "zset" => kind.as_str(),
            _ => "string",
        };
        Ok(Some(ScannedKey {
            key: key.to_string(),
            kind: match mapped {
                "hash" => "hash",
                "list" => "list",
                "set" => "set",
                "zset" => "zset",
                _ => "string",
            },
            ttl_seconds: (ttl >= 0).then_some(ttl),
        }))
    }

    async fn tenant_stats(&self, tenant: &str) -> Result<Stats, FaststoreError> {
        let (keys, _) = self.all_tenant_keys(tenant, "").await?;
        let base = format!("{KEY_PREFIX}{tenant}:");
        let mut by_type: BTreeMap<&'static str, usize> = BTreeMap::new();
        for name in ["string", "hash", "list", "set", "zset"] {
            by_type.insert(name, 0);
        }
        for full in &keys {
            if let Ok(Some(meta)) = self.meta_for(full, relative_key(full, &base)).await {
                *by_type.entry(meta.kind).or_insert(0) += 1;
            }
        }
        let total = by_type.values().sum();
        Ok(Stats {
            keys: total,
            by_type,
        })
    }

    async fn h_set_fields(
        &self,
        tenant: &str,
        key: &str,
        values: &Map<String, Value>,
        opts: &WriteOptions,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let existed: i64 = self.query(redis::cmd("EXISTS").arg(&full)).await?;
        let existed = existed == 1;
        if opts.if_not_exists && existed {
            return Err(FaststoreError::KeyExists(format!(
                "key '{key}' already exists"
            )));
        }
        if opts.if_exists && !existed {
            return Err(FaststoreError::NotFound(format!("key '{key}' not found")));
        }
        let mut cmd = redis::cmd("HSET");
        cmd.arg(&full);
        for (field, value) in values {
            cmd.arg(field).arg(encode_value(value));
        }
        let _: i64 = self.query(&cmd).await?;
        self.expire_with(&full, opts.ttl_seconds).await?;
        Ok(!existed)
    }

    async fn h_get_all(&self, tenant: &str, key: &str) -> Result<Option<HashAll>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(None);
        }
        if kind != "hash" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not hash"
            )));
        }
        let raw: HashMap<String, String> = self.query(redis::cmd("HGETALL").arg(&full)).await?;
        let ttl = self.raw_ttl(&full).await?;
        Ok(Some(HashAll {
            values: decode_object(raw),
            ttl_seconds: (ttl >= 0).then_some(ttl),
        }))
    }

    async fn h_get_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<FieldValue, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(FieldValue {
                found: false,
                value: None,
                ttl_seconds: None,
            });
        }
        if kind != "hash" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not hash"
            )));
        }
        let raw: Option<String> = self.query(redis::cmd("HGET").arg(&full).arg(field)).await?;
        let ttl = self.raw_ttl(&full).await?;
        Ok(FieldValue {
            found: raw.is_some(),
            value: raw.as_deref().map(decode_value),
            ttl_seconds: (ttl >= 0).then_some(ttl),
        })
    }

    async fn h_del_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(false);
        }
        if kind != "hash" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not hash"
            )));
        }
        let removed: i64 = self.query(redis::cmd("HDEL").arg(&full).arg(field)).await?;
        Ok(removed > 0)
    }

    async fn h_incr_field(
        &self,
        tenant: &str,
        key: &str,
        field: &str,
        by: i64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let value: i64 = self
            .query(redis::cmd("HINCRBY").arg(&full).arg(field).arg(by))
            .await?;
        self.expire_with(&full, ttl_seconds).await?;
        Ok(value as f64)
    }

    async fn h_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "hash" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not hash"
            )));
        }
        let len: i64 = self.query(redis::cmd("HLEN").arg(&full)).await?;
        Ok(len.max(0) as usize)
    }

    async fn l_push(
        &self,
        tenant: &str,
        key: &str,
        values: &[Value],
        side: &str,
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut cmd = redis::cmd(if side == "left" { "LPUSH" } else { "RPUSH" });
        cmd.arg(&full);
        for value in values {
            cmd.arg(encode_value(value));
        }
        let len: i64 = self.query(&cmd).await?;
        self.expire_with(&full, ttl_seconds).await?;
        Ok(len.max(0) as usize)
    }

    async fn l_pop(
        &self,
        tenant: &str,
        key: &str,
        side: &str,
        count: usize,
    ) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(Vec::new());
        }
        if kind != "list" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not list"
            )));
        }
        let mut cmd = redis::cmd(if side == "left" { "LPOP" } else { "RPOP" });
        cmd.arg(&full).arg(count);
        let raw: Option<Vec<String>> = self.query(&cmd).await?;
        Ok(raw
            .unwrap_or_default()
            .iter()
            .map(|item| decode_value(item))
            .collect())
    }

    async fn l_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(Vec::new());
        }
        if kind != "list" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not list"
            )));
        }
        let raw: Vec<String> = self
            .query(redis::cmd("LRANGE").arg(&full).arg(start).arg(stop))
            .await?;
        Ok(raw.iter().map(|item| decode_value(item)).collect())
    }

    async fn l_len(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "list" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not list"
            )));
        }
        let len: i64 = self.query(redis::cmd("LLEN").arg(&full)).await?;
        Ok(len.max(0) as usize)
    }

    async fn l_trim(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(false);
        }
        if kind != "list" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not list"
            )));
        }
        let _: String = self
            .query(redis::cmd("LTRIM").arg(&full).arg(start).arg(stop))
            .await?;
        Ok(true)
    }

    async fn s_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut cmd = redis::cmd("SADD");
        cmd.arg(&full);
        for member in members {
            cmd.arg(encode_value(member));
        }
        let added: i64 = self.query(&cmd).await?;
        self.expire_with(&full, ttl_seconds).await?;
        Ok(added.max(0) as usize)
    }

    async fn s_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "set" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not set"
            )));
        }
        let mut cmd = redis::cmd("SREM");
        cmd.arg(&full);
        for member in members {
            cmd.arg(encode_value(member));
        }
        let removed: i64 = self.query(&cmd).await?;
        Ok(removed.max(0) as usize)
    }

    async fn s_members(&self, tenant: &str, key: &str) -> Result<Vec<Value>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(Vec::new());
        }
        if kind != "set" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not set"
            )));
        }
        let raw: Vec<String> = self.query(redis::cmd("SMEMBERS").arg(&full)).await?;
        let mut decoded: Vec<Value> = raw.iter().map(|item| decode_value(item)).collect();
        Ok(sort_decoded(&mut decoded))
    }

    async fn s_is_member(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<bool, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(false);
        }
        if kind != "set" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not set"
            )));
        }
        let present: i64 = self
            .query(redis::cmd("SISMEMBER").arg(&full).arg(encode_value(member)))
            .await?;
        Ok(present == 1)
    }

    async fn s_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "set" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not set"
            )));
        }
        let card: i64 = self.query(redis::cmd("SCARD").arg(&full)).await?;
        Ok(card.max(0) as usize)
    }

    async fn z_add(
        &self,
        tenant: &str,
        key: &str,
        members: &[ZMember],
        ttl_seconds: Option<i64>,
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let mut cmd = redis::cmd("ZADD");
        cmd.arg(&full);
        for member in members {
            cmd.arg(member.score.to_string())
                .arg(encode_value(&member.member));
        }
        let added: i64 = self.query(&cmd).await?;
        self.expire_with(&full, ttl_seconds).await?;
        Ok(added.max(0) as usize)
    }

    async fn z_rem(
        &self,
        tenant: &str,
        key: &str,
        members: &[Value],
    ) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "zset" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not zset"
            )));
        }
        let mut cmd = redis::cmd("ZREM");
        cmd.arg(&full);
        for member in members {
            cmd.arg(encode_value(member));
        }
        let removed: i64 = self.query(&cmd).await?;
        Ok(removed.max(0) as usize)
    }

    async fn z_range(
        &self,
        tenant: &str,
        key: &str,
        start: i64,
        stop: i64,
        rev: bool,
    ) -> Result<Vec<ZMember>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(Vec::new());
        }
        if kind != "zset" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not zset"
            )));
        }
        let mut cmd = redis::cmd("ZRANGE");
        cmd.arg(&full).arg(start).arg(stop);
        if rev {
            cmd.arg("REV");
        }
        cmd.arg("WITHSCORES");
        let raw: Vec<String> = self.query(&cmd).await?;
        Ok(parse_zmembers(&raw))
    }

    async fn z_score(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
    ) -> Result<Option<f64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(None);
        }
        if kind != "zset" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not zset"
            )));
        }
        let raw: Option<String> = self
            .query(redis::cmd("ZSCORE").arg(&full).arg(encode_value(member)))
            .await?;
        Ok(raw.and_then(|value| value.parse::<f64>().ok()))
    }

    async fn z_rank(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        rev: bool,
    ) -> Result<Option<i64>, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(None);
        }
        if kind != "zset" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not zset"
            )));
        }
        let command = if rev { "ZREVRANK" } else { "ZRANK" };
        let raw: Option<i64> = self
            .query(redis::cmd(command).arg(&full).arg(encode_value(member)))
            .await?;
        Ok(raw)
    }

    async fn z_incr_by(
        &self,
        tenant: &str,
        key: &str,
        member: &Value,
        by: f64,
        ttl_seconds: Option<i64>,
    ) -> Result<f64, FaststoreError> {
        let full = tenant_key(tenant, key);
        let raw: String = self
            .query(
                redis::cmd("ZINCRBY")
                    .arg(&full)
                    .arg(by.to_string())
                    .arg(encode_value(member)),
            )
            .await?;
        self.expire_with(&full, ttl_seconds).await?;
        raw.parse::<f64>()
            .map_err(|_| FaststoreError::Internal("invalid ZINCRBY reply".into()))
    }

    async fn z_card(&self, tenant: &str, key: &str) -> Result<usize, FaststoreError> {
        let full = tenant_key(tenant, key);
        let kind = self.key_type(&full).await?;
        if kind == "none" {
            return Ok(0);
        }
        if kind != "zset" {
            return Err(FaststoreError::WrongType(format!(
                "key holds {kind}, not zset"
            )));
        }
        let card: i64 = self.query(redis::cmd("ZCARD").arg(&full)).await?;
        Ok(card.max(0) as usize)
    }

    async fn acquire_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let result: Option<String> = self
            .query(
                redis::cmd("SET")
                    .arg(&full)
                    .arg(token)
                    .arg("PX")
                    .arg(ttl_ms)
                    .arg("NX"),
            )
            .await?;
        Ok(result.as_deref() == Some("OK"))
    }

    async fn release_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let released: i64 = self
            .query(
                redis::cmd("EVAL")
                    .arg(RELEASE_LOCK)
                    .arg(1)
                    .arg(&full)
                    .arg(token),
            )
            .await?;
        Ok(released == 1)
    }

    async fn extend_lock(
        &self,
        tenant: &str,
        name: &str,
        token: &str,
        ttl_ms: i64,
    ) -> Result<bool, FaststoreError> {
        let full = lock_key(tenant, name);
        let extended: i64 = self
            .query(
                redis::cmd("EVAL")
                    .arg(EXTEND_LOCK)
                    .arg(1)
                    .arg(&full)
                    .arg(token)
                    .arg(ttl_ms),
            )
            .await?;
        Ok(extended == 1)
    }
}

fn parse_zrange(raw: &[String], with_scores: bool) -> Vec<Value> {
    let mut out = Vec::new();
    for chunk in raw.chunks(2) {
        let member = decode_value(&chunk[0]);
        if with_scores && chunk.len() > 1 {
            let score = chunk[1].parse::<f64>().unwrap_or(0.0);
            out.push(json!({"member": member, "score": number_json(score)}));
        } else {
            out.push(member);
        }
    }
    out
}

fn parse_zmembers(raw: &[String]) -> Vec<ZMember> {
    let mut out = Vec::new();
    for chunk in raw.chunks(2) {
        if chunk.len() < 2 {
            break;
        }
        out.push(ZMember {
            member: decode_value(&chunk[0]),
            score: chunk[1].parse::<f64>().unwrap_or(0.0),
        });
    }
    out
}

fn map_redis_error(error: redis::RedisError) -> FaststoreError {
    let message = error.to_string();
    if message.contains("WRONGTYPE") {
        return FaststoreError::WrongType("key holds a different value type".into());
    }
    let lower = message.to_lowercase();
    if lower.contains("not_a_number")
        || lower.contains("not an integer")
        || lower.contains("is not a valid float")
        || lower.contains("value is not an integer")
    {
        return FaststoreError::NotANumber("value is not a number".into());
    }
    if message.contains("ECONNREFUSED")
        || message.contains("ECONNRESET")
        || message.contains("NR_CLOSED")
        || message.contains("Connection is closed")
        || message.contains("Loading")
        || message.contains("READONLY")
    {
        return FaststoreError::StorageUnavailable("cache backend is unavailable".into());
    }
    FaststoreError::Internal(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_namespace_matches_the_typescript_store() {
        assert_eq!(
            tenant_key("org:acme", "session:1"),
            "synapseone:faststore:v1:org:acme:session:1"
        );
        assert_eq!(
            tenant_key("user:u-1", "a/b"),
            "synapseone:faststore:v1:user:u-1:a/b"
        );
        assert_eq!(
            lock_key("account:acc-1", "job"),
            "synapseone:faststore:v1:account:acc-1:__lock__:job"
        );
    }

    #[test]
    fn json_round_trip_and_fallback() {
        assert_eq!(encode_value(&json!({"a": 1})), "{\"a\":1}");
        assert_eq!(decode_value("{\"a\":1}"), json!({"a": 1}));
        assert_eq!(decode_value("plain"), Value::String("plain".into()));
        // JSON object member order is preserved like JavaScript's
        // JSON.stringify, which keeps set/zset member encodings stable.
        assert_eq!(encode_value(&json!({"b": 1, "a": 2})), "{\"b\":1,\"a\":2}");
    }

    #[test]
    fn glob_escaping_matches_the_typescript_store() {
        assert_eq!(escape_glob("x:*"), "x:\\*");
        assert_eq!(escape_glob("[a]"), "\\[a\\]");
    }
}
