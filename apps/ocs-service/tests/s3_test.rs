// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! S3 SigV4 signing, presigning, XML decoding and backend tests against a
//! mock S3 HTTP server.

mod common;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use common::*;
use serde_json::json;
use synapseone_ocs::backend::{checksum_hex, tenant_segment, Backend, S3Backend};
use synapseone_ocs::s3::{presign_url, sign_request, xml_decode, S3Client, S3Config};
use synapseone_ocs::{build_app, Config};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config(endpoint: &str) -> S3Config {
    S3Config {
        endpoint: endpoint.into(),
        bucket: "b".into(),
        region: "us-east-1".into(),
        access_key: "k".into(),
        secret_key: "s".into(),
        path_style: true,
    }
}

#[test]
fn aws_documented_get_object_signature_vector() {
    let cfg = S3Config {
        endpoint: "https://examplebucket.s3.amazonaws.com".into(),
        bucket: String::new(),
        region: "us-east-1".into(),
        access_key: "AKIAIOSFODNN7EXAMPLE".into(),
        secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
        path_style: false,
    };
    let now = DateTime::parse_from_rfc3339("2013-05-24T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let payload_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let signed = sign_request(
        &cfg,
        "GET",
        "test.txt",
        &[],
        &[("range".into(), "bytes=0-9".into())],
        payload_hash,
        now,
    )
    .unwrap();
    assert_eq!(
        signed.url,
        "https://examplebucket.s3.amazonaws.com/test.txt"
    );
    let authorization = signed
        .headers
        .iter()
        .find(|(name, _)| name == "Authorization")
        .map(|(_, value)| value.as_str())
        .unwrap();
    assert!(authorization
        .contains("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"));
    assert!(authorization.contains("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"));
    assert!(authorization
        .contains("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"));
    assert_eq!(
        signed
            .headers
            .iter()
            .find(|(name, _)| name == "x-amz-date")
            .unwrap()
            .1,
        "20130524T000000Z"
    );
}

