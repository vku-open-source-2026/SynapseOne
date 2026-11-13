// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Transactional-outbox relay to SynapseStream. At-least-once: rows stay
//! unpublished until Stream has acknowledged the whole batch.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::store::{OutboxEvent, Store};
use crate::Config;

static RELAY_BUSY: AtomicBool = AtomicBool::new(false);

fn tenant_for_event(payload: &Value) -> String {
    if let Some(org) = payload.get("organization_id").and_then(Value::as_str) {
        if !org.is_empty() {
            return format!("org:{org}");
        }
    }
    if let Some(account) = payload.get("account_id").and_then(Value::as_str) {
        if !account.is_empty() {
            return format!("account:{account}");
        }
    }
    "platform".into()
}

fn encode_component(value: &str) -> String {
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

async fn stream_call(
    config: &Config,
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    tenant: &str,
    body: Option<Value>,
    allow_conflict: bool,
) -> Result<(), String> {
    let base = config.stream_service_url.trim_end_matches('/');
    if base.is_empty() {
        return Err("STREAM_SERVICE_URL is not configured".into());
    }
    let mut request = client
        .request(method, format!("{base}{path}"))
        .header("content-type", "application/json")
        .header("x-synapseone-tenant", tenant);
    if !config.internal_secret.is_empty() {
        request = request.header("x-synapseone-internal", &config.internal_secret);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text.clone()))
    };
    if !status.is_success() && !(allow_conflict && status.as_u16() == 409) {
        let message = parsed
            .get("message")
            .or_else(|| parsed.get("error"))
            .and_then(Value::as_str)
            .unwrap_or(&text)
            .chars()
            .take(300)
            .collect::<String>();
        return Err(format!(
            "SynapseStream request -> {}: {message}",
            status.as_u16()
        ));
    }
    Ok(())
}

pub async fn relay_outbox_once(store: &Store, config: &Config, limit: i64) -> usize {
    if RELAY_BUSY.swap(true, Ordering::SeqCst) {
        return 0;
    }
    let result = relay_inner(store, config, limit).await;
    RELAY_BUSY.store(false, Ordering::SeqCst);
    result
}

async fn relay_inner(store: &Store, config: &Config, limit: i64) -> usize {
    let rows = match store.list_unpublished(limit).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!("[base][outbox] list failed: {error}");
            return 0;
        }
    };
    if rows.is_empty() {
        return 0;
    }
    let mut groups: Vec<(String, Vec<OutboxEvent>)> = Vec::new();
    for row in rows {
        let tenant = tenant_for_event(&row.payload);
        match groups.iter_mut().find(|(name, _)| name == &tenant) {
            Some((_, items)) => items.push(row),
            None => groups.push((tenant, vec![row])),
        }
    }
    let client = reqwest::Client::new();
    let topic = encode_component(&config.outbox_stream_topic);
    let mut published = 0usize;
    for (tenant, group) in groups {
        let topic_put = format!("/v1/stream/topics/{topic}");
        if let Err(error) = stream_call(
            config,
            &client,
            reqwest::Method::PUT,
            &topic_put,
            &tenant,
            Some(json!({})),
            true,
        )
        .await
        {
            for row in &group {
                let _ = store.record_failure(&row.event_id, &error).await;
            }
            continue;
        }
        let events: Vec<Value> = group
            .iter()
            .map(|row| {
                json!({
                    "payload": row.payload,
                    "key": row.payload.get("collection_id").cloned().unwrap_or(Value::Null),
                    "headers": {"source": "synapsebase", "schema_version": 1},
                })
            })
            .collect();
        let batch_path = format!("/v1/stream/topics/{topic}/events:batch");
        if let Err(error) = stream_call(
            config,
            &client,
            reqwest::Method::POST,
            &batch_path,
            &tenant,
            Some(json!({"events": events})),
            false,
        )
        .await
        {
            for row in &group {
                let _ = store.record_failure(&row.event_id, &error).await;
            }
            continue;
        }
        let ids: Vec<String> = group.iter().map(|row| row.event_id.clone()).collect();
        if let Err(error) = store.mark_published(&ids).await {
            tracing::error!("[base][outbox] mark published failed: {error}");
            continue;
        }
        published += group.len();
    }
    published
}
