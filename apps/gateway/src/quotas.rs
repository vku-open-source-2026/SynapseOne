// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! IAM-backed service quotas and shared fixed-window admission.
//!
//! Effective limits are fetched from IAM and cached briefly. Tenant request
//! admission is atomic across minute, five-hour and UTC-day windows in IAM's
//! Valkey meter. IAM/Valkey outages fail open to the existing local minute
//! limiter; anonymous traffic always uses that local limiter.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QuotaService {
    Ai,
    Inference,
    Workflow,
}

impl QuotaService {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ai => "ai",
            Self::Inference => "inference",
            Self::Workflow => "workflow",
        }
    }
}

pub fn quota_service_for_route(path: &str) -> Option<QuotaService> {
    if path == "/v1/ai" || path.starts_with("/v1/ai/") {
        return Some(QuotaService::Ai);
    }
    if path == "/v1/inference" || path.starts_with("/v1/inference/") {
        return Some(QuotaService::Inference);
    }
    for prefix in [
        "/v1/workflows",
        "/v1/templates",
        "/v1/human-tasks",
        "/v1/executions",
        "/v1/credentials",
        "/v1/inference-jobs",
        "/v1/secrets",
        "/mcp",
    ] {
        if path == prefix || path.starts_with(&format!("{prefix}/")) {
            return Some(QuotaService::Workflow);
        }
    }
    if path.starts_with("/v1/accounts/")
        && (path.ends_with("/credentials") || path.contains("/credentials/"))
    {
        return Some(QuotaService::Workflow);
    }
    None
}

/// Only execution-creating calls consume hourly/concurrency budgets.
pub fn consumes_workflow_execution(method: &str, path: &str) -> bool {
    if !method.eq_ignore_ascii_case("POST") {
        return false;
    }
    if path == "/v1/inference-jobs" || path == "/v1/workflows/test-run" {
        return true;
    }
    let Some(rest) = path.strip_prefix("/v1/workflows/") else {
        return false;
    };
    let mut segments = rest.split('/');
    let Some(workflow) = segments.next() else {
        return false;
    };
    let Some(action) = segments.next() else {
        return false;
    };
    if workflow.is_empty() || segments.next().is_some() {
        return false;
    }
    matches!(action, "execute" | "test-run")
}

#[derive(Clone, Debug)]
pub struct EffectiveQuota {
    pub service: QuotaService,
    pub org_id: String,
    pub requests_per_min: u64,
    pub requests_per_5h: u64,
    pub requests_per_day: u64,
    pub tokens_per_day: Option<u64>,
    pub executions_per_hour: Option<u64>,
    pub concurrent_executions: Option<u64>,
    #[allow(dead_code)]
    pub overridden: bool,
}

