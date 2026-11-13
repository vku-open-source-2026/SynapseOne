// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOCS bucket/object contract tests.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;
use synapseone_ocs::backend::{checksum_hex, FileBackend};
use synapseone_ocs::ocs::{create_presign_token, internal_key, marker_key, PresignPayload};
use synapseone_ocs::{build_app, Backend};

async fn create_bucket(app: &axum::Router, name: &str) -> TestResponse {
    json_request(
        app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": name}),
        default_headers(),
    )
    .await
}

#[tokio::test]
async fn bucket_lifecycle_head_stats_and_tenant_isolation() {
    let (app, _dir) = fs_app();
    let created = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": "city-assets", "quotaBytes": 4096}),
        default_headers(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    assert_eq!(created.json()["bucket"]["name"], "city-assets");
    assert_eq!(created.json()["bucket"]["quotaBytes"], 4096);
    assert_eq!(created.json()["bucket"]["owner"], "user-1");
    assert_eq!(created.json()["bucket"]["objects"], 0);

    let list = request(
        &app,
        "GET",
        "/v1/ocs/buckets?withStats=1",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(list.status, StatusCode::OK);
    let list_body = list.json();
    let names = list_body["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bucket| bucket["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["city-assets", "default"]);
    assert_eq!(list.json()["total"], 2);
    assert_eq!(list.json()["buckets"][0]["bytes"], 0);

    let head = request(
        &app,
        "HEAD",
        "/v1/ocs/buckets/city-assets",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert_eq!(head.header("x-ocs-bucket"), "city-assets");
    assert_eq!(head.header("x-ocs-quota-bytes"), "4096");

    let get = request(
        &app,
        "GET",
        "/v1/ocs/buckets/city-assets",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(get.status, StatusCode::OK);
    assert_eq!(get.header("cache-control"), "no-store");
    assert_eq!(get.json()["bucket"]["objects"], 0);
    assert_eq!(get.json()["bucket"]["bytes"], 0);

    let stats = request(
        &app,
        "GET",
        "/v1/ocs/buckets/city-assets/stats",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(stats.status, StatusCode::OK);
    assert_eq!(stats.json()["bucket"], "city-assets");
    assert_eq!(stats.json()["quotaBytes"], 4096);

    let other_tenant = request(
        &app,
        "GET",
        "/v1/ocs/buckets/city-assets",
        None,
        tenant_headers("org-b", "user-1"),
    )
    .await;
    assert_eq!(other_tenant.status, StatusCode::NOT_FOUND);
    assert_eq!(other_tenant.json()["error"], "bucket_not_found");

    let missing_head = request(
        &app,
        "HEAD",
        "/v1/ocs/buckets/missing-bucket",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(missing_head.status, StatusCode::NOT_FOUND);
    assert!(missing_head.body.is_empty());
}

#[tokio::test]
async fn bucket_validation_and_conflicts() {
    let (app, _dir) = fs_app();
    let invalid = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": "Bad Name"}),
        default_headers(),
    )
    .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.json()["error"], "invalid_bucket_name");

    let reserved = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": "default"}),
        default_headers(),
    )
    .await;
    assert_eq!(reserved.status, StatusCode::CONFLICT);
    assert_eq!(reserved.json()["error"], "bucket_exists");

    assert_eq!(
        create_bucket(&app, "city-assets").await.status,
        StatusCode::CREATED
    );
    let duplicate = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": "City-Assets"}),
        default_headers(),
    )
    .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);
    assert_eq!(duplicate.json()["error"], "bucket_exists");

    for quota in [json!(0), json!(1023), json!("nope"), json!(1024.5)] {
        let response = json_request(
            &app,
            "POST",
            "/v1/ocs/buckets",
            &json!({"name": "quota-test", "quotaBytes": quota}),
            default_headers(),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
        assert_eq!(response.json()["error"], "invalid_quota");
    }
}

async fn put_bucket_object(
    app: &axum::Router,
    bucket: &str,
    key: &str,
    body: &[u8],
) -> TestResponse {
    let mut headers = default_headers();
    headers.push(("content-type".into(), "text/plain".into()));
    headers.push(("x-object-checksum-sha256".into(), checksum_hex(body)));
    request(
        app,
        "PUT",
        &format!("/v1/ocs/buckets/{bucket}/objects/{key}"),
        Some(body.to_vec()),
        headers,
    )
    .await
}

#[tokio::test]
async fn object_put_get_head_list_copy_delete() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "docs").await.status,
        StatusCode::CREATED
    );
    let body = b"0123456789";
    let put = put_bucket_object(&app, "docs", "2026/10/report.txt", body).await;
    assert_eq!(put.status, StatusCode::CREATED, "{}", put.text());
    assert_eq!(put.json()["object"]["bucket"], "docs");
    assert_eq!(put.json()["object"]["key"], "2026/10/report.txt");
    assert_eq!(put.json()["object"]["size"], 10);
    assert_eq!(put.json()["object"]["checksumSha256"], checksum_hex(body));
    assert_eq!(put.header("etag"), format!("\"{}\"", checksum_hex(body)));

    let get = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects/2026/10/report.txt",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(get.status, StatusCode::OK);
    assert_eq!(get.body.as_ref(), body);
    assert_eq!(get.header("etag"), format!("\"{}\"", checksum_hex(body)));
    assert_eq!(get.header("accept-ranges"), "bytes");
    assert_eq!(get.header("x-ocs-bucket"), "docs");
    assert_eq!(get.header("x-object-key"), "2026/10/report.txt");

    let head = request(
        &app,
        "HEAD",
        "/v1/ocs/buckets/docs/objects/2026/10/report.txt",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert_eq!(head.header("content-length"), "10");
    assert!(head.body.is_empty());

    let flat = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects?prefix=2026/",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(flat.status, StatusCode::OK);
    assert_eq!(flat.json()["objects"].as_array().unwrap().len(), 1);
    assert_eq!(flat.json()["objects"][0]["key"], "2026/10/report.txt");
    assert!(flat.json()["nextCursor"].is_null());

    let delimiter = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects?prefix=2026/&delimiter=/",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(delimiter.status, StatusCode::OK);
    assert_eq!(delimiter.json()["commonPrefixes"][0], "2026/10/");
    assert_eq!(delimiter.json()["objects"].as_array().unwrap().len(), 0);
    assert_eq!(delimiter.json()["delimiter"], "/");

    let copied = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/docs/objects/copy",
        &json!({"sourceKey": "2026/10/report.txt", "destinationKey": "archive/report.txt"}),
        default_headers(),
    )
    .await;
    assert_eq!(copied.status, StatusCode::CREATED, "{}", copied.text());
    assert_eq!(copied.json()["source"]["key"], "2026/10/report.txt");
    let archived = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects/archive/report.txt",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(archived.body.as_ref(), body);

    let deleted = request(
        &app,
        "DELETE",
        "/v1/ocs/buckets/docs/objects/archive/report.txt",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(deleted.status, StatusCode::OK);
    assert_eq!(deleted.json()["key"], "archive/report.txt");
    assert_eq!(
        request(
            &app,
            "HEAD",
            "/v1/ocs/buckets/docs/objects/archive/report.txt",
            None,
            default_headers()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn range_requests_and_invalid_ranges() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "docs").await.status,
        StatusCode::CREATED
    );
    put_bucket_object(&app, "docs", "numbers.txt", b"0123456789").await;

    let ranged = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects/numbers.txt",
        None,
        {
            let mut headers = default_headers();
            with_header(&mut headers, "range", "bytes=2-5");
            headers
        },
    )
    .await;
    assert_eq!(ranged.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.body.as_ref(), b"2345");
    assert_eq!(ranged.header("content-range"), "bytes 2-5/10");
    assert_eq!(ranged.header("content-length"), "4");

    let open = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects/numbers.txt",
        None,
        {
            let mut headers = default_headers();
            with_header(&mut headers, "range", "bytes=5-");
            headers
        },
    )
    .await;
    assert_eq!(open.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(open.body.as_ref(), b"56789");

    let suffix = request(
        &app,
        "GET",
        "/v1/ocs/buckets/docs/objects/numbers.txt",
        None,
        {
            let mut headers = default_headers();
            with_header(&mut headers, "range", "bytes=-3");
            headers
        },
    )
    .await;
    assert_eq!(suffix.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(suffix.body.as_ref(), b"789");
    assert_eq!(suffix.header("content-range"), "bytes 7-9/10");

    for range in ["bytes=20-30", "bytes=5-2", "bytes=abc", "bytes=0-1,3-4"] {
        let invalid = request(
            &app,
            "GET",
            "/v1/ocs/buckets/docs/objects/numbers.txt",
            None,
            {
                let mut headers = default_headers();
                with_header(&mut headers, "range", range);
                headers
            },
        )
        .await;
        assert_eq!(invalid.status, StatusCode::RANGE_NOT_SATISFIABLE, "{range}");
        assert_eq!(invalid.json()["error"], "invalid_range");
        assert_eq!(invalid.header("content-range"), "bytes */10");
    }
}

#[tokio::test]
async fn conditional_get_etag_semantics() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "docs").await.status,
        StatusCode::CREATED
    );
    put_bucket_object(&app, "docs", "a.txt", b"hello").await;
    let etag = format!("\"{}\"", checksum_hex(b"hello"));

    let not_modified = request(&app, "GET", "/v1/ocs/buckets/docs/objects/a.txt", None, {
        let mut headers = default_headers();
        with_header(&mut headers, "if-none-match", &etag);
        headers
    })
    .await;
    assert_eq!(not_modified.status, StatusCode::NOT_MODIFIED);
    assert!(not_modified.body.is_empty());

    let wildcard = request(&app, "GET", "/v1/ocs/buckets/docs/objects/a.txt", None, {
        let mut headers = default_headers();
        with_header(&mut headers, "if-none-match", "*");
        headers
    })
    .await;
    assert_eq!(wildcard.status, StatusCode::NOT_MODIFIED);

    let precondition = request(&app, "GET", "/v1/ocs/buckets/docs/objects/a.txt", None, {
        let mut headers = default_headers();
        with_header(&mut headers, "if-match", "\"nope\"");
        headers
    })
    .await;
    assert_eq!(precondition.status, StatusCode::PRECONDITION_FAILED);
    assert_eq!(precondition.json()["error"], "precondition_failed");

    let matched = request(&app, "GET", "/v1/ocs/buckets/docs/objects/a.txt", None, {
        let mut headers = default_headers();
        with_header(&mut headers, "if-match", &etag);
        headers
    })
    .await;
    assert_eq!(matched.status, StatusCode::OK);
}

