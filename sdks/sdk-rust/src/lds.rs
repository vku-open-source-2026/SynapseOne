// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseLDS: datasources, attributes, records and NGSI-LD entities.

use crate::client::{query_string, segment, Client};
use crate::error::Result;
use serde_json::{json, Value};

/// LDS service handle.
#[derive(Clone)]
pub struct LdsService {
    client: Client,
}

impl LdsService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    fn ds_path(ds_id: &str) -> String {
        format!("/v1/lds/datasources/{}", segment(ds_id))
    }

    pub async fn list_licenses(&self) -> Result<Value> {
        self.client.get("/v1/lds/licenses").await
    }

    pub async fn list_datasources(
        &self,
        org_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(org_id) = org_id {
            params.push(("orgId", org_id.to_string()));
        }
        if let Some(account_id) = account_id {
            params.push(("accountId", account_id.to_string()));
        }
        let path = if params.is_empty() {
            "/v1/lds/datasources".to_string()
        } else {
            format!("/v1/lds/datasources?{}", query_string(&params))
        };
        self.client.get(path).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_datasource(
        &self,
        name: &str,
        entity_type: &str,
        license: &str,
        slug: Option<&str>,
        license_url: Option<&str>,
        contexts: Option<Value>,
        default_visibility: Option<&str>,
        description: Option<&str>,
        org_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "name": name,
            "entityType": entity_type,
            "license": license,
        });
        if let Some(slug) = slug {
            body["slug"] = json!(slug);
        }
        if let Some(license_url) = license_url {
            body["licenseUrl"] = json!(license_url);
        }
        if let Some(contexts) = contexts {
            body["contexts"] = contexts;
        }
        if let Some(default_visibility) = default_visibility {
            body["defaultVisibility"] = json!(default_visibility);
        }
        if let Some(description) = description {
            body["description"] = json!(description);
        }
        if let Some(org_id) = org_id {
            body["orgId"] = json!(org_id);
        }
        if let Some(account_id) = account_id {
            body["accountId"] = json!(account_id);
        }
        self.client.post("/v1/lds/datasources", body).await
    }

    pub async fn get_datasource(&self, ds_id: &str) -> Result<Value> {
        self.client.get(Self::ds_path(ds_id)).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_datasource(
        &self,
        ds_id: &str,
        name: Option<&str>,
        slug: Option<&str>,
        entity_type: Option<&str>,
        license: Option<&str>,
        license_url: Option<&str>,
        contexts: Option<Value>,
        default_visibility: Option<&str>,
        description: Option<&str>,
        org_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(value) = name {
            body.insert("name".to_string(), json!(value));
        }
        if let Some(value) = slug {
            body.insert("slug".to_string(), json!(value));
        }
        if let Some(value) = entity_type {
            body.insert("entityType".to_string(), json!(value));
        }
        if let Some(value) = license {
            body.insert("license".to_string(), json!(value));
        }
        if let Some(value) = license_url {
            body.insert("licenseUrl".to_string(), json!(value));
        }
        if let Some(value) = contexts {
            body.insert("contexts".to_string(), value);
        }
        if let Some(value) = default_visibility {
            body.insert("defaultVisibility".to_string(), json!(value));
        }
        if let Some(value) = description {
            body.insert("description".to_string(), json!(value));
        }
        if let Some(value) = org_id {
            body.insert("orgId".to_string(), json!(value));
        }
        if let Some(value) = account_id {
            body.insert("accountId".to_string(), json!(value));
        }
        self.client
            .patch(Self::ds_path(ds_id), Value::Object(body))
            .await
    }

    pub async fn delete_datasource(&self, ds_id: &str) -> Result<Value> {
        self.client.delete(Self::ds_path(ds_id)).await
    }

    pub async fn get_datasource_attributes(&self, ds_id: &str) -> Result<Value> {
        self.client
            .get(format!("{}/attributes", Self::ds_path(ds_id)))
            .await
    }

    pub async fn set_datasource_attributes(&self, ds_id: &str, attributes: Value) -> Result<Value> {
        self.client
            .put(
                format!("{}/attributes", Self::ds_path(ds_id)),
                json!({ "attributes": attributes }),
            )
            .await
    }

    pub async fn ingest_records(&self, ds_id: &str, records: Value) -> Result<Value> {
        let body = if records.is_array() {
            json!({ "records": records })
        } else {
            records
        };
        self.client
            .post(format!("{}/records", Self::ds_path(ds_id)), body)
            .await
    }

    pub async fn list_entities(
        &self,
        ds_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
        visibility: Option<&str>,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(offset) = offset {
            params.push(("offset", offset.to_string()));
        }
        if let Some(visibility) = visibility {
            params.push(("visibility", visibility.to_string()));
        }
        let path = if params.is_empty() {
            format!("{}/entities", Self::ds_path(ds_id))
        } else {
            format!(
                "{}/entities?{}",
                Self::ds_path(ds_id),
                query_string(&params)
            )
        };
        self.client.get(path).await
    }

    pub async fn get_entity(&self, ds_id: &str, entity_id: &str) -> Result<Value> {
        self.client
            .get(format!(
                "{}/entities/{}",
                Self::ds_path(ds_id),
                segment(entity_id)
            ))
            .await
    }

    pub async fn get_datasource_stats(&self, ds_id: &str) -> Result<Value> {
        self.client
            .get(format!("{}/stats", Self::ds_path(ds_id)))
            .await
    }
}