#[test]
fn presigned_url_shape_and_signature() {
    let cfg = config("https://s3.example.com");
    let now = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let url = presign_url(&cfg, "GET", "tenants/x/a.png", 900, now).unwrap();
    assert!(url.starts_with("https://s3.example.com/b/tenants/x/a.png?"));
    assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
    assert!(url.contains("X-Amz-Credential=k%2F20260101%2Fus-east-1%2Fs3%2Faws4_request"));
    assert!(url.contains("X-Amz-Date=20260101T000000Z"));
    assert!(url.contains("X-Amz-Expires=900"));
    assert!(url.contains("X-Amz-SignedHeaders=host"));
    let signature = url
        .split("X-Amz-Signature=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap();
    assert_eq!(
        signature,
        "fa2dadb51733c0251bdb6e1feb7df37e0028b2b32ae55517afb7b161d3550ee7"
    );

    let clamped = presign_url(&cfg, "PUT", "a.txt", 1_000_000, now).unwrap();
    assert!(clamped.contains("X-Amz-Expires=604800"));
}

#[tokio::test]
async fn list_decodes_xml_entities_and_continuation_token() {
    let server = MockServer::start().await;
    let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
        <ListBucketResult>\
        <IsTruncated>true</IsTruncated>\
        <NextContinuationToken>tok&amp;1</NextContinuationToken>\
        <Contents><Key>tenants/t1/x y&amp;z.bin</Key><Size>3</Size><ETag>&#34;0b75926a&#34;</ETag></Contents>\
        <Contents><Key>tenants/t1/a&lt;b&gt;.txt</Key><Size>1</Size><ETag>&quot;aab457e0&quot;</ETag></Contents>\
        </ListBucketResult>";
    Mock::given(method("GET"))
        .and(path("/b/"))
        .and(query_param("list-type", "2"))
        .and(query_param("prefix", "tenants/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/xml")
                .set_body_string(xml),
        )
        .mount(&server)
        .await;
    let client = S3Client::new(config(&server.uri())).unwrap();
    let page = client.list("tenants/", 10, None).await.unwrap();
    assert_eq!(
        page.objects
            .iter()
            .map(|object| (object.key.as_str(), object.etag.as_str(), object.size))
            .collect::<Vec<_>>(),
        vec![
            ("tenants/t1/x y&z.bin", "0b75926a", 3),
            ("tenants/t1/a<b>.txt", "aab457e0", 1)
        ]
    );
    assert_eq!(page.next.as_deref(), Some("tok&1"));

    let requests = server.received_requests().await.unwrap();
    let authorization = requests[0]
        .headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(authorization.starts_with("AWS4-HMAC-SHA256 Credential=k/"));
    assert!(authorization.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date"));
    assert_eq!(
        requests[0]
            .headers
            .get("x-amz-content-sha256")
            .unwrap()
            .to_str()
            .unwrap(),
        checksum_hex(b"")
    );
}

#[tokio::test]
async fn s3_backend_put_get_head_list_delete_and_usage() {
    let server = MockServer::start().await;
    let segment = tenant_segment("org:org-a");
    let object_path = format!("/b/tenants/{segment}/a.txt");
    let binary = vec![0u8, 255, 1, 254];

    Mock::given(method("PUT"))
        .and(path(&object_path))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"etag-put\""))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(&object_path))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "image/png")
                .insert_header("etag", "\"etag-get\"")
                .insert_header("last-modified", "Wed, 01 Jan 2026 00:00:00 GMT")
                .set_body_bytes(binary.clone()),
        )
        .mount(&server)
        .await;
    Mock::given(method("HEAD"))
        .and(path(&object_path))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "image/png")
                .insert_header("etag", "\"etag-head\"")
                .insert_header("content-length", "4"),
        )
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(&object_path))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/b/tenants/{segment}/missing.txt")))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let list_xml = format!(
        "<ListBucketResult><IsTruncated>false</IsTruncated>\
         <Contents><Key>tenants/{segment}/a.txt</Key><Size>4</Size>\
         <ETag>&#34;etag-list&#34;</ETag>\
         <LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>"
    );
    Mock::given(method("GET"))
        .and(path("/b/"))
        .and(query_param("list-type", "2"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/xml")
                .set_body_string(list_xml),
        )
        .mount(&server)
        .await;

    let backend = Backend::S3(S3Backend::new(
        S3Client::new(config(&server.uri())).unwrap(),
    ));
    let meta = backend
        .put(
            "org:org-a",
            "a.txt",
            &binary,
            "image/png",
            Some(&checksum_hex(&binary)),
        )
        .await
        .unwrap();
    assert_eq!(meta.etag, "etag-put");
    assert_eq!(meta.size, 4);
    assert_eq!(
        meta.checksum_sha256.as_deref(),
        Some(checksum_hex(&binary).as_str())
    );

    let object = backend.get("org:org-a", "a.txt").await.unwrap().unwrap();
    assert_eq!(object.body, Bytes::from(binary.clone()));
    assert_eq!(object.meta.content_type, "image/png");
    assert_eq!(object.meta.etag, "etag-get");
    assert_eq!(object.meta.size, 4);

    let head = backend.head("org:org-a", "a.txt").await.unwrap().unwrap();
    assert_eq!(head.etag, "etag-head");
    assert_eq!(head.size, 4);

    let missing = backend.get("org:org-a", "missing.txt").await.unwrap();
    assert!(missing.is_none());

    let page = backend.list("org:org-a", "", 10, None).await.unwrap();
    assert_eq!(page.objects.len(), 1);
    assert_eq!(page.objects[0].key, "a.txt");
    assert_eq!(page.objects[0].content_type, "application/octet-stream");
    assert_eq!(page.objects[0].etag, "etag-list");

    let (objects, bytes) = backend.usage("org:org-a").await.unwrap();
    assert_eq!(objects, 1);
    assert_eq!(bytes, 4);

    assert!(backend.delete("org:org-a", "a.txt").await.unwrap());

    let requests = server.received_requests().await.unwrap();
    let put = requests
        .iter()
        .find(|request| request.method == wiremock::http::Method::PUT)
        .expect("put request");
    let payload_hash = put
        .headers
        .get("x-amz-content-sha256")
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(payload_hash, checksum_hex(&binary));
    assert!(put
        .headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap()
        .contains(
            "SignedHeaders=content-type;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date"
        ));
}

