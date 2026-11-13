// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOCS bucket model helpers: bucket/key validation, reserved internal
//! namespace, bucket metadata and HMAC-signed public URL tokens.

use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::backend::{validate_key, ObjectMeta};
use crate::util::{decode_base64url, epoch_iso, ApiError};

pub const DEFAULT_BUCKET: &str = "default";
pub const OCS_PREFIX: &str = "@ocs/";
pub const BUCKET_MARKER: &str = ".bucket";

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketMeta {
    pub name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignPayload {
    pub tenant: String,
    pub bucket: String,
    pub key: String,
    pub method: String,
    pub exp: i64,
    #[serde(default)]
    pub nonce: String,
}

pub fn validate_bucket_name(name: &str) -> Option<String> {
    let length = name.chars().count();
    if !(3..=63).contains(&length) {
        return Some("bucket name must be 3..63 characters".into());
    }
    let bytes = name.as_bytes();
    let boundary = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let invalid_character = || {
        "bucket name must use lowercase letters, digits, dots or hyphens and start/end with alphanumeric"
            .to_string()
    };
    if !boundary(bytes[0]) || !boundary(bytes[length - 1]) {
        return Some(invalid_character());
    }
    if !bytes.iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'.' || *byte == b'-'
    }) {
        return Some(invalid_character());
    }
    if name.contains("..") || name.contains(".-") || name.contains("-.") {
        return Some("bucket name contains an invalid separator".into());
    }
    let parts = name.split('.').collect::<Vec<_>>();
    let ipv4 = parts.len() == 4
        && parts
            .iter()
            .all(|part| (1..=3).contains(&part.len()) && part.chars().all(|c| c.is_ascii_digit()));
    if ipv4 {
        return Some("bucket name must not look like an IPv4 address".into());
    }
    None
}

/// User keys may not enter the reserved internal bucket namespace.
pub fn validate_ocs_key(key: &str) -> Option<String> {
    if let Some(error) = validate_key(key) {
        return Some(error);
    }
    if key.starts_with(OCS_PREFIX) {
        return Some("key uses a reserved prefix".into());
    }
    if key == BUCKET_MARKER || key.ends_with(&format!("/{BUCKET_MARKER}")) {
        return Some("key uses a reserved name".into());
    }
    None
}

pub fn create_presign_token(payload: &PresignPayload, secret: &str) -> String {
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(payload).unwrap_or_default());
    let signature = sign_presign_body(&body, secret);
    format!("{body}.{signature}")
}

fn sign_presign_body(body: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac accepts any key");
    mac.update(body.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub fn verify_presign_token(
    token: &str,
    method: &str,
    secret: &str,
) -> Result<PresignPayload, ApiError> {
    let invalid = || {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "invalid_presign_token",
            "invalid presign token",
        )
    };
    let (body, signature) = token.split_once('.').ok_or_else(invalid)?;
    if body.is_empty() || signature.is_empty() {
        return Err(invalid());
    }
    let expected = sign_presign_body(body, secret);
    if signature.len() != expected.len()
        || signature
            .as_bytes()
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return Err(invalid());
    }
    let decoded = decode_base64url(body).ok_or_else(invalid)?;
    let payload: PresignPayload = serde_json::from_slice(&decoded).map_err(|_| invalid())?;
    if payload.tenant.is_empty()
        || payload.bucket.is_empty()
        || payload.key.is_empty()
        || payload.method.is_empty()
        || payload.exp == 0
    {
        return Err(invalid());
    }
    if payload.exp.saturating_mul(1000) < chrono::Utc::now().timestamp_millis() {
        return Err(ApiError::new(
            StatusCode::GONE,
            "presign_expired",
            "presign token expired",
        ));
    }
    if payload.method != method.to_uppercase() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "presign_method_mismatch",
            "presign method mismatch",
        ));
    }
    Ok(payload)
}

pub fn internal_key(bucket: &str, key: &str) -> String {
    if bucket == DEFAULT_BUCKET {
        key.to_string()
    } else {
        format!("{OCS_PREFIX}{bucket}/{key}")
    }
}

pub fn user_key(bucket: &str, key: &str) -> String {
    if bucket == DEFAULT_BUCKET {
        return key.to_string();
    }
    let prefix = format!("{OCS_PREFIX}{bucket}/");
    key.strip_prefix(&prefix).unwrap_or(key).to_string()
}

pub fn marker_key(bucket: &str) -> String {
    format!("{OCS_PREFIX}{bucket}/{BUCKET_MARKER}")
}

