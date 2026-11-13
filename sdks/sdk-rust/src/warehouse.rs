// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Warehouse: OLAP datasets, SQL queries, ETL, reports and dashboards.

use crate::client::{segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

const PREFIX: &str = "/v1/warehouse";

/// Warehouse service handle.
#[derive(Clone)]
pub struct WarehouseService {
    client: Client,
}

impl WarehouseService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn status(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/status")).await
    }

    pub async fn datasets(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/datasets")).await
    }

    pub async fn dataset(&self, id: &str) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/datasets/{}", segment(id)))
            .await
    }

    pub async fn create_dataset(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/datasets"), input).await
    }

    pub async fn ingest(&self, id: &str, rows: Value) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/datasets/{}/rows", segment(id)),
                json!({ "rows": rows }),
            )
            .await
    }

    pub async fn query(&self, sql: &str, limit: Option<u32>) -> Result<Value> {
        let mut body = json!({ "sql": sql });
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        self.client.post(format!("{PREFIX}/query"), body).await
    }

    pub async fn templates(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/templates")).await
    }

    pub async fn workflow_templates(&self) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/workflow-templates"))
            .await
    }

    pub async fn instantiate_workflow_template(&self, name: &str, input: Value) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/workflow-templates/{}/instantiate", segment(name)),
                input,
            )
            .await
    }

    pub async fn jobs(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/jobs")).await
    }

    pub async fn run_batch(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/etl/batch"), input).await
    }

    pub async fn ensure_stream(&self, input: Value) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/etl/stream"), input)
            .await
    }

    pub async fn run_job(&self, id: &str) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/jobs/{}/run", segment(id)), json!({}))
            .await
    }

    pub async fn pause_job(&self, id: &str) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/jobs/{}/pause", segment(id)), json!({}))
            .await
    }

    pub async fn reports(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/reports")).await
    }

    pub async fn create_report(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/reports"), input).await
    }

    pub async fn run_report(&self, id: &str) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/reports/{}/run", segment(id)), json!({}))
            .await
    }

    pub async fn publish_report(&self, id: &str) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/reports/{}/publish", segment(id)),
                json!({}),
            )
            .await
    }

    pub async fn public_report(&self, share_id: &str) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/public/reports/{}", segment(share_id)))
            .await
    }

    pub async fn dashboards(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/dashboards")).await
    }

    pub async fn create_dashboard(&self, input: Value) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/dashboards"), input)
            .await
    }

    pub async fn run_dashboard(&self, id: &str) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/dashboards/{}/run", segment(id)),
                json!({}),
            )
            .await
    }

    pub async fn publish_dashboard(&self, id: &str) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/dashboards/{}/publish", segment(id)),
                json!({}),
            )
            .await
    }

    pub async fn public_dashboard(&self, share_id: &str) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/public/dashboards/{}", segment(share_id)))
            .await
    }

    pub async fn use_cases(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/use-cases")).await
    }

    pub async fn seed_use_case(&self, id: &str) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/use-cases/{}/seed", segment(id)),
                json!({}),
            )
            .await
    }
}
