// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseQueue API tests: drive the real Axum router on the in-memory
//! backend and cover publish, delay, dedupe, consume/ack, visibility and
//! heartbeat, nack/retry/dead-letter/replay, batch, queues, tenancy,
//! validation, the internal-secret gate and long-poll consumption.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request as HttpRequest, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;

const AUTH: [(&str, &str); 3] = [
    ("x-synapseone-user", "user-1"),
    ("x-synapseone-org", "tenant-a"),
    ("x-synapseone-kind", "user"),
];

fn test_state() -> AppState {
    AppState {
        store: Store::memory(),
        config: Config {
            port: 0,
            is_prod: false,
            internal_secret: String::new(),
            cors_origins: Vec::new(),
            max_payload_bytes: 262_144,
            hsts_enabled: false,
        },
        metrics: Arc::new(Mutex::new(HashMap::new())),
        started: Instant::now(),
    }
}

fn test_app() -> Router {
    build_app(test_state())
}

async fn send_raw(
    app: Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Bytes) {
    let payload = body
        .map(|value| serde_json::to_vec(&value).expect("json body"))
        .unwrap_or_default();
    let mut builder = HttpRequest::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder.body(Body::from(payload)).expect("request");
    let response = app.oneshot(request).await.expect("response");
    let status = response.status();
    let response_headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, response_headers, bytes)
}

async fn call_with(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let (status, _, bytes) = send_raw(app.clone(), method, uri, body, headers).await;
    let json = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    (status, json)
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    call_with(app, method, uri, body, &AUTH).await
}

