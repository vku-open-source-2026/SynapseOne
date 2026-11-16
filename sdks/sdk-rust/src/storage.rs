// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Legacy Synapse object storage namespace (`/v1/storage`).

use crate::client::{query_string, segment, Client, Request};
use crate::error::Result;
use http::header::{HeaderName, HeaderValue};
use http::Method;
use serde_json::{json, Value};
use std::time::Duration;

const PREFIX: &str = "/v1/storage";

/// Object storage service handle.
#[derive(Clone)]
pub struct StorageService {
    client: Client,
}

fn key_path(key: &str) -> String {
    key.split('/').map(segment).collect::<Vec<_>>().join("/")
}

impl StorageService {
    pub(crate) fn new(client: Client) -> Self {
        Self { client }
    }

    pub async fn put_object(
        &self,
        key: &str,
        body: impl Into<bytes::Bytes>,
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<Value> {
        let mut request = Request::new(Method::PUT, format!("{PREFIX}/objects/{}", key_path(key)))
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

    pub async fn get_object(&self, key: &str) -> Result<bytes::Bytes> {
        self.client
            .send_bytes(Request::get(format!("{PREFIX}/objects/{}", key_path(key))))
            .await
            .map(|response| response.body)
    }

    pub async fn head_object(&self, key: &str) -> Result<Option<Value>> {
        let request = Request::new(Method::HEAD, format!("{PREFIX}/objects/{}", key_path(key)));
        match self.client.send_bytes(request).await {
            Ok(response) => Ok(Some(json!({
                "key": header(&response.headers, "x-object-key").unwrap_or_else(|| key.to_string()),
                "size": header(&response.headers, "content-length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
                "contentType": header(&response.headers, "content-type").unwrap_or_else(|| "application/octet-stream".to_string()),
                "etag": header(&response.headers, "etag").unwrap_or_default().trim_matches('"'),
                "checksumSha256": header(&response.headers, "x-object-checksum-sha256"),
                "createdAt": header(&response.headers, "x-object-created-at").unwrap_or_default(),
                "updatedAt": header(&response.headers, "x-object-updated-at").unwrap_or_default(),
            }))),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn delete_object(&self, key: &str) -> Result<Value> {
        self.client
            .delete(format!("{PREFIX}/objects/{}", key_path(key)))
            .await
    }

    pub async fn list_objects(
        &self,
        prefix: &str,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let mut params = vec![("limit", limit.to_string())];
        if !prefix.is_empty() {
            params.push(("prefix", prefix.to_string()));
        }
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor.to_string()));
        }
        self.client
            .get(format!("{PREFIX}/objects?{}", query_string(&params)))
            .await
    }

    pub async fn presign(&self, key: &str, method: &str, expires_in: u32) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/presign"),
                json!({ "key": key, "method": method, "expiresIn": expires_in }),
            )
            .await
    }

    pub async fn create_multipart(&self, key: &str, content_type: &str) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/uploads"),
                json!({ "key": key, "contentType": content_type }),
            )
            .await
    }

    pub async fn upload_part(
        &self,
        upload_id: &str,
        key: &str,
        part_number: u32,
        body: impl Into<bytes::Bytes>,
    ) -> Result<Value> {
        let request = Request::new(
            Method::PUT,
            format!(
                "{PREFIX}/uploads/{}/parts/{}?{}",
                segment(upload_id),
                part_number,
                query_string(&[("key", key.to_string())])
            ),
        )
        .bytes(body, "application/octet-stream")
        .timeout(Duration::from_secs(120));
        self.client
            .send(request)
            .await
            .map(|response| response.body)
    }

    pub async fn complete_multipart(
        &self,
        upload_id: &str,
        key: &str,
        parts: Value,
    ) -> Result<Value> {
        self.client
            .post(
                format!("{PREFIX}/uploads/{}/complete", segment(upload_id)),
                json!({ "key": key, "parts": parts }),
            )
            .await
    }

    pub async fn abort_multipart(&self, upload_id: &str, key: &str) -> Result<Value> {
        self.client
            .delete(format!(
                "{PREFIX}/uploads/{}?{}",
                segment(upload_id),
                query_string(&[("key", key.to_string())])
            ))
            .await
    }
}

fn header(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}
