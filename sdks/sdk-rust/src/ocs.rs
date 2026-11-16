// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOCS: buckets, objects, presign and multipart uploads.

use crate::client::{query_string, segment, Client, Request};
use crate::error::Result;
use http::header::{HeaderName, HeaderValue};
use http::Method;
use serde_json::{json, Value};
use std::time::Duration;

/// OCS service handle.
#[derive(Clone)]
pub struct OcsService {
    client: Client,
}

fn object_key_path(key: &str) -> String {
    key.split('/').map(segment).collect::<Vec<_>>().join("/")
}

impl OcsService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    // ---- buckets -------------------------------------------------------

    pub async fn create_bucket(&self, name: &str, quota_bytes: Option<u64>) -> Result<Value> {
        let mut body = json!({ "name": name });
        if let Some(quota_bytes) = quota_bytes {
            body["quotaBytes"] = json!(quota_bytes);
        }
        self.client.post("/v1/ocs/buckets", body).await
    }

    pub async fn list_buckets(&self, with_stats: bool) -> Result<Value> {
        let path = if with_stats {
            "/v1/ocs/buckets?withStats=1"
        } else {
            "/v1/ocs/buckets"
        };
        self.client.get(path).await
    }

    pub async fn get_bucket(&self, name: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/ocs/buckets/{}", segment(name)))
            .await
    }

    /// HEAD bucket; returns `None` when the bucket does not exist.
    pub async fn head_bucket(&self, name: &str) -> Result<Option<Value>> {
        let request = Request::new(Method::HEAD, format!("/v1/ocs/buckets/{}", segment(name)));
        match self.client.send_bytes(request).await {
            Ok(response) => Ok(Some(json!({
                "status": response.status,
                "headers": headers_to_json(&response.headers),
            }))),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn bucket_stats(&self, name: &str) -> Result<Value> {
        self.client
            .get(format!("/v1/ocs/buckets/{}/stats", segment(name)))
            .await
    }

    pub async fn delete_bucket(&self, name: &str, force: bool) -> Result<Value> {
        let path = if force {
            format!("/v1/ocs/buckets/{}?force=true", segment(name))
        } else {
            format!("/v1/ocs/buckets/{}", segment(name))
        };
        self.client.delete(path).await
    }

    // ---- objects -------------------------------------------------------

    pub async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        body: impl Into<bytes::Bytes>,
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<Value> {
        let mut request = Request::new(
            Method::PUT,
            format!(
                "/v1/ocs/buckets/{}/objects/{}",
                segment(bucket),
                object_key_path(key)
            ),
        )
        .bytes(body, content_type);
        if let Some(checksum) = checksum_sha256 {
            request = request.header(
                HeaderName::from_static("x-object-checksum-sha256"),
                HeaderValue::from_str(checksum)?,
            );
        }
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn get_object(
        &self,
        bucket: &str,
        key: &str,
        range_header: Option<&str>,
        if_none_match: Option<&str>,
        if_match: Option<&str>,
    ) -> Result<bytes::Bytes> {
        let mut request = Request::get(format!(
            "/v1/ocs/buckets/{}/objects/{}",
            segment(bucket),
            object_key_path(key)
        ));
        if let Some(range_header) = range_header {
            request = request.header(
                HeaderName::from_static("range"),
                HeaderValue::from_str(range_header)?,
            );
        }
        if let Some(if_none_match) = if_none_match {
            request = request.header(
                HeaderName::from_static("if-none-match"),
                HeaderValue::from_str(if_none_match)?,
            );
        }
        if let Some(if_match) = if_match {
            request = request.header(
                HeaderName::from_static("if-match"),
                HeaderValue::from_str(if_match)?,
            );
        }
        self.client
            .send_bytes(request)
            .await
            .map(|response| response.body)
    }

    /// HEAD object; returns `None` when the object does not exist.
    pub async fn head_object(&self, bucket: &str, key: &str) -> Result<Option<Value>> {
        let request = Request::new(
            Method::HEAD,
            format!(
                "/v1/ocs/buckets/{}/objects/{}",
                segment(bucket),
                object_key_path(key)
            ),
        );
        match self.client.send_bytes(request).await {
            Ok(response) => Ok(Some(json!({
                "key": header_str(&response.headers, "x-object-key").unwrap_or_else(|| key.to_string()),
                "bucket": header_str(&response.headers, "x-ocs-bucket").unwrap_or_else(|| bucket.to_string()),
                "size": header_str(&response.headers, "content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
                "contentType": header_str(&response.headers, "content-type").unwrap_or_else(|| "application/octet-stream".to_string()),
                "etag": header_str(&response.headers, "etag").unwrap_or_default().trim_matches('"'),
                "checksumSha256": header_str(&response.headers, "x-object-checksum-sha256"),
                "createdAt": header_str(&response.headers, "x-object-created-at").unwrap_or_default(),
                "updatedAt": header_str(&response.headers, "x-object-updated-at").unwrap_or_default(),
            }))),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn delete_object(&self, bucket: &str, key: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/ocs/buckets/{}/objects/{}",
                segment(bucket),
                object_key_path(key)
            ))
            .await
    }

    pub async fn list_objects(
        &self,
        bucket: &str,
        prefix: &str,
        delimiter: Option<&str>,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let mut params = vec![("limit", limit.to_string())];
        if !prefix.is_empty() {
            params.push(("prefix", prefix.to_string()));
        }
        if let Some(delimiter) = delimiter {
            params.push(("delimiter", delimiter.to_string()));
        }
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor.to_string()));
        }
        self.client
            .get(format!(
                "/v1/ocs/buckets/{}/objects?{}",
                segment(bucket),
                query_string(&params)
            ))
            .await
    }

    pub async fn copy_object(
        &self,
        bucket: &str,
        source_key: &str,
        destination_key: &str,
        source_bucket: Option<&str>,
        content_type: Option<&str>,
    ) -> Result<Value> {
        let mut body = json!({
            "sourceKey": source_key,
            "destinationKey": destination_key,
        });
        if let Some(source_bucket) = source_bucket {
            body["sourceBucket"] = json!(source_bucket);
        }
        if let Some(content_type) = content_type {
            body["contentType"] = json!(content_type);
        }
        self.client
            .post(
                format!("/v1/ocs/buckets/{}/objects/copy", segment(bucket)),
                body,
            )
            .await
    }

    pub async fn presign(
        &self,
        bucket: &str,
        key: &str,
        method: &str,
        expires_in: u32,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/ocs/buckets/{}/presign", segment(bucket)),
                json!({ "key": key, "method": method, "expiresIn": expires_in }),
            )
            .await
    }

    pub async fn create_multipart(
        &self,
        bucket: &str,
        key: &str,
        content_type: &str,
    ) -> Result<Value> {
        self.client
            .post(
                format!("/v1/ocs/buckets/{}/uploads", segment(bucket)),
                json!({ "key": key, "contentType": content_type }),
            )
            .await
    }

    pub async fn upload_part(
        &self,
        bucket: &str,
        upload_id: &str,
        key: &str,
        part_number: u32,
        body: impl Into<bytes::Bytes>,
    ) -> Result<Value> {
        let path = format!(
            "/v1/ocs/buckets/{}/uploads/{}/parts/{}?{}",
            segment(bucket),
            segment(upload_id),
            part_number,
            query_string(&[("key", key.to_string())])
        );
        let request = Request::new(Method::PUT, path)
            .bytes(body, "application/octet-stream")
            .timeout(Duration::from_secs(120));
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn complete_multipart(
        &self,
        bucket: &str,
        upload_id: &str,
        key: &str,
        parts: Value,
    ) -> Result<Value> {
        self.client
            .post(
                format!(
                    "/v1/ocs/buckets/{}/uploads/{}/complete",
                    segment(bucket),
                    segment(upload_id)
                ),
                json!({ "key": key, "parts": parts }),
            )
            .await
    }

    pub async fn abort_multipart(&self, bucket: &str, upload_id: &str, key: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "/v1/ocs/buckets/{}/uploads/{}?{}",
                segment(bucket),
                segment(upload_id),
                query_string(&[("key", key.to_string())])
            ))
            .await
    }
}

fn header_str(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn headers_to_json(headers: &http::HeaderMap) -> Value {
    let mut map = serde_json::Map::new();
    for (name, value) in headers {
        map.insert(
            name.as_str().to_string(),
            Value::String(value.to_str().unwrap_or_default().to_string()),
        );
    }
    Value::Object(map)
}
