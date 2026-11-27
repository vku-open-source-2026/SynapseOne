// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Transport and Base contract tests for the SynapseOne Rust SDK.

use serde_json::json;
use std::time::Duration;
use synapseone::{BatchOperation, Client, Credentials, Error, OrderBy, Query, Request};
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
    warehouse
        .create_dataset(json!({ "name": "ds", "columns": [] }))
        .await
        .unwrap();
    warehouse.dataset("ds1").await.unwrap();
    warehouse
        .update_dataset("ds1", json!({ "name": "renamed" }))
        .await
        .unwrap();
    warehouse.delete_dataset("ds1").await.unwrap();
    warehouse.ingest("ds1", json!([])).await.unwrap();
    warehouse.query("select 1", Some(10)).await.unwrap();
    warehouse.templates().await.unwrap();
    warehouse.pipeline_status().await.unwrap();
    warehouse.jobs().await.unwrap();
    warehouse
        .create_job(json!({ "mode": "batch" }))
        .await
        .unwrap();
    warehouse.get_job("j1").await.unwrap();
    warehouse
        .update_job("j1", json!({ "name": "renamed" }))
        .await
        .unwrap();
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

#[tokio::test]
async fn same_origin_redirect_keeps_credentials() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/start"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/v1/final"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/final"))
        .and(header("authorization", "Bearer jwt-123"))
        .and(header("x-api-key", "key-123"))
        .and(header("x-synapseone-tenant", "acme"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
        .mount(&server)
        .await;

    let value = client(&server).get("/v1/start").await.unwrap();
    assert_eq!(value["ok"], true);
}

#[tokio::test]
async fn untrusted_cross_origin_redirect_is_refused() {
    let other = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"other": true})))
        .mount(&other)
        .await;
    let source = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/start"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/capture", other.uri())),
        )
        .mount(&source)
        .await;

    let error = client(&source).get("/v1/start").await.unwrap_err();
    assert!(matches!(error, Error::Redirect { .. }), "{error:?}");
    let requests = other.received_requests().await.unwrap_or_default();
    assert!(requests.is_empty(), "untrusted target was contacted");
}

#[tokio::test]
async fn trusted_cross_origin_redirect_strips_credentials() {
    let other = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/capture"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"other": true})))
        .mount(&other)
        .await;
    let source = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/start"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", format!("{}/capture", other.uri())),
        )
        .mount(&source)
        .await;

    let client = Client::builder(source.uri())
        .credentials(Credentials::api_key("key-123").with_token("jwt-123"))
        .tenant("acme")
        .trusted_redirect_origin(other.uri())
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap();
    let value = client.get("/v1/start").await.unwrap();
    assert_eq!(value["other"], true);

    let requests = other.received_requests().await.unwrap_or_default();
    assert_eq!(requests.len(), 1);
    let headers = &requests[0].headers;
    assert!(headers.get("authorization").is_none());
    assert!(headers.get("x-api-key").is_none());
    assert!(headers.get("x-synapseone-tenant").is_none());
    assert!(headers.get("cookie").is_none());
}

#[tokio::test]
async fn redirect_loops_are_bounded() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/loop"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", "/v1/loop"))
        .mount(&server)
        .await;

    let client = Client::builder(server.uri())
        .max_redirects(2)
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap();
    let error = client.get("/v1/loop").await.unwrap_err();
    assert!(matches!(error, Error::Redirect { .. }), "{error:?}");
}

#[tokio::test]
async fn binary_responses_preserve_exact_bytes() {
    let server = MockServer::start().await;
    let body = vec![0u8, 1, 2, 254, 255];
    Mock::given(method("GET"))
        .and(path("/v1/bytes"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
        .mount(&server)
        .await;

    let response = client(&server)
        .send_bytes(Request::get("/v1/bytes"))
        .await
        .unwrap();
    assert_eq!(response.body.as_ref(), body.as_slice());
}

#[tokio::test]
async fn binary_limit_overflow_is_explicit() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/bytes"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; 100]))
        .mount(&server)
        .await;

    let client = Client::builder(server.uri())
        .max_binary_bytes(4)
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap();
    let error = client
        .send_bytes(Request::get("/v1/bytes"))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::BodyTooLarge { .. }), "{error:?}");
}

#[tokio::test]
async fn json_limit_overflow_is_explicit() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/large"))
        .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(100)))
        .mount(&server)
        .await;

    let client = Client::builder(server.uri())
        .max_json_bytes(4)
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap();
    let error = client.get("/v1/large").await.unwrap_err();
    assert!(matches!(error, Error::BodyTooLarge { .. }), "{error:?}");
}

#[tokio::test]
async fn timeout_covers_slow_response_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/slow"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"ok": true}))
                .set_delay(Duration::from_millis(300)),
        )
        .mount(&server)
        .await;

    let client = Client::builder(server.uri())
        .timeout(Duration::from_millis(40))
        .max_attempts(1)
        .build()
        .unwrap();
    let started = std::time::Instant::now();
    let error = client.get("/v1/slow").await.unwrap_err();
    assert!(matches!(error, Error::Timeout { .. }), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn truncated_body_is_reported() {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort",
            );
            let _ = stream.flush();
        }
    });

    let client = Client::builder(format!("http://{address}"))
        .max_attempts(1)
        .retry_base(Duration::from_millis(1))
        .build()
        .unwrap();
    let error = client
        .send_bytes(Request::get("/v1/bytes"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, Error::Network { .. } | Error::Timeout { .. }),
        "{error:?}"
    );
}
