// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Legacy `/v1/storage` contract tests.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;
use synapseone_ocs::backend::validate_key;

const BINARY: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];

#[tokio::test]
async fn health_and_metrics() {
    let (app, _dir) = fs_app();
    let health = request(&app, "GET", "/health", None, vec![]).await;
    assert_eq!(health.status, StatusCode::OK);
    let body = health.json();
    assert_eq!(body["service"], "storage");
    assert_eq!(body["product"], "SynapseOCS");
    assert_eq!(body["backend"], "fs");
    assert_eq!(body["capabilities"]["buckets"], true);
    assert_eq!(body["capabilities"]["presign"], false);
    assert_eq!(body["capabilities"]["multipart"], true);

    let metrics = request(&app, "GET", "/metrics", None, vec![]).await;
    assert_eq!(metrics.status, StatusCode::OK);
    assert!(metrics.text().contains("synapseone_storage_up 1"));
    assert!(metrics.text().contains("synapseone_ocs_up 1"));
    assert!(metrics
        .text()
        .contains("synapseone_storage_backend{backend=\"fs\"} 1"));
    assert_eq!(metrics.header("content-type"), "text/plain; version=0.0.4");
}

#[tokio::test]
async fn put_get_head_delete_binary_roundtrip() {
    let (app, _dir) = fs_app();
    let checksum = sha256_hex(BINARY);
    let mut headers = default_headers();
    with_header(&mut headers, "content-type", "image/png");
    with_header(&mut headers, "x-object-checksum-sha256", &checksum);
    let put = request(
        &app,
        "PUT",
        "/v1/storage/objects/reports/2026/photo.png",
        Some(BINARY.to_vec()),
        headers,
    )
    .await;
    assert_eq!(put.status, StatusCode::CREATED, "{}", put.text());
    assert_eq!(put.json()["object"]["size"], BINARY.len());
    assert_eq!(put.json()["object"]["contentType"], "image/png");
    assert_eq!(put.json()["object"]["checksumSha256"], checksum);
    assert_eq!(put.header("etag"), format!("\"{}\"", checksum));

    let get = request(
        &app,
        "GET",
        "/v1/storage/objects/reports/2026/photo.png",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(get.status, StatusCode::OK);
    assert_eq!(get.body.as_ref(), BINARY);
    assert_eq!(get.header("content-type"), "image/png");
    assert_eq!(get.header("x-object-checksum-sha256"), checksum);
    assert_eq!(get.header("content-length"), BINARY.len().to_string());

    let head = request(
        &app,
        "HEAD",
        "/v1/storage/objects/reports/2026/photo.png",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert!(head.body.is_empty());
    assert_eq!(head.header("content-length"), BINARY.len().to_string());
    assert_eq!(head.header("etag"), format!("\"{}\"", checksum));

    let list = request(
        &app,
        "GET",
        "/v1/storage/objects?prefix=reports/",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.json()["objects"][0]["key"], "reports/2026/photo.png");
    assert_eq!(list.json()["objects"].as_array().unwrap().len(), 1);
    assert!(list.json()["nextCursor"].is_null());

    let overwrite = request(
        &app,
        "PUT",
        "/v1/storage/objects/reports/2026/photo.png",
        Some(b"second".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(overwrite.status, StatusCode::OK);

    let delete = request(
        &app,
        "DELETE",
        "/v1/storage/objects/reports/2026/photo.png",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(delete.status, StatusCode::OK);
    assert_eq!(delete.json()["ok"], true);
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/storage/objects/reports/2026/photo.png",
            None,
            default_headers()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "HEAD",
            "/v1/storage/objects/reports/2026/photo.png",
            None,
            default_headers()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn rejects_checksum_mismatch_empty_bodies_and_traversal() {
    let (app, _dir) = fs_app();
    let mut headers = default_headers();
    with_header(&mut headers, "x-object-checksum-sha256", "deadbeef");
    let bad = request(
        &app,
        "PUT",
        "/v1/storage/objects/a.txt",
        Some(b"hello".to_vec()),
        headers,
    )
    .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad.json()["error"], "checksum_mismatch");
    assert_eq!(bad.json()["expected"], sha256_hex(b"hello"));

    let empty = request(
        &app,
        "PUT",
        "/v1/storage/objects/empty.txt",
        Some(Vec::new()),
        default_headers(),
    )
    .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(empty.json()["error"], "empty_body");

    assert!(validate_key("../etc/passwd")
        .unwrap_or_default()
        .contains("traversal"));
    assert!(validate_key("/absolute")
        .unwrap_or_default()
        .contains("start"));
    assert_eq!(validate_key("ok/path-1.png"), None);

    let traversal = request(
        &app,
        "PUT",
        "/v1/storage/objects/reports/../escape.txt",
        Some(b"x".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(traversal.status, StatusCode::BAD_REQUEST);
    assert_eq!(traversal.json()["error"], "invalid_key");

    let unsafe_get = request(
        &app,
        "GET",
        "/v1/storage/objects/reports/../escape.txt",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(unsafe_get.status, StatusCode::NOT_FOUND);

    let encoded_space = request(
        &app,
        "PUT",
        "/v1/storage/objects/a%20b.txt",
        Some(b"x".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(encoded_space.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn tenant_isolation() {
    let (app, _dir) = fs_app();
    let put = request(
        &app,
        "PUT",
        "/v1/storage/objects/secret.txt",
        Some(b"tenant-a only".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(put.status, StatusCode::CREATED);

    let same = request(
        &app,
        "GET",
        "/v1/storage/objects/secret.txt",
        None,
        tenant_headers("org-a", "user-1"),
    )
    .await;
    assert_eq!(same.status, StatusCode::OK);
    assert_eq!(same.body.as_ref(), b"tenant-a only");

    let other = request(
        &app,
        "GET",
        "/v1/storage/objects/secret.txt",
        None,
        tenant_headers("org-b", "user-1"),
    )
    .await;
    assert_eq!(other.status, StatusCode::NOT_FOUND);
    let other_list = request(
        &app,
        "GET",
        "/v1/storage/objects",
        None,
        tenant_headers("org-b", "user-1"),
    )
    .await;
    assert_eq!(other_list.json()["objects"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn list_prefix_and_pagination() {
    let (app, _dir) = fs_app();
    for key in ["docs/a.txt", "docs/b.txt", "docs/c.txt", "other/d.txt"] {
        let put = request(
            &app,
            "PUT",
            &format!("/v1/storage/objects/{key}"),
            Some(b"x".to_vec()),
            default_headers(),
        )
        .await;
        assert_eq!(put.status, StatusCode::CREATED);
    }
    let first = request(
        &app,
        "GET",
        "/v1/storage/objects?prefix=docs/&limit=2",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.json()["objects"].as_array().unwrap().len(), 2);
    let cursor = first.json()["nextCursor"].as_str().unwrap().to_string();
    assert_eq!(cursor, "docs/b.txt");

    let second = request(
        &app,
        "GET",
        &format!("/v1/storage/objects?prefix=docs/&limit=2&cursor={cursor}"),
        None,
        default_headers(),
    )
    .await;
    assert_eq!(second.json()["objects"].as_array().unwrap().len(), 1);
    assert_eq!(second.json()["objects"][0]["key"], "docs/c.txt");
    assert!(second.json()["nextCursor"].is_null());

    let bad_prefix = request(
        &app,
        "GET",
        "/v1/storage/objects?prefix=../x",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(bad_prefix.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_prefix.json()["error"], "invalid_prefix");

    for query in ["limit=0", "limit=1001", "limit=abc", "limit=1.5"] {
        let response = request(
            &app,
            "GET",
            &format!("/v1/storage/objects?{query}"),
            None,
            default_headers(),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(response.json()["error"], "invalid_limit");
    }
}

#[tokio::test]
async fn tenant_quota_is_enforced_and_overwrites_are_replaced() {
    let (app, _dir) = fs_app_with(|config| config.tenant_quota_bytes = 1024);
    let first = request(
        &app,
        "PUT",
        "/v1/storage/objects/a.bin",
        Some(vec![1u8; 600]),
        default_headers(),
    )
    .await;
    assert_eq!(first.status, StatusCode::CREATED);
    let second = request(
        &app,
        "PUT",
        "/v1/storage/objects/b.bin",
        Some(vec![2u8; 600]),
        default_headers(),
    )
    .await;
    assert_eq!(second.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(second.json()["error"], "quota_exceeded");
    assert_eq!(second.json()["usedBytes"], 600);
    assert_eq!(second.json()["quotaBytes"], 1024);

    let overwrite = request(
        &app,
        "PUT",
        "/v1/storage/objects/a.bin",
        Some(vec![3u8; 600]),
        default_headers(),
    )
    .await;
    assert_eq!(overwrite.status, StatusCode::OK);
}

#[tokio::test]
async fn max_object_size_and_allowed_types() {
    let (app, _dir) = fs_app_with(|config| {
        config.max_object_bytes = 1024;
        config.allowed_types = vec!["image/png".into()];
    });
    let too_large = request(
        &app,
        "PUT",
        "/v1/storage/objects/big.bin",
        Some(vec![0u8; 1025]),
        default_headers(),
    )
    .await;
    assert_eq!(too_large.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(too_large.json()["error"], "object_too_large");
    assert!(too_large.json()["message"]
        .as_str()
        .unwrap()
        .contains("1024"));

    let mut wrong_type = default_headers();
    with_header(&mut wrong_type, "content-type", "text/plain");
    let rejected = request(
        &app,
        "PUT",
        "/v1/storage/objects/a.txt",
        Some(b"x".to_vec()),
        wrong_type,
    )
    .await;
    assert_eq!(rejected.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(rejected.json()["error"], "unsupported_media_type");
    assert_eq!(rejected.json()["allowed"][0], "image/png");

    let mut allowed = default_headers();
    with_header(&mut allowed, "content-type", "image/png");
    let accepted = request(
        &app,
        "PUT",
        "/v1/storage/objects/a.png",
        Some(b"x".to_vec()),
        allowed,
    )
    .await;
    assert_eq!(accepted.status, StatusCode::CREATED);
}

#[tokio::test]
async fn multipart_upload_assembles_parts_and_aborts() {
    let (app, _dir) = fs_app();
    let created = json_request(
        &app,
        "POST",
        "/v1/storage/uploads",
        &json!({"key": "big/video.bin", "contentType": "application/octet-stream"}),
        default_headers(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let upload_id = created.json()["uploadId"].as_str().unwrap().to_string();
    assert_eq!(created.json()["key"], "big/video.bin");

    let part1 = vec![1u8; 1024];
    let part2 = vec![2u8; 2048];
    let first = request(
        &app,
        "PUT",
        &format!("/v1/storage/uploads/{upload_id}/parts/1?key=big/video.bin"),
        Some(part1.clone()),
        default_headers(),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    assert_eq!(first.json()["size"], 1024);
    assert_eq!(first.json()["etag"], sha256_hex(&part1));
    let second = request(
        &app,
        "PUT",
        &format!("/v1/storage/uploads/{upload_id}/parts/2?key=big/video.bin"),
        Some(part2.clone()),
        default_headers(),
    )
    .await;
    assert_eq!(second.status, StatusCode::OK);

    let completed = json_request(
        &app,
        "POST",
        &format!("/v1/storage/uploads/{upload_id}/complete"),
        &json!({
            "key": "big/video.bin",
            "parts": [
                {"partNumber": 2, "etag": second.json()["etag"]},
                {"partNumber": 1, "etag": first.json()["etag"]}
            ]
        }),
        default_headers(),
    )
    .await;
    assert_eq!(
        completed.status,
        StatusCode::CREATED,
        "{}",
        completed.text()
    );
    assert_eq!(completed.json()["object"]["size"], 3072);
    let get = request(
        &app,
        "GET",
        "/v1/storage/objects/big/video.bin",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(get.status, StatusCode::OK);
    assert_eq!(get.body.len(), 3072);
    assert_eq!(get.body[0], 1);
    assert_eq!(get.body[1024], 2);

    let aborted = json_request(
        &app,
        "POST",
        "/v1/storage/uploads",
        &json!({"key": "big/aborted.bin"}),
        default_headers(),
    )
    .await;
    let abort_id = aborted.json()["uploadId"].as_str().unwrap().to_string();
    let abort = request(
        &app,
        "DELETE",
        &format!("/v1/storage/uploads/{abort_id}"),
        None,
        default_headers(),
    )
    .await;
    assert_eq!(abort.status, StatusCode::OK);
    let missing = json_request(
        &app,
        "POST",
        &format!("/v1/storage/uploads/{abort_id}/complete"),
        &json!({"key": "big/aborted.bin", "parts": [{"partNumber": 1, "etag": "x"}]}),
        default_headers(),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_GATEWAY);
    assert_eq!(missing.json()["error"], "backend_error");
}

#[tokio::test]
async fn multipart_invalid_inputs() {
    let (app, _dir) = fs_app();
    let bad_key = json_request(
        &app,
        "POST",
        "/v1/storage/uploads",
        &json!({"key": "../escape"}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_key.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_key.json()["error"], "invalid_key");

    let created = json_request(
        &app,
        "POST",
        "/v1/storage/uploads",
        &json!({"key": "video.bin"}),
        default_headers(),
    )
    .await;
    let upload_id = created.json()["uploadId"].as_str().unwrap().to_string();
    let invalid_part = request(
        &app,
        "PUT",
        &format!("/v1/storage/uploads/{upload_id}/parts/0?key=video.bin"),
        Some(b"x".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(invalid_part.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_part.json()["error"], "invalid_part_number");

    let empty = request(
        &app,
        "PUT",
        &format!("/v1/storage/uploads/{upload_id}/parts/1?key=video.bin"),
        Some(Vec::new()),
        default_headers(),
    )
    .await;
    assert_eq!(empty.status, StatusCode::BAD_REQUEST);
    assert_eq!(empty.json()["error"], "empty_body");

    let no_parts = json_request(
        &app,
        "POST",
        &format!("/v1/storage/uploads/{upload_id}/complete"),
        &json!({"key": "video.bin", "parts": []}),
        default_headers(),
    )
    .await;
    assert_eq!(no_parts.status, StatusCode::BAD_REQUEST);
    assert_eq!(no_parts.json()["error"], "invalid_parts");

    let missing_etag = json_request(
        &app,
        "POST",
        &format!("/v1/storage/uploads/{upload_id}/complete"),
        &json!({"key": "video.bin", "parts": [{"partNumber": 1}]}),
        default_headers(),
    )
    .await;
    assert_eq!(missing_etag.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing_etag.json()["error"], "invalid_parts");
}

#[tokio::test]
async fn presign_is_unsupported_on_filesystem() {
    let (app, _dir) = fs_app();
    let response = json_request(
        &app,
        "POST",
        "/v1/storage/presign",
        &json!({"key": "a.txt", "method": "GET"}),
        default_headers(),
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(response.json()["error"], "presign_unsupported");
    assert_eq!(response.json()["backend"], "fs");

    let bad_key = json_request(
        &app,
        "POST",
        "/v1/storage/presign",
        &json!({"key": "../x"}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_key.status, StatusCode::BAD_REQUEST);
    let bad_ttl = json_request(
        &app,
        "POST",
        "/v1/storage/presign",
        &json!({"key": "a.txt", "expiresIn": 0}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_ttl.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_ttl.json()["error"], "invalid_expires_in");
}

#[tokio::test]
async fn legacy_synapsedx_headers_are_honoured() {
    let (app, _dir) = fs_app();
    let legacy_headers = vec![
        ("x-synapsedx-user".to_string(), "user-legacy".to_string()),
        ("x-synapsedx-org".to_string(), "org-legacy".to_string()),
        ("x-synapsedx-kind".to_string(), "user".to_string()),
    ];
    let put = request(
        &app,
        "PUT",
        "/v1/storage/objects/legacy-header.txt",
        Some(b"ok".to_vec()),
        legacy_headers,
    )
    .await;
    assert_eq!(put.status, StatusCode::CREATED);
    let get = request(
        &app,
        "GET",
        "/v1/storage/objects/legacy-header.txt",
        None,
        tenant_headers("org-legacy", "user-legacy"),
    )
    .await;
    assert_eq!(get.status, StatusCode::OK);
    assert_eq!(get.body.as_ref(), b"ok");
}

#[tokio::test]
async fn tenant_required_and_explicit_tenant_header() {
    let (app, _dir) = fs_app();
    let missing = request(&app, "GET", "/v1/storage/objects", None, vec![]).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert_eq!(missing.json()["error"], "tenant_required");

    let explicit = request(
        &app,
        "GET",
        "/v1/storage/objects",
        None,
        vec![("x-synapseone-tenant".into(), "acme:team.1".into())],
    )
    .await;
    assert_eq!(explicit.status, StatusCode::OK);

    let invalid = request(
        &app,
        "GET",
        "/v1/storage/objects",
        None,
        vec![("x-synapseone-tenant".into(), "bad tenant".into())],
    )
    .await;
    assert_eq!(invalid.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn production_internal_secret_gate() {
    let (app, _dir) = fs_app_with(|config| {
        config.is_prod = true;
        config.internal_secret = "top-secret".into();
        config.cors_origins = vec!["https://console.example".into()];
    });
    let no_secret = request(&app, "GET", "/v1/storage/objects", None, default_headers()).await;
    assert_eq!(no_secret.status, StatusCode::UNAUTHORIZED);
    assert_eq!(no_secret.json()["error"], "unauthorized");
    assert_eq!(
        no_secret.json()["message"],
        "Missing or invalid internal secret"
    );

    let mut wrong = default_headers();
    with_header(&mut wrong, "x-synapseone-internal", "wrong");
    let wrong = request(&app, "GET", "/v1/storage/objects", None, wrong).await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);

    let mut right = default_headers();
    with_header(&mut right, "x-synapseone-internal", "top-secret");
    let allowed = request(&app, "GET", "/v1/storage/objects", None, right.clone()).await;
    assert_eq!(allowed.status, StatusCode::OK);

    let health = request(&app, "GET", "/health", None, vec![]).await;
    assert_eq!(health.status, StatusCode::OK);

    let mut other_tenant = tenant_headers("org-b", "user-2");
    with_header(&mut other_tenant, "x-synapseone-internal", "top-secret");
    let isolated = request(&app, "GET", "/v1/storage/objects", None, other_tenant).await;
    assert_eq!(isolated.status, StatusCode::OK);

    let signed = request(&app, "GET", "/v1/ocs/signed", None, vec![]).await;
    assert_eq!(signed.status, StatusCode::FORBIDDEN);
    assert_eq!(signed.json()["error"], "invalid_presign_token");
}

#[tokio::test]
async fn unknown_routes_and_methods_return_not_found() {
    let (app, _dir) = fs_app();
    let missing = request(&app, "GET", "/v1/storage/nope", None, default_headers()).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["error"], "not_found");

    let wrong_method = request(
        &app,
        "PATCH",
        "/v1/storage/objects",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(wrong_method.status, StatusCode::NOT_FOUND);
    assert_eq!(wrong_method.json()["error"], "not_found");
}

#[tokio::test]
async fn cors_preflight_is_handled_before_tenant_gate() {
    let (app, _dir) = fs_app();
    let response = request(
        &app,
        "OPTIONS",
        "/v1/storage/objects",
        None,
        vec![
            ("origin".into(), "https://console.example".into()),
            ("access-control-request-method".into(), "PUT".into()),
            (
                "access-control-request-headers".into(),
                "content-type".into(),
            ),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::NO_CONTENT);
    assert_eq!(response.header("access-control-allow-origin"), "*");
}

#[tokio::test]
async fn request_id_and_security_headers_are_present() {
    let (app, _dir) = fs_app();
    let mut headers = default_headers();
    with_header(&mut headers, "x-request-id", "req-123");
    let response = request(&app, "GET", "/v1/storage/objects", None, headers).await;
    assert_eq!(response.header("x-request-id"), "req-123");
    assert_eq!(response.header("x-content-type-options"), "nosniff");
    assert_eq!(response.header("referrer-policy"), "no-referrer");

    let generated = request(&app, "GET", "/v1/storage/objects", None, default_headers()).await;
    assert!(!generated.header("x-request-id").is_empty());
}
