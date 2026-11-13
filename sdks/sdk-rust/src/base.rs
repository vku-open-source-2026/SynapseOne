// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase: collections, documents, queries, batches, change feed, GIS and
//! property-graph endpoints.

use crate::client::{query_string, segment, Client, Request};
use crate::error::Result;
use crate::types::{BatchOperation, OrderBy, Query, QueryResult, VectorSearchResult};
use http::Method;
use serde_json::{json, Value};

/// SynapseBase service handle.
#[derive(Clone)]
pub struct BaseService {
    client: Client,
}

impl BaseService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Bind a collection name for typed convenience methods.
    pub fn collection(&self, name: impl Into<String>) -> Collection {
        Collection {
            service: self.clone(),
            name: name.into(),
        }
    }

    fn collection_path(collection: &str) -> String {
        format!("/v1/base/collections/{}", segment(collection))
    }

    // ---- graph ---------------------------------------------------------

    pub async fn graph_upsert_nodes(&self, collection: &str, nodes: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/graph/nodes", Self::collection_path(collection)),
                json!({ "nodes": nodes }),
            )
            .await
    }

    pub async fn graph_upsert_edges(&self, collection: &str, edges: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/graph/edges", Self::collection_path(collection)),
                json!({ "edges": edges }),
            )
            .await
    }

    pub async fn graph_node(
        &self,
        collection: &str,
        node_id: &str,
        depth: u32,
        limit: u32,
    ) -> Result<Value> {
        let qs = query_string(&[("depth", depth.to_string()), ("limit", limit.to_string())]);
        self.client
            .get(format!(
                "{}/graph/nodes/{}?{}",
                Self::collection_path(collection),
                segment(node_id),
                qs
            ))
            .await
    }

    pub async fn graph_query(
        &self,
        collection: &str,
        start: Vec<String>,
        depth: u32,
        limit: u32,
        edge_types: Option<Vec<String>>,
    ) -> Result<Value> {
        let mut body = json!({ "start": start, "depth": depth, "limit": limit });
        if let Some(edge_types) = edge_types {
            body["edgeTypes"] = json!(edge_types);
        }
        self.client
            .post(
                format!("{}/graph/query", Self::collection_path(collection)),
                body,
            )
            .await
    }

    pub async fn graph_stats(&self, collection: &str) -> Result<Value> {
        self.client
            .get(format!("{}/graph/stats", Self::collection_path(collection)))
            .await
    }

    pub async fn graph_delete_node(&self, collection: &str, node_id: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{}/graph/nodes/{}",
                Self::collection_path(collection),
                segment(node_id)
            ))
            .await
    }

    // ---- GIS -----------------------------------------------------------

    pub async fn geo_upsert(&self, collection: &str, features: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/geo/features", Self::collection_path(collection)),
                json!({ "features": features }),
            )
            .await
    }

    pub async fn geo_list(
        &self,
        collection: &str,
        bbox: Option<&str>,
        limit: u32,
    ) -> Result<Value> {
        let mut params = vec![("limit", limit.to_string())];
        if let Some(bbox) = bbox {
            params.push(("bbox", bbox.to_string()));
        }
        let qs = query_string(&params);
        self.client
            .get(format!(
                "{}/geo/features?{}",
                Self::collection_path(collection),
                qs
            ))
            .await
    }

    pub async fn geo_near(
        &self,
        collection: &str,
        lat: f64,
        lng: f64,
        radius_meters: f64,
        limit: u32,
    ) -> Result<Value> {
        self.client
            .post(
                format!("{}/geo/near", Self::collection_path(collection)),
                json!({
                    "lat": lat,
                    "lng": lng,
                    "radiusMeters": radius_meters,
                    "limit": limit,
                }),
            )
            .await
    }

    pub async fn geo_within(&self, collection: &str, geometry: Value, limit: u32) -> Result<Value> {
        self.client
            .post(
                format!("{}/geo/within", Self::collection_path(collection)),
                json!({ "geometry": geometry, "limit": limit }),
            )
            .await
    }

    pub async fn geo_stats(&self, collection: &str) -> Result<Value> {
        self.client
            .get(format!("{}/geo/stats", Self::collection_path(collection)))
            .await
    }

    pub async fn geo_delete(&self, collection: &str, feature_id: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{}/geo/features/{}",
                Self::collection_path(collection),
                segment(feature_id)
            ))
            .await
    }

    // ---- collections ---------------------------------------------------

    pub async fn list_collections(
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
            "/v1/base/collections".to_string()
        } else {
            format!("/v1/base/collections?{}", query_string(&params))
        };
        self.client.get(path).await
    }

    pub async fn create_collection(
        &self,
        name: &str,
        description: Option<&str>,
        mapping: Option<Value>,
        org_id: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "name": name });
        if let Some(description) = description {
            body["description"] = json!(description);
        }
        if let Some(mapping) = mapping {
            body["mapping"] = mapping;
        }
        if let Some(org_id) = org_id {
            body["orgId"] = json!(org_id);
        }
        if let Some(account_id) = account_id {
            body["accountId"] = json!(account_id);
        }
        self.client.post("/v1/base/collections", body).await
    }

    pub async fn get_collection(&self, collection: &str) -> Result<Value> {
        self.client.get(Self::collection_path(collection)).await
    }

    pub async fn update_collection(
        &self,
        collection: &str,
        name: Option<&str>,
        description: Option<Value>,
        mapping: Option<Value>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".to_string(), json!(name));
        }
        if let Some(description) = description {
            body.insert("description".to_string(), description);
        }
        if let Some(mapping) = mapping {
            body.insert("mapping".to_string(), mapping);
        }
        self.client
            .patch(Self::collection_path(collection), Value::Object(body))
            .await
    }

    pub async fn delete_collection(&self, collection: &str) -> Result<Value> {
        self.client.delete(Self::collection_path(collection)).await
    }

    pub async fn collection_stats(&self, collection: &str) -> Result<Value> {
        self.client
            .get(format!("{}/stats", Self::collection_path(collection)))
            .await
    }

    // ---- documents -----------------------------------------------------

    pub async fn create_document(
        &self,
        collection: &str,
        data: Value,
        id: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({ "data": data });
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        self.client
            .post(
                format!("{}/documents", Self::collection_path(collection)),
                body,
            )
            .await
    }

    pub async fn get_document(
        &self,
        collection: &str,
        doc_id: &str,
        as_view: &str,
    ) -> Result<Value> {
        let path = format!(
            "{}/documents/{}",
            Self::collection_path(collection),
            segment(doc_id)
        );
        let path = if as_view == "data" {
            path
        } else {
            format!("{}?{}", path, query_string(&[("as", as_view.to_string())]))
        };
        self.client.get(path).await
    }

    pub async fn set_document(
        &self,
        collection: &str,
        doc_id: &str,
        data: Value,
        if_version: Option<i64>,
        merge: bool,
    ) -> Result<Value> {
        let mut body = json!({ "data": data });
        if let Some(if_version) = if_version {
            body["ifVersion"] = json!(if_version);
        }
        if merge {
            body["merge"] = json!(true);
        }
        self.client
            .put(
                format!(
                    "{}/documents/{}",
                    Self::collection_path(collection),
                    segment(doc_id)
                ),
                body,
            )
            .await
    }

    pub async fn update_document(
        &self,
        collection: &str,
        doc_id: &str,
        data: Option<Value>,
        unset: Option<Vec<String>>,
        if_version: Option<i64>,
    ) -> Result<Value> {
        let mut body = serde_json::Map::new();
        if let Some(data) = data {
            body.insert("data".to_string(), data);
        }
        if let Some(unset) = unset {
            body.insert("unset".to_string(), json!(unset));
        }
        if let Some(if_version) = if_version {
            body.insert("ifVersion".to_string(), json!(if_version));
        }
        self.client
            .patch(
                format!(
                    "{}/documents/{}",
                    Self::collection_path(collection),
                    segment(doc_id)
                ),
                Value::Object(body),
            )
            .await
    }

    pub async fn delete_document(
        &self,
        collection: &str,
        doc_id: &str,
        if_version: Option<i64>,
    ) -> Result<Value> {
        let mut path = format!(
            "{}/documents/{}",
            Self::collection_path(collection),
            segment(doc_id)
        );
        if let Some(if_version) = if_version {
            path = format!(
                "{}?{}",
                path,
                query_string(&[("ifVersion", if_version.to_string())])
            );
        }
        self.client.delete(path).await
    }

    // ---- query ---------------------------------------------------------

    pub async fn query_documents(&self, collection: &str, query: Query) -> Result<QueryResult> {
        let body = serde_json::to_value(query)?;
        let value = self
            .client
            .post(format!("{}/query", Self::collection_path(collection)), body)
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn query(&self, collection: &str, query: Query) -> Result<QueryResult> {
        self.query_documents(collection, query).await
    }

    pub async fn vector_search(
        &self,
        collection: &str,
        vector: Vec<f32>,
        limit: Option<i64>,
        field: Option<&str>,
        metric: Option<&str>,
        filter: Option<Value>,
        select: Option<Vec<String>>,
        as_view: &str,
    ) -> Result<VectorSearchResult> {
        let mut body = json!({ "vector": vector, "as": as_view });
        if let Some(limit) = limit {
            body["limit"] = json!(limit);
        }
        if let Some(field) = field {
            body["field"] = json!(field);
        }
        if let Some(metric) = metric {
            body["metric"] = json!(metric);
        }
        if let Some(filter) = filter {
            body["where"] = filter;
        }
        if let Some(select) = select {
            body["select"] = json!(select);
        }
        let value = self
            .client
            .post(
                format!("{}/vector-search", Self::collection_path(collection)),
                body,
            )
            .await?;
        Ok(serde_json::from_value(value)?)
    }

    pub async fn list_documents(
        &self,
        collection: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<Value> {
        let mut params = Vec::new();
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(offset) = offset {
            params.push(("offset", offset.to_string()));
        }
        let path = if params.is_empty() {
            format!("{}/documents", Self::collection_path(collection))
        } else {
            format!(
                "{}/documents?{}",
                Self::collection_path(collection),
                query_string(&params)
            )
        };
        self.client.get(path).await
    }

    pub async fn increment(
        &self,
        collection: &str,
        doc_id: &str,
        field: &str,
        by: f64,
        if_version: Option<i64>,
    ) -> Result<Value> {
        let mut body = json!({ "field": field, "by": by });
        if let Some(if_version) = if_version {
            body["ifVersion"] = json!(if_version);
        }
        self.client
            .post(
                format!(
                    "{}/documents/{}/increment",
                    Self::collection_path(collection),
                    segment(doc_id)
                ),
                body,
            )
            .await
    }

    pub async fn batch(&self, collection: &str, operations: Vec<BatchOperation>) -> Result<Value> {
        self.batch_values(collection, serde_json::to_value(operations)?)
            .await
    }

    pub async fn batch_values(&self, collection: &str, operations: Value) -> Result<Value> {
        self.client
            .post(
                format!("{}/documents:batch", Self::collection_path(collection)),
                json!({ "operations": operations }),
            )
            .await
    }

    pub async fn changes(
        &self,
        collection: &str,
        since: &str,
        limit: Option<i64>,
        as_view: &str,
    ) -> Result<Value> {
        let mut params = vec![("since", since.to_string())];
        if let Some(limit) = limit {
            params.push(("limit", limit.to_string()));
        }
        if as_view != "data" {
            params.push(("as", as_view.to_string()));
        }
        self.client
            .get(format!(
                "{}/changes?{}",
                Self::collection_path(collection),
                query_string(&params)
            ))
            .await
    }

    // ---- tenant-scoped search -----------------------------------------

    pub async fn search(
        &self,
        query: &str,
        mode: &str,
        collection: Option<&str>,
        collections: Option<Vec<String>>,
        filters: Option<Value>,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "query": query,
            "mode": mode,
            "limit": limit,
            "filters": filters.unwrap_or_else(|| json!({})),
        });
        if let Some(collection) = collection {
            body["collection"] = json!(collection);
        }
        if let Some(collections) = collections {
            body["collections"] = json!(collections);
        }
        if let Some(cursor) = cursor {
            body["cursor"] = json!(cursor);
        }
        self.client.post("/v1/search", body).await
    }

    pub async fn search_fulltext(&self, query: &str) -> Result<Value> {
        self.search(query, "fulltext", None, None, None, 20, None)
            .await
    }

    pub async fn search_semantic(&self, query: &str) -> Result<Value> {
        self.search(query, "semantic", None, None, None, 20, None)
            .await
    }

    pub async fn search_hybrid(&self, query: &str) -> Result<Value> {
        self.search(query, "hybrid", None, None, None, 20, None)
            .await
    }

    pub async fn reindex_search(&self, collections: Option<Vec<String>>) -> Result<Value> {
        let body = match collections {
            Some(collections) => json!({ "collections": collections }),
            None => json!({}),
        };
        self.client.post("/v1/search/reindex", body).await
    }

    pub async fn search_status(&self) -> Result<Value> {
        self.client.get("/v1/search/status").await
    }

    /// Raw request escape hatch for endpoints added after this SDK release.
    pub async fn raw(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
    ) -> Result<Value> {
        self.client.request(method, path, body).await
    }
}