#[tokio::test]
async fn list_pagination_delimiter_and_errors() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "files").await.status,
        StatusCode::CREATED
    );
    for key in ["a/1.txt", "a/2.txt", "b/3.txt", "top.txt"] {
        let response = put_bucket_object(&app, "files", key, b"x").await;
        assert_eq!(response.status, StatusCode::CREATED);
    }

    let first = request(
        &app,
        "GET",
        "/v1/ocs/buckets/files/objects?prefix=a/&limit=1",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.json()["objects"].as_array().unwrap().len(), 1);
    let cursor = first.json()["nextCursor"].as_str().unwrap().to_string();
    assert!(!cursor.is_empty());

    let second = request(
        &app,
        "GET",
        &format!("/v1/ocs/buckets/files/objects?prefix=a/&limit=1&cursor={cursor}"),
        None,
        default_headers(),
    )
    .await;
    assert_eq!(second.json()["objects"][0]["key"], "a/2.txt");
    assert!(second.json()["nextCursor"].is_null());

    let delimited = request(
        &app,
        "GET",
        "/v1/ocs/buckets/files/objects?delimiter=/",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(delimited.json()["commonPrefixes"][0], "a/");
    assert_eq!(delimited.json()["commonPrefixes"][1], "b/");
    let delimited_body = delimited.json();
    let objects = delimited_body["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0]["key"], "top.txt");

    let invalid_delimiter = request(
        &app,
        "GET",
        "/v1/ocs/buckets/files/objects?delimiter=//",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(invalid_delimiter.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_delimiter.json()["error"], "invalid_delimiter");

    let invalid_limit = request(
        &app,
        "GET",
        "/v1/ocs/buckets/files/objects?limit=0",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(invalid_limit.status, StatusCode::BAD_GATEWAY);
    assert_eq!(invalid_limit.json()["error"], "backend_error");

    let invalid_prefix = request(
        &app,
        "GET",
        "/v1/ocs/buckets/files/objects?prefix=../x",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(invalid_prefix.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_prefix.json()["error"], "invalid_prefix");
}

#[tokio::test]
async fn bucket_and_tenant_quotas() {
    let (app, _dir) = fs_app();
    let created = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets",
        &json!({"name": "quota-bucket", "quotaBytes": 1024}),
        default_headers(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED);

    assert_eq!(
        put_bucket_object(&app, "quota-bucket", "first.bin", &vec![1u8; 700])
            .await
            .status,
        StatusCode::CREATED
    );
    let bucket_full = put_bucket_object(&app, "quota-bucket", "second.bin", &vec![2u8; 700]).await;
    assert_eq!(bucket_full.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(bucket_full.json()["error"], "bucket_quota_exceeded");
    assert_eq!(bucket_full.json()["details"]["usedBytes"], 700);
    assert_eq!(bucket_full.json()["details"]["quotaBytes"], 1024);

    let overwrite = put_bucket_object(&app, "quota-bucket", "first.bin", &vec![3u8; 700]).await;
    assert_eq!(overwrite.status, StatusCode::OK);

    let (tenant_app, _tenant_dir) = fs_app_with(|config| config.tenant_quota_bytes = 1024);
    assert_eq!(
        create_bucket(&tenant_app, "second-bucket").await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        put_bucket_object(&tenant_app, "second-bucket", "one.bin", &vec![4u8; 700])
            .await
            .status,
        StatusCode::CREATED
    );
    let tenant_full =
        put_bucket_object(&tenant_app, "second-bucket", "two.bin", &vec![4u8; 700]).await;
    assert_eq!(tenant_full.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(tenant_full.json()["error"], "quota_exceeded");
    assert_eq!(tenant_full.json()["details"]["quotaBytes"], 1024);
    assert!(tenant_full.json()["details"]["usedBytes"].as_u64().unwrap() >= 700);
}

#[tokio::test]
async fn bucket_delete_refuses_non_empty_unless_forced() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "trash-me").await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        put_bucket_object(&app, "trash-me", "a.txt", b"a")
            .await
            .status,
        StatusCode::CREATED
    );
    let refused = request(
        &app,
        "DELETE",
        "/v1/ocs/buckets/trash-me",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.json()["error"], "bucket_not_empty");
    assert_eq!(refused.json()["objects"], 1);

    let forced = request(
        &app,
        "DELETE",
        "/v1/ocs/buckets/trash-me?force=true",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(forced.status, StatusCode::OK);
    assert_eq!(forced.json()["deletedObjects"], 1);
    assert_eq!(
        request(
            &app,
            "HEAD",
            "/v1/ocs/buckets/trash-me",
            None,
            default_headers()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    let default_delete = request(
        &app,
        "DELETE",
        "/v1/ocs/buckets/default",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(default_delete.status, StatusCode::FORBIDDEN);
    assert_eq!(default_delete.json()["error"], "default_bucket_protected");
    assert_eq!(
        request(
            &app,
            "DELETE",
            "/v1/ocs/buckets/missing-bucket",
            None,
            default_headers()
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn multipart_upload_is_bucket_aware() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "media").await.status,
        StatusCode::CREATED
    );
    let created = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/uploads",
        &json!({"key": "video.bin", "contentType": "application/octet-stream"}),
        default_headers(),
    )
    .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let upload_id = created.json()["uploadId"].as_str().unwrap().to_string();
    assert_eq!(created.json()["bucket"], "media");

    let part1 = request(
        &app,
        "PUT",
        &format!("/v1/ocs/buckets/media/uploads/{upload_id}/parts/1?key=video.bin"),
        Some(vec![1u8; 10]),
        default_headers(),
    )
    .await;
    let part2 = request(
        &app,
        "PUT",
        &format!("/v1/ocs/buckets/media/uploads/{upload_id}/parts/2?key=video.bin"),
        Some(vec![2u8; 20]),
        default_headers(),
    )
    .await;
    assert_eq!(part1.status, StatusCode::OK);
    assert_eq!(part2.status, StatusCode::OK);
    let completed = json_request(
        &app,
        "POST",
        &format!("/v1/ocs/buckets/media/uploads/{upload_id}/complete"),
        &json!({
            "key": "video.bin",
            "parts": [
                {"partNumber": 1, "etag": part1.json()["etag"]},
                {"partNumber": 2, "etag": part2.json()["etag"]}
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
    assert_eq!(completed.json()["object"]["size"], 30);
    assert_eq!(completed.json()["object"]["bucket"], "media");
    let get = request(
        &app,
        "GET",
        "/v1/ocs/buckets/media/objects/video.bin",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(get.body.len(), 30);

    let aborted = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/uploads",
        &json!({"key": "aborted.bin"}),
        default_headers(),
    )
    .await;
    let abort_id = aborted.json()["uploadId"].as_str().unwrap().to_string();
    let abort = request(
        &app,
        "DELETE",
        &format!("/v1/ocs/buckets/media/uploads/{abort_id}?key=aborted.bin"),
        None,
        default_headers(),
    )
    .await;
    assert_eq!(abort.status, StatusCode::OK);

    let invalid_key = request(
        &app,
        "PUT",
        &format!(
            "/v1/ocs/buckets/media/uploads/{}/parts/1?key=../escape",
            aborted.json()["uploadId"].as_str().unwrap()
        ),
        Some(b"x".to_vec()),
        default_headers(),
    )
    .await;
    assert_eq!(invalid_key.status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid_key.json()["error"], "invalid_key");
}

#[tokio::test]
async fn presign_signed_get_put_head_delete() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "media").await.status,
        StatusCode::CREATED
    );
    assert_eq!(
        put_bucket_object(&app, "media", "video.bin", b"0123456789")
            .await
            .status,
        StatusCode::CREATED
    );

    let presign = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "video.bin", "method": "GET"}),
        default_headers(),
    )
    .await;
    assert_eq!(presign.status, StatusCode::OK, "{}", presign.text());
    assert_eq!(presign.json()["method"], "GET");
    assert_eq!(presign.json()["expiresIn"], 900);
    let url = url::Url::parse(presign.json()["url"].as_str().unwrap()).unwrap();
    assert_eq!(url.path(), "/v1/ocs/signed");
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .unwrap()
        .1
        .into_owned();

    let signed_get = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&token)),
        None,
        vec![],
    )
    .await;
    assert_eq!(signed_get.status, StatusCode::OK);
    assert_eq!(signed_get.body.as_ref(), b"0123456789");
    assert_eq!(signed_get.header("x-ocs-bucket"), "media");

    let ranged = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&token)),
        None,
        {
            let mut headers = Vec::new();
            with_header(&mut headers, "range", "bytes=0-2");
            headers
        },
    )
    .await;
    assert_eq!(ranged.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.body.as_ref(), b"012");

    let head_presign = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "video.bin", "method": "HEAD"}),
        default_headers(),
    )
    .await;
    let head_token = query_token(&head_presign);
    let signed_head = request(
        &app,
        "HEAD",
        &format!("/v1/ocs/signed?token={}", percent_encode(&head_token)),
        None,
        vec![],
    )
    .await;
    assert_eq!(signed_head.status, StatusCode::OK);
    assert_eq!(signed_head.header("content-length"), "10");

    let put_presign = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "signed.txt", "method": "PUT"}),
        default_headers(),
    )
    .await;
    let put_token = query_token(&put_presign);
    let mut put_headers = vec![("content-type".to_string(), "text/plain".to_string())];
    with_header(
        &mut put_headers,
        "x-object-checksum-sha256",
        &checksum_hex(b"signed"),
    );
    let signed_put = request(
        &app,
        "PUT",
        &format!("/v1/ocs/signed?token={}", percent_encode(&put_token)),
        Some(b"signed".to_vec()),
        put_headers,
    )
    .await;
    assert_eq!(
        signed_put.status,
        StatusCode::CREATED,
        "{}",
        signed_put.text()
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/ocs/buckets/media/objects/signed.txt",
            None,
            default_headers()
        )
        .await
        .body
        .as_ref(),
        b"signed"
    );

    let delete_presign = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "signed.txt", "method": "DELETE"}),
        default_headers(),
    )
    .await;
    let delete_token = query_token(&delete_presign);
    let signed_delete = request(
        &app,
        "DELETE",
        &format!("/v1/ocs/signed?token={}", percent_encode(&delete_token)),
        None,
        vec![],
    )
    .await;
    assert_eq!(signed_delete.status, StatusCode::OK);
    assert_eq!(signed_delete.json()["bucket"], "media");
    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/v1/ocs/signed?token={}", percent_encode(&delete_token)),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );

    let wrong_method = request(
        &app,
        "DELETE",
        &format!("/v1/ocs/signed?token={}", percent_encode(&token)),
        None,
        vec![],
    )
    .await;
    assert_eq!(wrong_method.status, StatusCode::FORBIDDEN);
    assert_eq!(wrong_method.json()["error"], "presign_method_mismatch");

    let mut tampered = token.clone();
    tampered.push('x');
    let invalid = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&tampered)),
        None,
        vec![],
    )
    .await;
    assert_eq!(invalid.status, StatusCode::FORBIDDEN);
    assert_eq!(invalid.json()["error"], "invalid_presign_token");
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            let character = byte as char;
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
                character.to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn query_token(response: &TestResponse) -> String {
    let url = url::Url::parse(response.json()["url"].as_str().unwrap()).unwrap();
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn expired_and_bucketless_presign_tokens() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "media").await.status,
        StatusCode::CREATED
    );
    let expired = create_presign_token(
        &PresignPayload {
            tenant: "org:org-a".into(),
            bucket: "media".into(),
            key: "a.txt".into(),
            method: "GET".into(),
            exp: 1,
            nonce: "n".into(),
        },
        "ocs-dev-presign-secret",
    );
    let response = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&expired)),
        None,
        vec![],
    )
    .await;
    assert_eq!(response.status, StatusCode::GONE);
    assert_eq!(response.json()["error"], "presign_expired");

    let missing_bucket = create_presign_token(
        &PresignPayload {
            tenant: "org:org-a".into(),
            bucket: "missing".into(),
            key: "a.txt".into(),
            method: "GET".into(),
            exp: chrono::Utc::now().timestamp() + 60,
            nonce: "n".into(),
        },
        "ocs-dev-presign-secret",
    );
    let response = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&missing_bucket)),
        None,
        vec![],
    )
    .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["error"], "bucket_not_found");
}

