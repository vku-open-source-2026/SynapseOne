// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Gateway request telemetry: every proxied request becomes one usage event,
//! buffered in memory and flushed to IAM in small batches. Best-effort by
//! design — a dead analytics sink must never affect live traffic.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

const MAX_BUFFER: usize = 2_000;
const MAX_BATCH: usize = 200;
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
const POST_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    pub created_at: String,
    pub request_id: String,
    pub feature: String,
    pub route: String,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub duration_ms: u64,
    pub auth_kind: String,
    pub org_id: Option<String>,
    pub account_id: Option<String>,
    pub user_id: Option<String>,
    pub error: Option<String>,
}

const FEATURE_ROUTES: [(&str, &str); 24] = [
    ("/v1/auth", "auth"),
    ("/v1/orgs", "iam"),
    ("/v1/accounts", "iam"),
    ("/v1/roles", "iam"),
    ("/v1/users", "iam"),
    ("/v1/service-accounts", "iam"),
    ("/v1/policies", "iam"),
    ("/v1/managed-policies", "iam"),
    ("/v1/keys", "iam"),
    ("/v1/authorize", "iam"),
    ("/v1/audit", "iam"),
    ("/v1/workflows", "workflows"),
    ("/v1/templates", "workflows"),
    ("/v1/executions", "workflows"),
    ("/v1/credentials", "workflows"),
    ("/webhook", "workflows"),
    ("/v1/ai", "ai"),
    ("/v1/lds", "lds"),
    ("/v1/base", "base"),
    ("/v1/faststore", "faststore"),
    ("/v1/queue", "queue"),
    ("/v1/storage", "storage"),
    ("/v1/warehouse", "warehouse"),
    ("/v1/usage", "usage"),
];

/// Map a routing-table path to a stable product feature key.
pub fn feature_for_route(route_path: &str) -> String {
    for (prefix, feature) in FEATURE_ROUTES {
        if route_path == prefix || route_path.starts_with(&format!("{prefix}/")) {
            return feature.to_string();
        }
    }
    let segment = route_path
        .split('/')
        .filter(|value| !value.is_empty())
        .nth(1)
        .unwrap_or("");
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[a-z0-9-]{1,64}$").expect("feature regex"));
    if re.is_match(segment) {
        segment.to_string()
    } else {
        "other".into()
    }
}

/// Dashboard reads must not inflate their own counters.
pub fn is_usage_excluded(pathname: &str) -> bool {
    pathname == "/v1/usage" || pathname.starts_with("/v1/usage/")
}

pub fn is_usage_telemetry_enabled() -> bool {
    std::env::var("USAGE_TELEMETRY").as_deref() != Ok("false")
}

pub struct UsageTelemetry {
    buffer: Mutex<Vec<UsageEvent>>,
    flush: tokio::sync::Mutex<()>,
    client: reqwest::Client,
    iam_base: String,
    internal_secret: String,
    enabled: bool,
    last_warn: Mutex<Option<Instant>>,
}

impl UsageTelemetry {
    pub fn new(
        client: reqwest::Client,
        iam_base: impl Into<String>,
        internal_secret: impl Into<String>,
        enabled: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            buffer: Mutex::new(Vec::new()),
            flush: tokio::sync::Mutex::new(()),
            client,
            iam_base: iam_base.into().trim_end_matches('/').to_string(),
            internal_secret: internal_secret.into(),
            enabled,
            last_warn: Mutex::new(None),
        })
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    #[cfg(test)]
    pub fn buffer_size(&self) -> usize {
        self.buffer.lock().expect("usage buffer").len()
    }

    pub fn enqueue(self: &Arc<Self>, event: UsageEvent) {
        if !self.enabled {
            return;
        }
        let should_flush = {
            let mut buffer = self.buffer.lock().expect("usage buffer");
            buffer.push(event);
            if buffer.len() > MAX_BUFFER {
                let excess = buffer.len() - MAX_BUFFER;
                buffer.drain(0..excess);
            }
            buffer.len() >= MAX_BATCH
        };
        if should_flush {
            let telemetry = Arc::clone(self);
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move {
                    telemetry.flush_now().await;
                });
            }
        }
    }

    /// Flush at most one batch; on failure the events are put back (bounded).
    pub async fn flush_now(&self) {
        let _guard = self.flush.lock().await;
        if !self.enabled {
            return;
        }
        let batch = {
            let mut buffer = self.buffer.lock().expect("usage buffer");
            if buffer.is_empty() {
                return;
            }
            let count = buffer.len().min(MAX_BATCH);
            buffer.drain(0..count).collect::<Vec<_>>()
        };
        if let Err(error) = self.post_batch(&batch).await {
            let mut buffer = self.buffer.lock().expect("usage buffer");
            let mut restored = batch;
            restored.append(&mut buffer);
            restored.truncate(MAX_BUFFER);
            *buffer = restored;
            self.warn_once(&format!(
                "flush failed ({error}); keeping {} buffered event(s)",
                buffer.len()
            ));
        }
    }

    async fn post_batch(&self, events: &[UsageEvent]) -> Result<(), String> {
        let mut request = self
            .client
            .post(format!("{}/v1/usage/ingest", self.iam_base))
            .timeout(POST_TIMEOUT)
            .json(&serde_json::json!({ "events": events }));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("IAM ingest HTTP {}", response.status().as_u16()));
        }
        Ok(())
    }

    fn warn_once(&self, message: &str) {
        let now = Instant::now();
        let mut last = self.last_warn.lock().expect("usage warn");
        if let Some(previous) = *last {
            if now.duration_since(previous) < Duration::from_secs(60) {
                return;
            }
        }
        *last = Some(now);
        tracing::warn!("[gateway][usage] {message}");
    }

    /// Background timer; call once from the binary, never from request paths.
    pub fn start(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        if !self.enabled {
            return None;
        }
        let telemetry = Arc::clone(self);
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(FLUSH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                telemetry.flush_now().await;
            }
        }))
    }
}
