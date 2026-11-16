// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Faststore API tests: boot the real axum router on the in-memory backend and
//! cover keys/TTL/NX, counters, batch, scans, hashes, lists, sets, sorted sets,
//! locks, tenancy, validation, the internal-secret gate, audit and security
//! headers.

use axum::body::Body;
use axum::http::{HeaderMap, Request as HttpRequest, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;

const USER_HEADERS: [(&str, &str); 4] = [
    ("content-type", "application/json"),
    ("x-synapseone-user", "user-1"),
    ("x-synapseone-org", "tenant-a"),
    ("x-synapseone-kind", "user"),
];

fn test_state() -> AppState {
    AppState {
        store: Store::Memory(MemoryStore::new()),
        config: Config {
            port: 0,
            is_prod: false,
            internal_secret: String::new(),
            cors_origins: Vec::new(),
        },
    }
}

fn state_with_secret(secret: &str) -> AppState {
    let mut state = test_state();
    state.config.internal_secret = secret.to_string();
    state
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = HttpRequest::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let payload = body
        .map(|value| serde_json::to_vec(&value).expect("json body"))
        .unwrap_or_default();
    let request = builder.body(Body::from(payload)).expect("request");
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body")
        .to_vec();
    (status, headers, bytes)
}

fn parse_body(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()))
    }
}

async fn send(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let (status, _, bytes) = call(app, method, uri, body, &USER_HEADERS).await;
    (status, parse_body(&bytes))
}

async fn send_with(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let (status, _, bytes) = call(app, method, uri, body, headers).await;
    (status, parse_body(&bytes))
}

#[tokio::test]
async fn health_and_metrics_are_served() {
    let app = build_app(test_state());

    let (status, body) = send(&app, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "faststore");
    assert_eq!(body["backend"], "memory");
    assert_eq!(body["version"], "0.7.1");

    let (status, _, bytes) = call(&app, "GET", "/metrics", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("synapseone_faststore_up 1"), "{text}");
    assert!(
        text.contains("synapseone_faststore_backend_info{backend=\"memory\"} 1"),
        "{text}"
    );
    assert!(
        text.contains("synapseone_faststore_http_requests_total"),
        "{text}"
    );
}

