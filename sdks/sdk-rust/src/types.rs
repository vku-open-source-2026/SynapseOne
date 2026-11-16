// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared request/response types.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A page returned by `POST /v1/base/collections/{name}/query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
    #[serde(rename = "nextCursor", default)]
    pub next_cursor: Option<String>,
}

impl QueryResult {
    /// Iterate over document envelopes, returning each `data` object.
    pub fn data(&self) -> impl Iterator<Item = &Value> {
        self.items.iter().filter_map(|item| item.get("data"))
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// Vector similarity result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorSearchResult {
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub limit: i64,
    #[serde(default = "default_metric")]
    pub metric: String,
}

fn default_metric() -> String {
    "cosine".to_string()
}

/// Ordering clause for Base queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBy {
    pub field: String,
    pub direction: String,
}

impl OrderBy {
    pub fn asc(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            direction: "asc".to_string(),
        }
    }

    pub fn desc(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            direction: "desc".to_string(),
        }
    }
}

/// Builder for a Base query body.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Query {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#where: Option<Value>,
    #[serde(rename = "orderBy", skip_serializing_if = "Option::is_none")]
    pub order_by: Option<Vec<OrderBy>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<Vec<String>>,
    #[serde(rename = "as")]
    pub as_view: String,
}

impl Query {
    pub fn new() -> Self {
        Self {
            as_view: "data".to_string(),
            ..Default::default()
        }
    }

    pub fn filter(mut self, filter: Value) -> Self {
        self.r#where = Some(filter);
        self
    }

    pub fn order_by(mut self, order_by: Vec<OrderBy>) -> Self {
        self.order_by = Some(order_by);
        self
    }

    pub fn limit(mut self, limit: i64) -> Self {
        self.limit = Some(limit);
        self
    }

    pub fn offset(mut self, offset: i64) -> Self {
        self.offset = Some(offset);
        self
    }

    pub fn cursor(mut self, cursor: impl Into<String>) -> Self {
        self.cursor = Some(cursor.into());
        self
    }

    pub fn select(mut self, fields: Vec<String>) -> Self {
        self.select = Some(fields);
        self
    }

    pub fn as_view(mut self, view: impl Into<String>) -> Self {
        self.as_view = view.into();
        self
    }
}

/// One operation inside `documents:batch`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchOperation {
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<f64>,
}

impl BatchOperation {
    pub fn update(id: impl Into<String>, data: Value) -> Self {
        Self {
            op: "update".to_string(),
            id: Some(id.into()),
            data: Some(data),
            object: None,
            field: None,
            by: None,
        }
    }

    pub fn create(id: Option<String>, data: Value) -> Self {
        Self {
            op: "create".to_string(),
            id,
            data: Some(data),
            object: None,
            field: None,
            by: None,
        }
    }

    pub fn delete(id: impl Into<String>) -> Self {
        Self {
            op: "delete".to_string(),
            id: Some(id.into()),
            data: None,
            object: None,
            field: None,
            by: None,
        }
    }
}

/// A collection statistics envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionStats {
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Health/readiness payload from the gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub upstreams: Vec<Value>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
