// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Transactional-outbox relay to SynapseStream. At-least-once: rows stay
//! unpublished until Stream has acknowledged the whole batch.
//!
//! Failed events are retried with exponential backoff and deterministic
//! jitter. A permanent event error is quarantined instead of blocking the head
//! of the queue forever. Quarantined rows are visible through the internal
//! outbox endpoints and can be replayed after the payload or configuration is
//! fixed.
//!
//! Ordering note: because one failing event backs off independently, later
//! events may be published first. Base outbox delivery is at-least-once with
//! best-effort ordering, not a strictly ordered event log.

use std::hash::{Hash, Hasher};

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::store::{OutboxEvent, Store};
use crate::Config;

/// Serialize relay passes inside one process. Multiple replicas still publish
/// concurrently; Stream delivery is at-least-once and downstream dedupes by
/// event id. Tests also boot several stores in one process, so a hard global
/// "busy -> return 0" flag would make them interfere.
static RELAY_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone)]
struct StreamFailure {
    message: String,
    /// True when the event payload/route itself is invalid. Authentication,
    /// authorization, rate-limit, timeout, server and network failures are
    /// transient so a deployment mistake does not quarantine the backlog.
    permanent: bool,
}

impl StreamFailure {
    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            permanent: false,
        }
    }
}

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
) -> Result<(), StreamFailure> {
    let base = config.stream_service_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(StreamFailure::transient("STREAM_SERVICE_URL is not configured"));
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
    let response = request
        .send()
        .await
        .map_err(|error| StreamFailure::transient(error.to_string()))?;
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
        // Only event-shape/payload failures are permanent. 401/403/404/409/
        // 429/5xx may be caused by a deployment or transient outage and must
        // keep retrying.
        let permanent = matches!(status.as_u16(), 400 | 405 | 413 | 415 | 422);
        return Err(StreamFailure {
            message: format!("SynapseStream request -> {}: {message}", status.as_u16()),
            permanent,
        });
    }
    Ok(())
}

/// Exponential backoff with deterministic ±20% jitter, cap `max_ms`.
fn retry_delay_ms(event_id: &str, attempts: i64, base_ms: u64, max_ms: u64) -> i64 {
    let shift = attempts.saturating_sub(1).clamp(0, 20) as u32;
    let exponential = base_ms.saturating_mul(1u64 << shift).min(max_ms);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (event_id, attempts).hash(&mut hasher);
    let jitter_pct = (hasher.finish() % 41) as i64 - 20; // -20..=20
    (exponential as i64 * (100 + jitter_pct) / 100).clamp(1, max_ms as i64)
}

async fn record_failure(
    store: &Store,
    config: &Config,
    row: &OutboxEvent,
    failure: &StreamFailure,
) {
    let attempt = row.attempts.saturating_add(1);
    let dead_letter = failure.permanent || attempt >= config.outbox_max_attempts;
    let next_attempt_at = if dead_letter {
        None
    } else {
        let delay = retry_delay_ms(
            &row.event_id,
            attempt,
            config.outbox_retry_base_ms,
            config.outbox_retry_max_ms,
        );
        Some(Utc::now() + Duration::milliseconds(delay))
    };
    if let Err(error) = store
        .record_failure(
            &row.event_id,
            &failure.message,
            next_attempt_at,
            dead_letter,
        )
        .await
    {
        tracing::error!(
            "[base][outbox] could not record failure for {}: {error}",
            row.event_id
        );
        return;
    }
    if dead_letter {
        tracing::error!(
            "[base][outbox] dead-lettered event {} after {} attempt(s): {}",
            row.event_id,
            attempt,
            failure.message
        );
    } else {
        tracing::warn!(
            "[base][outbox] event {} attempt {} failed, retrying: {}",
            row.event_id,
            attempt,
            failure.message
        );
    }
}

async fn publish_group(
    store: &Store,
    config: &Config,
    client: &reqwest::Client,
    topic: &str,
    tenant: &str,
    group: &[OutboxEvent],
) -> usize {
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
    let batch = stream_call(
        config,
        client,
        reqwest::Method::POST,
        &batch_path,
        tenant,
        Some(json!({"events": events})),
        false,
    )
    .await;
    match batch {
        Ok(()) => {
            let ids: Vec<String> = group.iter().map(|row| row.event_id.clone()).collect();
            if let Err(error) = store.mark_published(&ids).await {
                tracing::error!("[base][outbox] mark published failed: {error}");
                return 0;
            }
            group.len()
        }
        Err(failure) if failure.permanent && group.len() > 1 => {
            // Isolate a poison event: retry each row on its own, so one bad
            // payload cannot quarantine or block its valid batch neighbours.
            let mut published = 0usize;
            for row in group {
                let single = stream_call(
                    config,
                    client,
                    reqwest::Method::POST,
                    &batch_path,
                    tenant,
                    Some(json!({
                        "events": [{
                            "payload": row.payload,
                            "key": row.payload.get("collection_id").cloned().unwrap_or(Value::Null),
                            "headers": {"source": "synapsebase", "schema_version": 1},
                        }]
                    })),
                    false,
                )
                .await;
                match single {
                    Ok(()) => {
                        if store
                            .mark_published(&[row.event_id.clone()])
                            .await
                            .is_ok()
                        {
                            published += 1;
                        }
                    }
                    Err(error) => record_failure(store, config, row, &error).await,
                }
            }
            published
        }
        Err(failure) => {
            for row in group {
                record_failure(store, config, row, &failure).await;
            }
            0
        }
    }
}

pub async fn relay_outbox_once(store: &Store, config: &Config, limit: i64) -> usize {
    let _guard = RELAY_LOCK.lock().await;
    relay_inner(store, config, limit).await
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
        if let Err(failure) = stream_call(
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
            // Topic setup is not event-specific; treat every failure here as
            // transient so a bad route or credential does not quarantine data.
            let failure = StreamFailure::transient(failure.message);
            for row in &group {
                record_failure(store, config, row, &failure).await;
            }
            continue;
        }
        published += publish_group(store, config, &client, &topic, &tenant, &group).await;
    }
    published
}

#[cfg(test)]
mod tests {
    use super::retry_delay_ms;

    #[test]
    fn retry_backoff_is_exponential_capped_and_jittered() {
        let first = retry_delay_ms("event-a", 1, 1000, 60_000);
        let second = retry_delay_ms("event-a", 2, 1000, 60_000);
        let capped = retry_delay_ms("event-a", 20, 1000, 60_000);
        assert!((800..=1200).contains(&first), "{first}");
        assert!((1600..=2400).contains(&second), "{second}");
        assert!((48_000..=60_000).contains(&capped), "{capped}");
        assert!((800..=1200).contains(&retry_delay_ms("event-b", 1, 1000, 60_000)));
    }
}