#[tokio::test]
async fn s3_backend_multipart_flow() {
    let server = MockServer::start().await;
    let segment = tenant_segment("org:org-a");
    let object_path = format!("/b/tenants/{segment}/video.bin");

    Mock::given(method("POST"))
        .and(path(&object_path))
        .and(query_param("uploadId", "up&id"))
        .respond_with(ResponseTemplate::new(200))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(&object_path))
        .and(query_param("uploads", ""))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<InitiateMultipartUploadResult><UploadId>up&amp;id</UploadId></InitiateMultipartUploadResult>",
        ))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path(&object_path))
        .and(query_param("partNumber", "1"))
        .and(query_param("uploadId", "up&id"))
        .respond_with(ResponseTemplate::new(200).insert_header("etag", "\"part-1\""))
        .mount(&server)
        .await;
    Mock::given(method("HEAD"))
        .and(path(&object_path))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/octet-stream")
                .insert_header("etag", "\"final\"")
                .insert_header("content-length", "30"),
        )
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path(&object_path))
        .and(query_param("uploadId", "up&id"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let backend = Backend::S3(S3Backend::new(
        S3Client::new(config(&server.uri())).unwrap(),
    ));
    let upload_id = backend
        .create_multipart("org:org-a", "video.bin", "application/octet-stream")
        .await
        .unwrap();
    assert_eq!(upload_id, "up&id");
    let etag = backend
        .upload_part("org:org-a", &upload_id, "video.bin", 1, &[7u8; 10])
        .await
        .unwrap();
    assert_eq!(etag, "part-1");
    let meta = backend
        .complete_multipart("org:org-a", &upload_id, "video.bin", &[(1, etag)])
        .await
        .unwrap();
    assert_eq!(meta.size, 30);
    assert_eq!(meta.etag, "final");
    backend
        .abort_multipart("org:org-a", &upload_id, "video.bin")
        .await
        .unwrap();

    let requests = server.received_requests().await.unwrap();
    let complete = requests
        .iter()
        .filter(|request| request.method == wiremock::http::Method::POST)
        .find(|request| {
            request
                .url
                .query_pairs()
                .any(|(key, value)| key == "uploadId" && value == "up&id")
        })
        .expect("complete request");
    let body = String::from_utf8(complete.body.clone()).unwrap();
    assert_eq!(
        body,
        "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>\"part-1\"</ETag></Part></CompleteMultipartUpload>"
    );
    assert!(requests.iter().any(|request| {
        request.method == wiremock::http::Method::DELETE
            && request
                .url
                .query_pairs()
                .any(|(key, value)| key == "uploadId" && value == "up&id")
    }));
}

/// ListParts drives the multipart quota check: the backend must page
/// through the part list and return (part number, size) pairs, including
/// the truncated second page.
#[tokio::test]
async fn s3_backend_part_sizes_pages_through_list_parts() {
    let server = MockServer::start().await;
    let segment = tenant_segment("org:org-a");
    let object_path = format!("/b/tenants/{segment}/video.bin");

    Mock::given(method("GET"))
        .and(path(&object_path))
        .and(query_param("uploadId", "up-1"))
        .and(query_param("part-number-marker", "3"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<ListPartsResult>\
             <IsTruncated>false</IsTruncated>\
             <Part><PartNumber>4</PartNumber><Size>70</Size></Part>\
             <Part><PartNumber>5</PartNumber><Size>80</Size></Part>\
             </ListPartsResult>",
        ))
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(&object_path))
        .and(query_param("uploadId", "up-1"))
        .respond_with(ResponseTemplate::new(200).set_body_string(
            "<ListPartsResult>\
             <IsTruncated>true</IsTruncated>\
             <NextPartNumberMarker>3</NextPartNumberMarker>\
             <Part><PartNumber>1</PartNumber><Size>10</Size></Part>\
             <Part><PartNumber>2</PartNumber><Size>20</Size></Part>\
             <Part><PartNumber>3</PartNumber><Size>30</Size></Part>\
             </ListPartsResult>",
        ))
        .with_priority(2)
        .mount(&server)
        .await;

    let backend = Backend::S3(S3Backend::new(
        S3Client::new(config(&server.uri())).unwrap(),
    ));
    let sizes = backend
        .part_sizes("org:org-a", "up-1", "video.bin")
        .await
        .unwrap();
    assert_eq!(sizes, vec![(1, 10), (2, 20), (3, 30), (4, 70), (5, 80)]);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == wiremock::http::Method::GET)
            .count(),
        2,
        "the truncated first page must be followed by a marker page"
    );
}

