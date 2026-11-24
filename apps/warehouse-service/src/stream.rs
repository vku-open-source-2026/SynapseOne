// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Stream ETL workers: read a micro-batch from SynapseStream, append rows to
//! the target dataset, then ack only after the durable write succeeds.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::store::WarehouseStore;
use crate::types::{DatasetMeta, JobMeta, StreamEventRows};
use crate::util::js_string;

#[derive(Clone)]
pub struct StreamRuntime {
    store: WarehouseStore,
    registry: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    base_url: String,
    lakehouse_url: String,
    secret: String,
    client: reqwest::Client,
}

/// Identity of one Base document state in the Lakehouse change log. The
/// collection id and document creation time keep a deleted/re-created
/// collection or document from colliding with its previous incarnation.
/// `create` and `update` at one version describe one upsert state; `delete`
/// is a separate tombstone at that version.
fn lakehouse_change_key(
    collection_id: &str,
    document_id: &str,
    created_at: &str,
    version: i64,
    operation: &str,
) -> String {
    let operation_key = if operation == "delete" {
        "delete"
    } else {
        "upsert"
    };
    format!("base:{collection_id}:{document_id}:{created_at}:{version}:{operation_key}")
}

impl StreamRuntime {
    pub fn new(
        store: WarehouseStore,
        base_url: String,
        lakehouse_url: String,
        secret: String,
    ) -> Self {
        Self {
            store,
            registry: Arc::new(Mutex::new(HashMap::new())),
            base_url: base_url.trim_end_matches('/').to_string(),
            lakehouse_url: lakehouse_url.trim_end_matches('/').to_string(),
            secret,
            client: reqwest::Client::new(),
        }
    }

    pub async fn start_running(&self) {
        match self.store.running_stream_jobs().await {
            Ok(jobs) => {
                for (tenant, job) in jobs {
                    self.spawn(tenant, job.id);
                }
            }
            Err(error) => {
                tracing::error!("[warehouse] stream worker startup failed: {error}");
            }
        }
    }

    pub fn stop(&self, job_id: &str) {
        let state = self
            .registry
            .lock()
            .ok()
            .and_then(|workers| workers.get(job_id).cloned());
        if let Some(state) = state {
            state.store(true, Ordering::SeqCst);
        }
    }

    /// Idempotent worker bootstrap, matching the TS `workers` map.
    pub fn spawn(&self, tenant: String, job_id: String) {
        let state = Arc::new(AtomicBool::new(false));
        {
            let Ok(mut workers) = self.registry.lock() else {
                return;
            };
            if workers.contains_key(&job_id) {
                return;
            }
            workers.insert(job_id.clone(), state.clone());
        }
        let runtime = self.clone();
        tokio::spawn(async move {
            runtime.run_worker(&tenant, &job_id, &state).await;
            if let Ok(mut workers) = runtime.registry.lock() {
                workers.remove(&job_id);
            }
        });
    }

