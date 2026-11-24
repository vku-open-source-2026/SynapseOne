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
    pub destination: String,
    pub lakehouse_namespace: Option<String>,
    pub lakehouse_table: Option<String>,
    pub source_collection: Option<String>,
    pub source_database: Option<String>,
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
    pub destination: String,
    pub lakehouse_namespace: Option<String>,
    pub lakehouse_table: Option<String>,
    pub source_collection: Option<String>,
    pub source_database: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StreamEventRows {
    pub event_id: String,
    pub rows: Vec<Value>,
    /// Set for a SynapseBase document-change event. The worker replaces the
    /// current row for this document instead of appending a duplicate.
    pub document_id: Option<String>,
    /// `create|update|delete` for a Base event; `delete` removes the row.
    pub base_operation: Option<String>,
    /// Base document version (used for the current-state high-water mark).
    pub version: Option<i64>,
    /// Base document creation timestamp; a change means the id was re-created.
    pub created_at: Option<String>,
}