#[tokio::test]
async fn reserved_keys_and_default_bucket_compatibility() {
    let (app, _dir) = fs_app();
    assert_eq!(
        request(
            &app,
            "PUT",
            "/v1/storage/objects/legacy.txt",
            Some(b"legacy".to_vec()),
            default_headers()
        )
        .await
        .status,
        StatusCode::CREATED
    );
    let list = request(
        &app,
        "GET",
        "/v1/ocs/buckets/default/objects",
        None,
        default_headers(),
    )
    .await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.json()["objects"].as_array().unwrap().len(), 1);
    assert_eq!(list.json()["objects"][0]["key"], "legacy.txt");
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/ocs/buckets/default/objects/legacy.txt",
            None,
            default_headers()
        )
        .await
        .body
        .as_ref(),
        b"legacy"
    );

    for key in ["@ocs/evil", ".bucket", "a/.bucket"] {
        let response = request(
            &app,
            "PUT",
            &format!("/v1/ocs/buckets/default/objects/{key}"),
            Some(b"x".to_vec()),
            default_headers(),
        )
        .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{key}");
        assert_eq!(response.json()["error"], "invalid_key");
    }

    assert_eq!(
        request(
            &app,
            "PUT",
            "/v1/ocs/buckets/default/objects/ocs.txt",
            Some(b"ocs".to_vec()),
            default_headers()
        )
        .await
        .status,
        StatusCode::CREATED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/storage/objects/ocs.txt",
            None,
            default_headers()
        )
        .await
        .body
        .as_ref(),
        b"ocs"
    );
}

