// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Stream ETL workers: read a micro-batch from SynapseStream, append rows to
//! the target dataset, then ack only after the durable write succeeds.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::store::WarehouseStore;
use crate::types::{DatasetMeta, JobMeta, StreamEventRows};
use crate::util::js_string;

#[derive(Clone)]
pub struct StreamRuntime {
    store: WarehouseStore,
    registry: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    base_url: String,
    secret: String,
    client: reqwest::Client,
}

impl StreamRuntime {
    pub fn new(store: WarehouseStore, base_url: String, secret: String) -> Self {
        Self {
            store,
            registry: Arc::new(Mutex::new(HashMap::new())),
            base_url: base_url.trim_end_matches('/').to_string(),
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
            let Some(topic) = job.stream_topic.clone() else {
                break;
            };
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
            let payload_event_id = payload_object
                .and_then(|object| object.get("event_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let event_id = payload_event_id.unwrap_or_else(|| js_string(event.get("id")));
            let mut rows = payload_rows(&payload);
            if has_event_id {
                for row in &mut rows {
                    if let Some(object) = row.as_object_mut() {
                        object
                            .entry("event_id")
                            .or_insert_with(|| Value::String(event_id.clone()));
                    }
                }
            }
            StreamEventRows { event_id, rows }
        })
        .collect()
}
