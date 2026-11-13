// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Minimal S3-compatible client (hand-rolled SigV4).
//!
//! No AWS SDK: SeaweedFS, MinIO, AWS S3 and other S3 services implement the
//! same HTTP contract. Signing, presigned URLs and XML decoding mirror
//! `s3.ts` byte-for-byte for the canonical request.

use std::collections::BTreeMap;

use base64::Engine;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use reqwest::header::HeaderMap;
use sha2::{Digest, Sha256};

use crate::util::{encode_uri_component, truncate_chars};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
pub struct S3Config {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub path_style: bool,
}

#[derive(Clone, Debug)]
pub struct S3Object {
    pub body: Bytes,
    pub content_type: String,
    pub etag: String,
    pub size: u64,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SignedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct ListedObject {
    pub key: String,
    pub size: u64,
    pub etag: String,
    pub last_modified: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ListResult {
    pub objects: Vec<ListedObject>,
    pub next: Option<String>,
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn signing_key(secret: &str, date_stamp: &str, region: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    hmac(&k_service, b"aws4_request")
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_query(params: &[(String, String)]) -> String {
    let mut sorted = params.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .into_iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                encode_uri_component(&key),
                encode_uri_component(&value)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn amz_date(now: DateTime<Utc>) -> String {
    now.format("%Y%m%dT%H%M%SZ").to_string()
}

fn endpoint_parts(endpoint: &str) -> Result<(String, String), String> {
    let url = url::Url::parse(endpoint).map_err(|error| error.to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "endpoint has no host".to_string())?;
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let pathname = url.path().to_string();
    let trimmed = pathname.strip_suffix('/').unwrap_or(&pathname).to_string();
    Ok((host, trimmed))
}

fn object_path(cfg: &S3Config, trimmed_endpoint_path: &str, key: &str) -> String {
    let prefix = if cfg.path_style {
        format!("/{}", cfg.bucket)
    } else {
        String::new()
    };
    let encoded_key = encode_path(key);
    let path = format!("{trimmed_endpoint_path}{prefix}/{encoded_key}");
    if path.is_empty() {
        "/".into()
    } else {
        path
    }
}

/// Sign an S3 request. `payload_hash` is the hex sha256 of the body.
pub fn sign_request(
    cfg: &S3Config,
    method: &str,
    key: &str,
    query: &[(String, String)],
    headers: &[(String, String)],
    payload_hash: &str,
    now: DateTime<Utc>,
) -> Result<SignedRequest, String> {
    let (host, endpoint_path) = endpoint_parts(&cfg.endpoint)?;
    let path = object_path(cfg, &endpoint_path, key);
    let stamp = amz_date(now);
    let date_stamp = &stamp[..8];

    let mut canonical: BTreeMap<String, String> = BTreeMap::new();
    canonical.insert("host".into(), host);
    for (name, value) in headers {
        canonical.insert(name.to_lowercase(), value.trim().to_string());
    }
    canonical.insert("x-amz-content-sha256".into(), payload_hash.to_string());
    canonical.insert("x-amz-date".into(), stamp.clone());

    let signed_headers = canonical.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = canonical
        .iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let canonical_query = encode_query(query);
    let canonical_request = [
        method,
        &path,
        &canonical_query,
        &canonical_headers,
        &signed_headers,
        payload_hash,
    ]
    .join("\n");
    let scope = format!("{date_stamp}/{}/s3/aws4_request", cfg.region);
    let string_to_sign = [
        "AWS4-HMAC-SHA256",
        &stamp,
        &scope,
        &sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");
    let key = signing_key(&cfg.secret_key, date_stamp, &cfg.region);
    let signature = hex::encode(hmac(&key, string_to_sign.as_bytes()));

    let mut out_headers = headers.to_vec();
    out_headers.push(("x-amz-content-sha256".into(), payload_hash.to_string()));
    out_headers.push(("x-amz-date".into(), stamp));
    out_headers.push((
        "Authorization".into(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            cfg.access_key
        ),
    ));
    let url = format!(
        "{}{}{}",
        cfg.endpoint.strip_suffix('/').unwrap_or(&cfg.endpoint),
        path,
        if canonical_query.is_empty() {
            String::new()
        } else {
            format!("?{canonical_query}")
        }
    );
    Ok(SignedRequest {
        url,
        headers: out_headers,
    })
}

/// Presigned URL (query-string auth), valid for `expires_in` seconds.
pub fn presign_url(
    cfg: &S3Config,
    method: &str,
    key: &str,
    expires_in: u64,
    now: DateTime<Utc>,
) -> Result<String, String> {
    let (host, endpoint_path) = endpoint_parts(&cfg.endpoint)?;
    let path = object_path(cfg, &endpoint_path, key);
    let stamp = amz_date(now);
    let date_stamp = &stamp[..8];
    let scope = format!("{date_stamp}/{}/s3/aws4_request", cfg.region);
    let expires = expires_in.clamp(1, 604_800).to_string();
    let params = vec![
        ("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()),
        (
            "X-Amz-Credential".into(),
            format!("{}/{scope}", cfg.access_key),
        ),
        ("X-Amz-Date".into(), stamp.clone()),
        ("X-Amz-Expires".into(), expires),
        ("X-Amz-SignedHeaders".into(), "host".into()),
    ];
    let canonical_request = [
        method,
        &path,
        &encode_query(&params),
        &format!("host:{host}\n"),
        "host",
        "UNSIGNED-PAYLOAD",
    ]
    .join("\n");
    let string_to_sign = [
        "AWS4-HMAC-SHA256",
        &stamp,
        &scope,
        &sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");
    let signing = signing_key(&cfg.secret_key, date_stamp, &cfg.region);
    let signature = hex::encode(hmac(&signing, string_to_sign.as_bytes()));
    let mut signed_params = params;
    signed_params.push(("X-Amz-Signature".into(), signature));
    Ok(format!(
        "{}{path}?{}",
        cfg.endpoint.strip_suffix('/').unwrap_or(&cfg.endpoint),
        encode_query(&signed_params)
    ))
}

fn decode_entity(entity: &str) -> Option<String> {
    match entity {
        "amp" => return Some("&".into()),
        "lt" => return Some("<".into()),
        "gt" => return Some(">".into()),
        "quot" => return Some("\"".into()),
        "apos" => return Some("'".into()),
        _ => {}
    }
    let code = if let Some(hex) = entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        u32::from_str_radix(hex, 16).ok()
    } else if let Some(decimal) = entity.strip_prefix('#') {
        decimal.parse::<u32>().ok()
    } else {
        None
    }?;
    char::from_u32(code).map(String::from)
}

/// Decode XML character references exactly once. Backends differ: AWS escapes
/// `&` as `&amp;`, SeaweedFS also writes `"` as `&#34;`.
pub fn xml_decode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        if let Some(end) = tail.find(';') {
            let entity = &tail[1..end];
            if let Some(decoded) = decode_entity(entity) {
                out.push_str(&decoded);
                rest = &tail[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

fn extract_tag<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    Some(&block[start..end])
}

fn header_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn clean_etag(etag: &str) -> String {
    etag.replace('"', "")
}

#[derive(Clone, Debug)]
pub struct S3Client {
    cfg: S3Config,
    http: reqwest::Client,
}

impl S3Client {
    pub fn new(cfg: S3Config) -> Result<Self, String> {
        endpoint_parts(&cfg.endpoint)?;
        let http = reqwest::Client::builder()
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { cfg, http })
    }

    pub fn config(&self) -> &S3Config {
        &self.cfg
    }

    async fn call(
        &self,
        method: &str,
        key: &str,
        query: &[(String, String)],
        headers: &[(String, String)],
        body: Option<&[u8]>,
    ) -> Result<reqwest::Response, String> {
        let payload = body.unwrap_or(&[]);
        let payload_hash = sha256_hex(payload);
        let signed = sign_request(
            &self.cfg,
            method,
            key,
            query,
            headers,
            &payload_hash,
            Utc::now(),
        )?;
        let method =
            reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
        let send_body = !matches!(method.as_str(), "GET" | "HEAD");
        let mut builder = self.http.request(method, &signed.url);
        for (name, value) in &signed.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = body {
            builder = builder.header("content-length", body.len().to_string());
            if send_body {
                builder = builder.body(body.to_vec());
            }
        }
        builder.send().await.map_err(|error| error.to_string())
    }

    async fn failure(prefix: &str, response: reqwest::Response) -> String {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        format!("{prefix} {status}: {}", truncate_chars(&text, 300))
    }

    pub async fn put(
        &self,
        key: &str,
        body: &[u8],
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<String, String> {
        let mut headers = vec![("content-type".to_string(), content_type.to_string())];
        if let Some(checksum) = checksum_sha256 {
            let raw = hex::decode(checksum).unwrap_or_default();
            headers.push((
                "x-amz-checksum-sha256".into(),
                base64::engine::general_purpose::STANDARD.encode(raw),
            ));
        }
        let response = self.call("PUT", key, &[], &headers, Some(body)).await?;
        if !response.status().is_success() {
            return Err(Self::failure("s3 put", response).await);
        }
        let etag = clean_etag(&header_value(response.headers(), "etag"));
        if etag.is_empty() {
            Ok(sha256_hex(body))
        } else {
            Ok(etag)
        }
    }

    pub async fn get(&self, key: &str) -> Result<Option<S3Object>, String> {
        let response = self.call("GET", key, &[], &[], None).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(Self::failure("s3 get", response).await);
        }
        let content_type = match header_value(response.headers(), "content-type") {
            value if value.is_empty() => "application/octet-stream".into(),
            value => value,
        };
        let etag = clean_etag(&header_value(response.headers(), "etag"));
        let declared_size = header_value(response.headers(), "content-length")
            .parse::<u64>()
            .ok();
        let last_modified = match header_value(response.headers(), "last-modified") {
            value if value.is_empty() => None,
            value => Some(value),
        };
        let body = response.bytes().await.map_err(|error| error.to_string())?;
        let size = declared_size.unwrap_or(body.len() as u64);
        Ok(Some(S3Object {
            body,
            content_type,
            etag,
            size,
            last_modified,
        }))
    }

    pub async fn head(&self, key: &str) -> Result<Option<S3Object>, String> {
        let response = self.call("HEAD", key, &[], &[], None).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("s3 head {}", response.status().as_u16()));
        }
        let content_type = match header_value(response.headers(), "content-type") {
            value if value.is_empty() => "application/octet-stream".into(),
            value => value,
        };
        let etag = clean_etag(&header_value(response.headers(), "etag"));
        let size = header_value(response.headers(), "content-length")
            .parse::<u64>()
            .unwrap_or(0);
        let last_modified = match header_value(response.headers(), "last-modified") {
            value if value.is_empty() => None,
            value => Some(value),
        };
        Ok(Some(S3Object {
            body: Bytes::new(),
            content_type,
            etag,
            size,
            last_modified,
        }))
    }

    pub async fn delete(&self, key: &str) -> Result<(), String> {
        let response = self.call("DELETE", key, &[], &[], None).await?;
        if !response.status().is_success() && response.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!("s3 delete {}", response.status().as_u16()));
        }
        Ok(())
    }

    pub async fn list(
        &self,
        prefix: &str,
        limit: usize,
        token: Option<&str>,
    ) -> Result<ListResult, String> {
        let mut query = vec![
            ("list-type".into(), "2".into()),
            ("prefix".into(), prefix.into()),
            ("max-keys".into(), limit.clamp(1, 1000).to_string()),
        ];
        if let Some(token) = token {
            query.push(("continuation-token".into(), token.into()));
        }
        let response = self.call("GET", "", &query, &[], None).await?;
        if !response.status().is_success() {
            return Err(Self::failure("s3 list", response).await);
        }
        let xml = response.text().await.map_err(|error| error.to_string())?;
        let mut objects = Vec::new();
        let mut rest = xml.as_str();
        while let Some(start) = rest.find("<Contents>") {
            let after = &rest[start + "<Contents>".len()..];
            let Some(end) = after.find("</Contents>") else {
                break;
            };
            let block = &after[..end];
            let key = xml_decode(extract_tag(block, "Key").unwrap_or(""));
            let size = extract_tag(block, "Size")
                .map(|value| value.trim().parse::<u64>().unwrap_or(0))
                .unwrap_or(0);
            let etag = clean_etag(&xml_decode(extract_tag(block, "ETag").unwrap_or("")));
            let last_modified = extract_tag(block, "LastModified").map(str::to_string);
            if !key.is_empty() {
                objects.push(ListedObject {
                    key,
                    size,
                    etag,
                    last_modified,
                });
            }
            rest = &after[end + "</Contents>".len()..];
        }
        let truncated = xml.contains("<IsTruncated>true</IsTruncated>");
        let next = if truncated {
            extract_tag(&xml, "NextContinuationToken").map(xml_decode)
        } else {
            None
        };
        Ok(ListResult { objects, next })
    }

    pub fn presign(&self, method: &str, key: &str, expires_in: u64) -> Result<String, String> {
        presign_url(&self.cfg, method, key, expires_in, Utc::now())
    }

    pub async fn create_multipart(&self, key: &str, content_type: &str) -> Result<String, String> {
        let headers = vec![("content-type".to_string(), content_type.to_string())];
        let query = vec![("uploads".to_string(), String::new())];
        let response = self.call("POST", key, &query, &headers, None).await?;
        if !response.status().is_success() {
            return Err(Self::failure("s3 create multipart", response).await);
        }
        let xml = response.text().await.map_err(|error| error.to_string())?;
        let id = extract_tag(&xml, "UploadId").map(xml_decode);
        id.filter(|value| !value.is_empty())
            .ok_or_else(|| "s3 create multipart: missing UploadId".into())
    }

    pub async fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: u64,
        body: &[u8],
    ) -> Result<String, String> {
        let query = vec![
            ("partNumber".into(), part_number.to_string()),
            ("uploadId".into(), upload_id.to_string()),
        ];
        let response = self.call("PUT", key, &query, &[], Some(body)).await?;
        if !response.status().is_success() {
            return Err(Self::failure("s3 upload part", response).await);
        }
        Ok(clean_etag(&header_value(response.headers(), "etag")))
    }

    pub async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u64, String)],
    ) -> Result<(), String> {
        let mut ordered = parts.to_vec();
        ordered.sort_by_key(|(part_number, _)| *part_number);
        let body = format!(
            "<CompleteMultipartUpload>{}</CompleteMultipartUpload>",
            ordered
                .iter()
                .map(|(part_number, etag)| format!(
                    "<Part><PartNumber>{part_number}</PartNumber><ETag>\"{etag}\"</ETag></Part>"
                ))
                .collect::<Vec<_>>()
                .join("")
        );
        let query = vec![("uploadId".to_string(), upload_id.to_string())];
        let headers = vec![("content-type".into(), "application/xml".into())];
        let response = self
            .call("POST", key, &query, &headers, Some(body.as_bytes()))
            .await?;
        if !response.status().is_success() {
            return Err(Self::failure("s3 complete multipart", response).await);
        }
        Ok(())
    }

    pub async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), String> {
        let query = vec![("uploadId".to_string(), upload_id.to_string())];
        let _ = self.call("DELETE", key, &query, &[], None).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_decode_handles_named_and_numeric_references() {
        assert_eq!(
            xml_decode("a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos;"),
            "a & b <c> \"q\" 's'"
        );
        assert_eq!(xml_decode("&#34;abc&#34; &#x26; &#38;"), "\"abc\" & &");
        assert_eq!(xml_decode("plain/key.txt"), "plain/key.txt");
        assert_eq!(xml_decode("&amp;amp;"), "&amp;");
        assert_eq!(xml_decode("&unknown;"), "&unknown;");
    }
}
