// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Lakehouse: Apache Iceberg namespaces, tables, snapshots and scans.

use crate::client::{segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

const PREFIX: &str = "/v1/lakehouse";

/// Lakehouse service handle.
#[derive(Clone)]
pub struct LakehouseService {
    client: Client,
}

impl LakehouseService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn usage(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/usage")).await
    }

    pub async fn namespaces(&self) -> Result<Value> {
        self.client.get(format!("{PREFIX}/namespaces")).await
    }

    pub async fn create_namespace(&self, name: &str) -> Result<Value> {
        self.client
            .post(format!("{PREFIX}/namespaces"), json!({ "name": name }))
            .await
    }

    pub async fn delete_namespace(&self, namespace: &str) -> Result<Value> {
        self.client
            .delete(format!("{PREFIX}/namespaces/{}", segment(namespace)))
            .await
    }

    pub async fn tables(&self, namespace: &str) -> Result<Value> {
        self.client
            .get(format!(
                "{PREFIX}/namespaces/{}/tables",
                segment(namespace)
            ))
            .await
    }

    pub async fn create_table(&self, namespace: &str, input: Value) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/namespaces/{}/tables", segment(namespace)),
                input,
            )
            .await
    }

    pub async fn table(&self, namespace: &str, table: &str) -> Result<Value> {
        self.client
            .get(format!(
                "{PREFIX}/namespaces/{}/tables/{}",
                segment(namespace),
                segment(table)
            ))
            .await
    }

    pub async fn delete_table(&self, namespace: &str, table: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{PREFIX}/namespaces/{}/tables/{}",
                segment(namespace),
                segment(table)
            ))
            .await
    }

    pub async fn append(
        &self,
        namespace: &str,
        table: &str,
        rows: Value,
        idempotency_key: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "rows": rows });
        if let Some(key) = idempotency_key {
            body["idempotencyKey"] = json!(key);
        }
        self.client
            .post(
                format!(
                    "{PREFIX}/namespaces/{}/tables/{}/rows",
                    segment(namespace),
                    segment(table)
                ),
                body,
            )
            .await
    }

    pub async fn query(
        &self,
        namespace: &str,
        table: &str,
        limit: Option<u32>,
        snapshot_id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({});
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        if let Some(snapshot_id) = snapshot_id {
            body["snapshotId"] = json!(snapshot_id);
        }
        self.client
            .post(
                format!(
                    "{PREFIX}/namespaces/{}/tables/{}/query",
                    segment(namespace),
                    segment(table)
                ),
                body,
            )
            .await
    }

    pub async fn snapshots(&self, namespace: &str, table: &str) -> Result<Value> {
        self.client
            .get(format!(
                "{PREFIX}/namespaces/{}/tables/{}/snapshots",
                segment(namespace),
                segment(table)
            ))
            .await
    }

    pub async fn evolve(&self, namespace: &str, table: &str, add: Value) -> Result<Value> {
        self.client
            .post(
                format!(
                    "{PREFIX}/namespaces/{}/tables/{}/schema",
                    segment(namespace),
                    segment(table)
                ),
                json!({ "add": add }),
            )
            .await
    }
}