pub fn public_meta(bucket: &str, meta: &ObjectMeta) -> Value {
    let mut value = serde_json::to_value(meta).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert("key".into(), Value::String(user_key(bucket, &meta.key)));
        map.insert("bucket".into(), Value::String(bucket.to_string()));
    }
    value
}

pub fn meta_headers(bucket: &str, meta: &ObjectMeta) -> Vec<(String, String)> {
    let mut headers = vec![
        ("Content-Type".into(), meta.content_type.clone()),
        ("Content-Length".into(), meta.size.to_string()),
        ("ETag".into(), format!("\"{}\"", meta.etag)),
        ("Accept-Ranges".into(), "bytes".into()),
        ("x-object-key".into(), user_key(bucket, &meta.key)),
        ("x-ocs-bucket".into(), bucket.to_string()),
        ("x-object-created-at".into(), meta.created_at.clone()),
        ("x-object-updated-at".into(), meta.updated_at.clone()),
    ];
    if let Some(checksum) = &meta.checksum_sha256 {
        headers.push(("x-object-checksum-sha256".into(), checksum.clone()));
    }
    headers
}

pub fn set_header(response: &mut Response, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, value);
    }
}

pub fn apply_meta_headers(response: &mut Response, bucket: &str, meta: &ObjectMeta) {
    for (name, value) in meta_headers(bucket, meta) {
        if let Ok(header_name) = name.parse::<axum::http::HeaderName>() {
            if let Ok(header_value) = HeaderValue::from_str(&value) {
                response.headers_mut().insert(header_name, header_value);
            }
        }
    }
}

pub fn bucket_with_stats(meta: &BucketMeta, objects: usize, bytes: u64) -> Value {
    let mut value = serde_json::to_value(meta).unwrap_or_else(|_| json!({}));
    if let Value::Object(map) = &mut value {
        map.insert("objects".into(), json!(objects));
        map.insert("bytes".into(), json!(bytes));
    }
    value
}

pub fn default_bucket_meta() -> BucketMeta {
    BucketMeta {
        name: DEFAULT_BUCKET.into(),
        created_at: epoch_iso(),
        updated_at: None,
        owner: None,
        quota_bytes: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_name_validation() {
        assert!(validate_bucket_name("city-assets").is_none());
        assert!(validate_bucket_name("a1.b2").is_none());
        assert!(validate_bucket_name("ab").is_some());
        assert!(validate_bucket_name("Bad Name").is_some());
        assert!(validate_bucket_name("1.2.3.4").is_some());
        assert!(validate_bucket_name("bad..name").is_some());
        assert!(validate_bucket_name("bad.-name").is_some());
    }

    #[test]
    fn ocs_key_validation_rejects_internal_namespace() {
        assert!(validate_ocs_key("normal/path.txt").is_none());
        assert!(validate_ocs_key("@ocs/evil").is_some());
        assert!(validate_ocs_key(".bucket").is_some());
        assert!(validate_ocs_key("a/.bucket").is_some());
        assert!(validate_ocs_key("../etc/passwd").is_some());
    }

    #[test]
    fn presign_token_roundtrip_and_method_binding() {
        let payload = PresignPayload {
            tenant: "org:a".into(),
            bucket: "media".into(),
            key: "video.bin".into(),
            method: "GET".into(),
            exp: chrono::Utc::now().timestamp() + 60,
            nonce: "n".into(),
        };
        let token = create_presign_token(&payload, "secret");
        let verified = verify_presign_token(&token, "GET", "secret").expect("valid token");
        assert_eq!(verified.key, "video.bin");
        assert_eq!(
            verify_presign_token(&token, "DELETE", "secret")
                .unwrap_err()
                .code,
            "presign_method_mismatch"
        );
        assert_eq!(
            verify_presign_token(&token, "GET", "other")
                .unwrap_err()
                .code,
            "invalid_presign_token"
        );
    }

    #[test]
    fn expired_presign_token_is_gone() {
        let payload = PresignPayload {
            tenant: "org:a".into(),
            bucket: "media".into(),
            key: "video.bin".into(),
            method: "GET".into(),
            exp: 1,
            nonce: "n".into(),
        };
        let token = create_presign_token(&payload, "secret");
        let error = verify_presign_token(&token, "GET", "secret").unwrap_err();
        assert_eq!(error.status, StatusCode::GONE);
        assert_eq!(error.code, "presign_expired");
    }
}
