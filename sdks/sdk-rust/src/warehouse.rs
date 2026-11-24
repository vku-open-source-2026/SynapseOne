// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Warehouse: OLAP datasets, SQL queries and ETL jobs.

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

    pub async fn pipeline_status(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/pipeline/status")).await
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

    pub async fn delete_dataset(&self, id: &str) -> Result<Value> {
        self.client
            .delete(format!("{PREFIX}/datasets/{}", segment(id)))
            .await
    }

    pub async fn update_dataset(&self, id: &str, input: Value) -> Result<Value> {
        self.client
            .patch(format!("{PREFIX}/datasets/{}", segment(id)), input)
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

    pub async fn base_to_warehouse(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/etl/base"), input).await
    }

    pub async fn lakehouse_to_warehouse(&self, input: Value) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/etl/lakehouse"), input)
            .await
    }

    pub async fn base_to_lakehouse(&self, input: Value) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/etl/base-lakehouse"), input)
            .await
    }

    pub async fn preview_ocs(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/etl/ocs/preview"), input).await
    }

    pub async fn import_ocs(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/etl/ocs"), input).await
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

    pub async fn resume_job(&self, id: &str) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/jobs/{}/resume", segment(id)), json!({}))
            .await
    }

    pub async fn create_job(&self, input: Value) -> Result<Value> {
        self.client.post(format!("{PREFIX}/jobs"), input).await
    }

    pub async fn get_job(&self, id: &str) -> Result<Value> {
        self.client
            .get(format!("{PREFIX}/jobs/{}", segment(id)))
            .await
    }

    pub async fn update_job(&self, id: &str, input: Value) -> Result<Value> {
        self.client
            .patch(format!("{PREFIX}/jobs/{}", segment(id)), input)
            .await
    }

    pub async fn delete_job(&self, id: &str) -> Result<Value> {
        self.client
            .delete(format!("{PREFIX}/jobs/{}", segment(id)))
            .await
    }
}