#[derive(Clone, Debug)]
pub struct ServiceDefaults {
    pub rpm: u64,
    pub rp5h: u64,
    pub rpd: u64,
    pub tpd: Option<u64>,
    pub eph: Option<u64>,
    pub concurrent: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct QuotaDefaults {
    pub ai: ServiceDefaults,
    pub inference: ServiceDefaults,
    pub workflow: ServiceDefaults,
}

impl QuotaDefaults {
    pub fn for_service(&self, service: QuotaService) -> EffectiveQuota {
        let defaults = match service {
            QuotaService::Ai => &self.ai,
            QuotaService::Inference => &self.inference,
            QuotaService::Workflow => &self.workflow,
        };
        EffectiveQuota {
            service,
            org_id: String::new(),
            requests_per_min: defaults.rpm,
            requests_per_5h: defaults.rp5h,
            requests_per_day: defaults.rpd,
            tokens_per_day: defaults.tpd,
            executions_per_hour: defaults.eph,
            concurrent_executions: defaults.concurrent,
            overridden: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QuotaLookup {
    pub quota: EffectiveQuota,
    /// False means IAM was unavailable and only the local minute fallback is safe.
    pub authoritative: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct QuotaCheckResult {
    pub allowed: bool,
    pub window: String,
    pub count: u64,
    pub limit: u64,
    #[serde(rename = "retryAfterSeconds")]
    pub retry_after_seconds: u64,
    #[serde(rename = "resetAt")]
    pub reset_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExecutionAdmissionResult {
    pub allowed: bool,
    pub window: String,
    pub count: u64,
    pub limit: u64,
    pub retry_after_seconds: u64,
    pub reset_at: Option<String>,
    pub token: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct UsageMeter {
    pub tokens_today_ai: u64,
    pub tokens_today_inference: u64,
}

fn clamp_u64(value: &Value, max: u64) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number >= 1 && *number <= max)
}

fn optional_clamp_u64(value: Option<&Value>, max: u64) -> Option<Option<u64>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(value) => clamp_u64(value, max).map(Some),
    }
}

fn parse_quota(service: QuotaService, org_id: &str, body: &Value) -> Option<EffectiveQuota> {
    Some(EffectiveQuota {
        service,
        org_id: org_id.to_string(),
        requests_per_min: clamp_u64(body.get("requestsPerMin")?, 100_000)?,
        requests_per_5h: clamp_u64(body.get("requestsPer5h")?, 1_000_000_000)?,
        requests_per_day: clamp_u64(body.get("requestsPerDay")?, 1_000_000_000)?,
        tokens_per_day: optional_clamp_u64(body.get("tokensPerDay"), 1_000_000_000)?,
        executions_per_hour: optional_clamp_u64(body.get("executionsPerHour"), 1_000_000)?,
        concurrent_executions: optional_clamp_u64(body.get("concurrentExecutions"), 1_000)?,
        overridden: body
            .get("overridden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_meter(body: &Value) -> UsageMeter {
    UsageMeter {
        tokens_today_ai: body
            .get("tokensToday")
            .and_then(|value| value.get("ai"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        tokens_today_inference: body
            .get("tokensToday")
            .and_then(|value| value.get("inference"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn parse_execution_admission(body: &Value) -> Option<ExecutionAdmissionResult> {
    let allowed = body.get("allowed")?.as_bool()?;
    let window = body.get("window")?.as_str()?;
    if !matches!(window, "hour" | "concurrent") {
        return None;
    }
    let token = body
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_string);
    if allowed
        && token
            .as_deref()
            .is_none_or(|value| value.is_empty() || value.len() > 64)
    {
        return None;
    }
    Some(ExecutionAdmissionResult {
        allowed,
        window: window.to_string(),
        count: body.get("count")?.as_u64()?,
        limit: body.get("limit")?.as_u64()?,
        retry_after_seconds: body.get("retryAfterSeconds")?.as_u64()?,
        reset_at: body
            .get("resetAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        token,
    })
}

fn parse_check(body: &Value) -> Option<QuotaCheckResult> {
    let allowed = body.get("allowed")?.as_bool()?;
    let window = body.get("window")?.as_str()?;
    if !matches!(window, "minute" | "fiveHour" | "day") {
        return None;
    }
    Some(QuotaCheckResult {
        allowed,
        window: window.to_string(),
        count: body.get("count")?.as_u64()?,
        limit: body.get("limit")?.as_u64()?,
        retry_after_seconds: body.get("retryAfterSeconds")?.as_u64()?,
        reset_at: body
            .get("resetAt")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub struct QuotaClient {
    client: reqwest::Client,
    iam_base: String,
    internal_secret: String,
    ttl: Duration,
    defaults: QuotaDefaults,
    quotas: Mutex<HashMap<String, (EffectiveQuota, Instant)>>,
    meters: Mutex<HashMap<String, (UsageMeter, Instant)>>,
}

impl QuotaClient {
    pub fn new(
        client: reqwest::Client,
        iam_base: impl Into<String>,
        internal_secret: impl Into<String>,
        ttl: Duration,
        defaults: QuotaDefaults,
    ) -> Self {
        Self {
            client,
            iam_base: iam_base.into().trim_end_matches('/').to_string(),
            internal_secret: internal_secret.into(),
            ttl,
            defaults,
            quotas: Mutex::new(HashMap::new()),
            meters: Mutex::new(HashMap::new()),
        }
    }

    pub fn default_for(&self, service: QuotaService) -> EffectiveQuota {
        self.defaults.for_service(service)
    }

    pub async fn effective(&self, org_id: &str, service: QuotaService) -> QuotaLookup {
        let key = format!("{}:{org_id}", service.as_str());
        if let Ok(cache) = self.quotas.lock() {
            if let Some((quota, at)) = cache.get(&key) {
                if at.elapsed() < self.ttl {
                    return QuotaLookup {
                        quota: quota.clone(),
                        authoritative: true,
                    };
                }
            }
        }
        let fetched = self.fetch_quota(org_id, service).await;
        let Some(mut quota) = fetched else {
            return QuotaLookup {
                quota: self.defaults.for_service(service),
                authoritative: false,
            };
        };
        quota.org_id = org_id.to_string();
        if let Ok(mut cache) = self.quotas.lock() {
            if cache.len() > 10_000 {
                cache.retain(|_, (_, at)| at.elapsed() < self.ttl);
            }
            cache.insert(key, (quota.clone(), Instant::now()));
        }
        QuotaLookup {
            quota,
            authoritative: true,
        }
    }

    /// Atomically admit a tenant request across all fixed request windows.
    /// Any IAM/Valkey failure is explicit so the caller can use its local fallback.
    pub async fn check(
        &self,
        subject: &str,
        quota: &EffectiveQuota,
    ) -> Result<QuotaCheckResult, ()> {
        let mut request = self
            .client
            .post(format!("{}/internal/quota/check", self.iam_base))
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({
                "subject": subject,
                "service": quota.service.as_str(),
                "limits": {
                    "minute": quota.requests_per_min,
                    "fiveHour": quota.requests_per_5h,
                    "day": quota.requests_per_day,
                },
            }));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let response = request.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let body: Value = response.json().await.map_err(|_| ())?;
        parse_check(&body).ok_or(())
    }

    /// Atomically admit a workflow execution against the shared hourly counter
    /// and concurrency lease set used by both normal routes and MCP tools/call.
    pub async fn admit_execution(
        &self,
        subject: &str,
        hour: u64,
        concurrent: u64,
    ) -> Result<ExecutionAdmissionResult, ()> {
        let mut request = self
            .client
            .post(format!(
                "{}/internal/workflow/execution/check",
                self.iam_base
            ))
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({
                "subject": subject,
                "limits": { "hour": hour, "concurrent": concurrent },
            }));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let response = request.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let body: Value = response.json().await.map_err(|_| ())?;
        parse_execution_admission(&body).ok_or(())
    }

    pub async fn release_execution(&self, subject: &str, token: &str) -> Result<bool, ()> {
        let mut request = self
            .client
            .post(format!(
                "{}/internal/workflow/execution/release",
                self.iam_base
            ))
            .timeout(Duration::from_secs(3))
            .json(&serde_json::json!({ "subject": subject, "token": token }));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let response = request.send().await.map_err(|_| ())?;
        if !response.status().is_success() {
            return Err(());
        }
        let body: Value = response.json().await.map_err(|_| ())?;
        body.get("released").and_then(Value::as_bool).ok_or(())
    }

    pub async fn meter(&self, org_id: &str) -> UsageMeter {
        if let Ok(cache) = self.meters.lock() {
            if let Some((meter, at)) = cache.get(org_id) {
                if at.elapsed() < self.ttl {
                    return meter.clone();
                }
            }
        }
        let fetched = self.fetch_meter(org_id).await.unwrap_or_default();
        if let Ok(mut cache) = self.meters.lock() {
            if cache.len() > 10_000 {
                cache.retain(|_, (_, at)| at.elapsed() < self.ttl);
            }
            cache.insert(org_id.to_string(), (fetched.clone(), Instant::now()));
        }
        fetched
    }

    async fn fetch_quota(&self, org_id: &str, service: QuotaService) -> Option<EffectiveQuota> {
        let mut request = self
            .client
            .get(format!(
                "{}/internal/quotas?orgId={org_id}&service={}",
                self.iam_base,
                service.as_str(),
            ))
            .timeout(Duration::from_secs(3));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let body: Value = request
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        parse_quota(service, org_id, &body)
    }

    async fn fetch_meter(&self, org_id: &str) -> Option<UsageMeter> {
        let mut request = self
            .client
            .get(format!(
                "{}/internal/usage/meter?orgId={org_id}",
                self.iam_base
            ))
            .timeout(Duration::from_secs(3));
        if !self.internal_secret.is_empty() {
            request = request.header("x-synapseone-internal", &self.internal_secret);
        }
        let body: Value = request
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json()
            .await
            .ok()?;
        Some(parse_meter(&body))
    }
}