#[tokio::test]
async fn key_value_crud_ttl_nx_xx_and_tenant_isolation() {
    let app = build_app(test_state());

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/session:1",
        Some(json!({"value": {"user": "a"}, "ttlSeconds": 60})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["created"], true);
    assert_eq!(body["ok"], true);

    let (status, body) = send(&app, "GET", "/v1/faststore/keys/session:1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["type"], "string");
    assert_eq!(body["value"], json!({"user": "a"}));
    assert!(body["ttlSeconds"].as_i64().unwrap() > 0);

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/session:1",
        Some(json!({"value": [1, 2]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["created"], false);
    let (_, body) = send(&app, "GET", "/v1/faststore/keys/session:1", None).await;
    assert_eq!(body["value"], json!([1, 2]));

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/session:1",
        Some(json!({"value": 1, "ifNotExists": true})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "key_exists");

    let (status, _) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/nope",
        Some(json!({"value": 1, "ifExists": true})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/session:1",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-2"),
            ("x-synapseone-org", "tenant-b"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(&app, "DELETE", "/v1/faststore/keys/session:1", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], true);
    let (status, _) = send(&app, "GET", "/v1/faststore/keys/session:1", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/bad",
        Some(json!({"value": 1, "ttlSeconds": -1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_ttl");

    // Legacy x-synapsedx-* aliases resolve the same tenant.
    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/legacy",
        Some(json!({"value": "ok"})),
        &[
            ("content-type", "application/json"),
            ("x-synapsedx-user", "user-1"),
            ("x-synapsedx-org", "tenant-a"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn string_ttl_expiry() {
    let app = build_app(test_state());
    let (status, _) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/short",
        Some(json!({"value": "x", "ttlSeconds": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = send(&app, "GET", "/v1/faststore/keys/short/ttl", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["ttlSeconds"].as_i64().unwrap() >= 0);

    tokio::time::sleep(std::time::Duration::from_millis(1150)).await;
    let (status, _) = send(&app, "GET", "/v1/faststore/keys/short", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn counters_expiry_and_type_safety() {
    let app = build_app(test_state());

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/hits/incr",
        Some(json!({"by": 3})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], 3);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/hits/incr",
        Some(json!({"by": 2})),
    )
    .await;
    assert_eq!(body["value"], 5);

    let (status, _) = send(
        &app,
        "POST",
        "/v1/faststore/keys/hits/expire",
        Some(json!({"ttlSeconds": 60})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, body) = send(&app, "GET", "/v1/faststore/keys/hits/ttl", None).await;
    assert!(body["ttlSeconds"].as_i64().unwrap() > 0);

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/hits/expire",
        Some(json!({"ttlSeconds": 0})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ttlSeconds"], 0);
    let (_, body) = send(&app, "GET", "/v1/faststore/keys/hits/ttl", None).await;
    assert_eq!(body["ttlSeconds"], -1);

    send(
        &app,
        "PUT",
        "/v1/faststore/keys/text",
        Some(json!({"value": "abc"})),
    )
    .await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/text/incr",
        Some(json!({"by": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "not_a_number");

    send(
        &app,
        "PUT",
        "/v1/faststore/hashes/h",
        Some(json!({"values": {"a": 1}})),
    )
    .await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/h/incr",
        Some(json!({"by": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "wrong_type");
}

#[tokio::test]
async fn batch_operations_and_key_scanning() {
    let app = build_app(test_state());

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/batch",
        Some(json!({"operations": [
            {"op": "set", "key": "n:a", "value": 1},
            {"op": "set", "key": "n:b", "value": 2},
            {"op": "get", "key": "n:a"},
            {"op": "incr", "key": "n:a", "by": 4},
            {"op": "delete", "key": "n:b"},
            {"op": "wat", "key": "n:c"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let results = body["results"].as_array().unwrap();
    assert_eq!(results.len(), 6);
    assert_eq!(results[0]["ok"], true);
    assert_eq!(results[2]["value"], 1);
    assert_eq!(results[3]["value"], 5);
    assert_eq!(results[4]["deleted"], true);
    assert_eq!(results[5]["ok"], false);
    assert_eq!(results[5]["error"], "unsupported_op");
    assert_eq!(body["ok"], false);

    for index in 1..=5 {
        send(
            &app,
            "PUT",
            &format!("/v1/faststore/keys/x:{index}"),
            Some(json!({"value": index})),
        )
        .await;
    }
    let (status, page1) = send(&app, "GET", "/v1/faststore/keys?prefix=x:&limit=2", None).await;
    assert_eq!(status, StatusCode::OK);
    let keys: Vec<&str> = page1["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["x:1", "x:2"]);
    let cursor = page1["cursor"].as_str().unwrap().to_string();

    let (_, page2) = send(
        &app,
        "GET",
        &format!("/v1/faststore/keys?prefix=x:&limit=2&cursor={cursor}"),
        None,
    )
    .await;
    let keys: Vec<&str> = page2["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["x:3", "x:4"]);
    let cursor = page2["cursor"].as_str().unwrap().to_string();

    let (_, page3) = send(
        &app,
        "GET",
        &format!("/v1/faststore/keys?prefix=x:&limit=2&cursor={cursor}"),
        None,
    )
    .await;
    let keys: Vec<&str> = page3["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["x:5"]);
    assert_eq!(page3["cursor"], Value::Null);

    let (status, stats) = send(&app, "GET", "/v1/faststore/stats", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stats["keys"], 6);
    assert_eq!(stats["byType"]["string"], 6);
    assert_eq!(stats["tenant"], "org:tenant-a");

    let (status, _) = send(
        &app,
        "POST",
        "/v1/faststore/batch",
        Some(json!({"operations": []})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn hashes_fields_counters_and_type_checks() {
    let app = build_app(test_state());

    let (status, _) = send(
        &app,
        "PUT",
        "/v1/faststore/hashes/users:1",
        Some(json!({"values": {"name": "Alice", "age": 30}})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = send(&app, "GET", "/v1/faststore/hashes/users:1/name", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], "Alice");

    let (_, body) = send(&app, "GET", "/v1/faststore/hashes/users:1", None).await;
    assert_eq!(body["values"], json!({"name": "Alice", "age": 30}));

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/hashes/users:1/incr",
        Some(json!({"field": "age", "by": 2})),
    )
    .await;
    assert_eq!(body["value"], 32);
    let (_, body) = send(&app, "GET", "/v1/faststore/hashes/users:1/age", None).await;
    assert_eq!(body["value"], 32);

    let (status, body) = send(&app, "DELETE", "/v1/faststore/hashes/users:1/name", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], true);
    let (status, _) = send(&app, "GET", "/v1/faststore/hashes/users:1/name", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send(
        &app,
        "PUT",
        "/v1/faststore/hashes/users:1",
        Some(json!({"values": {"x": 1}, "ifNotExists": true})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (_, body) = send(&app, "GET", "/v1/faststore/hashes/users:1/length", None).await;
    assert_eq!(body["length"], 1);

    send(
        &app,
        "PUT",
        "/v1/faststore/keys/plain",
        Some(json!({"value": "x"})),
    )
    .await;
    let (status, body) = send(&app, "GET", "/v1/faststore/hashes/plain", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "wrong_type");

    let (status, _) = send(
        &app,
        "PUT",
        "/v1/faststore/hashes/single:1/color",
        Some(json!({"value": "blue"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = send(&app, "GET", "/v1/faststore/hashes/single:1", None).await;
    assert_eq!(body["values"], json!({"color": "blue"}));
}

#[tokio::test]
async fn lists_push_range_pop_trim() {
    let app = build_app(test_state());

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/push",
        Some(json!({"values": [1, 2], "side": "right"})),
    )
    .await;
    assert_eq!(body["length"], 2);
    send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/push",
        Some(json!({"values": [0], "side": "left"})),
    )
    .await;

    let (_, body) = send(&app, "GET", "/v1/faststore/lists/queue", None).await;
    assert_eq!(body["values"], json!([0, 1, 2]));
    assert_eq!(body["length"], 3);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/pop",
        Some(json!({"side": "left", "count": 2})),
    )
    .await;
    assert_eq!(body["values"], json!([0, 1]));
    assert_eq!(body["length"], 1);

    send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/trim",
        Some(json!({"start": 0, "stop": 0})),
    )
    .await;
    let (_, body) = send(&app, "GET", "/v1/faststore/lists/queue", None).await;
    assert_eq!(body["values"], json!([2]));

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/pop",
        Some(json!({"side": "right"})),
    )
    .await;
    assert_eq!(body["values"], json!([2]));
    assert_eq!(body["length"], 0);
    let (_, body) = send(&app, "GET", "/v1/faststore/lists/queue", None).await;
    assert_eq!(body["values"], json!([]));

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/lists/queue/push",
        Some(json!({"values": [1], "side": "middle"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");
}

#[tokio::test]
async fn sets_add_contains_members_remove() {
    let app = build_app(test_state());

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/sets/tags/add",
        Some(json!({"members": ["a", "b", "a"]})),
    )
    .await;
    assert_eq!(body["added"], 2);
    assert_eq!(body["card"], 2);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/sets/tags/contains",
        Some(json!({"member": "a"})),
    )
    .await;
    assert_eq!(body["contains"], true);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/sets/tags/contains",
        Some(json!({"member": "c"})),
    )
    .await;
    assert_eq!(body["contains"], false);

    let (_, body) = send(&app, "GET", "/v1/faststore/sets/tags", None).await;
    assert_eq!(body["members"], json!(["a", "b"]));
    let (_, body) = send(&app, "GET", "/v1/faststore/sets/tags/card", None).await;
    assert_eq!(body["card"], 2);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/sets/tags/remove",
        Some(json!({"members": ["a", "z"]})),
    )
    .await;
    assert_eq!(body["removed"], 1);
    assert_eq!(body["card"], 1);
}

#[tokio::test]
async fn zsets_scores_ranges_ranks_increments() {
    let app = build_app(test_state());

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/add",
        Some(json!({"members": [
            {"member": "a", "score": 1},
            {"member": "b", "score": 2},
            {"member": "c", "score": 2}
        ]})),
    )
    .await;
    assert_eq!(body["added"], 3);

    let (_, body) = send(
        &app,
        "GET",
        "/v1/faststore/zsets/scores?withScores=true",
        None,
    )
    .await;
    let members: Vec<&str> = body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["member"].as_str().unwrap())
        .collect();
    assert_eq!(members, vec!["a", "b", "c"]);
    assert_eq!(body["members"][0]["score"], json!(1));
    assert_eq!(body["members"][1]["score"], json!(2));

    let (_, body) = send(
        &app,
        "GET",
        "/v1/faststore/zsets/scores?rev=true&withScores=true",
        None,
    )
    .await;
    let members: Vec<&str> = body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["member"].as_str().unwrap())
        .collect();
    assert_eq!(members, vec!["c", "b", "a"]);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/score",
        Some(json!({"member": "b"})),
    )
    .await;
    assert_eq!(body["score"], 2);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/rank",
        Some(json!({"member": "a"})),
    )
    .await;
    assert_eq!(body["rank"], 0);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/rank",
        Some(json!({"member": "a", "rev": true})),
    )
    .await;
    assert_eq!(body["rank"], 2);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/incr",
        Some(json!({"member": "a", "by": 5})),
    )
    .await;
    assert_eq!(body["score"], 6);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/rank",
        Some(json!({"member": "a"})),
    )
    .await;
    assert_eq!(body["rank"], 2);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/add",
        Some(json!({"members": [{"member": "b", "score": 5}]})),
    )
    .await;
    assert_eq!(body["added"], 0);
    assert_eq!(body["card"], 3);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/zsets/scores/remove",
        Some(json!({"members": ["b"]})),
    )
    .await;
    assert_eq!(body["removed"], 1);
    let (_, body) = send(&app, "GET", "/v1/faststore/zsets/scores/card", None).await;
    assert_eq!(body["card"], 2);
}

#[tokio::test]
async fn locks_acquire_release_extend_and_wait() {
    let app = build_app(test_state());

    let (_, first) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/acquire",
        Some(json!({"ttlSeconds": 30, "token": "t1"})),
    )
    .await;
    assert_eq!(first["acquired"], true);
    assert_eq!(first["lock"], "job");
    assert_eq!(first["token"], "t1");

    let (_, second) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/acquire",
        Some(json!({"ttlSeconds": 30, "token": "t2"})),
    )
    .await;
    assert_eq!(second["acquired"], false);
    assert_eq!(second["retryAfterMs"], 50);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/release",
        Some(json!({"token": "t2"})),
    )
    .await;
    assert_eq!(body["released"], false);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/extend",
        Some(json!({"token": "t2", "ttlSeconds": 30})),
    )
    .await;
    assert_eq!(body["extended"], false);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/extend",
        Some(json!({"token": "t1", "ttlSeconds": 60})),
    )
    .await;
    assert_eq!(body["extended"], true);
    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/release",
        Some(json!({"token": "t1"})),
    )
    .await;
    assert_eq!(body["released"], true);

    let (_, again) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/acquire",
        Some(json!({"ttlSeconds": 30, "token": "t2"})),
    )
    .await;
    assert_eq!(again["acquired"], true);

    let started = std::time::Instant::now();
    let (_, waited) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/acquire",
        Some(json!({"ttlSeconds": 30, "token": "t3", "waitMs": 120})),
    )
    .await;
    assert_eq!(waited["acquired"], false);
    assert!(started.elapsed().as_millis() >= 100);

    let (_, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/job/release",
        Some(json!({"token": "t2"})),
    )
    .await;
    assert_eq!(body["released"], true);
}

#[tokio::test]
async fn tenant_isolation_by_org_account_and_user() {
    let app = build_app(test_state());
    send(
        &app,
        "PUT",
        "/v1/faststore/keys/shared",
        Some(json!({"value": "org-a"})),
    )
    .await;

    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-9"),
            ("x-synapseone-org", "tenant-b"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Same org, different user still shares the org namespace.
    let (status, body) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-2"),
            ("x-synapseone-org", "tenant-a"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], "org-a");

    // Account scope is disjoint from the org scope.
    let account_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-user", "user-3"),
        ("x-synapseone-account", "acc-1"),
    ];
    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared",
        None,
        &account_headers,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // User scope is the fallback when no org/account is stamped.
    let user_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-user", "user-4"),
    ];
    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/private",
        Some(json!({"value": "u4"})),
        &user_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, body) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/private",
        None,
        &user_headers,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], "u4");
    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/private",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-5"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Platform callers pick an explicit tenant namespace.
    let platform_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-tenant", "admin"),
    ];
    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/shared",
        Some(json!({"value": "platform-value"})),
        &platform_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared",
        None,
        &platform_headers,
    )
    .await;
    assert_eq!(body["value"], "platform-value");
    let (_, stats) = send_with(&app, "GET", "/v1/faststore/stats", None, &platform_headers).await;
    assert_eq!(stats["tenant"], "tenant:admin");
}

#[tokio::test]
async fn api_key_headers_never_fall_back_to_platform() {
    let app = build_app(test_state());
    let platform_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-tenant", "admin"),
    ];
    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/shared",
        Some(json!({"value": "platform-value"})),
        &platform_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let key_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-kind", "apikey"),
        ("x-synapseone-account", "acc-9"),
    ];
    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared?tenant=admin",
        None,
        &key_headers,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/shared",
        Some(json!({"value": "key-value"})),
        &key_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, body) = send_with(&app, "GET", "/v1/faststore/keys/shared", None, &key_headers).await;
    assert_eq!(body["value"], "key-value");

    let (status, _) = send(&app, "GET", "/v1/faststore/keys/shared", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys/shared",
        None,
        &platform_headers,
    )
    .await;
    assert_eq!(body["value"], "platform-value");
}

#[tokio::test]
async fn authentication_and_validation() {
    let app = build_app(test_state());

    let (status, body) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys",
        None,
        &[("x-synapseone-anon", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "auth_required");

    let (status, body) = send_with(&app, "GET", "/v1/faststore/keys", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "tenant_required");

    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/keys",
        None,
        &[("x-synapseone-tenant", "admin")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(&app, "GET", "/v1/faststore/keys/absent", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(&app, "GET", "/v1/faststore/keys?cursor=nope", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_cursor");

    let (status, _) = send(
        &app,
        "POST",
        "/v1/faststore/batch",
        Some(json!({"operations": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn validation_errors_are_mapped() {
    let app = build_app(test_state());

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/batch",
        Some(json!({"operations": [{"op": "get", "key": "a/b"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["results"][0]["error"], "invalid_key");

    let long_field = "f".repeat(257);
    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/hashes/h/incr",
        Some(json!({"field": long_field, "by": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_field");

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/k",
        Some(json!({"value": 1, "ttlSeconds": MAX_TTL_SECONDS + 1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_ttl");

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/keys/k",
        Some(json!({"value": 1, "ifNotExists": true, "ifExists": true})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");

    let (status, body) = send(
        &app,
        "PUT",
        "/v1/faststore/hashes/h",
        Some(json!({"values": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/keys/k/incr",
        Some(json!({"by": 2_000_000_000i64})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");

    let (status, body) = send(
        &app,
        "POST",
        "/v1/faststore/locks/l/acquire",
        Some(json!({"token": ""})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_token");

    // Malformed JSON and non-object bodies.
    let request = HttpRequest::builder()
        .method("PUT")
        .uri("/v1/faststore/keys/broken")
        .header("content-type", "application/json")
        .header("x-synapseone-user", "user-1")
        .header("x-synapseone-org", "tenant-a")
        .body(Body::from("{"))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(parse_body(&bytes)["error"], "invalid_json");

    let (status, body) = send(&app, "PUT", "/v1/faststore/keys/array", Some(json!([1, 2]))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_body");

    let (status, body) = send(&app, "PUT", "/v1/faststore/keys/missing", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");
}

#[tokio::test]
async fn payload_limit_is_enforced() {
    let app = build_app(test_state());
    let oversized = vec![b'a'; MAX_BODY_BYTES + 1];
    let request = HttpRequest::builder()
        .method("PUT")
        .uri("/v1/faststore/keys/big")
        .header("content-type", "application/json")
        .header("x-synapseone-user", "user-1")
        .header("x-synapseone-org", "tenant-a")
        .body(Body::from(oversized))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(parse_body(&bytes)["error"], "payload_too_large");
}

#[tokio::test]
async fn internal_secret_gate_protects_v1_routes() {
    let app = build_app(state_with_secret("top-secret"));

    let (status, body) = send(&app, "GET", "/v1/faststore/stats", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");

    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/stats",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-1"),
            ("x-synapseone-org", "tenant-a"),
            ("x-synapseone-internal", "wrong"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/stats",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-1"),
            ("x-synapseone-org", "tenant-a"),
            ("x-synapseone-internal", "top-secret"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Legacy alias works too.
    let (status, _) = send_with(
        &app,
        "GET",
        "/v1/faststore/stats",
        None,
        &[
            ("content-type", "application/json"),
            ("x-synapseone-user", "user-1"),
            ("x-synapseone-org", "tenant-a"),
            ("x-synapsedx-internal", "top-secret"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Health and metrics stay public.
    let (status, _) = send(&app, "GET", "/health", None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(&app, "GET", "/metrics", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn security_headers_and_request_id_are_set() {
    let app = build_app(test_state());
    let (status, headers, _) = call(
        &app,
        "GET",
        "/health",
        None,
        &[("x-request-id", "abc-123_X.Y~")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get("x-request-id").unwrap(), "abc-123_X.Y~");
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(headers.get("x-frame-options").unwrap(), "DENY");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
    assert_eq!(
        headers.get("permissions-policy").unwrap(),
        "camera=(), microphone=(), geolocation=()"
    );

    let (_, headers, _) = call(
        &app,
        "GET",
        "/health",
        None,
        &[("x-request-id", "bad id!<script>")],
    )
    .await;
    assert_eq!(headers.get("x-request-id").unwrap(), "badidscript");
}

#[tokio::test]
async fn cors_preflight_and_dev_origin() {
    let app = build_app(test_state());
    let (status, headers, _) = call(
        &app,
        "OPTIONS",
        "/v1/faststore/keys/demo",
        None,
        &[
            ("origin", "https://console.example.com"),
            ("access-control-request-method", "PUT"),
            ("access-control-request-headers", "content-type"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");
    // Preflight responses still carry the security headers.
    assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    assert!(headers.get("x-request-id").is_some());
}

#[tokio::test]
async fn mutation_audit_records_actor_and_result() {
    let app = build_app(test_state());
    let audit_headers = [
        ("content-type", "application/json"),
        ("x-synapseone-user", "audit-user"),
        ("x-synapseone-org", "audit-tenant"),
        ("x-synapseone-kind", "user"),
    ];

    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/audit:key",
        Some(json!({"value": "super-secret-value"})),
        &audit_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let events: Vec<audit::AuditEvent> = audit::events()
        .into_iter()
        .filter(|event| event.actor_id == "audit-user")
        .collect();
    let event = events
        .iter()
        .find(|event| event.action == "faststore:keys:update")
        .expect("audit event");
    assert_eq!(event.actor_type, "user");
    assert_eq!(event.org_id.as_deref(), Some("audit-tenant"));
    assert_eq!(event.result, "allowed");
    assert_eq!(event.status_code, 201);
    assert_eq!(event.context["params"]["key"], "***");
    assert_eq!(event.context["service"], "faststore");
    assert!(
        !serde_json::to_string(&audit::events())
            .unwrap()
            .contains("super-secret-value"),
        "values must never enter the audit trail"
    );

    let (status, _) = send_with(
        &app,
        "PUT",
        "/v1/faststore/keys/audit:key",
        Some(json!({})),
        &audit_headers,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let denied = audit::events()
        .into_iter()
        .filter(|event| event.actor_id == "audit-user")
        .any(|event| event.action == "faststore:keys:update" && event.result == "denied");
    assert!(denied, "denied mutation must be audited");

    // Read-only POST endpoints are not mutations.
    send_with(
        &app,
        "POST",
        "/v1/faststore/sets/audit:set/contains",
        Some(json!({"member": "x"})),
        &audit_headers,
    )
    .await;
    let contains_events = audit::events()
        .into_iter()
        .filter(|event| {
            event.actor_id == "audit-user"
                && event.context["route"] == "/v1/faststore/sets/:key/contains"
        })
        .count();
    assert_eq!(contains_events, 0);
}