/// A collection bound to the Base service.
#[derive(Clone)]
pub struct Collection {
    service: BaseService,
    name: String,
}

impl Collection {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn service(&self) -> &BaseService {
        &self.service
    }

    pub async fn create(&self, data: Value, id: Option<&str>) -> Result<Value> {
        self.service.create_document(&self.name, data, id).await
    }

    pub async fn get(&self, id: &str, as_view: &str) -> Result<Value> {
        self.service.get_document(&self.name, id, as_view).await
    }

    pub async fn set(
        &self,
        id: &str,
        data: Value,
        if_version: Option<i64>,
        merge: bool,
    ) -> Result<Value> {
        self.service
            .set_document(&self.name, id, data, if_version, merge)
            .await
    }

    pub async fn update(
        &self,
        id: &str,
        data: Option<Value>,
        unset: Option<Vec<String>>,
        if_version: Option<i64>,
    ) -> Result<Value> {
        self.service
            .update_document(&self.name, id, data, unset, if_version)
            .await
    }

    pub async fn delete(&self, id: &str, if_version: Option<i64>) -> Result<Value> {
        self.service
            .delete_document(&self.name, id, if_version)
            .await
    }

    pub async fn list(&self, limit: Option<i64>, offset: Option<i64>) -> Result<Value> {
        self.service.list_documents(&self.name, limit, offset).await
    }

    pub async fn query(&self, query: Query) -> Result<QueryResult> {
        self.service.query_documents(&self.name, query).await
    }

    pub async fn batch(&self, operations: Vec<BatchOperation>) -> Result<Value> {
        self.service.batch(&self.name, operations).await
    }

    pub async fn changes(&self, since: &str, limit: Option<i64>, as_view: &str) -> Result<Value> {
        self.service
            .changes(&self.name, since, limit, as_view)
            .await
    }

    /// Convenience: build an `OrderBy` list quickly.
    pub fn order(field: impl Into<String>, direction: &str) -> OrderBy {
        OrderBy {
            field: field.into(),
            direction: direction.to_string(),
        }
    }

    /// Convenience: a raw `Request` for this collection's documents path.
    pub fn request(&self, method: Method, suffix: &str) -> Request {
        Request::new(
            method,
            format!(
                "/v1/base/collections/{}/documents{}",
                segment(&self.name),
                suffix
            ),
        )
    }
}