    async fn tenant_suspended(&self, tenant: &str) -> bool {
        use std::sync::OnceLock;
        static CACHE: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();
        let (resource, id) = if let Some(org) = tenant.strip_prefix("org:") {
            ("orgs", org)
        } else if let Some(account) = tenant.strip_prefix("account:") {
            ("accounts", account)
        } else {
            return false;
        };
        let cache_key = format!("{resource}:{id}");
        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(guard) = cache.lock() {
            if let Some((suspended, checked)) = guard.get(&cache_key) {
                if checked.elapsed() < Duration::from_secs(5) {
                    return *suspended;
                }
            }
        }
        let base = std::env::var("IAM_SERVICE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "http://iam:4001".into());
        let mut request = self
            .client
            .get(format!(
                "{}/internal/{resource}/{id}/status",
                base.trim_end_matches('/')
            ))
            .timeout(Duration::from_millis(1500));
        if !self.secret.is_empty() {
            request = request.header("x-synapseone-internal", self.secret.as_str());
        }
        let suspended = match request.send().await {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .ok()
                .and_then(|body| body.get("status").and_then(Value::as_str).map(str::to_string))
                .as_deref()
                .is_some_and(|value| value == "suspended" || value == "retired"),
            _ => false,
        };
        if let Ok(mut guard) = cache.lock() {
            guard.insert(cache_key, (suspended, Instant::now()));
        }
        suspended
    }

    async fn run_worker(&self, tenant: &str, job_id: &str, state: &AtomicBool) {
        let mut backoff = 1000u64;
        while !state.load(Ordering::SeqCst) {
            let job = match self.store.get_job(tenant, job_id).await {
                Ok(Some(job)) => job,
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!("[warehouse] stream job {job_id} lookup failed: {error}");
                    break;
                }
            };
            if job.mode != "stream" || job.status != "running" {
                break;
            }
            // Continuous ETL is not grandfathered through tenant suspension:
            // stop at the next batch boundary and require an operator resume
            // after reactivation.
            if job.destination == "lakehouse" || !job.target_dataset_id.is_empty() {
                if self.tenant_suspended(tenant).await {
                    let _ = self.store.set_job_status(tenant, job_id, "paused").await;
                    break;
                }
            }
            let Some(topic) = job.stream_topic.clone() else {
                break;
            };
            if job.destination == "lakehouse" {
                let group = job
                    .stream_group
                    .clone()
                    .unwrap_or_else(|| format!("lakehouse_{}", job.id));
                match self.run_once_lakehouse(tenant, &job, &topic, &group).await {
                    Ok(events) => {
                        backoff = 1000;
                        if events == 0 {
                            sleep_ms(job.interval_ms.max(1) as u64).await;
                        }
                    }
                    Err(error) => {
                        let _ = self.store.record_job_error(tenant, job_id, &error).await;
                        sleep_ms(backoff).await;
                        backoff = (backoff * 2).min(30_000);
                    }
                }
                continue;
            }
            let dataset = match self.store.get_dataset(tenant, &job.target_dataset_id).await {
                Ok(Some(dataset)) => dataset,
                Ok(None) => {
                    let _ = self
                        .store
                        .record_job_error(
                            tenant,
                            job_id,
                            format!("target dataset '{}' not found", job.target_dataset_id),
                        )
                        .await;
                    break;
                }
                Err(error) => {
                    tracing::warn!("[warehouse] stream dataset lookup failed: {error}");
                    break;
                }
            };
            let group = job
                .stream_group
                .clone()
                .unwrap_or_else(|| format!("warehouse_{}", job.id));
            match self.run_once(tenant, &job, &dataset, &topic, &group).await {
                Ok(events) => {
                    backoff = 1000;
                    if events == 0 {
                        sleep_ms(job.interval_ms.max(1) as u64).await;
                    }
                }
                Err(error) => {
                    let _ = self.store.record_job_error(tenant, job_id, &error).await;
                    sleep_ms(backoff).await;
                    backoff = (backoff * 2).min(30_000);
                }
            }
        }
    }