#[test]
fn xml_decode_matrix() {
    assert_eq!(
        xml_decode("a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos;"),
        "a & b <c> \"q\" 's'"
    );
    assert_eq!(xml_decode("&#34;abc&#34; &#x26; &#38;"), "\"abc\" & &");
    assert_eq!(xml_decode("plain/key.txt"), "plain/key.txt");
    assert_eq!(xml_decode("&amp;amp;"), "&amp;");
    assert_eq!(xml_decode("&unknown;"), "&unknown;");
    assert_eq!(json!(xml_decode("&#x1F600;")), json!("😀"));
}

#[tokio::test]
async fn legacy_presign_returns_a_public_ocs_url_and_secures_put() {
    let server = MockServer::start().await;
    let backend = Backend::S3(S3Backend::new(
        S3Client::new(config(&server.uri())).unwrap(),
    ));
    let mut cfg = Config::for_test();
    cfg.public_base_url = "https://cdn.example.test".into();
    cfg.max_object_bytes = 1024;
    cfg.allowed_types = vec!["image/png".into()];
    let app = build_app(backend, cfg);

    let presign = json_request(
        &app,
        "POST",
        "/v1/storage/presign",
        &serde_json::json!({"key": "a.png", "method": "PUT", "expiresIn": 300}),
        default_headers(),
    )
    .await;
    assert_eq!(
        presign.status,
        reqwest::StatusCode::OK,
        "{}",
        presign.text()
    );
    let url = presign.json()["url"].as_str().unwrap().to_string();
    assert!(url.starts_with("https://cdn.example.test/v1/ocs/signed?token="));
    assert!(
        !url.contains(&server.uri()),
        "internal S3 endpoint leaked: {url}"
    );
    assert!(!url.contains("127.0.0.1"), "internal S3 host leaked: {url}");
    let token = url
        .split("token=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();

    // The legacy PUT token is an OCS token: object-size and content-type
    // policy are enforced before the storage backend sees any request.
    let oversized = request(
        &app,
        "PUT",
        &format!("/v1/ocs/signed?token={token}"),
        Some(vec![0u8; 4096]),
        vec![("content-type".into(), "image/png".into())],
    )
    .await;
    assert_eq!(oversized.status, reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(oversized.json()["error"], "object_too_large");

    let wrong_type = request(
        &app,
        "PUT",
        &format!("/v1/ocs/signed?token={token}"),
        Some(b"small".to_vec()),
        vec![("content-type".into(), "text/plain".into())],
    )
    .await;
    assert_eq!(
        wrong_type.status,
        reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(wrong_type.json()["error"], "unsupported_media_type");

    assert!(
        server.received_requests().await.unwrap().is_empty(),
        "policy rejects must not reach the S3 backend"
    );
}

#[tokio::test]
async fn s3_range_get_is_signed_and_bounded() {
    let server = MockServer::start().await;
    let segment = tenant_segment("org:org-a");
    let object_path = format!("/b/tenants/{segment}/ranged.bin");
    Mock::given(method("GET"))
        .and(path(&object_path))
        .and(header("range", "bytes=2-5"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-type", "application/octet-stream")
                .insert_header("content-range", "bytes 2-5/10")
                .insert_header("etag", "\"range-etag\"")
                .set_body_bytes(b"2345".to_vec()),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/b/tenants/{segment}/ignore.bin")))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/octet-stream")
                .set_body_bytes(vec![9u8; 1024 * 1024]),
        )
        .mount(&server)
        .await;

    let backend = Backend::S3(S3Backend::new(
        S3Client::new(config(&server.uri())).unwrap(),
    ));
    let object = backend
        .get_range("org:org-a", "ranged.bin", 2, 5)
        .await
        .expect("range")
        .expect("object");
    assert_eq!(object.body.as_ref(), b"2345");
    assert_eq!(object.meta.size, 10);
    assert_eq!(object.meta.etag, "range-etag");

    // A backend that ignores Range must fail closed instead of buffering the
    // full object into memory.
    let ignored = backend
        .get_range("org:org-a", "ignore.bin", 0, 9)
        .await
        .expect_err("ignored range must be an error");
    assert!(
        ignored.contains("ignored the requested byte range"),
        "{ignored}"
    );

    let requests = server.received_requests().await.unwrap();
    let ranged = requests
        .iter()
        .find(|request| request.url.path().ends_with("/ranged.bin"))
        .expect("ranged request");
    assert_eq!(
        ranged.headers.get("range").unwrap().to_str().unwrap(),
        "bytes=2-5"
    );
    let authorization = ranged
        .headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        authorization.contains("range"),
        "the Range header must be part of SigV4: {authorization}"
    );
}
