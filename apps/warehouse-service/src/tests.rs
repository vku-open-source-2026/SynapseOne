// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! End-to-end API tests. Every test owns its own in-memory databases or its
//! own temporary DuckDB directory.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State as AxumState;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::api::{build_app, AppState, Config};
use crate::store::{StoreOptions, WarehouseStore};
use crate::stream::StreamRuntime;

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("synapse-wh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn app_with(
    data_dir: Option<PathBuf>,
    secret: &str,
    max_body_bytes: usize,
    stream_url: &str,
) -> Router {
    let store = WarehouseStore::new(match data_dir {
        Some(path) => StoreOptions::file(path),
        None => StoreOptions::memory(),
    });
    let config = Config {
        port: 0,
        is_prod: false,
        internal_secret: secret.into(),
        max_body_bytes,
    };
    let stream = StreamRuntime::new(store.clone(), stream_url.into(), secret.into());
    build_app(AppState {
        store,
        config,
        stream,
    })
}

fn memory_app() -> Router {
    app_with(None, "", 8 * 1024 * 1024, "http://127.0.0.1:9")
}

async fn raw_call(
    app: &Router,
    method: &str,
    uri: &str,
    body: &[u8],
    org: &str,
    secret: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-synapseone-user", "manager-1")
        .header("x-synapseone-org", org)
        .header("x-synapseone-kind", "user");
    if let Some(secret) = secret {
        builder = builder.header("x-synapseone-internal", secret);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_vec())).unwrap())
        .await
        .expect("router response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body")
        .to_vec();
    (status, headers, bytes)
}

async fn call_as(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    org: &str,
    secret: Option<&str>,
) -> (StatusCode, Value) {
    let payload = body
        .map(|value| serde_json::to_vec(&value).unwrap())
        .unwrap_or_default();
    let (status, _, bytes) = raw_call(app, method, uri, &payload, org, secret).await;
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    call_as(app, method, uri, body, "tenant-a", None).await
}

async fn call_text(app: &Router, uri: &str) -> (StatusCode, String) {
    let (status, _, bytes) = raw_call(app, "GET", uri, b"", "tenant-a", None).await;
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn incidents() -> Value {
    json!({
        "id": "city_incidents",
        "name": "City incidents",
        "columns": [
            {"name": "ts", "type": "timestamp"},
            {"name": "city", "type": "string"},
            {"name": "category", "type": "string"},
            {"name": "severity", "type": "number"}
        ]
    })
}

fn incident_rows() -> Value {
    json!({
        "rows": [
            {"ts": "2026-11-10T08:00:00Z", "city": "Hanoi", "category": "traffic", "severity": 2},
            {"ts": "2026-11-10T09:00:00Z", "city": "Hanoi", "category": "flood", "severity": 4},
            {"ts": "2026-11-11T10:00:00Z", "city": "Da Nang", "category": "flood", "severity": 3}
        ]
    })
}

async fn create_incidents(app: &Router) {
    let (status, _) = call(app, "POST", "/v1/warehouse/datasets", Some(incidents())).await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn health_and_ready_are_public() {
    let app = memory_app();
    let (status, body) = call(&app, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "warehouse");
    assert_eq!(body["engine"], "duckdb");
    assert_eq!(body["version"], "0.9.0");
    assert!(body["time"].as_str().unwrap().ends_with('Z'));

    let (status, body) = call(&app, "GET", "/ready", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "warehouse");
}

#[tokio::test]
async fn response_headers_include_request_id_and_security_defaults() {
    let app = memory_app();
    let (status, headers, _) = raw_call(&app, "GET", "/health", b"", "tenant-a", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        headers
            .get("x-frame-options")
            .and_then(|value| value.to_str().ok()),
        Some("DENY")
    );
    assert_eq!(
        headers
            .get("referrer-policy")
            .and_then(|value| value.to_str().ok()),
        Some("no-referrer")
    );
    assert!(headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.len() >= 8));
}

#[tokio::test]
async fn cors_reflects_the_request_origin() {
    let app = memory_app();
    let request = Request::builder()
        .method("OPTIONS")
        .uri("/v1/warehouse/datasets")
        .header("origin", "https://console.example")
        .header("access-control-request-method", "GET")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert!(response.status().is_success());
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("https://console.example")
    );
}