    async fn run_once(
        &self,
        tenant: &str,
        job: &JobMeta,
        dataset: &DatasetMeta,
        topic: &str,
        group: &str,
    ) -> Result<usize, String> {
        self.stream_call(
            "PUT",
            &format!("/v1/stream/topics/{topic}"),
            tenant,
            Some(&json!({})),
            true,
        )
        .await?;
        self.stream_call(
            "PUT",
            &format!("/v1/stream/topics/{topic}/groups/{group}"),
            tenant,
            Some(&json!({"startId": "0"})),
            true,
        )
        .await?;
        let count = job.batch_size.clamp(1, 100);
        let read = self
            .stream_call(
                "POST",
                &format!("/v1/stream/topics/{topic}/groups/{group}/read"),
                tenant,
                Some(&json!({
                    "consumer": format!("warehouse-{}", job.id),
                    "count": count,
                    "blockMs": 500,
                })),
                false,
            )
            .await?;
        let events = read
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if events.is_empty() {
            return Ok(0);
        }
        let materialized = materialize(dataset, &events);
        self.store
            .ingest_stream_events(tenant, dataset, &job.id, materialized)
            .await
            .map_err(|error| error.to_string())?;
        let ids = events
            .iter()
            .map(|event| event.get("id").cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>();
        self.stream_call(
            "POST",
            &format!("/v1/stream/topics/{topic}/groups/{group}/ack"),
            tenant,
            Some(&json!({ "ids": ids })),
            false,
        )
        .await?;
        self.store
            .record_job_run(tenant, &job.id, events.len() as i64)
            .await
            .map_err(|error| error.to_string())?;
        Ok(events.len())
    }

    /// Consume a Base change stream and append durable Iceberg change-log rows.
    /// The Lakehouse idempotency key is derived from the document identity and
    /// version, so replay/duplicate delivery cannot append the same change twice.
    async fn run_once_lakehouse(
        &self,
        tenant: &str,
        job: &JobMeta,
        topic: &str,
        group: &str,
    ) -> Result<usize, String> {
        let namespace = job
            .lakehouse_namespace
            .clone()
            .ok_or_else(|| "lakehouse job missing namespace".to_string())?;
        let table = job
            .lakehouse_table
            .clone()
            .ok_or_else(|| "lakehouse job missing table".to_string())?;
        self.stream_call(
            "PUT",
            &format!("/v1/stream/topics/{topic}"),
            tenant,
            Some(&json!({})),
            true,
        )
        .await?;
        self.stream_call(
            "PUT",
            &format!("/v1/stream/topics/{topic}/groups/{group}"),
            tenant,
            Some(&json!({"startId": "0"})),
            true,
        )
        .await?;
        let count = job.batch_size.clamp(1, 100);
        let read = self
            .stream_call(
                "POST",
                &format!("/v1/stream/topics/{topic}/groups/{group}/read"),
                tenant,
                Some(&json!({
                    "consumer": format!("warehouse-lakehouse-{}", job.id),
                    "count": count,
                    "blockMs": 500,
                })),
                false,
            )
            .await?;
        let events = read
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if events.is_empty() {
            return Ok(0);
        }

        for event in &events {
            let payload = event.get("payload").cloned().unwrap_or(Value::Null);
            if payload.get("source").and_then(Value::as_str) != Some("synapsebase")
                || payload.get("resource_type").and_then(Value::as_str) != Some("document")
            {
                continue;
            }
            if let Some(source) = job.source_database.as_deref() {
                let database = payload
                    .get("database_name")
                    .or_else(|| payload.get("database_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if database != source {
                    continue;
                }
            }
            if let Some(source) = job.source_collection.as_deref() {
                let collection = payload
                    .get("collection_name")
                    .or_else(|| payload.get("collection_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if collection != source {
                    continue;
                }
            }
            let Some(operation) = payload.get("operation").and_then(Value::as_str) else {
                continue;
            };
            if !matches!(operation, "create" | "update" | "delete") {
                continue;
            }
            let Some(document_id) = payload.get("document_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(version) = payload.get("version").and_then(Value::as_i64) else {
                continue;
            };
            let collection = payload
                .get("collection_name")
                .or_else(|| payload.get("collection_id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let data = payload
                .get("data")
                .map(|value| {
                    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
                })
                .unwrap_or_else(|| "null".to_string());
            let row = json!({
                "event_id": payload.get("event_id").cloned().unwrap_or(Value::Null),
                "collection": collection,
                "document_id": document_id,
                "operation": operation,
                "version": version,
                "occurred_at": payload.get("occurred_at").cloned().unwrap_or(Value::Null),
                "data": data,
                "deleted": operation == "delete",
            });
            let collection_id = payload
                .get("collection_id")
                .and_then(Value::as_str)
                .unwrap_or(collection);
            let created_at = payload
                .get("created_at")
                .or_else(|| payload.get("occurred_at"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let key = lakehouse_change_key(
                collection_id,
                document_id,
                created_at,
                version,
                operation,
            );
            self.lakehouse_append(tenant, &namespace, &table, row, &key)
                .await?;
        }

        let ids = events
            .iter()
            .map(|event| event.get("id").cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>();
        self.stream_call(
            "POST",
            &format!("/v1/stream/topics/{topic}/groups/{group}/ack"),
            tenant,
            Some(&json!({ "ids": ids })),
            false,
        )
        .await?;
        self.store
            .record_job_run(tenant, &job.id, events.len() as i64)
            .await
            .map_err(|error| error.to_string())?;
        Ok(events.len())
    }

    async fn lakehouse_append(
        &self,
        tenant: &str,
        namespace: &str,
        table: &str,
        row: Value,
        idempotency_key: &str,
    ) -> Result<(), String> {
        if self.lakehouse_url.is_empty() {
            return Err("LAKEHOUSE_SERVICE_URL is not configured".into());
        }
        let (header, value) = if let Some(org) = tenant.strip_prefix("org:") {
            ("x-synapseone-org", org)
        } else if let Some(account) = tenant.strip_prefix("account:") {
            ("x-synapseone-account", account)
        } else {
            return Err("lakehouse ETL requires an org or account tenant".into());
        };
        let url = format!(
            "{}/v1/lakehouse/namespaces/{}/tables/{}/rows",
            self.lakehouse_url,
            urlencoding(namespace),
            urlencoding(table)
        );
        let mut request = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .header(header, value)
            .json(&json!({
                "rows": [row],
                "idempotencyKey": idempotency_key,
            }));
        if !self.secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.secret);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Lakehouse append failed: {error}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let message: String = text.chars().take(300).collect();
            return Err(format!(
                "Lakehouse append -> {}: {message}",
                status.as_u16()
            ));
        }
        Ok(())
    }

    async fn stream_call(
        &self,
        method: &str,
        path: &str,
        tenant: &str,
        body: Option<&Value>,
        allow_conflict: bool,
    ) -> Result<Value, String> {
        let url = format!("{}{}", self.base_url, path);
        let mut request = self
            .client
            .request(
                method
                    .parse()
                    .map_err(|_| format!("invalid method {method}"))?,
                &url,
            )
            .header("content-type", "application/json")
            .header("x-synapseone-tenant", tenant);
        if !self.secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.secret);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("SynapseStream {method} {path} failed: {error}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        let allowed = status.is_success() || (allow_conflict && status.as_u16() == 409);
        if !allowed {
            let message = parsed
                .get("message")
                .or_else(|| parsed.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(format!(
                "SynapseStream {method} {path} -> {}: {message}",
                status.as_u16()
            ));
        }
        Ok(parsed)
    }
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms.max(50))).await;
}

fn urlencoding(value: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if KEEP.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn payload_rows(payload: &Value) -> Vec<Value> {
    let parsed = match payload {
        Value::String(text) => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| payload.clone())
        }
        other => other.clone(),
    };
    match parsed {
        Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Value::Object(_) => item,
                other => json!({ "value": other }),
            })
            .collect(),
        Value::Object(object) => vec![Value::Object(object)],
        other => vec![json!({ "value": other })],
    }
}

fn base_document_row(payload: &Value) -> Value {
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    let mut row = if data.is_object() {
        data
    } else {
        json!({ "value": data })
    };
    if let Some(object) = row.as_object_mut() {
        for key in [
            "document_id",
            "collection_id",
            "collection_name",
            "database_id",
            "database_name",
            "operation",
            "version",
            "occurred_at",
        ] {
            if let Some(value) = payload.get(key) {
                object
                    .entry(key.to_string())
                    .or_insert_with(|| value.clone());
            }
        }
        object
            .entry("deleted".to_string())
            .or_insert_with(|| Value::Bool(payload.get("operation").and_then(Value::as_str) == Some("delete")));
    }
    row
}

fn materialize(dataset: &DatasetMeta, events: &[Value]) -> Vec<StreamEventRows> {
    let has_event_id = dataset
        .columns
        .iter()
        .any(|column| column.name == "event_id");
    events
        .iter()
        .map(|event| {
            let payload = event.get("payload").cloned().unwrap_or(Value::Null);
            let payload_object = payload.as_object();
            let is_base_document = payload_object
                .and_then(|object| object.get("source"))
                .and_then(Value::as_str)
                == Some("synapsebase")
                && payload_object
                    .and_then(|object| object.get("resource_type"))
                    .and_then(Value::as_str)
                    == Some("document");
            let base_operation = if is_base_document {
                payload
                    .get("operation")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            };
            let document_id = if is_base_document {
                payload
                    .get("document_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            };
            let payload_event_id = payload_object
                .and_then(|object| object.get("event_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let event_id = payload_event_id.unwrap_or_else(|| js_string(event.get("id")));
            let mut rows = if is_base_document {
                if base_operation.as_deref() == Some("delete") {
                    Vec::new()
                } else {
                    vec![base_document_row(&payload)]
                }
            } else {
                payload_rows(&payload)
            };
            if has_event_id {
                for row in &mut rows {
                    if let Some(object) = row.as_object_mut() {
                        object
                            .entry("event_id")
                            .or_insert_with(|| Value::String(event_id.clone()));
                    }
                }
            }
            StreamEventRows {
                event_id,
                rows,
                document_id,
                base_operation,
                version: payload.get("version").and_then(Value::as_i64),
                created_at: payload
                    .get("created_at")
                    .or_else(|| payload.get("occurred_at"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{lakehouse_change_key, materialize};
    use crate::store::{StoreOptions, WarehouseStore};
    use crate::types::{NewDataset, WarehouseColumn};
    use serde_json::json;

    fn dataset() -> NewDataset {
        NewDataset {
            id: "base_rows".into(),
            name: "Base rows".into(),
            description: String::new(),
            columns: vec![
                WarehouseColumn {
                    name: "document_id".into(),
                    column_type: "string".into(),
                },
                WarehouseColumn {
                    name: "name".into(),
                    column_type: "string".into(),
                },
                WarehouseColumn {
                    name: "capacity".into(),
                    column_type: "number".into(),
                },
                WarehouseColumn {
                    name: "version".into(),
                    column_type: "number".into(),
                },
            ],
            mode: "stream".into(),
            stream_topic: Some("base-changes".into()),
        }
    }

    fn payload(operation: &str, version: i64) -> serde_json::Value {
        json!({
            "event_id": format!("evt-{version}"),
            "source": "synapsebase",
            "resource_type": "document",
            "document_id": "p-1",
            "collection_id": "col-1",
            "collection_name": "parks",
            "operation": operation,
            "version": version,
            "occurred_at": "2026-11-24T00:00:00.000Z",
            "data": {"name": "Central Park", "capacity": 100 + version}
        })
    }

    #[test]
    fn lakehouse_change_key_scopes_state_to_collection_and_creation() {
        let created = "2026-11-24T00:00:00.000Z";
        assert_eq!(
            lakehouse_change_key("col-a", "p-1", created, 2, "create"),
            "base:col-a:p-1:2026-11-24T00:00:00.000Z:2:upsert"
        );
        assert_eq!(
            lakehouse_change_key("col-a", "p-1", created, 2, "update"),
            "base:col-a:p-1:2026-11-24T00:00:00.000Z:2:upsert"
        );
        assert_eq!(
            lakehouse_change_key("col-a", "p-1", created, 2, "delete"),
            "base:col-a:p-1:2026-11-24T00:00:00.000Z:2:delete"
        );
        assert_ne!(
            lakehouse_change_key("col-b", "p-1", created, 2, "create"),
            lakehouse_change_key("col-a", "p-1", created, 2, "create")
        );
        assert_ne!(
            lakehouse_change_key("col-a", "p-1", "2026-11-24T00:00:00.001Z", 1, "create"),
            lakehouse_change_key("col-a", "p-1", created, 1, "create")
        );
    }

    #[tokio::test]
    async fn base_events_replace_and_delete_the_current_row() {
        let store = WarehouseStore::new(StoreOptions::memory());
        let meta = store
            .create_dataset("org:qa", dataset())
            .await
            .expect("dataset");
        let event = |payload: serde_json::Value, id: &str| json!({"id": id, "payload": payload});

        let create = materialize(&meta, &[event(payload("create", 1), "1-0")]);
        assert_eq!(create[0].document_id.as_deref(), Some("p-1"));
        assert_eq!(create[0].rows[0]["name"], "Central Park");
        assert_eq!(create[0].rows[0]["version"], 1);
        let (inserted, duplicates) = store
            .ingest_stream_events("org:qa", &meta, "job", create)
            .await
            .unwrap();
        assert_eq!((inserted, duplicates), (1, 0));

        let update = materialize(&meta, &[event(payload("update", 2), "2-0")]);
        let (inserted, _) = store
            .ingest_stream_events("org:qa", &meta, "job", update)
            .await
            .unwrap();
        assert_eq!(inserted, 1);
        let rows = store
            .query(
                "org:qa",
                Some(&json!(
                    "SELECT document_id, name, capacity, version FROM base_rows"
                )),
                100,
            )
            .await
            .unwrap();
        assert_eq!(rows.rows.len(), 1, "update must replace, not append");
        assert_eq!(rows.rows[0]["version"], 2);
        assert_eq!(rows.rows[0]["capacity"], 102);

        let delete = materialize(&meta, &[event(payload("delete", 3), "3-0")]);
        assert!(delete[0].rows.is_empty());
        assert_eq!(delete[0].base_operation.as_deref(), Some("delete"));
        store
            .ingest_stream_events("org:qa", &meta, "job", delete)
            .await
            .unwrap();
        let rows = store
            .query(
                "org:qa",
                Some(&json!("SELECT count(*) AS n FROM base_rows")),
                100,
            )
            .await
            .unwrap();
        assert_eq!(rows.rows[0]["n"], 0, "delete must remove the row");
    }
#[tokio::test]
async fn base_stream_state_never_regresses_or_resurrects_a_document() {
    let store = WarehouseStore::new(StoreOptions::memory());
    let meta = store
        .create_dataset("org:qa", dataset())
        .await
        .expect("dataset");
    let event = |operation: &str, version: i64, created: &str| {
        json!({
            "id": format!("stream-{operation}-{version}-{created}"),
            "payload": {
                "event_id": format!("evt-{operation}-{version}-{created}"),
                "source": "synapsebase",
                "resource_type": "document",
                "document_id": "p-1",
                "collection_id": "col-1",
                "collection_name": "parks",
                "operation": operation,
                "version": version,
                "created_at": created,
                "occurred_at": "2026-11-24T00:00:00.000Z",
                "data": {"name": "Central Park", "capacity": version}
            }
        })
    };

    let create = materialize(&meta, &[event("create", 3, "2026-11-01T00:00:00.000Z")]);
    store
        .ingest_stream_events("org:qa", &meta, "job", create)
        .await
        .unwrap();
    // A delayed older update must not overwrite version 3.
    let stale = materialize(&meta, &[event("update", 2, "2026-11-01T00:00:00.000Z")]);
    let (inserted, _) = store
        .ingest_stream_events("org:qa", &meta, "job", stale)
        .await
        .unwrap();
    assert_eq!(inserted, 0);
    let rows = store
        .query("org:qa", Some(&json!("SELECT version, capacity FROM base_rows")), 10)
        .await
        .unwrap();
    assert_eq!(rows.rows[0]["version"], 3);
    assert_eq!(rows.rows[0]["capacity"], 3);

    // A delayed delete of an older version must not remove the newer row.
    let stale_delete = materialize(&meta, &[event("delete", 2, "2026-11-01T00:00:00.000Z")]);
    store
        .ingest_stream_events("org:qa", &meta, "job", stale_delete)
        .await
        .unwrap();
    let rows = store
        .query("org:qa", Some(&json!("SELECT version FROM base_rows")), 10)
        .await
        .unwrap();
    assert_eq!(rows.rows.len(), 1);

    // A delete at the same version removes the row (Base emits its existing
    // version); a delayed create from the same incarnation must not
    // resurrect it.
    let delete = materialize(&meta, &[event("delete", 3, "2026-11-01T00:00:00.000Z")]);
    store
        .ingest_stream_events("org:qa", &meta, "job", delete)
        .await
        .unwrap();
    let old_create = materialize(&meta, &[event("create", 1, "2026-11-01T00:00:00.000Z")]);
    store
        .ingest_stream_events("org:qa", &meta, "job", old_create)
        .await
        .unwrap();
    let rows = store
        .query("org:qa", Some(&json!("SELECT version FROM base_rows")), 10)
        .await
        .unwrap();
    assert!(rows.rows.is_empty(), "deleted document was resurrected");

    // Re-creating the id at a new creation time is a new incarnation and is
    // allowed to start again at version 1.
    let recreated = materialize(&meta, &[event("create", 1, "2026-11-24T00:00:00.000Z")]);
    let (inserted, _) = store
        .ingest_stream_events("org:qa", &meta, "job", recreated)
        .await
        .unwrap();
    assert_eq!(inserted, 1);
    let rows = store
        .query("org:qa", Some(&json!("SELECT version, capacity FROM base_rows")), 10)
        .await
        .unwrap();
    assert_eq!(rows.rows.len(), 1);
    assert_eq!(rows.rows[0]["version"], 1);
    assert_eq!(rows.rows[0]["capacity"], 1);
}

}
