// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Behavioural tests for the Rust port. They boot the real Axum app against the
//! in-memory backend, so CI never needs a production database.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Request as HttpRequest, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower::ServiceExt;

use crate::api::build_app;
use crate::cache::{Cache, CachedDocument};
use crate::store::Store;
use crate::{AppState, Config};

fn user_headers(org: &str, sub: &str) -> Vec<(String, String)> {
    vec![
        ("content-type".into(), "application/json".into()),
        ("x-synapseone-user".into(), sub.into()),
        ("x-synapseone-org".into(), org.into()),
        ("x-synapseone-kind".into(), "user".into()),
    ]
}

fn key_headers(account: &str) -> Vec<(String, String)> {
    vec![
        ("content-type".into(), "application/json".into()),
        ("x-synapseone-kind".into(), "apikey".into()),
        ("x-synapseone-account".into(), account.into()),
    ]
}

fn with_header(
    mut headers: Vec<(String, String)>,
    name: &str,
    value: &str,
) -> Vec<(String, String)> {
    headers.push((name.to_string(), value.to_string()));
    headers
}

async fn test_state() -> AppState {
    let store = Store::connect(None).await.expect("memory store");
    AppState::new(store, Config::for_test())
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(String, String)],
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Value) {
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let has_body = !payload.is_empty();
    call_raw(app, method, uri, headers, payload, has_body).await
}

async fn call_raw(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(String, String)],
    body: String,
    has_body: bool,
) -> (StatusCode, HeaderMap, Value) {
    let mut builder = HttpRequest::builder().method(method).uri(uri);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let request = builder
        .body(if has_body {
            Body::from(body)
        } else {
            Body::empty()
        })
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()))
    };
    (status, headers, value)
}