#[tokio::test]
async fn dataset_lifecycle_and_rows() {
    let app = memory_app();
    let (status, created) = call(&app, "POST", "/v1/warehouse/datasets", Some(incidents())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["id"], "city_incidents");
    assert_eq!(created["columns"].as_array().unwrap().len(), 4);
    assert_eq!(created["mode"], "batch");
    assert_eq!(created["rowCount"], 0);

    let (status, duplicate) = call(&app, "POST", "/v1/warehouse/datasets", Some(incidents())).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(duplicate["error"], "dataset_exists");

    let (status, fetched) = call(&app, "GET", "/v1/warehouse/datasets/city_incidents", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["id"], "city_incidents");

    let (status, inserted) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(incident_rows()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(inserted["inserted"], 3);

    let (status, fetched) = call(&app, "GET", "/v1/warehouse/datasets/city_incidents", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["rowCount"], 3);

    let (status, listed) = call(&app, "GET", "/v1/warehouse/datasets", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["rowCount"], 3);

    let (status, deleted) = call(
        &app,
        "DELETE",
        "/v1/warehouse/datasets/city_incidents",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["deleted"], true);

    let (status, missing) = call(&app, "GET", "/v1/warehouse/datasets/city_incidents", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"], "dataset_not_found");

    let (_, listed) = call(&app, "GET", "/v1/warehouse/datasets", None).await;
    assert!(listed["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn rows_ingest_validates_shapes_and_numbers() {
    let app = memory_app();
    create_incidents(&app).await;

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_rows");

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(json!({"rows": [1]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_rows");

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(json!({"rows": [{"severity": "not-a-number"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_rows");

    // Express also accepted a top-level array body.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(json!([{
            "ts": "2026-11-10T08:00:00Z",
            "city": "Hue",
            "category": "flood",
            "severity": 1
        }])),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["inserted"], 1);
}

#[tokio::test]
async fn sql_allowlist_accepts_read_only_and_rejects_unsafe_sql() {
    let app = memory_app();
    create_incidents(&app).await;

    for sql in [
        "DROP TABLE city_incidents",
        "DELETE FROM city_incidents",
        "SELECT * FROM read_csv('/etc/passwd')",
        "SELECT 1; DELETE FROM city_incidents",
        "-- comment\nSELECT 1",
        "/* block */ SELECT 1",
        "SELECT * FROM _usage_hourly",
        "SELECT * FROM _datasets",
        "SELECT * FROM query_table('_usage_hourly')",
        "SELECT * FROM query('SELECT * FROM _datasets')",
        "SELECT * FROM sniff_csv('/etc/passwd')",
        "ATTACH 'x.db'",
    ] {
        let (status, body) = call(
            &app,
            "POST",
            "/v1/warehouse/query",
            Some(json!({"sql": sql})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{sql}");
        assert_eq!(body["error"], "invalid_sql", "{sql}");
    }

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT 'delete' AS word, 1 AS n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rows"][0]["word"], "delete");

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT ';' AS s"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rows"][0]["s"], ";");
}

#[tokio::test]
async fn query_result_shape_and_limit() {
    let app = memory_app();
    create_incidents(&app).await;
    call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(incident_rows()),
    )
    .await;

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({
            "sql": "SELECT city, count(*) AS incidents, avg(severity) AS avg_severity FROM city_incidents GROUP BY city ORDER BY incidents DESC"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["columns"],
        json!(["city", "incidents", "avg_severity"])
    );
    assert_eq!(body["types"].as_array().unwrap().len(), 3);
    assert_eq!(body["rowCount"], 2);
    assert_eq!(body["truncated"], false);
    assert!(body["durationMs"].as_u64().is_some());
    assert_eq!(body["rows"][0]["city"], "Hanoi");
    assert_eq!(body["rows"][0]["incidents"], 2);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT * FROM city_incidents ORDER BY city", "limit": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["rowCount"], 1);
    assert_eq!(body["truncated"], true);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT * FROM does_not_exist"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "query_failed");
}

#[tokio::test]
async fn tenant_isolation_is_org_first() {
    let app = memory_app();
    call_as(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(incidents()),
        "tenant-a",
        None,
    )
    .await;
    let mut other = incidents();
    other["id"] = json!("other_data");
    let (status, _) = call_as(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(other),
        "tenant-b",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (_, listed) = call_as(
        &app,
        "GET",
        "/v1/warehouse/datasets",
        None,
        "tenant-b",
        None,
    )
    .await;
    let ids = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["other_data"]);

    let (status, body) = call_as(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT * FROM city_incidents"})),
        "tenant-b",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "query_failed");

    let (status, _) = call_as(
        &app,
        "DELETE",
        "/v1/warehouse/datasets/city_incidents",
        None,
        "tenant-b",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn templates_and_job_lifecycle() {
    let app = memory_app();
    let (status, templates) = call(&app, "GET", "/v1/warehouse/templates", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = templates["items"].as_array().unwrap();
    assert_eq!(items.len(), 5);
    let modes = items
        .iter()
        .map(|item| item["mode"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(modes.contains(&"batch"));
    assert!(modes.contains(&"stream"));

    let (status, _) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(json!({
            "id": "sensor_readings",
            "name": "Sensor readings",
            "mode": "stream",
            "streamTopic": "iot-sensors",
            "columns": [
                {"name": "ts", "type": "timestamp"},
                {"name": "device_id", "type": "string"},
                {"name": "value", "type": "number"}
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, job) = call(
        &app,
        "POST",
        "/v1/warehouse/jobs",
        Some(json!({
            "name": "Batch ingest",
            "mode": "batch",
            "targetDatasetId": "sensor_readings",
            "sql": "SELECT * FROM sensor_readings"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(job["mode"], "batch");
    assert_eq!(job["status"], "running");
    let job_id = job["id"].as_str().unwrap().to_string();

    let (status, fetched) = call(&app, "GET", &format!("/v1/warehouse/jobs/{job_id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fetched["id"], job_id);

    let (status, run) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/run"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run["ok"], true);
    assert_eq!(run["rows"], 0);

    let (status, paused) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/pause"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paused["status"], "paused");

    let (status, resumed) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/resume"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resumed["status"], "running");

    let (status, stream_job) = call(
        &app,
        "POST",
        "/v1/warehouse/jobs",
        Some(json!({
            "name": "Sensor ingest",
            "mode": "stream",
            "targetDatasetId": "sensor_readings",
            "streamTopic": "iot-sensors",
            "batchSize": 10,
            "intervalMs": 100
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(stream_job["mode"], "stream");
    let stream_job_id = stream_job["id"].as_str().unwrap().to_string();
    let (status, paused) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{stream_job_id}/pause"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(paused["status"], "paused");

    let (status, deleted) = call(
        &app,
        "DELETE",
        &format!("/v1/warehouse/jobs/{stream_job_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["deleted"], true);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/jobs",
        Some(json!({"mode": "nope", "targetDatasetId": "sensor_readings"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_mode");
}

#[tokio::test]
async fn batch_etl_replaces_schema_and_appends() {
    let app = memory_app();
    create_incidents(&app).await;
    call(
        &app,
        "POST",
        "/v1/warehouse/datasets/city_incidents/rows",
        Some(incident_rows()),
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(json!({
            "id": "city_daily",
            "name": "City daily",
            "columns": [{"name": "placeholder", "type": "string"}]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, job) = call(
        &app,
        "POST",
        "/v1/warehouse/jobs",
        Some(json!({
            "name": "Daily incident rollup",
            "mode": "batch",
            "targetDatasetId": "city_daily",
            "writeMode": "replace",
            "sql": "SELECT date_trunc('day', ts) AS day, category, count(*) AS events FROM city_incidents GROUP BY 1, 2 ORDER BY 1"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let job_id = job["id"].as_str().unwrap();
    let (status, run) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/run"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(run["rows"], 3);

    let (status, target) = call(&app, "GET", "/v1/warehouse/datasets/city_daily", None).await;
    assert_eq!(status, StatusCode::OK);
    let column_names = target["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|column| column["name"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(column_names, vec!["day", "category", "events"]);

    let (status, created) = call(
        &app,
        "POST",
        "/v1/warehouse/etl/batch",
        Some(json!({
            "name": "Adhoc rollup",
            "targetDatasetId": "city_daily",
            "writeMode": "replace",
            "sql": "SELECT category, count(*) AS events FROM city_incidents GROUP BY category"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["ok"], true);
    let first_rows = created["rows"].as_i64().unwrap();
    assert!(first_rows >= 2);

    let (status, appended) = call(
        &app,
        "POST",
        "/v1/warehouse/etl/batch",
        Some(json!({
            "targetDatasetId": "city_daily",
            "writeMode": "append",
            "sql": "SELECT category, count(*) AS events FROM city_incidents GROUP BY category"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert!(appended["rows"].as_i64().unwrap() >= first_rows * 2);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/etl/batch",
        Some(json!({
            "targetDatasetId": "missing_target",
            "sql": "SELECT 1"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "dataset_not_found");

    let (status, body) = call(
        &app,
        "POST",
        "/v1/warehouse/etl/batch",
        Some(json!({
            "targetDatasetId": "city_daily",
            "sql": "DROP TABLE city_daily"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_sql");
}

#[tokio::test]
async fn etl_stream_is_idempotent_by_name() {
    let app = memory_app();
    call(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(json!({
            "id": "sensor_readings",
            "name": "Sensor readings",
            "mode": "stream",
            "streamTopic": "iot-sensors",
            "columns": [{"name": "device_id", "type": "string"}]
        })),
    )
    .await;
    let body = json!({
        "name": "Sensor stream",
        "targetDatasetId": "sensor_readings",
        "streamTopic": "iot-sensors",
        "batchSize": 10,
        "intervalMs": 100
    });
    let (status, first) = call(&app, "POST", "/v1/warehouse/etl/stream", Some(body.clone())).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["created"], true);
    let job_id = first["job"]["id"].as_str().unwrap().to_string();

    let (status, second) = call(&app, "POST", "/v1/warehouse/etl/stream", Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["created"], false);
    assert_eq!(second["job"]["id"], job_id);

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/pause"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/warehouse/jobs/{job_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn internal_secret_gate_and_production_fail_closed() {
    let app = app_with(None, "top-secret", 8 * 1024 * 1024, "http://127.0.0.1:9");
    let (status, body) = call(&app, "GET", "/v1/warehouse/datasets", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");

    let (status, body) = call_as(
        &app,
        "GET",
        "/v1/warehouse/datasets",
        None,
        "tenant-a",
        Some("wrong"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");

    let (status, _) = call_as(
        &app,
        "GET",
        "/v1/warehouse/datasets",
        None,
        "tenant-a",
        Some("top-secret"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = call(&app, "GET", "/internal/usage/watermark", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");

    let (status, body) = call_as(
        &app,
        "GET",
        "/internal/usage/watermark",
        None,
        "tenant-a",
        Some("top-secret"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    assert!(body["coveredUntil"].is_null());

    // Health stays public even when the API is guarded.
    let (status, _) = call(&app, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);

    // Production without the shared secret returns the TS misconfigured 500.
    let prod = build_app(AppState {
        store: WarehouseStore::new(StoreOptions::memory()),
        config: Config {
            port: 0,
            is_prod: true,
            internal_secret: String::new(),
            max_body_bytes: 1024,
        },
        stream: StreamRuntime::new(
            WarehouseStore::new(StoreOptions::memory()),
            "http://127.0.0.1:9".into(),
            String::new(),
        ),
    });
    let (status, body) = call(&prod, "GET", "/v1/warehouse/datasets", None).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"], "misconfigured");
    let (status, _) = call(&prod, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn body_limit_and_invalid_json_envelopes() {
    let app = app_with(None, "", 256, "http://127.0.0.1:9");
    let huge = json!({
        "name": "Too large",
        "description": "x".repeat(1000),
        "columns": [{"name": "id", "type": "string"}]
    });
    let (status, body) = call(&app, "POST", "/v1/warehouse/datasets", Some(huge)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "payload_too_large");

    let (status, _, bytes) = raw_call(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        b"{not-json",
        "tenant-a",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"], "invalid_json");
}

#[tokio::test]
async fn internal_usage_rollups_are_idempotent_and_tenant_scoped() {
    let app = memory_app();
    let rollup = json!({
        "from": "2026-11-12T10:00:00.000Z",
        "to": "2026-11-12T12:00:00.000Z",
        "hourly": [
            {
                "bucket": "2026-11-12T10:00:00.000Z", "feature": "warehouse", "route": "/v1/warehouse", "method": "GET",
                "statusClass": 2, "authKind": "user", "accountId": "acc-1", "model": null,
                "requests": 8, "success": 8, "clientErrors": 0, "serverErrors": 0,
                "durationSum": 80, "durationMax": 20, "latency": [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "lastRequestAt": "2026-11-12T10:55:00.000Z"
            },
            {
                "bucket": "2026-11-12T11:00:00.000Z", "feature": "base", "route": "/v1/base", "method": "POST",
                "statusClass": 5, "authKind": "apikey", "accountId": "acc-2", "model": null,
                "requests": 2, "success": 0, "clientErrors": 0, "serverErrors": 2,
                "durationSum": 400, "durationMax": 200, "latency": [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0],
                "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "lastRequestAt": "2026-11-12T11:10:00.000Z"
            }
        ],
        "users": [
            {
                "bucket": "2026-11-12T10:00:00.000Z", "feature": "warehouse", "method": "GET", "statusClass": 2,
                "accountId": "acc-1", "userId": "u-1", "requests": 5,
                "firstSeen": "2026-11-12T10:01:00.000Z", "lastSeen": "2026-11-12T10:50:00.000Z"
            },
            {
                "bucket": "2026-11-12T10:00:00.000Z", "feature": "warehouse", "method": "GET", "statusClass": 2,
                "accountId": "acc-1", "userId": "u-2", "requests": 3,
                "firstSeen": "2026-11-12T10:02:00.000Z", "lastSeen": "2026-11-12T10:52:00.000Z"
            }
        ]
    });
    let (status, wrapped) = call(&app, "POST", "/internal/usage/rollup", Some(rollup)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(wrapped["ok"], true);
    assert_eq!(wrapped["hourly"], 2);
    assert_eq!(wrapped["users"], 2);

    let (status, summary) = call(
        &app,
        "POST",
        "/internal/usage/summary",
        Some(json!({
            "from": "2026-11-12T10:00:00.000Z",
            "to": "2026-11-12T12:00:00.000Z"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["totals"]["requests"], 10);
    assert_eq!(summary["totals"]["success"], 8);
    assert_eq!(summary["totals"]["serverErrors"], 2);
    assert_eq!(summary["totals"]["userIds"].as_array().unwrap().len(), 2);
    assert_eq!(summary["totals"]["accountIds"].as_array().unwrap().len(), 2);
    assert_eq!(summary["coverageEnd"], "2026-11-12T12:00:00.000Z");
    assert_eq!(summary["minBucket"], "2026-11-12T10:00:00.000Z");
    assert_eq!(summary["features"].as_array().unwrap().len(), 2);
    assert_eq!(summary["series"].as_array().unwrap().len(), 2);
    assert_eq!(summary["statusClasses"].as_array().unwrap().len(), 2);

    let (status, watermark) = call(&app, "GET", "/internal/usage/watermark", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(watermark["coveredUntil"], "2026-11-12T12:00:00.000Z");

    let (status, _) = call(
        &app,
        "POST",
        "/internal/usage/rollup",
        Some(json!({
            "from": "2026-11-12T10:00:00.000Z",
            "to": "2026-11-12T11:00:00.000Z",
            "hourly": [{
                "bucket": "2026-11-12T10:00:00.000Z", "feature": "warehouse", "route": "/v1/warehouse", "method": "GET",
                "statusClass": 2, "authKind": "user", "accountId": "acc-1", "model": null,
                "requests": 3, "success": 3, "clientErrors": 0, "serverErrors": 0,
                "durationSum": 9, "durationMax": 3, "latency": [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "lastRequestAt": "2026-11-12T10:30:00.000Z"
            }],
            "users": []
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (_, after) = call(
        &app,
        "POST",
        "/internal/usage/summary",
        Some(json!({
            "from": "2026-11-12T10:00:00.000Z",
            "to": "2026-11-12T12:00:00.000Z"
        })),
    )
    .await;
    assert_eq!(after["totals"]["requests"], 5);
    assert_eq!(after["totals"]["userIds"].as_array().unwrap().len(), 0);

    // Empty completed hours still advance coverage.
    let (status, _) = call(
        &app,
        "POST",
        "/internal/usage/rollup",
        Some(json!({
            "from": "2026-11-12T12:00:00.000Z",
            "to": "2026-11-12T13:00:00.000Z",
            "hourly": [],
            "users": []
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, advanced) = call(&app, "GET", "/internal/usage/watermark", None).await;
    assert_eq!(advanced["coveredUntil"], "2026-11-12T13:00:00.000Z");

    // Tenant isolation: another tenant sees no rollups.
    let (status, other) = call_as(
        &app,
        "POST",
        "/internal/usage/summary",
        Some(json!({
            "from": "2026-11-12T10:00:00.000Z",
            "to": "2026-11-12T12:00:00.000Z"
        })),
        "tenant-b",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(other["totals"]["requests"], 0);
    assert!(other["coverageEnd"].is_null());
}

#[tokio::test]
async fn stream_materialization_deduplicates_across_restart() {
    let dir = TempDir::new();
    let store = WarehouseStore::new(StoreOptions::file(dir.0.clone()));
    let dataset = store
        .create_dataset(
            "org:exact-a",
            crate::types::NewDataset {
                id: "exact_events".into(),
                name: "Exact events".into(),
                description: String::new(),
                columns: vec![
                    crate::types::WarehouseColumn {
                        name: "event_id".into(),
                        column_type: "string".into(),
                    },
                    crate::types::WarehouseColumn {
                        name: "value".into(),
                        column_type: "number".into(),
                    },
                ],
                mode: "batch".into(),
                stream_topic: None,
            },
        )
        .await
        .unwrap();

    let event = |index: i64| crate::types::StreamEventRows {
        event_id: format!("evt-{index}"),
        rows: vec![json!({"event_id": format!("evt-{index}"), "value": index})],
    };
    for index in 1..=25 {
        let (inserted, duplicates) = store
            .ingest_stream_events("org:exact-a", &dataset, "job", vec![event(index)])
            .await
            .unwrap();
        assert_eq!((inserted, duplicates), (1, 0));
    }

    // Simulate a process restart: drop the handles and reopen the same file.
    store.reset().await;
    let reopened = store
        .get_dataset("org:exact-a", "exact_events")
        .await
        .unwrap()
        .unwrap();
    for index in 1..=50 {
        store
            .ingest_stream_events("org:exact-a", &reopened, "job", vec![event(index)])
            .await
            .unwrap();
    }
    let count = store
        .query(
            "org:exact-a",
            Some(&json!(
                "SELECT count(*) AS n, sum(value) AS total FROM exact_events"
            )),
            200,
        )
        .await
        .unwrap();
    assert_eq!(count.rows[0]["n"], 50);
    assert_eq!(count.rows[0]["total"], 1275);

    // Same dataset id in another tenant's file is empty.
    store
        .create_dataset(
            "org:exact-b",
            crate::types::NewDataset {
                id: "exact_events".into(),
                name: "Other".into(),
                description: String::new(),
                columns: vec![crate::types::WarehouseColumn {
                    name: "event_id".into(),
                    column_type: "string".into(),
                }],
                mode: "batch".into(),
                stream_topic: None,
            },
        )
        .await
        .unwrap();
    let other = store
        .query(
            "org:exact-b",
            Some(&json!("SELECT count(*) AS n FROM exact_events")),
            200,
        )
        .await
        .unwrap();
    assert_eq!(other.rows[0]["n"], 0);

    // One file per tenant plus the tenant index.
    let files = std::fs::read_dir(&dir.0)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        files
            .iter()
            .filter(|name| name.ends_with(".duckdb"))
            .count(),
        2
    );
    assert!(files.iter().any(|name| name == "tenants.json"));
    store.reset().await;
}

#[derive(Clone)]
struct FakeStream {
    reads: Arc<AtomicUsize>,
    acks: Arc<AtomicUsize>,
}

async fn fake_create() -> (StatusCode, Json<Value>) {
    (StatusCode::CREATED, Json(json!({"ok": true})))
}

async fn fake_read(AxumState(fake): AxumState<FakeStream>) -> Json<Value> {
    let read = fake.reads.fetch_add(1, Ordering::SeqCst);
    if read == 0 {
        Json(json!({
            "events": [{
                "id": "1-0",
                "payload": {
                    "ts": "2026-11-11T10:00:00Z",
                    "device_id": "sensor-01",
                    "value": 24.5
                }
            }],
            "count": 1
        }))
    } else {
        Json(json!({"events": [], "count": 0}))
    }
}

async fn fake_ack(AxumState(fake): AxumState<FakeStream>, Json(body): Json<Value>) -> Json<Value> {
    let ids = body
        .get("ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(ids, vec![json!("1-0")]);
    fake.acks.fetch_add(1, Ordering::SeqCst);
    Json(json!({"acked": ids.len()}))
}

#[tokio::test]
async fn stream_etl_reads_ingests_and_acks() {
    let fake = FakeStream {
        reads: Arc::new(AtomicUsize::new(0)),
        acks: Arc::new(AtomicUsize::new(0)),
    };
    let fake_app = Router::new()
        .route("/v1/stream/topics/{topic}", put(fake_create))
        .route("/v1/stream/topics/{topic}/groups/{group}", put(fake_create))
        .route(
            "/v1/stream/topics/{topic}/groups/{group}/read",
            post(fake_read),
        )
        .route(
            "/v1/stream/topics/{topic}/groups/{group}/ack",
            post(fake_ack),
        )
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, fake_app).await;
    });

    let app = app_with(
        None,
        "",
        8 * 1024 * 1024,
        &format!("http://127.0.0.1:{}", address.port()),
    );
    let (status, _) = call(
        &app,
        "POST",
        "/v1/warehouse/datasets",
        Some(json!({
            "id": "sensor_readings",
            "name": "Sensor readings",
            "mode": "stream",
            "streamTopic": "iot-sensors",
            "columns": [
                {"name": "ts", "type": "timestamp"},
                {"name": "device_id", "type": "string"},
                {"name": "value", "type": "number"}
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, job) = call(
        &app,
        "POST",
        "/v1/warehouse/jobs",
        Some(json!({
            "name": "Sensor ingest",
            "mode": "stream",
            "targetDatasetId": "sensor_readings",
            "streamTopic": "iot-sensors",
            "batchSize": 10,
            "intervalMs": 100
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let job_id = job["id"].as_str().unwrap().to_string();

    let mut row_count = 0;
    for _ in 0..200 {
        let (_, dataset) = call(&app, "GET", "/v1/warehouse/datasets/sensor_readings", None).await;
        row_count = dataset["rowCount"].as_i64().unwrap_or(0);
        if row_count >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(row_count, 1);
    assert!(fake.acks.load(Ordering::SeqCst) >= 1);

    let (status, query) = call(
        &app,
        "POST",
        "/v1/warehouse/query",
        Some(json!({"sql": "SELECT device_id, value FROM sensor_readings"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(query["rows"][0]["device_id"], "sensor-01");
    assert_eq!(query["rows"][0]["value"], 24.5);

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/warehouse/jobs/{job_id}/pause"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/warehouse/jobs/{job_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    server.abort();
}

#[tokio::test]
async fn metrics_and_pipeline_status_report_tenant_counts() {
    let app = memory_app();
    create_incidents(&app).await;
    let (status, pipeline) = call(&app, "GET", "/v1/warehouse/pipeline/status", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pipeline["ok"], true);
    assert_eq!(pipeline["datasets"], 1);
    assert_eq!(pipeline["jobs"], 0);

    let (status, text) = call_text(&app, "/metrics").await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.contains("synapseone_warehouse_up 1"));
    assert!(text.contains("synapseone_warehouse_datasets 1"));
    assert!(text.contains("synapseone_warehouse_jobs 0"));
    assert!(text.ends_with('\n'));
}

#[tokio::test]
async fn mutations_emit_audit_events() {
    if !crate::audit::audit_enabled() {
        return;
    }
    let app = memory_app();
    crate::audit::clear();
    create_incidents(&app).await;
    let events = crate::audit::events();
    let event = events
        .iter()
        .find(|event| {
            event.action == "warehouse:datasets:create"
                && event.org_id.as_deref() == Some("tenant-a")
        })
        .expect("audit event");
    assert_eq!(event.actor_type, "user");
    assert_eq!(event.actor_id, "manager-1");
    assert_eq!(event.result, "allowed");
    assert_eq!(event.status_code, 201);
    assert!(!event.request_id.is_empty());
}