async fn create_queue(app: &Router, extra: Value) -> Value {
    let mut body = json!({"maxAttempts": 3, "visibilityTimeoutSeconds": 30});
    if let (Some(base), Value::Object(extra)) = (body.as_object_mut(), extra) {
        for (key, value) in extra {
            base.insert(key, value);
        }
    }
    let (status, created) = call(app, "PUT", "/v1/queue/queues/jobs", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    created
}

async fn publish(app: &Router, body: Value) -> Value {
    let (status, published) = call(app, "POST", "/v1/queue/queues/jobs/messages", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{published}");
    published
}

async fn consume(app: &Router, body: Value) -> Value {
    let (status, consumed) = call(app, "POST", "/v1/queue/queues/jobs/consume", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{consumed}");
    consumed
}

#[tokio::test]
async fn health_and_metrics_are_served() {
    let app = test_app();
    let (status, headers, bytes) = send_raw(app.clone(), "GET", "/health", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let health: Value = serde_json::from_slice(&bytes).expect("health json");
    assert_eq!(health["service"], "queue");
    assert_eq!(health["backend"], "memory");
    assert_eq!(health["version"], VERSION);
    assert!(health["time"].as_str().unwrap().ends_with('Z'));

    // Security headers and a generated request id are always attached.
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["x-frame-options"], "DENY");
    assert_eq!(headers["referrer-policy"], "no-referrer");
    assert!(headers.contains_key("x-request-id"));

    let (status, headers, _) = send_raw(
        app.clone(),
        "GET",
        "/health",
        None,
        &[("x-request-id", "trace.1-abc/ignored")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["x-request-id"], "trace.1-abcignored");

    let (status, _, bytes) = send_raw(app, "GET", "/metrics", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let metrics = String::from_utf8_lossy(&bytes);
    assert!(metrics.contains("synapseone_queue_up 1"));
    assert!(metrics.contains("synapseone_queue_backend_info{backend=\"memory\"} 1"));
    assert!(metrics.contains("synapseone_queue_http_requests_total{key=\"GET|/health|200\"}"));
}

#[tokio::test]
async fn cors_preflight_allows_dev_origins() {
    let app = test_app();
    let request = HttpRequest::builder()
        .method("OPTIONS")
        .uri("/v1/queue/queues")
        .header("origin", "https://console.example.com")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "content-type")
        .body(Body::empty())
        .expect("preflight request");
    let response = app.oneshot(request).await.expect("preflight response");
    assert_eq!(response.status(), StatusCode::OK);
    let allowed = response.headers()["access-control-allow-origin"]
        .to_str()
        .expect("allow origin");
    assert!(
        allowed == "*" || allowed == "https://console.example.com",
        "unexpected allow-origin: {allowed}"
    );
}

#[tokio::test]
async fn receipts_are_opaque_capability_tokens() {
    let app = test_app();
    create_queue(&app, json!({})).await;
    let published = publish(&app, json!({"payload": {"n": 1}})).await;
    let id = published["message"]["id"].as_str().unwrap().to_string();

    let first = consume(&app, json!({"maxMessages": 1})).await;
    let receipt = first["messages"][0]["receipt"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(receipt.starts_with("rcpt_"));
    assert!(receipt.len() > 24);
    assert!(
        !receipt.contains(&id),
        "receipt must not embed the message id"
    );
    let ends_with_sequence = receipt.rsplit_once(':').is_some_and(|(_, suffix)| {
        !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
    });
    assert!(!ends_with_sequence, "receipt must not end with id:seq");

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": format!("{id}:1")})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    publish(&app, json!({"payload": {"n": 2}})).await;
    let again = consume(&app, json!({"maxMessages": 1})).await;
    assert_ne!(again["messages"][0]["receipt"], receipt.as_str());

    let (status, body) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": receipt})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
}

#[tokio::test]
async fn publish_peek_consume_and_ack() {
    let app = test_app();
    create_queue(&app, json!({})).await;

    let first = publish(
        &app,
        json!({
            "payload": {"task": "send-email", "to": "a@example.com"},
            "headers": {"trace": "t1"},
        }),
    )
    .await;
    assert_eq!(first["duplicate"], false);
    assert_eq!(first["message"]["payload"]["task"], "send-email");
    assert_eq!(first["message"]["headers"]["trace"], "t1");
    assert!(first["message"]["publishedAt"]
        .as_str()
        .unwrap()
        .ends_with('Z'));

    let second = publish(&app, json!({"payload": 2})).await;
    assert!(second["message"]["id"].as_str().is_some());

    let (status, peek) = call(
        &app,
        "GET",
        "/v1/queue/queues/jobs/messages?ready=true",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(peek["count"], 2);

    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["pending"], 2);
    assert_eq!(stats["inflight"], 0);
    assert_eq!(stats["published"], 2);

    let consumed = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(consumed["count"], 1);
    assert_eq!(consumed["messages"][0]["attempts"], 1);
    assert!(consumed["messages"][0]["receipt"].as_str().is_some());
    assert!(consumed["messages"][0]["leaseExpiresAt"].as_str().is_some());
    assert_eq!(consumed["messages"][0]["consumer"], "user-1");

    let (_, during) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(during["pending"], 1);
    assert_eq!(during["inflight"], 1);

    let (status, acked) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": consumed["messages"][0]["receipt"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(acked["ok"], true);

    let (_, after_ack) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(after_ack["acked"], 1);
    assert_eq!(after_ack["inflight"], 0);

    let last = consume(&app, json!({"maxMessages": 10})).await;
    assert_eq!(last["count"], 1);
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": last["messages"][0]["receipt"]})),
    )
    .await;
}

#[tokio::test]
async fn delayed_delivery_and_dedupe_keys() {
    let app = test_app();
    create_queue(&app, json!({})).await;

    publish(&app, json!({"payload": "later", "delaySeconds": 1})).await;
    let (_, peek) = call(
        &app,
        "GET",
        "/v1/queue/queues/jobs/messages?ready=true",
        None,
    )
    .await;
    assert_eq!(peek["count"], 0);
    let not_yet = consume(&app, json!({"maxMessages": 5})).await;
    assert_eq!(not_yet["count"], 0);

    tokio::time::sleep(Duration::from_millis(1100)).await;
    let ready = consume(&app, json!({"maxMessages": 5})).await;
    assert_eq!(ready["count"], 1);
    assert_eq!(ready["messages"][0]["payload"], "later");
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": ready["messages"][0]["receipt"]})),
    )
    .await;

    let one = publish(&app, json!({"payload": "once", "dedupeKey": "order-1"})).await;
    let (status, two) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": "once", "dedupeKey": "order-1"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(two["duplicate"], true);
    assert_eq!(two["id"], one["id"]);

    let got = consume(&app, json!({"maxMessages": 1})).await;
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": got["messages"][0]["receipt"]})),
    )
    .await;

    // The dedupe entry outlives the acked message but is only honoured while
    // the message still exists.
    let three = publish(&app, json!({"payload": "once", "dedupeKey": "order-1"})).await;
    assert_eq!(three["duplicate"], false);
    assert_ne!(three["id"], one["id"]);
}

#[tokio::test]
async fn nack_retries_dead_letters_and_replay() {
    let app = test_app();
    create_queue(&app, json!({"maxAttempts": 2})).await;
    let published = publish(&app, json!({"payload": {"n": 1}})).await;
    let id = published["id"].as_str().unwrap().to_string();

    let first = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(first["messages"][0]["attempts"], 1);
    let (status, retry) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/nack",
        Some(json!({"receipt": first["messages"][0]["receipt"], "error": "boom"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["state"], "retry");
    assert_eq!(retry["attempts"], 1);
    assert!(retry["availableAt"].as_str().is_some());
    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["retried"], 1);
    assert_eq!(stats["pending"], 1);

    let second = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(second["messages"][0]["attempts"], 2);
    let (_, dead) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/nack",
        Some(json!({
            "receipt": second["messages"][0]["receipt"],
            "error": "still failing",
        })),
    )
    .await;
    assert_eq!(dead["state"], "dead");
    assert_eq!(dead["attempts"], 2);
    assert!(dead["deadAt"].as_str().is_some());

    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["dead"], 1);
    assert_eq!(stats["inflight"], 0);

    let (_, dead_list) = call(&app, "GET", "/v1/queue/queues/jobs/dead", None).await;
    assert_eq!(dead_list["count"], 1);
    assert_eq!(dead_list["messages"][0]["id"], id);
    assert_eq!(dead_list["messages"][0]["dead"], true);
    assert_eq!(dead_list["messages"][0]["lastError"], "still failing");

    let (status, replay) = call(
        &app,
        "POST",
        &format!("/v1/queue/queues/jobs/dead/{id}/replay"),
        Some(json!({"resetAttempts": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay["message"]["attempts"], 0);

    let (_, after_replay) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(after_replay["dead"], 0);
    assert_eq!(after_replay["pending"], 1);
    assert_eq!(after_replay["replayed"], 1);

    let third = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(third["messages"][0]["attempts"], 1);
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": third["messages"][0]["receipt"]})),
    )
    .await;

    publish(&app, json!({"payload": "drop"})).await;
    let ran = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(ran["count"], 1);
    let (_, dropped) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/nack",
        Some(json!({"receipt": ran["messages"][0]["receipt"], "requeue": false})),
    )
    .await;
    assert_eq!(dropped["state"], "dead");
}

#[tokio::test]
async fn visibility_timeout_heartbeat_and_redelivery() {
    let app = test_app();
    create_queue(&app, json!({})).await;
    let published = publish(&app, json!({"payload": "lease"})).await;
    assert!(published["id"].as_str().is_some());

    let first = consume(
        &app,
        json!({"maxMessages": 1, "visibilityTimeoutSeconds": 1}),
    )
    .await;
    assert_eq!(first["count"], 1);
    let receipt = first["messages"][0]["receipt"].clone();

    let (status, beat) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/heartbeat",
        Some(json!({"receipt": receipt, "visibilityTimeoutSeconds": 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(beat["leaseExpiresAt"].as_str().is_some());

    tokio::time::sleep(Duration::from_millis(1100)).await;
    let blocked = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(blocked["count"], 0);

    tokio::time::sleep(Duration::from_millis(1100)).await;
    let redelivered = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(redelivered["count"], 1);
    assert_eq!(redelivered["messages"][0]["attempts"], 2);
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": redelivered["messages"][0]["receipt"]})),
    )
    .await;
}

#[tokio::test]
async fn long_poll_consume_returns_as_soon_as_work_arrives() {
    let app = test_app();
    create_queue(&app, json!({})).await;
    let started = Instant::now();
    let waiting = tokio::spawn({
        let app = app.clone();
        async move {
            call(
                &app,
                "POST",
                "/v1/queue/queues/jobs/consume",
                Some(json!({"maxMessages": 1, "waitSeconds": 5})),
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(120)).await;
    publish(&app, json!({"payload": {"hello": "world"}})).await;
    let wake_started = Instant::now();
    let (status, got) = waiting.await.expect("long poll");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["count"], 1);
    assert_eq!(got["messages"][0]["payload"]["hello"], "world");
    assert_eq!(got["waitSeconds"], 5);
    assert!(
        got["waitedMs"].as_i64().unwrap() >= 100,
        "waitedMs={}",
        got["waitedMs"]
    );
    assert!(
        wake_started.elapsed() < Duration::from_secs(2),
        "wake-up took {:?}",
        wake_started.elapsed()
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must not sleep out the full wait"
    );
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": got["messages"][0]["receipt"]})),
    )
    .await;
}

#[tokio::test]
async fn long_poll_honours_wait_budget_and_delayed_messages() {
    let app = test_app();
    create_queue(&app, json!({})).await;

    let started = Instant::now();
    let empty = consume(&app, json!({"maxMessages": 1, "waitSeconds": 1})).await;
    let elapsed = started.elapsed();
    assert_eq!(empty["count"], 0);
    assert!(
        empty["waitedMs"].as_i64().unwrap() >= 900,
        "waitedMs={}",
        empty["waitedMs"]
    );
    assert!(
        empty["waitedMs"].as_i64().unwrap() < 2500,
        "waitedMs={}",
        empty["waitedMs"]
    );
    assert!(elapsed >= Duration::from_millis(900) && elapsed < Duration::from_millis(2500));

    // A delayed message is not announced; the waiter computes the next
    // availability time and picks it up without a scan loop.
    let started = Instant::now();
    let delayed = tokio::spawn({
        let app = app.clone();
        async move {
            publish(&app, json!({"payload": "later", "delaySeconds": 1})).await;
        }
    });
    let got = consume(&app, json!({"maxMessages": 1, "waitSeconds": 3})).await;
    delayed.await.expect("publish");
    let elapsed = started.elapsed();
    assert_eq!(got["count"], 1);
    assert_eq!(got["messages"][0]["payload"], "later");
    assert!(
        elapsed >= Duration::from_millis(900) && elapsed < Duration::from_millis(2500),
        "delayed pickup took {elapsed:?}"
    );
    call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": got["messages"][0]["receipt"]})),
    )
    .await;
}

#[tokio::test]
async fn wait_seconds_is_validated_and_bounded() {
    let app = test_app();
    create_queue(&app, json!({})).await;

    let (status, too_long) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/consume",
        Some(json!({"maxMessages": 1, "waitSeconds": 21})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(too_long["error"], "invalid_request");

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/consume",
        Some(json!({"maxMessages": 1, "waitSeconds": -1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let started = Instant::now();
    let immediate = consume(&app, json!({"maxMessages": 1})).await;
    assert_eq!(immediate["count"], 0);
    assert!(immediate["waitedMs"].as_i64().unwrap() < 500);
    assert!(immediate.get("waitSeconds").is_none());
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[tokio::test]
async fn batch_publish_and_tenant_isolation() {
    let app = test_app();
    create_queue(&app, json!({})).await;

    let (status, batch) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages:batch",
        Some(json!({
            "messages": [
                {"payload": 1},
                {"payload": 2, "id": "custom-id"},
                {"headers": {"only": true}},
            ],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(batch["results"].as_array().unwrap().len(), 3);
    assert_eq!(batch["results"][0]["ok"], true);
    assert_eq!(batch["results"][1]["id"], "custom-id");
    assert_eq!(batch["results"][2]["ok"], false);
    assert_eq!(batch["ok"], false);

    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["pending"], 2);

    let foreign = [
        ("x-synapseone-user", "user-1"),
        ("x-synapseone-org", "tenant-b"),
        ("x-synapseone-kind", "user"),
    ];
    let (status, _) = call_with(
        &app,
        "GET",
        "/v1/queue/queues/jobs/messages",
        None,
        &foreign,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues/jobs/stats", None, &foreign).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn api_key_headers_are_account_scoped_never_platform() {
    let app = test_app();
    let key_headers = [
        ("x-synapseone-kind", "apikey"),
        ("x-synapseone-account", "acc-9"),
    ];

    create_queue(&app, json!({})).await;
    let (status, _) = call_with(
        &app,
        "GET",
        "/v1/queue/queues/jobs/stats",
        None,
        &key_headers,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, listed) = call_with(&app, "GET", "/v1/queue/queues", None, &key_headers).await;
    assert_eq!(listed, json!([]));

    let (status, made) = call_with(
        &app,
        "PUT",
        "/v1/queue/queues/jobs",
        Some(json!({"maxAttempts": 3, "visibilityTimeoutSeconds": 30})),
        &key_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{made}");
    let (status, _) = call_with(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages?tenant=admin",
        Some(json!({"payload": 1})),
        &key_headers,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, stats) = call_with(
        &app,
        "GET",
        "/v1/queue/queues/jobs/stats",
        None,
        &key_headers,
    )
    .await;
    assert_eq!(stats["pending"], 1);

    // Platform (`tenant:admin`) is a different namespace.
    let platform = [("x-synapseone-tenant", "admin")];
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues/jobs/stats", None, &platform).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn queue_configuration_listing_purge_and_delete() {
    let app = test_app();
    let (_, empty) = call(&app, "GET", "/v1/queue/queues", None).await;
    assert_eq!(empty, json!([]));

    let created = create_queue(
        &app,
        json!({"maxAttempts": 4, "visibilityTimeoutSeconds": 10}),
    )
    .await;
    assert_eq!(created["name"], "jobs");
    assert_eq!(created["maxAttempts"], 4);
    assert_eq!(created["visibilityTimeoutSeconds"], 10);

    let (_, listed) = call(&app, "GET", "/v1/queue/queues", None).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "jobs");

    let (status, one) = call(&app, "GET", "/v1/queue/queues/jobs", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(one["stats"]["pending"], 0);

    publish(&app, json!({"payload": "x"})).await;
    publish(&app, json!({"payload": "y"})).await;
    let (status, purged) = call(&app, "POST", "/v1/queue/queues/jobs/purge", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(purged["purged"], true);
    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["pending"], 0);

    let (status, updated) = call(
        &app,
        "PUT",
        "/v1/queue/queues/jobs",
        Some(json!({"maxAttempts": 7})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["maxAttempts"], 7);

    let (_, deleted) = call(&app, "DELETE", "/v1/queue/queues/jobs", None).await;
    assert_eq!(deleted["deleted"], true);
    let (status, _) = call(&app, "GET", "/v1/queue/queues/jobs", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_ack_and_dead_letter_delete() {
    let app = test_app();
    create_queue(&app, json!({"maxAttempts": 1})).await;
    publish(&app, json!({"payload": 1})).await;
    publish(&app, json!({"payload": 2})).await;
    let consumed = consume(&app, json!({"maxMessages": 2})).await;
    assert_eq!(consumed["count"], 2);
    let receipts = consumed["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["receipt"].clone())
        .collect::<Vec<_>>();

    let (status, acked) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipts": receipts})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(acked["ok"], true);
    assert_eq!(acked["results"].as_array().unwrap().len(), 2);
    let (_, stats) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(stats["acked"], 2);

    // Dead-letter deletion removes an entry without replaying it.
    publish(&app, json!({"payload": "dead"})).await;
    let taken = consume(&app, json!({"maxMessages": 1})).await;
    let (_, dead) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/nack",
        Some(json!({"receipt": taken["messages"][0]["receipt"], "error": "nope"})),
    )
    .await;
    let id = dead["id"].as_str().unwrap().to_string();
    let (status, deleted) = call(
        &app,
        "DELETE",
        &format!("/v1/queue/queues/jobs/dead/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["deleted"], true);
    let (_, dead_list) = call(&app, "GET", "/v1/queue/queues/jobs/dead", None).await;
    assert_eq!(dead_list["count"], 0);
}

#[tokio::test]
async fn authentication_and_validation() {
    let app = test_app();
    let anon = [("x-synapseone-anon", "1")];
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues", None, &anon).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, missing) = call_with(&app, "GET", "/v1/queue/queues", None, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(missing["error"], "tenant_required");

    let platform = [("x-synapseone-tenant", "admin")];
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues", None, &platform).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = call(&app, "GET", "/v1/queue/queues/1bad", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, missing_payload) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"headers": {"a": 1}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(missing_payload["error"], "invalid_payload");

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": 1, "delaySeconds": -1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/consume",
        Some(json!({"maxMessages": 0})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    create_queue(&app, json!({})).await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/ack",
        Some(json!({"receipt": "nope:1"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/heartbeat",
        Some(json!({"receipt": "nope:1"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/dead/nope/replay",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages:batch",
        Some(json!({"messages": []})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": 1, "id": "bad/id"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": {"blob": "x".repeat(300_000)}})),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": 1, "dedupeKey": "bad\nkey"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn internal_secret_gate_is_timing_safe_and_optional_in_dev() {
    let mut state = test_state();
    state.config.internal_secret = "s3cret".into();
    let app = build_app(state);

    let (status, body) = call(&app, "GET", "/v1/queue/queues", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");

    let mut wrong = AUTH.to_vec();
    wrong.push(("x-synapseone-internal", "wrong"));
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues", None, &wrong).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let mut right = AUTH.to_vec();
    right.push(("x-synapseone-internal", "s3cret"));
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues", None, &right).await;
    assert_eq!(status, StatusCode::OK);

    // The legacy header prefix is still accepted during the rebrand window.
    let mut legacy = AUTH.to_vec();
    legacy.push(("x-synapsedx-internal", "s3cret"));
    let (status, _) = call_with(&app, "GET", "/v1/queue/queues", None, &legacy).await;
    assert_eq!(status, StatusCode::OK);

    // Health and metrics stay reachable for probes.
    let (status, _, _) = send_raw(app.clone(), "GET", "/health", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send_raw(app, "GET", "/metrics", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn production_config_fails_closed() {
    let mut config = Config {
        port: 4007,
        is_prod: true,
        internal_secret: String::new(),
        cors_origins: Vec::new(),
        max_payload_bytes: 262_144,
        hsts_enabled: false,
    };
    assert!(assert_production_config(&config, Some("redis://127.0.0.1/")).is_err());
    config.internal_secret = "secret".into();
    assert!(assert_production_config(&config, None).is_err());
    assert!(assert_production_config(&config, Some("redis://127.0.0.1/")).is_ok());
    config.is_prod = false;
    config.internal_secret.clear();
    assert!(assert_production_config(&config, None).is_ok());
}

#[tokio::test]
async fn mutation_audit_records_actor_tenant_action_and_result() {
    audit::clear();
    let app = test_app();
    create_queue(&app, json!({})).await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        Some(json!({"payload": {"secret": "super-secret-value"}})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let events = audit::events();
    let event = events
        .iter()
        .find(|event| event.action == "queue:queues.messages:create")
        .expect("publish audit event");
    assert_eq!(event.actor_type, "user");
    assert_eq!(event.actor_id, "user-1");
    assert_eq!(event.org_id.as_deref(), Some("tenant-a"));
    assert_eq!(event.result, "allowed");
    assert_eq!(event.status_code, 201);
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("super-secret-value"),
        "message payloads must never enter the audit trail"
    );

    let (status, _) = call(&app, "POST", "/v1/queue/queues/missing/purge", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let events = audit::events();
    let denied = events
        .iter()
        .find(|event| event.action == "queue:queues:purge" && event.result == "denied")
        .expect("denied purge audit event");
    assert_eq!(denied.status_code, 404);

    let before = audit::events().len();
    let (status, _) = call(&app, "GET", "/v1/queue/queues/jobs/stats", None).await;
    assert_eq!(status, StatusCode::OK);
    let after = audit::events();
    assert!(
        after
            .iter()
            .all(|event| event.context["method"].as_str() != Some("GET")),
        "reads must not add mutation events"
    );
    assert!(after.len() >= before);
}

#[tokio::test]
async fn oversized_body_is_rejected() {
    let app = test_app();
    let (status, _, _) = send_raw(
        app,
        "POST",
        "/v1/queue/queues/jobs/messages",
        None,
        &[AUTH[0], AUTH[1], AUTH[2], ("content-length", "6000000")],
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}