async fn create_collection(app: &Router, headers: &[(String, String)], body: Value) -> Value {
    let (status, _, value) = call(app, "POST", "/v1/base/collections", headers, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

async fn create_database(app: &Router, headers: &[(String, String)], body: Value) -> Value {
    let (status, _, value) = call(app, "POST", "/v1/base/databases", headers, Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

async fn create_collection_in(
    app: &Router,
    headers: &[(String, String)],
    database: &str,
    body: Value,
) -> Value {
    let (status, _, value) = call(
        app,
        "POST",
        &format!("/v1/base/databases/{database}/collections"),
        headers,
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

async fn create_doc(
    app: &Router,
    headers: &[(String, String)],
    collection: &str,
    body: Value,
) -> Value {
    let (status, _, value) = call(
        app,
        "POST",
        &format!("/v1/base/collections/{collection}/documents"),
        headers,
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

async fn create_doc_in(
    app: &Router,
    headers: &[(String, String)],
    database: &str,
    collection: &str,
    body: Value,
) -> Value {
    let (status, _, value) = call(
        app,
        "POST",
        &format!("/v1/base/databases/{database}/collections/{collection}/documents"),
        headers,
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    value
}

#[test]
fn route_patterns_collapse_database_and_collection_ids() {
    assert_eq!(
        crate::api::route_pattern("/v1/base/databases/analytics/collections/users"),
        "/v1/base/databases/:database/collections/:collection"
    );
    assert_eq!(
        crate::api::route_pattern("/v1/base/databases/analytics/collections/users/documents/u1"),
        "/v1/base/databases/:database/collections/:collection/documents/:id"
    );
    assert_eq!(
        crate::api::route_pattern("/v1/base/collections/users/documents/u1"),
        "/v1/base/collections/:collection/documents/:id"
    );
    assert_eq!(
        crate::api::route_pattern("/v1/base/databases/analytics/stats"),
        "/v1/base/databases/:database/stats"
    );
}

#[tokio::test]
async fn health_and_metrics_are_served() {
    let state = test_state().await;
    let app = build_app(state);
    let (status, _, value) = call(&app, "GET", "/health", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["service"], "base");
    assert_eq!(value["db"], "memory");

    let (status, headers, value) = call(&app, "GET", "/metrics", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .starts_with("text/plain"));
    let text = value.as_str().expect("text metrics");
    assert!(text.contains("synapseone_base_up 1"));
    assert!(
        text.contains("synapseone_base_http_requests_total{key=\"GET|/health|200\"}"),
        "{text}"
    );
}

#[tokio::test]
async fn collection_crud_and_tenant_isolation() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    let collection = create_collection(
        &app,
        &headers,
        json!({"name": "users", "description": "Users"}),
    )
    .await;
    assert_eq!(collection["orgId"], "tenant-a");
    assert_eq!(
        collection["mapping"],
        json!({"additional": false, "fields": {}})
    );

    let (status, _, value) = call(&app, "GET", "/v1/base/collections", &headers, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value.as_array().unwrap().len(), 1);

    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/users",
        &user_headers("tenant-b", "user-2"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &headers,
        Some(json!({"name": "other", "orgId": "tenant-b"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, value) = call(
        &app,
        "PATCH",
        "/v1/base/collections/users",
        &headers,
        Some(json!({"description": "Accounts"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["description"], "Accounts");

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &headers,
        Some(json!({"name": "users"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _, _) = call(&app, "DELETE", "/v1/base/collections/users", &headers, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(&app, "GET", "/v1/base/collections/users", &headers, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn database_namespace_keeps_collection_names_unique_per_database() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");

    let analytics = create_database(
        &app,
        &headers,
        json!({"name": "analytics", "description": "Analytics workspace"}),
    )
    .await;
    assert_eq!(analytics["name"], "analytics");
    assert!(analytics.get("id").is_some());

    let billing = create_database(&app, &headers, json!({"name": "billing"})).await;
    assert_eq!(billing["orgId"], "tenant-a");

    // The same collection name is allowed in independent databases.
    let analytics_users =
        create_collection_in(&app, &headers, "analytics", json!({"name": "users"})).await;
    assert_eq!(analytics_users["database"], "analytics");
    let billing_users =
        create_collection_in(&app, &headers, "billing", json!({"name": "users"})).await;
    assert_eq!(billing_users["database"], "billing");

    // ...but not twice in one database.
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/databases/analytics/collections",
        &headers,
        Some(json!({"name": "users"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Documents are isolated by collection id even though the names match.
    let analytics_doc = create_doc_in(
        &app,
        &headers,
        "analytics",
        "users",
        json!({"id": "a-1", "data": {"scope": "analytics"}}),
    )
    .await;
    assert_eq!(analytics_doc["data"]["scope"], "analytics");
    assert_eq!(analytics_doc["database"], "analytics");
    let billing_doc = create_doc_in(
        &app,
        &headers,
        "billing",
        "users",
        json!({"id": "b-1", "data": {"scope": "billing"}}),
    )
    .await;
    assert_eq!(billing_doc["data"]["scope"], "billing");

    let (status, _, value) = call(&app, "GET", "/v1/base/collections/users", &headers, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/analytics/collections/users",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["databaseId"], analytics["id"]);
    assert_eq!(value["stats"]["documents"], 1);

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/analytics/collections/users/documents/a-1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["data"]["scope"], "analytics");

    // Flat legacy routes can opt into a database with ?database=.
    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/collections/users?database=billing",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["database"], "billing");

    // A default database still backs the old flat API.
    let default_collection = create_collection(&app, &headers, json!({"name": "users"})).await;
    assert_eq!(default_collection["database"], "default");
    let default_doc = create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "d-1", "data": {"scope": "default"}}),
    )
    .await;
    assert_eq!(default_doc["database"], "default");

    let (_, _, namespaced) = call(
        &app,
        "GET",
        "/v1/base/collections?database=analytics",
        &headers,
        None,
    )
    .await;
    let names: Vec<&str> = namespaced
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["users"]);

    let (_, _, databases) = call(&app, "GET", "/v1/base/databases", &headers, None).await;
    let names: Vec<&str> = databases
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["analytics", "billing", "default"]);
    let analytics_stats = databases
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "analytics")
        .unwrap();
    assert_eq!(analytics_stats["stats"]["collections"], 1);
    assert_eq!(analytics_stats["stats"]["documents"], 1);
}

#[tokio::test]
async fn database_rename_updates_collection_listing() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");

    create_database(&app, &headers, json!({"name": "app"})).await;
    create_collection_in(&app, &headers, "app", json!({"name": "users"})).await;

    let (status, _, value) = call(
        &app,
        "PATCH",
        "/v1/base/databases/app",
        &headers,
        Some(json!({"name": "portal"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["name"], "portal");

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/portal/collections/users",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["database"], "portal");

    let (_, _, listed) = call(
        &app,
        "GET",
        "/v1/base/collections?database=portal",
        &headers,
        None,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["database"], "portal");
}

#[tokio::test]
async fn default_databases_are_isolated_per_org_account() {
    let state = test_state().await;
    let app = build_app(state);
    let account_one = with_header(
        user_headers("tenant-a", "user-1"),
        "x-synapseone-account",
        "acc-1",
    );
    let account_two = with_header(
        user_headers("tenant-a", "user-2"),
        "x-synapseone-account",
        "acc-2",
    );
    let org_wide = user_headers("tenant-a", "user-3");

    create_collection(&app, &account_one, json!({"name": "users"})).await;
    create_collection(&app, &account_two, json!({"name": "users"})).await;
    create_collection(&app, &org_wide, json!({"name": "users"})).await;

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/collections/users",
        &account_one,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["accountId"], "acc-1");

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/collections/users",
        &account_two,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["accountId"], "acc-2");

    let (status, _, value) = call(&app, "GET", "/v1/base/collections/users", &org_wide, None).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value.get("accountId").is_none());

    let (_, _, databases) = call(&app, "GET", "/v1/base/databases", &org_wide, None).await;
    assert_eq!(databases.as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn platform_callers_can_create_in_a_query_scope() {
    let state = test_state().await;
    let app = build_app(state);

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/databases?orgId=tenant-a",
        &[],
        Some(json!({"name": "scoped"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    assert_eq!(value["orgId"], "tenant-a");
    assert!(value.get("accountId").is_none());

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/databases/scoped/collections?orgId=tenant-a",
        &[],
        Some(json!({"name": "users"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{value}");
    assert_eq!(value["database"], "scoped");
    assert_eq!(value["orgId"], "tenant-a");

    let tenant = user_headers("tenant-a", "user-1");
    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/scoped/collections/users",
        &tenant,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/databases?orgId=tenant-a",
        &[],
        Some(json!({"name": "conflict", "orgId": "tenant-b"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
    assert_eq!(value["error"], "invalid_tenant");
}

#[tokio::test]
async fn database_delete_requires_cascade_and_removes_children() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");

    create_database(&app, &headers, json!({"name": "app"})).await;
    create_collection_in(&app, &headers, "app", json!({"name": "notes"})).await;

    let (status, _, value) = call(&app, "DELETE", "/v1/base/databases/app", &headers, None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    assert_eq!(value["error"], "database_not_empty");

    let (status, _, value) = call(
        &app,
        "DELETE",
        "/v1/base/databases/app?cascade=true",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["deletedCollections"], 1);

    let (status, _, _) = call(&app, "GET", "/v1/base/databases/app", &headers, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/databases/app/collections/notes",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn database_routes_are_tenant_scoped_and_reject_ambiguous_scope() {
    let state = test_state().await;
    let app = build_app(state);
    let owner = user_headers("tenant-a", "user-1");
    let outsider = user_headers("tenant-b", "user-2");

    create_database(&app, &owner, json!({"name": "private"})).await;

    let (status, _, value) = call(&app, "GET", "/v1/base/databases/private", &outsider, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/databases/private/collections",
        &outsider,
        Some(json!({"name": "leak"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A platform caller must name the tenant scope.
    let (status, _, value) = call(&app, "GET", "/v1/base/databases/private", &[], None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");
    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/private?orgId=tenant-a",
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["orgId"], "tenant-a");

    // Path and query scope must agree.
    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/private/collections?database=other",
        &owner,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
    assert_eq!(value["error"], "invalid_database");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/databases/private/collections",
        &owner,
        Some(json!({"name": "users", "database": "other"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{value}");
    assert_eq!(value["error"], "invalid_database");

    // Creating in a missing database is a 404, not an accidental auto-create.
    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/databases/missing/collections",
        &owner,
        Some(json!({"name": "users"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");
    assert_eq!(value["error"], "database_not_found");

    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/databases/missing/collections",
        &owner,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{value}");
    assert_eq!(value["error"], "database_not_found");
}

#[tokio::test]
async fn api_key_headers_without_user_are_account_scoped() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "orgdata"})).await;

    let key = key_headers("acc-9");
    let mine = create_collection(&app, &key, json!({"name": "keydata"})).await;
    assert!(mine.get("orgId").is_none());
    assert_eq!(mine["accountId"], "acc-9");

    let (_, _, list) = call(&app, "GET", "/v1/base/collections", &key, None).await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["keydata"]);

    let (_, _, widened) = call(
        &app,
        "GET",
        "/v1/base/collections?orgId=tenant-a",
        &key,
        None,
    )
    .await;
    assert_eq!(widened, json!([]));

    let (status, _, _) = call(&app, "GET", "/v1/base/collections/orgdata", &key, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &key,
        Some(json!({"name": "evil", "orgId": "tenant-a"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &key,
        Some(json!({"name": "evil2", "accountId": "acc-other"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, _) = call(&app, "GET", "/v1/base/collections/keydata", &headers, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn document_crud_version_conflict_and_increment() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;

    let created = create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "u1", "data": {"name": "Alice", "score": 10}}),
    )
    .await;
    assert_eq!(created["version"], 1);

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/users/documents",
        &headers,
        Some(json!({"id": "u1", "data": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (_, _, got) = call(
        &app,
        "GET",
        "/v1/base/collections/users/documents/u1",
        &headers,
        None,
    )
    .await;
    assert_eq!(got["data"]["name"], "Alice");

    let (status, _, replaced) = call(
        &app,
        "PUT",
        "/v1/base/collections/users/documents/u1",
        &headers,
        Some(json!({"data": {"name": "Alice B"}, "ifVersion": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replaced["version"], 2);

    let (status, _, stale) = call(
        &app,
        "PUT",
        "/v1/base/collections/users/documents/u1",
        &headers,
        Some(json!({"data": {"name": "X"}, "ifVersion": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(stale["error"], "version_conflict");

    let (status, _, patched) = call(
        &app,
        "PATCH",
        "/v1/base/collections/users/documents/u1",
        &headers,
        Some(json!({"data": {"score": 5, "nickname": "Al"}, "unset": ["name"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["data"]["score"], 5);
    assert!(patched["data"].get("name").is_none());

    let (status, _, inc) = call(
        &app,
        "POST",
        "/v1/base/collections/users/documents/u1/increment",
        &headers,
        Some(json!({"field": "score", "by": 7})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(inc["data"]["score"], 12);

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/users/documents/u1/increment",
        &headers,
        Some(json!({"field": "nickname", "by": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/users/documents/u1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/users/documents/u1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn object_data_mapping_is_enforced_and_reversible() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(
        &app,
        &headers,
        json!({
            "name": "users",
            "mapping": {
                "fields": {
                    "fullName": {"path": "profile.name", "type": "string", "required": true},
                    "age": {"path": "profile.age", "type": "number"},
                    "joinedAt": {"path": "meta.joinedAt", "type": "date"}
                }
            }
        }),
    )
    .await;

    let created = create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "m1", "object": {"fullName": "Bảo", "age": 31, "joinedAt": "2026-01-02T00:00:00Z"}}),
    )
    .await;
    assert_eq!(
        created["data"],
        json!({"profile": {"name": "Bảo", "age": 31}, "meta": {"joinedAt": "2026-01-02T00:00:00Z"}})
    );

    let (status, _, got) = call(
        &app,
        "GET",
        "/v1/base/collections/users/documents/m1?as=object",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        got["object"],
        json!({"fullName": "Bảo", "age": 31, "joinedAt": "2026-01-02T00:00:00Z"})
    );

    for body in [
        json!({"object": {"age": 1}}),
        json!({"object": {"fullName": "X", "age": "old"}}),
        json!({"object": {"fullName": "X", "nope": 1}}),
        json!({"data": {"profile": {"age": 2}}}),
    ] {
        let (status, _, _) = call(
            &app,
            "POST",
            "/v1/base/collections/users/documents",
            &headers,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    let (status, _, patch) = call(
        &app,
        "PATCH",
        "/v1/base/collections/users/documents/m1",
        &headers,
        Some(json!({"object": {"age": 32}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patch["data"]["profile"]["age"], 32);

    let (_, _, query) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"as": "object", "where": {"age": {"gte": 30}}})),
    )
    .await;
    assert_eq!(query["items"][0]["object"]["fullName"], "Bảo");

    let (status, _, bad) = call(
        &app,
        "PATCH",
        "/v1/base/collections/users",
        &headers,
        Some(json!({"mapping": {"fields": {"x": {"path": "../x"}}}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(bad["error"], "invalid_mapping");
}

#[tokio::test]
async fn query_operators_ordering_projection_cursor_and_object_view() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    let docs = [
        json!({"id": "a", "data": {"name": "Alpha", "age": 10, "tags": ["x"], "nested": {"city": "Da Nang"}}}),
        json!({"id": "b", "data": {"name": "Beta", "age": 20, "tags": ["y"]}}),
        json!({"id": "c", "data": {"name": "Gamma", "age": 30, "tags": ["x", "y"]}}),
        json!({"id": "d", "data": {"name": "Delta", "age": 40}}),
    ];
    for document in docs {
        create_doc(&app, &headers, "users", document).await;
    }

    let (status, _, gt) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(
            json!({"where": {"age": {"gt": 15}}, "orderBy": {"field": "age", "direction": "desc"}}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gt}");
    let ids: Vec<&str> = gt["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["d", "c", "b"]);

    let (_, _, complex) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({
            "where": {"and": [{"age": {"gte": 20}}, {"or": [{"tags": {"contains": "x"}}, {"name": {"startsWith": "D"}}]}]}
        })),
    )
    .await;
    let mut complex_ids: Vec<&str> = complex["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    complex_ids.sort();
    assert_eq!(complex_ids, vec!["c", "d"]);

    let (_, _, missing) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"where": {"nested": {"exists": false}}})),
    )
    .await;
    let mut missing_ids: Vec<&str> = missing["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    missing_ids.sort();
    assert_eq!(missing_ids, vec!["b", "c", "d"]);

    let (_, _, projected) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"where": {"$id": {"eq": "a"}}, "select": ["name", "nested.city"]})),
    )
    .await;
    assert_eq!(
        projected["items"][0]["data"],
        json!({"name": "Alpha", "nested": {"city": "Da Nang"}})
    );

    let (_, _, page1) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"orderBy": "id", "limit": 2})),
    )
    .await;
    assert_eq!(page1["total"], 4);
    assert_eq!(page1["items"].as_array().unwrap().len(), 2);
    let cursor = page1["nextCursor"]
        .as_str()
        .expect("next cursor")
        .to_string();
    assert!(cursor.chars().all(|c| c != '+' && c != '/' && c != '='));

    let (_, _, page2) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"orderBy": "id", "limit": 2, "cursor": cursor})),
    )
    .await;
    let ids: Vec<&str> = page2["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["c", "d"]);
    assert!(page2["nextCursor"].is_null());

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/users/query",
        &headers,
        Some(json!({"where": {"age": {"gt": 1}}, "limit": 5000})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn batch_writes_and_change_feed() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    let (status, _, batch) = call(
        &app,
        "POST",
        "/v1/base/collections/users/documents:batch",
        &headers,
        Some(json!({
            "operations": [
                {"op": "create", "id": "a", "data": {"n": 1}},
                {"op": "set", "id": "b", "data": {"n": 2}},
                {"op": "update", "id": "b", "data": {"n": 3}},
                {"op": "increment", "id": "b", "field": "n", "by": 2},
                {"op": "delete", "id": "a"},
                {"op": "nope", "id": "x"}
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(batch["results"].as_array().unwrap().len(), 6);
    assert_eq!(batch["results"][0]["ok"], true);
    assert_eq!(batch["results"][4]["ok"], true);
    assert_eq!(batch["results"][5]["ok"], false);
    assert_eq!(batch["ok"], false);

    let (_, _, b) = call(
        &app,
        "GET",
        "/v1/base/collections/users/documents/b",
        &headers,
        None,
    )
    .await;
    assert_eq!(b["data"]["n"], 5);

    let since = (chrono::Utc::now() - chrono::Duration::seconds(60))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (status, _, changes) = call(
        &app,
        "GET",
        &format!(
            "/v1/base/collections/users/changes?since={}",
            percent_encoding::utf8_percent_encode(&since, percent_encoding::NON_ALPHANUMERIC)
        ),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let events = changes["changes"].as_array().unwrap();
    assert!(events
        .iter()
        .any(|event| event["id"] == "b" && event["data"]["n"] == 5));
    let tombstone = events
        .iter()
        .find(|event| event["id"] == "a" && event["operation"] == "delete")
        .expect("delete tombstone");
    assert_eq!(tombstone["deleted"], true);
    assert!(tombstone["eventId"].is_string());
    assert!(!changes["nextAfter"].is_null());

    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/users/changes?since=nope",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rolled_back_document_write_emits_no_outbox_event() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "dup", "data": {"n": 1}}),
    )
    .await;
    let since = (chrono::Utc::now() - chrono::Duration::seconds(60))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let uri = format!(
        "/v1/base/collections/users/changes?since={}",
        percent_encoding::utf8_percent_encode(&since, percent_encoding::NON_ALPHANUMERIC)
    );
    let (_, _, before) = call(&app, "GET", &uri, &headers, None).await;
    let failed = call(
        &app,
        "POST",
        "/v1/base/collections/users/documents",
        &headers,
        Some(json!({"id": "dup", "data": {"n": 2}})),
    )
    .await;
    assert_eq!(failed.0, StatusCode::CONFLICT);
    let (_, _, after) = call(&app, "GET", &uri, &headers, None).await;
    assert_eq!(
        after["changes"].as_array().unwrap().len(),
        before["changes"].as_array().unwrap().len()
    );
    assert_eq!(
        after["changes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["id"] == "dup")
            .count(),
        1
    );
}

type StreamRequests = Arc<Mutex<Vec<(String, String, Value, String)>>>;

#[derive(Clone, Default)]
struct StreamCapture {
    requests: StreamRequests,
}

async fn stream_stub(
    axum::extract::State(capture): axum::extract::State<StreamCapture>,
    request: HttpRequest<Body>,
) -> axum::response::Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let tenant = request
        .headers()
        .get("x-synapseone-tenant")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    capture
        .requests
        .lock()
        .await
        .push((method, path, body, tenant));
    (
        StatusCode::CREATED,
        axum::Json(json!({"ok": true, "events": []})),
    )
        .into_response()
}

async fn spawn_stream_stub() -> (String, StreamCapture) {
    let capture = StreamCapture::default();
    let app = Router::new()
        .fallback(stream_stub)
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), capture)
}

#[tokio::test]
async fn outbox_relay_publishes_once() {
    let (url, capture) = spawn_stream_stub().await;
    let mut config = Config::for_test();
    config.stream_service_url = url;
    let store = Store::connect(None).await.unwrap();
    let state = AppState::new(store.clone(), config.clone());
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "relay-1", "data": {"n": 1}}),
    )
    .await;

    let first = crate::outbox::relay_outbox_once(&store, &config, 100).await;
    assert_eq!(first, 1);
    let requests = capture.requests.lock().await.clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "PUT");
    assert!(requests[0].1.contains("base-changes"));
    assert_eq!(requests[1].0, "POST");
    assert_eq!(requests[1].3, "org:tenant-a");
    let payload = &requests[1].2["events"][0]["payload"];
    assert_eq!(payload["document_id"], "relay-1");
    assert!(!payload["event_id"]
        .as_str()
        .unwrap()
        .starts_with("backfill:"));

    let second = crate::outbox::relay_outbox_once(&store, &config, 100).await;
    assert_eq!(second, 0);
}

#[tokio::test]
async fn backfill_is_idempotent_and_replayable() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "snap-1", "data": {"n": 1}}),
    )
    .await;

    let (status, _, first) = call(
        &app,
        "POST",
        "/internal/base/collections/users/backfill",
        &headers,
        Some(json!({"limit": 100})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["enqueued"], 1);
    let (_, _, second) = call(
        &app,
        "POST",
        "/internal/base/collections/users/backfill",
        &headers,
        Some(json!({"limit": 100})),
    )
    .await;
    assert_eq!(second["enqueued"], 0);

    let since = percent_encoding::utf8_percent_encode(
        "1970-01-01T00:00:00.000Z",
        percent_encoding::NON_ALPHANUMERIC,
    );
    let (_, _, changes) = call(
        &app,
        "GET",
        &format!("/v1/base/collections/users/changes?since={since}&limit=100"),
        &headers,
        None,
    )
    .await;
    let backfilled: Vec<&Value> = changes["changes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| {
            event["id"] == "snap-1"
                && event["eventId"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("backfill:")
        })
        .collect();
    assert_eq!(backfilled.len(), 1);
}

#[tokio::test]
async fn machine_only_collection_prefixes_gate_tenants_but_not_machine_keys() {
    let store = Store::connect(None).await.unwrap();
    let mut config = Config::for_test();
    config.machine_collection_prefixes = crate::util::parse_collection_prefixes("synapsedx_");
    let state = AppState::new(store, config);
    state.audit.clear().await;
    let app = build_app(state);

    // Gateway-stamped principals: account key (machine), org member (user),
    // member-minted user-bound key (kind=apikey + owner header), and a
    // service-account JWT (kind=service-account + sub as user).
    let machine = with_header(key_headers("acct-a"), "x-synapseone-org", "org-a");
    let user = user_headers("org-a", "user-1");
    let user_bound = with_header(
        with_header(key_headers("acct-a"), "x-synapseone-org", "org-a"),
        "x-synapseone-user",
        "owner-1",
    );
    let service = vec![
        ("content-type".into(), "application/json".into()),
        ("x-synapseone-kind".into(), "service-account".into()),
        ("x-synapseone-account".into(), "acct-a".into()),
        ("x-synapseone-org".into(), "org-a".into()),
        ("x-synapseone-user".into(), "sa-1".into()),
    ];

    // Machine creates and writes the reserved collection.
    create_collection(
        &app,
        &machine,
        json!({"name": "synapsedx_capability_audit"}),
    )
    .await;
    create_doc(
        &app,
        &machine,
        "synapsedx_capability_audit",
        json!({"id": "audit-1", "data": {"title": "bridge audit"}}),
    )
    .await;
    // A normal tenant collection for contrast (and search).
    create_collection(&app, &user, json!({"name": "assets"})).await;
    create_doc(
        &app,
        &user,
        "assets",
        json!({"id": "asset-1", "data": {"title": "bridge asset"}}),
    )
    .await;

    // A tenant user cannot read, write or create reserved collections.
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/synapsedx_capability_audit/documents/audit-1",
        &user,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/synapsedx_capability_audit/documents/audit-1",
        &user,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &user,
        Some(json!({"name": "synapsedx_shadow"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/synapsedx_capability_audit/query",
        &user,
        Some(json!({"limit": 10})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The reserved name never appears in the tenant listing.
    let (status, _, listed) = call(&app, "GET", "/v1/base/collections", &user, None).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<String> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|collection| collection["name"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(names.contains(&"assets".to_string()), "{names:?}");
    assert!(
        !names.iter().any(|name| name.starts_with("synapsedx_")),
        "machine-only names leaked into a tenant listing: {names:?}"
    );

    // A user-bound key is NOT machine (kind=apikey but the owner header is set).
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/synapsedx_capability_audit/documents/audit-1",
        &user_bound,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &user_bound,
        Some(json!({"name": "synapsedx_userkey"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Account-level machine and service-account credentials keep access.
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/synapsedx_capability_audit/documents/audit-1",
        &machine,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/synapsedx_capability_audit/documents/audit-1",
        &service,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &service,
        Some(json!({"name": "synapsedx_service_created"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Database-qualified paths share the same gate.
    create_database(&app, &machine, json!({"name": "ops"})).await;
    create_collection_in(&app, &machine, "ops", json!({"name": "synapsedx_ops_data"})).await;
    create_doc_in(
        &app,
        &machine,
        "ops",
        "synapsedx_ops_data",
        json!({"id": "d1", "data": {"title": "ops"}}),
    )
    .await;
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/databases/ops/collections/synapsedx_ops_data/documents/d1",
        &user,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/databases/ops/collections/synapsedx_ops_data/documents/d1",
        &machine,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Search never returns reserved rows/names to a tenant caller.
    let (status, _, _) = call(&app, "POST", "/v1/search/reindex", &user, Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, results) = call(
        &app,
        "POST",
        "/v1/search",
        &user,
        Some(json!({"query": "bridge"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{results}");
    let hits = results["items"].as_array().unwrap();
    assert!(
        !hits.is_empty(),
        "normal collection must still be searchable"
    );
    for hit in hits {
        let collection = hit
            .get("metadata")
            .and_then(|metadata| metadata.get("collection"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_ne!(collection, "synapsedx_capability_audit", "{results}");
        assert!(!collection.starts_with("synapsedx_"), "{results}");
    }
    // The machine caller still sees the reserved row.
    let (status, _, machine_results) = call(
        &app,
        "POST",
        "/v1/search/reindex",
        &machine,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{machine_results}");
    let (status, _, machine_hits) = call(
        &app,
        "POST",
        "/v1/search",
        &machine,
        Some(json!({"query": "bridge"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        machine_hits["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hit| hit["metadata"]["collection"] == "synapsedx_capability_audit"),
        "{machine_hits}"
    );
}

#[tokio::test]
async fn machine_only_prefixes_default_to_disabled() {
    // Default config (no prefixes) keeps the general PaaS behaviour.
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "SynapseDX_legacy"})).await;
    let (status, _, document) = call(
        &app,
        "GET",
        "/v1/base/collections/SynapseDX_legacy",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{document}");
}

#[tokio::test]
async fn anonymous_callers_are_rejected() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = vec![
        ("content-type".to_string(), "application/json".to_string()),
        ("x-synapseone-anon".to_string(), "1".to_string()),
    ];
    let (status, _, _) = call(&app, "GET", "/v1/base/collections", &headers, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "bridge"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn vector_mapping_search_and_hybrid_metadata_filter() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    let collection = create_collection(
        &app,
        &headers,
        json!({
            "name": "kb_articles",
            "mapping": {
                "fields": {
                    "title": {"path": "title", "type": "string", "required": true},
                    "category": {"path": "meta.category", "type": "string"},
                    "embedding": {"path": "vec", "type": "vector", "dimension": 3, "metric": "cosine"}
                }
            }
        }),
    )
    .await;
    assert_eq!(
        collection["mapping"]["fields"]["embedding"]["type"],
        "vector"
    );
    assert_eq!(collection["mapping"]["fields"]["embedding"]["dimension"], 3);

    for (id, title, category, vector) in [
        ("doc1", "Intro to AI", "ai", json!([1, 0, 0])),
        ("doc2", "Database Indexing", "db", json!([0, 1, 0])),
        (
            "doc3",
            "AI in Databases",
            "ai",
            json!([
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
                0
            ]),
        ),
    ] {
        create_doc(
            &app,
            &headers,
            "kb_articles",
            json!({"id": id, "object": {"title": title, "category": category, "embedding": vector}}),
        )
        .await;
    }

    let (status, _, bad_dim) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/documents",
        &headers,
        Some(json!({"id": "bad1", "object": {"title": "Wrong Dim", "embedding": [1, 0]}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(bad_dim["message"]
        .as_str()
        .unwrap()
        .contains("dimension mismatch"));

    let (status, _, _non_finite) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/documents",
        &headers,
        Some(json!({"id": "bad2", "object": {"title": "NaN Dim", "embedding": [1, null, 0]}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, search1) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/vector-search",
        &headers,
        Some(json!({"vector": [1, 0, 0], "limit": 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{search1}");
    assert_eq!(search1["items"].as_array().unwrap().len(), 2);
    assert_eq!(search1["items"][0]["id"], "doc1");
    assert!(search1["items"][0]["similarity"].as_f64().unwrap() > 0.99);
    assert_eq!(search1["items"][1]["id"], "doc3");
    assert!(search1["items"][1]["similarity"].as_f64().unwrap() > 0.7);

    let (_, _, filtered) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/vector-search",
        &headers,
        Some(json!({"vector": [1, 0, 0], "where": {"category": {"eq": "db"}}, "as": "object"})),
    )
    .await;
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["id"], "doc2");
    assert_eq!(filtered["items"][0]["object"]["title"], "Database Indexing");

    let (_, _, via_query) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/query",
        &headers,
        Some(json!({"vectorSearch": {"vector": [0, 1, 0], "limit": 1}, "as": "object"})),
    )
    .await;
    assert_eq!(via_query["items"].as_array().unwrap().len(), 1);
    assert_eq!(via_query["items"][0]["id"], "doc2");

    let (_, _, l2) = call(
        &app,
        "POST",
        "/v1/base/collections/kb_articles/vector-search",
        &headers,
        Some(json!({"vector": [1, 0, 0], "metric": "l2"})),
    )
    .await;
    assert_eq!(l2["items"][0]["id"], "doc1");
    assert_eq!(l2["items"][0]["distance"], 0);
}

#[tokio::test]
async fn text_and_geospatial_operators() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "assets"})).await;
    let docs = [
        json!({"name": "Broken streetlight", "description": "The streetlight on Main Street is broken", "location": {"lat": 10.7769, "lng": 106.7009}}),
        json!({"name": "Flooded road", "description": "Road closed due to flooding", "location": {"lat": 10.78, "lng": 106.71}}),
        json!({"name": "Park bench", "description": "A quiet bench in the park", "location": {"lat": 21.0278, "lng": 105.8342}}),
    ];
    for (index, document) in docs.into_iter().enumerate() {
        create_doc(
            &app,
            &headers,
            "assets",
            json!({"id": format!("asset-{index}"), "data": document}),
        )
        .await;
    }

    let (status, _, text) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(
            json!({"where": {"field": "description", "op": "text", "value": "streetlight BROKEN"}}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(text["total"], 1);
    assert_eq!(text["items"][0]["id"], "asset-0");

    let (_, _, any_text) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(json!({"where": {"field": "$text", "op": "text", "value": "bench park"}})),
    )
    .await;
    let ids: Vec<&str> = any_text["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["asset-2"]);

    let (_, _, near) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(json!({"where": {"field": "location", "op": "near", "value": {"lat": 10.7769, "lng": 106.7009, "maxDistanceKm": 5}}})),
    )
    .await;
    let mut near_ids: Vec<&str> = near["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    near_ids.sort();
    assert_eq!(near_ids, vec!["asset-0", "asset-1"]);

    let (_, _, within) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(json!({"where": {"field": "location", "op": "within", "value": {"bbox": [106.69, 10.77, 106.72, 10.79]}}})),
    )
    .await;
    let mut within_ids: Vec<&str> = within["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    within_ids.sort();
    assert_eq!(within_ids, vec!["asset-0", "asset-1"]);

    let (_, _, polygon) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(json!({"where": {"field": "location", "op": "within", "value": {"type": "Polygon", "coordinates": [[[106.69, 10.77], [106.72, 10.77], [106.72, 10.79], [106.69, 10.79], [106.69, 10.77]]]}}})),
    )
    .await;
    assert_eq!(polygon["total"], 2);

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/assets/query",
        &headers,
        Some(json!({"where": {"field": "location", "op": "near", "value": {"lat": "x"}}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn document_listing_exposes_total_and_cursor_envelope() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "paged"})).await;
    for index in 0..5 {
        create_doc(
            &app,
            &headers,
            "paged",
            json!({"id": format!("p-{index}"), "data": {"i": index}}),
        )
        .await;
    }
    let (status, _headers_out, page) = call(
        &app,
        "GET",
        "/v1/base/collections/paged/documents?limit=2&withTotal=1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["total"], 5);
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert!(page["nextCursor"].is_string());
    let cursor = page["nextCursor"].as_str().unwrap().to_string();

    let (_, _, next) = call(
        &app,
        "POST",
        "/v1/base/collections/paged/query",
        &headers,
        Some(json!({"limit": 2, "cursor": cursor})),
    )
    .await;
    let ids: Vec<&str> = next["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["p-2", "p-3"]);

    let (_, headers_out, bare) = call(
        &app,
        "GET",
        "/v1/base/collections/paged/documents?limit=2",
        &headers,
        None,
    )
    .await;
    assert_eq!(
        headers_out
            .get("x-total-count")
            .and_then(|value| value.to_str().ok()),
        Some("5")
    );
    assert!(bare.is_array());
}

#[tokio::test]
async fn large_collections_are_scanned_in_batches() {
    let state = test_state().await;
    let database = state
        .store
        .ensure_default_database(&crate::store::CollectionScope {
            org_id: Some("bulk-org".into()),
            account_id: None,
            platform: false,
        })
        .await
        .unwrap();
    let collection = state
        .store
        .create_collection(crate::store::CreateCollectionInput {
            database_id: database.id,
            database_name: database.name,
            name: "bulk".into(),
            description: None,
            mapping: Default::default(),
            org_id: Some("bulk-org".into()),
            account_id: None,
            created_by: None,
        })
        .await
        .unwrap();
    let total = 10_050;
    for index in 0..total {
        state
            .store
            .create_document(
                &collection.id,
                &format!("doc-{index:06}"),
                json!({"i": index}),
            )
            .await
            .unwrap();
    }
    let documents = state
        .store
        .list_all_documents(&collection.id, Some(total), Some(1000))
        .await
        .unwrap();
    assert_eq!(documents.len(), total as usize);
}

#[tokio::test]
async fn mutation_audit_records_actor_tenant_action_result() {
    let state = test_state().await;
    state.audit.clear().await;
    let app = build_app(state.clone());
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "audited"})).await;
    create_doc(
        &app,
        &headers,
        "audited",
        json!({"id": "audit-doc", "data": {"description": "super-secret-value"}}),
    )
    .await;

    let events = state.audit.events().await;
    let write = events
        .iter()
        .find(|event| event.action == "base:collections.documents:create")
        .unwrap_or_else(|| panic!("missing audit event: {events:?}"));
    assert_eq!(write.actor_type, "user");
    assert_eq!(write.actor_id, "user-1");
    assert_eq!(write.org_id.as_deref(), Some("tenant-a"));
    assert_eq!(write.result, "allowed");
    assert_eq!(write.status_code, 201);
    assert_eq!(write.context["params"]["collection"], "audited");
    assert!(write
        .resource
        .starts_with("base:/v1/base/collections/:collection/documents"));
    let serialized = serde_json::to_string(&events).unwrap();
    assert!(!serialized.contains("super-secret-value"));

    let before = events.len();
    call(
        &app,
        "POST",
        "/v1/base/collections/audited/query",
        &headers,
        Some(json!({"limit": 1})),
    )
    .await;
    assert_eq!(state.audit.events().await.len(), before);

    call(
        &app,
        "DELETE",
        "/v1/base/collections/audited/documents/missing",
        &headers,
        None,
    )
    .await;
    let denied = state
        .audit
        .events()
        .await
        .into_iter()
        .find(|event| {
            event.action == "base:collections.documents:delete" && event.result == "denied"
        })
        .expect("denied audit event");
    assert_eq!(denied.status_code, 404);
}

#[derive(Clone, Default)]
struct AuditCapture {
    requests: Arc<Mutex<Vec<(String, String, Value)>>>,
}

async fn audit_stub(
    axum::extract::State(capture): axum::extract::State<AuditCapture>,
    request: HttpRequest<Body>,
) -> axum::response::Response {
    let secret = request
        .headers()
        .get("x-synapseone-internal")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let path = request.uri().path().to_string();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    capture.requests.lock().await.push((path, secret, body));
    (
        StatusCode::ACCEPTED,
        axum::Json(json!({"ok": true, "accepted": 1})),
    )
        .into_response()
}

#[tokio::test]
async fn audit_events_flush_to_iam_with_secret_and_no_pii() {
    let capture = AuditCapture::default();
    let app = Router::new()
        .fallback(audit_stub)
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let store = Store::connect(None).await.unwrap();
    let mut state = AppState::new(store, Config::for_test());
    state.audit = crate::audit::Audit::new(
        true,
        format!("http://{address}/v1/audit/ingest"),
        "audit-test-secret".into(),
    );
    let app = build_app(state.clone());
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "flushed"})).await;
    state.audit.flush_now().await;

    let requests = capture.requests.lock().await.clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].1, "audit-test-secret");
    let event = &requests[0].2["events"][0];
    assert_eq!(event["action"], "base:collections:create");
    assert_eq!(event["actorId"], "user-1");
    assert_eq!(event["orgId"], "tenant-a");
    assert_eq!(event["result"], "allowed");
    assert_eq!(event["statusCode"], 201);
    assert!(!requests[0].2.to_string().contains("content-type"));
}

#[tokio::test]
async fn internal_secret_gate_protects_v1_and_internal_routes() {
    let store = Store::connect(None).await.unwrap();
    let mut config = Config::for_test();
    config.internal_secret = "top-secret".into();
    let state = AppState::new(store, config);
    state.audit.clear().await;
    let app = build_app(state.clone());
    let headers = user_headers("tenant-a", "user-1");

    let (status, _, _) = call(&app, "GET", "/health", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    // Prometheus scrapes /metrics without a credential (static scrape config);
    // it is a diagnostic endpoint and stays exempt like health.
    let (status, _, _) = call(&app, "GET", "/metrics", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = call(&app, "GET", "/v1/base/collections", &headers, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &headers,
        Some(json!({"name": "blocked"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let rejected = state.audit.events().await.into_iter().find(|event| {
        event.action == "base:collections:create"
            && event.result == "denied"
            && event.status_code == 401
    });
    assert!(rejected.is_some(), "gate rejections must be audited");
    let (status, _, _) = call(
        &app,
        "POST",
        "/internal/base/collections/users/backfill",
        &headers,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let headers = with_header(headers, "x-synapseone-internal", "wrong");
    let (status, _, _) = call(&app, "GET", "/v1/base/collections", &headers, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let correct = with_header(
        user_headers("tenant-a", "user-1"),
        "x-synapseone-internal",
        "top-secret",
    );
    let (status, _, _) = call(&app, "GET", "/v1/base/collections", &correct, None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = call(
        &app,
        "POST",
        "/internal/base/collections/users/backfill",
        &correct,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn request_id_security_headers_and_cors() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = vec![
        ("x-request-id".to_string(), "abc-123.~_".to_string()),
        ("origin".to_string(), "https://console.example".to_string()),
    ];
    let (status, response_headers, _) = call(&app, "GET", "/health", &headers, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        response_headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok()),
        Some("abc-123.~_")
    );
    assert_eq!(
        response_headers
            .get("x-content-type-options")
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        response_headers
            .get("x-frame-options")
            .and_then(|value| value.to_str().ok()),
        Some("DENY")
    );
    assert_eq!(
        response_headers
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok()),
        Some("*")
    );

    let headers = vec![("x-request-id".to_string(), "bad id!@#".to_string())];
    let (_, response_headers, _) = call(&app, "GET", "/health", &headers, None).await;
    assert_eq!(
        response_headers
            .get("x-request-id")
            .and_then(|value| value.to_str().ok()),
        Some("badid")
    );
    let (_, response_headers, _) = call(&app, "GET", "/health", &[], None).await;
    assert!(!response_headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .is_empty());
}

#[tokio::test]
async fn validation_errors_are_reported_with_stable_codes() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections",
        &headers,
        Some(json!({"name": "1bad"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_name");

    create_collection(&app, &headers, json!({"name": "things"})).await;
    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/things/documents",
        &headers,
        Some(json!({"id": "bad/id", "data": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_document_id");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/things/documents",
        &headers,
        Some(json!({"data": {}, "object": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "mapping_error");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/things/query",
        &headers,
        Some(json!({"where": {"field": "x", "op": "bogus", "value": 1}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_query");

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/things/query",
        &headers,
        Some(json!({"cursor": "not-base64!"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_query");

    let (status, _, value) = call_raw(
        &app,
        "POST",
        "/v1/base/collections/things/documents",
        &headers,
        "{not-json".to_string(),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_json");
}

#[tokio::test]
async fn if_match_header_and_conditional_delete() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "users"})).await;
    create_doc(
        &app,
        &headers,
        "users",
        json!({"id": "u1", "data": {"n": 1}}),
    )
    .await;

    let headers_match = with_header(headers.clone(), "if-match", "W/\"1\"");
    let (status, _, value) = call(
        &app,
        "PUT",
        "/v1/base/collections/users/documents/u1",
        &headers_match,
        Some(json!({"data": {"n": 2}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["version"], 2);

    let (status, _, value) = call(
        &app,
        "DELETE",
        "/v1/base/collections/users/documents/u1?ifVersion=1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(value["error"], "version_conflict");

    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/users/documents/u1?ifVersion=2",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn graph_nodes_edges_traversal_and_cascade() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "social"})).await;

    let (status, _, nodes) = call(
        &app,
        "POST",
        "/v1/base/collections/social/graph/nodes",
        &headers,
        Some(json!({"nodes": [
            {"id": "a", "labels": ["Person"], "properties": {"name": "A"}},
            {"id": "b", "labels": ["Person"], "properties": {"name": "B"}},
            {"id": "c", "labels": ["Person"], "properties": {"name": "C"}}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{nodes}");
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 3);

    let (status, _, edges) = call(
        &app,
        "POST",
        "/v1/base/collections/social/graph/edges",
        &headers,
        Some(json!({"edges": [
            {"from": "a", "to": "b", "type": "KNOWS"},
            {"from": "b", "to": "c", "type": "KNOWS"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{edges}");
    assert_eq!(edges["edges"].as_array().unwrap().len(), 2);

    let (status, _, sub) = call(
        &app,
        "GET",
        "/v1/base/collections/social/graph/nodes/a?depth=1&limit=200",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sub["node"]["id"], "a");
    let ids: Vec<&str> = sub["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"a") && ids.contains(&"b") && !ids.contains(&"c"));
    assert_eq!(sub["edges"].as_array().unwrap().len(), 1);

    let (_, _, deep) = call(
        &app,
        "GET",
        "/v1/base/collections/social/graph/nodes/a?depth=2",
        &headers,
        None,
    )
    .await;
    assert_eq!(deep["nodes"].as_array().unwrap().len(), 3);

    let (_, _, query) = call(
        &app,
        "POST",
        "/v1/base/collections/social/graph/query",
        &headers,
        Some(json!({"start": ["a"], "depth": 1, "edgeTypes": ["KNOWS"]})),
    )
    .await;
    assert_eq!(query["nodes"].as_array().unwrap().len(), 2);

    let (_, _, stats) = call(
        &app,
        "GET",
        "/v1/base/collections/social/graph/stats",
        &headers,
        None,
    )
    .await;
    assert_eq!(stats["nodes"], 3);
    assert_eq!(stats["edges"], 2);

    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/social/graph/nodes/b",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, stats) = call(
        &app,
        "GET",
        "/v1/base/collections/social/graph/stats",
        &headers,
        None,
    )
    .await;
    assert_eq!(stats["nodes"], 2);
    assert_eq!(stats["edges"], 0);

    let (status, _, _) = call(
        &app,
        "GET",
        "/v1/base/collections/social/graph/nodes/b",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/social/graph/nodes",
        &headers,
        Some(json!({"nodes": [{"id": "bad id"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_graph");

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/social/graph/edges",
        &headers,
        Some(json!({"edges": [{"from": "a", "to": "missing", "type": "KNOWS"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn gis_features_bbox_radius_polygon_and_stats() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "sensors"})).await;
    let features = json!({"features": [
        {"id": "f1", "properties": {"kind": "air"}, "geometry": {"type": "Point", "coordinates": [106.7009, 10.7769]}},
        {"id": "f2", "properties": {"kind": "water"}, "geometry": {"type": "Point", "coordinates": [106.71, 10.78]}},
        {"id": "f3", "properties": {"kind": "air"}, "geometry": {"type": "Point", "coordinates": [105.8342, 21.0278]}}
    ]});
    let (status, _, upserted) = call(
        &app,
        "POST",
        "/v1/base/collections/sensors/geo/features",
        &headers,
        Some(features),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{upserted}");
    assert_eq!(upserted["features"].as_array().unwrap().len(), 3);

    let (status, _, listed) = call(
        &app,
        "GET",
        "/v1/base/collections/sensors/geo/features",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["type"], "FeatureCollection");
    assert_eq!(listed["features"].as_array().unwrap().len(), 3);

    let (_, _, bbox) = call(
        &app,
        "GET",
        "/v1/base/collections/sensors/geo/features?bbox=106.69,10.77,106.72,10.79",
        &headers,
        None,
    )
    .await;
    assert_eq!(bbox["features"].as_array().unwrap().len(), 2);

    let (_, _, near) = call(
        &app,
        "POST",
        "/v1/base/collections/sensors/geo/near",
        &headers,
        Some(json!({"lat": 10.7769, "lng": 106.7009, "radiusMeters": 5000})),
    )
    .await;
    let near_features = near["features"].as_array().unwrap();
    assert_eq!(near_features.len(), 2);
    assert_eq!(near_features[0]["id"], "f1");
    assert!(near_features[0]["distanceMeters"].as_f64().unwrap() < 1.0);

    let (_, _, within) = call(
        &app,
        "POST",
        "/v1/base/collections/sensors/geo/within",
        &headers,
        Some(json!({"geometry": {"type": "Polygon", "coordinates": [[[106.69, 10.77], [106.72, 10.77], [106.72, 10.79], [106.69, 10.79], [106.69, 10.77]]]}})),
    )
    .await;
    assert_eq!(within["features"].as_array().unwrap().len(), 2);

    let (_, _, stats) = call(
        &app,
        "GET",
        "/v1/base/collections/sensors/geo/stats",
        &headers,
        None,
    )
    .await;
    assert_eq!(stats["features"], 3);
    assert!(!stats["extent"].is_null());

    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/sensors/geo/features/f1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, stats) = call(
        &app,
        "GET",
        "/v1/base/collections/sensors/geo/stats",
        &headers,
        None,
    )
    .await;
    assert_eq!(stats["features"], 2);
    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/sensors/geo/features/missing",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, value) = call(
        &app,
        "POST",
        "/v1/base/collections/sensors/geo/features",
        &headers,
        Some(json!({"features": [{"id": "bad", "geometry": {"type": "Nope"}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "invalid_geo");

    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/base/collections/sensors/geo/near",
        &headers,
        Some(json!({"lat": 10.0, "lng": 106.0, "radiusMeters": 0})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

async fn seed_search(app: &Router) {
    let headers = user_headers("tenant-a", "analyst-1");
    create_collection(
        app,
        &headers,
        json!({"name": "incidents", "description": "Incident reports"}),
    )
    .await;
    for document in [
        json!({"id": "inc-1", "data": {"title": "Bridge flooding", "body": "River levels rose above the bridge deck after heavy rain.", "type": "incident", "status": "open", "acl": ["*"]}}),
        json!({"id": "inc-2", "data": {"title": "Power outage downtown", "body": "Transformer failure left three blocks without electricity.", "type": "incident", "status": "closed", "acl": ["analyst-1"]}}),
        json!({"id": "inc-3", "data": {"title": "Water pump maintenance", "body": "Preventive maintenance on the north water pump station.", "type": "maintenance", "status": "open"}}),
    ] {
        create_doc(app, &headers, "incidents", document).await;
    }
    let headers_b = user_headers("tenant-b", "analyst-b");
    create_collection(app, &headers_b, json!({"name": "secret-plans"})).await;
    create_doc(
        app,
        &headers_b,
        "secret-plans",
        json!({"id": "b-1", "data": {"title": "Bridge plan", "body": "Tenant B bridge secret."}}),
    )
    .await;
}

#[tokio::test]
async fn search_reindex_tenant_isolation_acl_and_highlighting() {
    let state = test_state().await;
    let app = build_app(state);
    seed_search(&app).await;
    let headers = user_headers("tenant-a", "analyst-1");
    let (status, _, first) = call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["indexed"], 3);
    let (_, _, second) = call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers,
        Some(json!({})),
    )
    .await;
    assert_eq!(second["indexed"], 3);
    assert_eq!(second["status"]["indexed"], 3);

    let (status, _, a) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "bridge flooding"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!a["items"].as_array().unwrap().is_empty());
    assert_eq!(a["items"][0]["documentId"], "inc-1");
    let highlights = a["items"][0]["highlights"].as_array().unwrap();
    assert!(highlights.iter().any(|item| item == "bridge"));
    assert!(a["items"][0]["snippet"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .contains("<mark>bridge</mark>"));
    let (_, _, b) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "bridge flooding"})),
    )
    .await;
    let scores_a: Vec<&Value> = a["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| &item["score"])
        .collect();
    let scores_b: Vec<&Value> = b["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| &item["score"])
        .collect();
    assert_eq!(scores_a, scores_b);

    let (status, _, get_search) = call(
        &app,
        "GET",
        "/v1/search?q=bridge+flooding&limit=5",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(get_search["items"][0]["documentId"], "inc-1");

    let (status, _, status_body) = call(&app, "GET", "/v1/search/status", &headers, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_body["indexed"], 3);
    assert_eq!(status_body["collections"], 1);

    let headers_b = user_headers("tenant-b", "analyst-b");
    call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers_b,
        Some(json!({})),
    )
    .await;
    let (_, _, bridge) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "bridge"})),
    )
    .await;
    assert!(!bridge["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "b-1"));

    let analyst_2 = user_headers("tenant-a", "analyst-2");
    let (_, _, private_doc) = call(
        &app,
        "POST",
        "/v1/search",
        &analyst_2,
        Some(json!({"query": "transformer outage"})),
    )
    .await;
    assert!(!private_doc["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "inc-2"));
    let (_, _, public_doc) = call(
        &app,
        "POST",
        "/v1/search",
        &analyst_2,
        Some(json!({"query": "bridge flooding"})),
    )
    .await;
    assert!(public_doc["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "inc-1"));

    let (_, _, cross_tenant) = call(
        &app,
        "POST",
        "/v1/search",
        &headers_b,
        Some(json!({"query": "bridge"})),
    )
    .await;
    assert!(!cross_tenant["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "inc-1"));
    assert!(cross_tenant["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "b-1"));
}

#[tokio::test]
async fn search_semantic_hybrid_facets_filters_pagination_and_deletes() {
    let state = test_state().await;
    let app = build_app(state.clone());
    seed_search(&app).await;
    let headers = user_headers("tenant-a", "analyst-1");
    call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers,
        Some(json!({})),
    )
    .await;

    let (status, _, semantic) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "electricity outage", "mode": "semantic"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!semantic["items"].as_array().unwrap().is_empty());
    assert_eq!(semantic["items"][0]["documentId"], "inc-2");
    assert_eq!(semantic["items"][0]["mode"], "semantic");

    let (_, _, hybrid) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "water pump", "mode": "hybrid"})),
    )
    .await;
    assert!(hybrid["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "inc-3"));

    let (_, _, page1) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "incident", "limit": 1})),
    )
    .await;
    assert_eq!(page1["items"].as_array().unwrap().len(), 1);
    assert!(page1["nextCursor"].is_string());
    assert!(!page1["facets"]["collection"].as_array().unwrap().is_empty());
    assert!(page1["facets"]["type"]
        .as_array()
        .unwrap()
        .iter()
        .any(|facet| facet["value"] == "incident"));
    let cursor = page1["nextCursor"].as_str().unwrap().to_string();
    let (_, _, page2) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "incident", "limit": 1, "cursor": cursor})),
    )
    .await;
    assert_ne!(
        page2["items"][0]["documentId"],
        page1["items"][0]["documentId"]
    );

    let (_, _, filtered) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "maintenance", "filters": {"status": "open"}})),
    )
    .await;
    assert!(filtered["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["metadata"]["status"] == "open"));

    let (status, _, _) = call(
        &app,
        "DELETE",
        "/v1/base/collections/incidents/documents/inc-1",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers,
        Some(json!({})),
    )
    .await;
    let (_, _, after_delete) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "bridge flooding"})),
    )
    .await;
    assert!(!after_delete["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "inc-1"));

    state.store.clear_memory().await;
    let (status, _, empty) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "anything"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["items"], json!([]));
    assert_eq!(empty["total"], 0);
}

type FaststoreRequests = Arc<Mutex<Vec<(String, String, HashMap<String, String>, String)>>>;

#[derive(Clone, Default)]
struct FaststoreCapture {
    stored: Arc<Mutex<HashMap<String, Value>>>,
    requests: FaststoreRequests,
}

async fn faststore_stub(
    axum::extract::State(capture): axum::extract::State<FaststoreCapture>,
    request: HttpRequest<Body>,
) -> axum::response::Response {
    let path = request.uri().path().to_string();
    let method = request.method().to_string();
    let headers: HashMap<String, String> = request
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
        })
        .collect();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let body = String::from_utf8_lossy(&bytes).to_string();
    capture
        .requests
        .lock()
        .await
        .push((method.clone(), path.clone(), headers, body.clone()));
    let key = path
        .rsplit('/')
        .next()
        .map(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8_lossy()
                .to_string()
        })
        .unwrap_or_default();
    if path.starts_with("/v1/faststore/keys/") {
        match method.as_str() {
            "GET" => {
                let stored = capture.stored.lock().await;
                match stored.get(&key) {
                    Some(value) => (
                        StatusCode::OK,
                        axum::Json(
                            json!({"key": key, "type": "string", "value": value, "ttlSeconds": 60}),
                        ),
                    )
                        .into_response(),
                    None => (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({"error": "not_found"})),
                    )
                        .into_response(),
                }
            }
            "PUT" => {
                let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                capture
                    .stored
                    .lock()
                    .await
                    .insert(key.clone(), parsed["value"].clone());
                (
                    StatusCode::CREATED,
                    axum::Json(json!({"ok": true, "key": key, "created": true})),
                )
                    .into_response()
            }
            "DELETE" => {
                let existed = capture.stored.lock().await.remove(&key).is_some();
                (
                    StatusCode::OK,
                    axum::Json(json!({"key": key, "deleted": existed})),
                )
                    .into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    } else if path == "/v1/faststore/batch" {
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if let Some(operations) = parsed["operations"].as_array() {
            for operation in operations {
                if let Some(key) = operation["key"].as_str() {
                    capture.stored.lock().await.remove(key);
                }
            }
        }
        (StatusCode::OK, axum::Json(json!({"results": []}))).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "not_found"})),
        )
            .into_response()
    }
}

async fn spawn_faststore() -> (String, FaststoreCapture) {
    let capture = FaststoreCapture::default();
    let app = Router::new()
        .fallback(faststore_stub)
        .with_state(capture.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), capture)
}

fn cache_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-synapseone-org", "tenant-a".parse().unwrap());
    headers.insert("x-synapseone-user", "user-1".parse().unwrap());
    headers
}

fn cache_doc(id: &str) -> CachedDocument {
    CachedDocument {
        collection_id: "collection-1".into(),
        id: id.into(),
        data: json!({"name": "Central"}),
        version: 1,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn cache_miss_write_hit_tenant_headers_and_invalidation() {
    let (url, capture) = spawn_faststore().await;
    let cache = Cache::new(url, "test-internal-secret".into(), 30, 1000, false);
    cache.reset_metrics();
    let headers = cache_headers();

    assert!(cache
        .get_document(&headers, "collection-1", "doc-1")
        .await
        .is_none());
    assert_eq!(cache.metrics().misses, 1);
    cache.set_document(&headers, &cache_doc("doc-1")).await;
    let fetched = cache
        .get_document(&headers, "collection-1", "doc-1")
        .await
        .expect("cached document");
    assert_eq!(fetched, cache_doc("doc-1"));
    assert_eq!(cache.metrics().hits, 1);

    let requests = capture.requests.lock().await.clone();
    let last = requests.last().expect("request");
    assert_eq!(
        last.2.get("x-synapseone-org").map(String::as_str),
        Some("tenant-a")
    );
    assert_eq!(
        last.2.get("x-synapseone-user").map(String::as_str),
        Some("user-1")
    );
    assert_eq!(
        last.2.get("x-synapseone-internal").map(String::as_str),
        Some("test-internal-secret")
    );
    assert!(!last.2.contains_key("authorization"));

    let without_tenant = HeaderMap::new();
    let before = capture.requests.lock().await.len();
    assert!(cache
        .get_document(&without_tenant, "collection-1", "doc-1")
        .await
        .is_none());
    assert_eq!(capture.requests.lock().await.len(), before);

    capture.stored.lock().await.insert(
        Cache::document_cache_key("collection-1", "doc-2"),
        json!(cache_doc("doc-2")),
    );
    cache
        .delete_document(&headers, "collection-1", "doc-1")
        .await;
    assert!(!capture
        .stored
        .lock()
        .await
        .contains_key(&Cache::document_cache_key("collection-1", "doc-1")));
    cache
        .delete_documents(&headers, "collection-1", &["doc-2".to_string()])
        .await;
    assert!(!capture
        .stored
        .lock()
        .await
        .contains_key(&Cache::document_cache_key("collection-1", "doc-2")));
    assert_eq!(cache.metrics().deletes, 2);
}

#[tokio::test]
async fn cache_wrongly_shaped_values_are_errors() {
    let (url, capture) = spawn_faststore().await;
    capture.stored.lock().await.insert(
        Cache::document_cache_key("collection-1", "doc-1"),
        json!({"collection_id": "collection-1", "id": "doc-1"}),
    );
    let cache = Cache::new(url, String::new(), 60, 1000, false);
    cache.reset_metrics();
    assert!(cache
        .get_document(&cache_headers(), "collection-1", "doc-1")
        .await
        .is_none());
    assert_eq!(cache.metrics().errors, 1);
}

#[tokio::test]
async fn production_configuration_is_fail_closed() {
    let mut config = Config::for_test();
    config.is_prod = true;
    assert!(config.is_production_config().is_err());
    config.internal_secret = "secret".into();
    assert!(config.is_production_config().is_err());
    config.database_url = "postgres://example/db".into();
    assert!(config.is_production_config().is_ok());
}

#[tokio::test]
async fn misconfigured_production_gate_returns_500() {
    let store = Store::connect(None).await.unwrap();
    let mut config = Config::for_test();
    config.is_prod = true;
    let state = AppState::new(store, config);
    let app = build_app(state);
    let (status, _, value) = call(
        &app,
        "GET",
        "/v1/base/collections",
        &user_headers("tenant-a", "user-1"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(value["error"], "misconfigured");
}

#[tokio::test]
async fn collection_stats_and_document_size_limits() {
    let state = test_state().await;
    let app = build_app(state);
    let headers = user_headers("tenant-a", "user-1");
    create_collection(&app, &headers, json!({"name": "sized"})).await;
    create_doc(
        &app,
        &headers,
        "sized",
        json!({"id": "s1", "data": {"name": "one"}}),
    )
    .await;

    let (status, _, collection) =
        call(&app, "GET", "/v1/base/collections/sized", &headers, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(collection["stats"]["documents"], 1);
    assert!(collection["stats"]["bytes"].as_i64().unwrap() > 0);
    assert!(collection["stats"]["lastUpdatedAt"].is_string());

    let (status, _, stats) = call(
        &app,
        "GET",
        "/v1/base/collections/sized/stats",
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stats["id"], collection["id"]);
    assert_eq!(stats["documents"], 1);

    let (status, _, value) = call_raw(
        &app,
        "POST",
        "/v1/base/collections/sized/documents",
        &headers,
        format!("\"{}\"", "a".repeat(5 * 1024 * 1024 + 128)),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(value["error"], "payload_too_large");

    let store = Store::connect(None).await.unwrap();
    let mut config = Config::for_test();
    config.max_document_bytes = 1024;
    let small_state = AppState::new(store, config);
    let small_app = build_app(small_state);
    create_collection(&small_app, &headers, json!({"name": "small"})).await;
    let (status, _, value) = call(
        &small_app,
        "POST",
        "/v1/base/collections/small/documents",
        &headers,
        Some(json!({"data": {"blob": "b".repeat(2000)}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(value["error"], "mapping_error");
    assert!(value["message"].as_str().unwrap().contains("1KB"));
}

#[tokio::test]
async fn sql_compiler_uses_bind_parameters_and_metadata_allowlist() {
    let spec = crate::query::parse_query_spec(
        &json!({
            "where": {"and": [
                {"age": {"gte": 18}},
                {"name": {"contains": "a\" OR true --"}},
                {"status": {"in": ["open", "closed"]}}
            ]},
            "orderBy": [{"field": "age", "direction": "desc"}],
            "limit": 10
        }),
        None,
    )
    .unwrap();
    let compiled = crate::pg_query::compile_query("collection-1", &spec);
    assert!(compiled.where_sql.contains("collection_id = $1"));
    assert!(compiled.where_sql.contains("jsonb_extract_path"));
    assert!(compiled.where_sql.contains("data @>"));
    assert!(compiled.order_sql.contains("\"id\" ASC"));
    assert!(!compiled.where_sql.contains("OR true"));
    assert!(compiled
        .all_params
        .iter()
        .any(|param| matches!(param, crate::pg_query::SqlParam::Text(text) if text.contains("a\" OR true --"))));
    assert!(compiled.where_params.len() < compiled.all_params.len());
}

#[tokio::test]
async fn query_cursor_round_trip() {
    let cursor = crate::query::encode_cursor(42);
    assert!(cursor.chars().all(|c| c != '+' && c != '/' && c != '='));
    let spec = crate::query::parse_query_spec(&json!({"cursor": cursor}), None).unwrap();
    assert_eq!(spec.offset, 42);
    let bad = crate::query::parse_query_spec(&json!({"cursor": "%%%"}), None);
    assert!(bad.is_err());
}

/// Optional live-Postgres coverage for the database namespace and its
/// migration. Skipped unless `BASE_TEST_DATABASE_URL` is set.
#[tokio::test]
async fn postgres_database_namespace_when_configured() {
    let Ok(url) = std::env::var("BASE_TEST_DATABASE_URL") else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let store = Store::connect_with_direct(Some(&url), Some(&url))
        .await
        .expect("postgres connect");
    let mut config = Config::for_test();
    config.database_url = url;
    let app = build_app(AppState::new(store, config));
    let headers = user_headers("live-db-org", "live-db-user");
    let suffix: String = crate::util::random_id().chars().take(8).collect();
    let database_name = format!("app_{suffix}");
    let database = create_database(&app, &headers, json!({"name": database_name})).await;

    let collection =
        create_collection_in(&app, &headers, &database_name, json!({"name": "users"})).await;
    assert_eq!(collection["database"], database_name);
    create_doc_in(
        &app,
        &headers,
        &database_name,
        "users",
        json!({"id": "u1", "data": {"name": "Ada"}}),
    )
    .await;

    // A same-named collection in the legacy default database must not collide.
    let default_collection_name = format!("users_{suffix}");
    create_collection(&app, &headers, json!({"name": default_collection_name})).await;
    create_doc(
        &app,
        &headers,
        &default_collection_name,
        json!({"id": "u1", "data": {"name": "Default"}}),
    )
    .await;

    let (status, _, value) = call(
        &app,
        "GET",
        &format!("/v1/base/databases/{database_name}/collections/users/documents/u1"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["data"]["name"], "Ada");

    let (status, _, value) = call(
        &app,
        "GET",
        &format!("/v1/base/collections/{default_collection_name}/documents/u1"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["data"]["name"], "Default");
    let (status, _, _) = call(
        &app,
        "DELETE",
        &format!("/v1/base/collections/{default_collection_name}"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = call(
        &app,
        "DELETE",
        &format!("/v1/base/databases/{database_name}"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _, value) = call(
        &app,
        "DELETE",
        &format!("/v1/base/databases/{database_name}?cascade=true"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["deletedCollections"], 1);

    let (status, _, _) = call(
        &app,
        "GET",
        &format!("/v1/base/databases/{database_name}"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(database["name"], database_name);
}

/// Optional live-Postgres coverage. CI runs it when `BASE_TEST_DATABASE_URL`
/// points at a disposable database (never at the production database); without
/// it the test is a no-op. Most tests above exercise the in-memory backend.
#[tokio::test]
async fn postgres_live_lifecycle_when_configured() {
    let Ok(url) = std::env::var("BASE_TEST_DATABASE_URL") else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let store = Store::connect_with_direct(Some(&url), Some(&url))
        .await
        .expect("postgres connect");
    let mut config = Config::for_test();
    config.database_url = url;
    let state = AppState::new(store.clone(), config);
    let app = build_app(state);
    let suffix: String = crate::util::random_id().chars().take(8).collect();
    let name = format!("live_{suffix}");
    let headers = user_headers("live-org", "live-user");
    let collection = create_collection(&app, &headers, json!({"name": name})).await;
    let collection_id = collection["id"].as_str().unwrap().to_string();

    let documents = [
        (
            "a",
            "Alpha",
            10,
            json!([1, 0, 0]),
            json!({"lat": 10.7769, "lng": 106.7009}),
            json!(["x"]),
            Some("quick brown fox"),
        ),
        (
            "b",
            "Beta",
            20,
            json!([0, 1, 0]),
            json!({"lat": 10.78, "lng": 106.71}),
            json!(["y"]),
            None,
        ),
        (
            "c",
            "Gamma",
            30,
            json!([0, 0, 1]),
            json!({"lat": 21.0278, "lng": 105.8342}),
            json!(["x", "y"]),
            None,
        ),
        (
            "d",
            "Delta",
            40,
            json!([1, 0, 0]),
            json!({"lat": 10.7769, "lng": 106.7009}),
            json!([]),
            None,
        ),
    ];
    for (id, title, age, embedding, location, tags, description) in documents {
        let mut data = json!({
            "name": title,
            "age": age,
            "embedding": embedding,
            "location": location,
            "tags": tags,
        });
        if let Some(description) = description {
            data["description"] = Value::String(description.to_string());
        }
        create_doc(&app, &headers, &name, json!({"id": id, "data": data})).await;
    }

    let (status, _, gt) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/query"),
        &headers,
        Some(
            json!({"where": {"age": {"gt": 15}}, "orderBy": {"field": "age", "direction": "desc"}}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{gt}");
    let ids: Vec<&str> = gt["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["d", "c", "b"]);
    assert_eq!(gt["total"], 3);

    let (_, _, text) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/query"),
        &headers,
        Some(json!({"where": {"field": "$text", "op": "text", "value": "alpha"}})),
    )
    .await;
    assert_eq!(text["total"], 1);
    assert_eq!(text["items"][0]["id"], "a");

    let (_, _, near) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/query"),
        &headers,
        Some(json!({"where": {"field": "location", "op": "near", "value": {"lat": 10.7769, "lng": 106.7009, "maxDistanceKm": 5}}})),
    )
    .await;
    assert_eq!(near["total"], 3);

    for (body, expected) in [
        (
            json!({"where": {"tags": {"contains": "x"}}}),
            vec!["a", "c"],
        ),
        (json!({"where": {"name": {"startsWith": "A"}}}), vec!["a"]),
        (
            json!({"where": {"name": {"endsWith": "ta"}}}),
            vec!["b", "d"],
        ),
        (
            json!({"where": {"description": {"contains": "brown"}}}),
            vec!["a"],
        ),
        (json!({"where": {"age": {"in": [10, 30]}}}), vec!["a", "c"]),
        (json!({"where": {"age": {"nin": [10, 30]}}}), vec!["b", "d"]),
        (json!({"where": {"age": {"ne": 10}}}), vec!["b", "c", "d"]),
        (
            json!({"where": {"description": {"exists": true}}}),
            vec!["a"],
        ),
        (
            json!({"where": {"description": {"exists": false}}}),
            vec!["b", "c", "d"],
        ),
        (
            json!({"where": {"or": [{"tags": {"contains": "y"}}, {"name": {"eq": "Alpha"}}]}}),
            vec!["a", "b", "c"],
        ),
        (
            json!({"where": {"field": "location", "op": "within", "value": {"bbox": [106.69, 10.77, 106.72, 10.79]}}}),
            vec!["a", "b", "d"],
        ),
        (
            json!({"where": {"field": "description", "op": "text", "value": "BROWN"}}),
            vec!["a"],
        ),
    ] {
        let (status, _, result) = call(
            &app,
            "POST",
            &format!("/v1/base/collections/{name}/query"),
            &headers,
            Some(body),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        let mut ids: Vec<&str> = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        ids.sort();
        let mut expected = expected;
        expected.sort();
        assert_eq!(ids, expected);
    }

    let (_, _, page1) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/query"),
        &headers,
        Some(json!({"orderBy": "id", "limit": 2})),
    )
    .await;
    assert_eq!(page1["total"], 4);
    let cursor = page1["nextCursor"].as_str().unwrap().to_string();
    let (_, _, page2) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/query"),
        &headers,
        Some(json!({"orderBy": "id", "limit": 2, "cursor": cursor})),
    )
    .await;
    let page2_ids: Vec<&str> = page2["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(page2_ids, vec!["c", "d"]);

    let (status, _, batch) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/documents:batch"),
        &headers,
        Some(json!({"operations": [
            {"op": "create", "id": "e", "data": {"name": "Epsilon", "age": 50}},
            {"op": "set", "id": "f", "data": {"name": "Zeta", "age": 60}},
            {"op": "increment", "id": "f", "field": "age", "by": 5},
            {"op": "delete", "id": "e"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{batch}");
    assert_eq!(batch["ok"], true);
    let (_, _, f) = call(
        &app,
        "GET",
        &format!("/v1/base/collections/{name}/documents/f"),
        &headers,
        None,
    )
    .await;
    assert_eq!(f["data"]["age"], 65);

    let (status, _, vector) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/vector-search"),
        &headers,
        Some(json!({"vector": [1, 0, 0], "limit": 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{vector}");
    assert_eq!(vector["items"][0]["id"], "a");

    let (status, _, updated) = call(
        &app,
        "PUT",
        &format!("/v1/base/collections/{name}/documents/a"),
        &headers,
        Some(json!({"data": {"name": "Alpha", "age": 11}, "ifVersion": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["version"], 2);

    let (status, _, incremented) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/documents/a/increment"),
        &headers,
        Some(json!({"field": "age", "by": 4})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(incremented["data"]["age"], 15);

    let since = (chrono::Utc::now() - chrono::Duration::seconds(120))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (status, _, changes) = call(
        &app,
        "GET",
        &format!(
            "/v1/base/collections/{name}/changes?since={}",
            percent_encoding::utf8_percent_encode(&since, percent_encoding::NON_ALPHANUMERIC)
        ),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changes}");
    assert!(changes["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["id"] == "a" && event["operation"] == "update"));

    let (status, _, _) = call(
        &app,
        "DELETE",
        &format!("/v1/base/collections/{name}/documents/d?ifVersion=1"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, changes) = call(
        &app,
        "GET",
        &format!(
            "/v1/base/collections/{name}/changes?since={}",
            percent_encoding::utf8_percent_encode(&since, percent_encoding::NON_ALPHANUMERIC)
        ),
        &headers,
        None,
    )
    .await;
    assert!(changes["changes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["id"] == "d" && event["deleted"] == true));

    let (status, _, nodes) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/graph/nodes"),
        &headers,
        Some(json!({"nodes": [{"id": "n1", "labels": ["A"]}, {"id": "n2", "labels": ["B"]}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{nodes}");
    let (status, _, edges) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/graph/edges"),
        &headers,
        Some(json!({"edges": [{"from": "n1", "to": "n2", "type": "LINKS"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{edges}");
    let (status, _, subgraph) = call(
        &app,
        "GET",
        &format!("/v1/base/collections/{name}/graph/nodes/n1?depth=2"),
        &headers,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{subgraph}");
    assert_eq!(subgraph["nodes"].as_array().unwrap().len(), 2);

    let (status, _, features) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/geo/features"),
        &headers,
        Some(json!({"features": [
            {"id": "g1", "properties": {"k": 1}, "geometry": {"type": "Point", "coordinates": [106.7009, 10.7769]}},
            {"id": "g2", "properties": {"k": 2}, "geometry": {"type": "Point", "coordinates": [105.8342, 21.0278]}}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{features}");
    let (status, _, nearby) = call(
        &app,
        "POST",
        &format!("/v1/base/collections/{name}/geo/near"),
        &headers,
        Some(json!({"lat": 10.7769, "lng": 106.7009, "radiusMeters": 5000})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{nearby}");
    assert_eq!(nearby["features"].as_array().unwrap().len(), 1);
    let (_, _, geo_stats) = call(
        &app,
        "GET",
        &format!("/v1/base/collections/{name}/geo/stats"),
        &headers,
        None,
    )
    .await;
    assert_eq!(geo_stats["features"], 2);

    let (status, _, reindex) = call(
        &app,
        "POST",
        "/v1/search/reindex",
        &headers,
        Some(json!({"collections": [name]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reindex}");
    let (status, _, hits) = call(
        &app,
        "POST",
        "/v1/search",
        &headers,
        Some(json!({"query": "alpha"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{hits}");
    assert!(hits["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["documentId"] == "a"));

    let pool = store.pool().expect("pool");
    let _ = sqlx::query("DELETE FROM synapseone_search_index WHERE collection_id = $1")
        .bind(&collection_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM synapseone_base_outbox WHERE collection_id = $1")
        .bind(&collection_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM synapseone_base_collections WHERE id = $1")
        .bind(&collection_id)
        .execute(pool)
        .await;
}
