// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Transport and Base contract tests for the SynapseOne Rust SDK.

use serde_json::json;
use std::time::Duration;
use synapseone::{BatchOperation, Client, Credentials, OrderBy, Query};
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(server: &MockServer) -> Client {
    Client::builder(server.uri())
        .credentials(Credentials::api_key("key-123").with_token("jwt-123"))
        .tenant("acme")
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap()
}

#[tokio::test]
async fn sends_auth_tenant_and_accept_headers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/health"))
        .and(header("authorization", "Bearer jwt-123"))
        .and(header("x-api-key", "key-123"))
        .and(header("x-synapseone-tenant", "acme"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;

    let value = client(&server).get("/v1/health").await.unwrap();
    assert_eq!(value["status"], "ok");
}

#[tokio::test]
async fn base_query_sends_filter_order_and_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/base/collections/features/query"))
        .and(body_partial_json(json!({
            "where": { "city_synced": false },
            "orderBy": [{ "field": "created_at", "direction": "asc" }],
            "limit": 10,
            "as": "data",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [{ "id": "a", "data": { "name": "A" } }],
            "total": 1,
            "limit": 10,
            "offset": 0,
            "nextCursor": "next"
        })))
        .mount(&server)
        .await;

    let page = client(&server)
        .base()
        .query_documents(
            "features",
            Query::new()
                .filter(json!({ "city_synced": false }))
                .order_by(vec![OrderBy::asc("created_at")])
                .limit(10),
        )
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.next_cursor.as_deref(), Some("next"));
}

#[tokio::test]
async fn base_database_handle_prefixes_collection_paths() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/base/databases/analytics/collections/features"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"id": "c1", "name": "features"})),
        )
        .mount(&server)
        .await;

    let value = client(&server)
        .base()
        .database("analytics")
        .get_collection("features")
        .await
        .unwrap();
    assert_eq!(value["name"], "features");
}

#[tokio::test]
async fn retries_retryable_status_then_succeeds() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/retry"))
        .respond_with(ResponseTemplate::new(503).set_body_string("try later"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/retry"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .mount(&server)
        .await;

    let value = client(&server).get("/v1/retry").await.unwrap();
    assert_eq!(value["ok"], true);
}

#[tokio::test]
async fn exposes_platform_error_code_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": "not_found",
            "message": "no such document",
        })))
        .mount(&server)
        .await;

    let error = client(&server).get("/v1/missing").await.unwrap_err();
    assert_eq!(error.status(), Some(404));
    assert_eq!(error.code(), Some("not_found"));
    assert!(error.is_not_found());
    assert_eq!(error.body().unwrap()["message"], "no such document");
}

#[tokio::test]
async fn detects_html_from_the_wrong_host() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/html"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string("<!doctype html><html>console</html>"),
        )
        .mount(&server)
        .await;

    let error = client(&server).get("/v1/html").await.unwrap_err();
    assert!(matches!(error, synapseone::Error::NonJsonResponse { .. }));
}

#[tokio::test]
async fn batch_update_uses_documents_batch() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/base/collections/features/documents:batch"))
        .and(body_partial_json(json!({
            "operations": [
                { "op": "update", "id": "a", "data": { "city_synced": true } }
            ]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{ "ok": true }]
        })))
        .mount(&server)
        .await;

    let result = client(&server)
        .base()
        .batch(
            "features",
            vec![BatchOperation::update("a", json!({ "city_synced": true }))],
        )
        .await
        .unwrap();
    assert_eq!(result["results"][0]["ok"], true);
}

#[tokio::test]
async fn warehouse_methods_target_registered_routes() {
    let server = MockServer::start().await;
    let routes = [
        ("GET", "/v1/warehouse/datasets"),
        ("POST", "/v1/warehouse/datasets"),
        ("GET", "/v1/warehouse/datasets/ds1"),
        ("PATCH", "/v1/warehouse/datasets/ds1"),
        ("DELETE", "/v1/warehouse/datasets/ds1"),
        ("POST", "/v1/warehouse/datasets/ds1/rows"),
        ("POST", "/v1/warehouse/query"),
        ("GET", "/v1/warehouse/templates"),
        ("GET", "/v1/warehouse/pipeline/status"),
        ("GET", "/v1/warehouse/jobs"),
        ("POST", "/v1/warehouse/jobs"),
        ("GET", "/v1/warehouse/jobs/j1"),
        ("PATCH", "/v1/warehouse/jobs/j1"),
        ("DELETE", "/v1/warehouse/jobs/j1"),
        ("POST", "/v1/warehouse/jobs/j1/run"),
        ("POST", "/v1/warehouse/jobs/j1/pause"),
        ("POST", "/v1/warehouse/jobs/j1/resume"),
        ("POST", "/v1/warehouse/etl/batch"),
        ("POST", "/v1/warehouse/etl/stream"),
        ("POST", "/v1/warehouse/etl/base"),
        ("POST", "/v1/warehouse/etl/lakehouse"),
        ("POST", "/v1/warehouse/etl/base-lakehouse"),
        ("POST", "/v1/warehouse/etl/ocs/preview"),
        ("POST", "/v1/warehouse/etl/ocs"),
    ];
    for (verb, route) in routes {
        Mock::given(method(verb))
            .and(path(route))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
            .mount(&server)
            .await;
    }
    let warehouse = client(&server).warehouse();
    warehouse.datasets().await.unwrap();
    warehouse.create_dataset(json!({ "name": "ds", "columns": [] })).await.unwrap();
    warehouse.dataset("ds1").await.unwrap();
    warehouse.update_dataset("ds1", json!({ "name": "renamed" })).await.unwrap();
    warehouse.delete_dataset("ds1").await.unwrap();
    warehouse.ingest("ds1", json!([])).await.unwrap();
    warehouse.query("select 1", Some(10)).await.unwrap();
    warehouse.templates().await.unwrap();
    warehouse.pipeline_status().await.unwrap();
    warehouse.jobs().await.unwrap();
    warehouse.create_job(json!({ "mode": "batch" })).await.unwrap();
    warehouse.get_job("j1").await.unwrap();
    warehouse.update_job("j1", json!({ "name": "renamed" })).await.unwrap();
    warehouse.delete_job("j1").await.unwrap();
    warehouse.run_job("j1").await.unwrap();
    warehouse.pause_job("j1").await.unwrap();
    warehouse.resume_job("j1").await.unwrap();
    warehouse.run_batch(json!({})).await.unwrap();
    warehouse.ensure_stream(json!({})).await.unwrap();
    warehouse.base_to_warehouse(json!({})).await.unwrap();
    warehouse.lakehouse_to_warehouse(json!({})).await.unwrap();
    warehouse.base_to_lakehouse(json!({})).await.unwrap();
    warehouse.preview_ocs(json!({})).await.unwrap();
    warehouse.import_ocs(json!({})).await.unwrap();
}
