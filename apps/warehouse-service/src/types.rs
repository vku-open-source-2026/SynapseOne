// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! JSON shapes returned by the warehouse API. Field order and camelCase names
//! match the TypeScript service.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const COLUMN_TYPES: &[&str] = &["string", "number", "boolean", "timestamp", "json"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WarehouseColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub columns: Vec<WarehouseColumn>,
    pub mode: String,
    pub stream_topic: Option<String>,
    pub row_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobMeta {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub status: String,
    pub target_dataset_id: String,
    pub sql: Option<String>,
    pub stream_topic: Option<String>,
    pub stream_group: Option<String>,
    pub batch_size: i64,
    pub interval_ms: i64,
    pub write_mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub types: Vec<String>,
    pub rows: Vec<Value>,
    pub row_count: usize,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EtlTemplate {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_columns: Option<Vec<WarehouseColumn>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_topic_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_mode: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewDataset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub columns: Vec<WarehouseColumn>,
    pub mode: String,
    pub stream_topic: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewJob {
    pub name: String,
    pub mode: String,
    pub target_dataset_id: String,
    pub sql: Option<String>,
    pub stream_topic: Option<String>,
    pub stream_group: Option<String>,
    pub batch_size: i64,
    pub interval_ms: i64,
    pub write_mode: String,
}

#[derive(Debug, Clone)]
pub struct StreamEventRows {
    pub event_id: String,
    pub rows: Vec<Value>,
}