#[tokio::test]
async fn signed_urls_bypass_tenant_gate_in_production() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = FileBackend::new(dir.path()).expect("fs backend");
    let tenant = "org:org-a";
    backend
        .put(
            tenant,
            &marker_key("media"),
            br#"{"name":"media","createdAt":"2026-01-01T00:00:00.000Z"}"#,
            "application/json",
            None,
        )
        .await
        .expect("bucket marker");
    let binary = [0u8, 1, 2, 255, 254];
    backend
        .put(
            tenant,
            &internal_key("media", "video.bin"),
            &binary,
            "video/mp4",
            None,
        )
        .await
        .expect("object");

    let mut config = test_config();
    config.is_prod = true;
    config.internal_secret = "top-secret".into();
    config.presign_secret = "top-secret".into();
    config.cors_origins = vec!["https://console.example".into()];
    let app = build_app(Backend::Fs(FileBackend::new(dir.path()).unwrap()), config);

    let token = create_presign_token(
        &PresignPayload {
            tenant: tenant.into(),
            bucket: "media".into(),
            key: "video.bin".into(),
            method: "GET".into(),
            exp: chrono::Utc::now().timestamp() + 60,
            nonce: "n".into(),
        },
        "top-secret",
    );
    let signed = request(
        &app,
        "GET",
        &format!("/v1/ocs/signed?token={}", percent_encode(&token)),
        None,
        vec![],
    )
    .await;
    assert_eq!(signed.status, StatusCode::OK);
    assert_eq!(signed.body.as_ref(), binary);
    assert_eq!(signed.header("content-type"), "video/mp4");

    let gated = request(&app, "GET", "/v1/ocs/buckets", None, default_headers()).await;
    assert_eq!(gated.status, StatusCode::UNAUTHORIZED);
    assert_eq!(gated.json()["error"], "unauthorized");

    let mut headers = default_headers();
    with_header(&mut headers, "x-synapseone-internal", "top-secret");
    let allowed = request(&app, "GET", "/v1/ocs/buckets", None, headers).await;
    assert_eq!(allowed.status, StatusCode::OK);
    assert_eq!(allowed.json()["total"], 2);
}

