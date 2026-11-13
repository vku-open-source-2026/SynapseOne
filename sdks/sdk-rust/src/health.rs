// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Gateway health and readiness probes.

use crate::client::{Client, Request};
use crate::error::Result;
use serde_json::{json, Value};

/// Health service handle.
#[derive(Clone)]
pub struct HealthService {
    client: Client,
}

impl HealthService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    /// Shallow gateway health (never fails for a degraded upstream).
    pub async fn health(&self) -> Result<Value> {
        self.client
            .send(Request::get("/health").max_attempts(1))
            .await
            .map(|response| response.body)
    }

    /// Aggregate readiness. A 503 means "degraded"; by default the parsed
    /// payload is returned so callers can inspect the upstream list.
    pub async fn ready(&self, throw_on_degraded: bool) -> Result<Value> {
        match self
            .client
            .send(Request::get("/ready").max_attempts(1))
            .await
        {
            Ok(response) => Ok(response.body),
            Err(error)
                if !throw_on_degraded && error.status() == Some(503) && error.body().is_some() =>
            {
                Ok(error.body().cloned().unwrap_or_else(|| json!({})))
            }
            Err(error) => Err(error),
        }
    }

    /// Project `{ok, tier1, upstreams}` for higher-tier readiness endpoints.
    pub async fn status(&self) -> Value {
        let health = self.health().await.ok();
        let ready = self.ready(false).await.ok();
        let reachable = health
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .is_some();
        let ready_ok = ready
            .as_ref()
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            == Some("ready");
        json!({
            "ok": reachable && ready_ok,
            "tier1": {
                "status": health.as_ref().and_then(|v| v.get("status")).cloned().unwrap_or_else(|| json!("unreachable")),
                "version": health.as_ref().and_then(|v| v.get("version")).cloned(),
                "reachable": reachable,
            },
            "upstreams": ready.as_ref().and_then(|v| v.get("upstreams")).cloned().unwrap_or_else(|| json!([])),
            "time": ready.as_ref().and_then(|v| v.get("time")).cloned(),
        })
    }
}
