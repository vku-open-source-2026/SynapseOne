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