#[tokio::test]
async fn presign_uses_configured_public_base_url() {
    let (app, _dir) = fs_app_with(|config| {
        config.public_base_url = "https://cdn.example.test".into();
    });
    assert_eq!(
        create_bucket(&app, "media").await.status,
        StatusCode::CREATED
    );
    let response = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "a.txt"}),
        default_headers(),
    )
    .await;
    assert_eq!(response.status, StatusCode::OK);
    assert!(response.json()["url"]
        .as_str()
        .unwrap()
        .starts_with("https://cdn.example.test/v1/ocs/signed?token="));
    assert_eq!(response.json()["expiresIn"], 900);

    let bad_ttl = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/presign",
        &json!({"key": "a.txt", "expiresIn": 0}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_ttl.status, StatusCode::BAD_GATEWAY);
    assert_eq!(bad_ttl.json()["error"], "backend_error");
}

#[tokio::test]
async fn copy_validates_source_and_destination_keys() {
    let (app, _dir) = fs_app();
    assert_eq!(
        create_bucket(&app, "docs").await.status,
        StatusCode::CREATED
    );
    put_bucket_object(&app, "docs", "a.txt", b"a").await;
    let missing_source = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/docs/objects/copy",
        &json!({"sourceKey": "missing.txt", "destinationKey": "b.txt"}),
        default_headers(),
    )
    .await;
    assert_eq!(missing_source.status, StatusCode::NOT_FOUND);
    assert_eq!(missing_source.json()["error"], "source_not_found");

    let bad_source = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/docs/objects/copy",
        &json!({"sourceKey": "../a", "destinationKey": "b.txt"}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_source.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_source.json()["error"], "invalid_source_key");

    let bad_destination = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/docs/objects/copy",
        &json!({"sourceKey": "a.txt", "destinationKey": "@ocs/x"}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_destination.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_destination.json()["error"], "invalid_destination_key");
}

#[tokio::test]
async fn allowed_types_apply_to_ocs_writes() {
    let (app, _dir) = fs_app_with(|config| config.allowed_types = vec!["image/png".into()]);
    assert_eq!(
        create_bucket(&app, "media").await.status,
        StatusCode::CREATED
    );
    let mut headers = default_headers();
    headers.push(("content-type".into(), "text/plain".into()));
    let rejected = request(
        &app,
        "PUT",
        "/v1/ocs/buckets/media/objects/a.txt",
        Some(b"x".to_vec()),
        headers,
    )
    .await;
    assert_eq!(rejected.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(rejected.json()["error"], "unsupported_media_type");

    let bad_multipart = json_request(
        &app,
        "POST",
        "/v1/ocs/buckets/media/uploads",
        &json!({"key": "x.txt", "contentType": "text/plain"}),
        default_headers(),
    )
    .await;
    assert_eq!(bad_multipart.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}
