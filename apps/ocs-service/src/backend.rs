// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Object storage backends: local filesystem (dev/single-node) and
//! S3-compatible stores (SeaweedFS / MinIO / AWS S3 / R2).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use bytes::Bytes;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::config::Config;
use crate::s3::{S3Client, S3Config, S3Object};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectMeta {
    pub key: String,
    pub size: u64,
    pub content_type: String,
    pub etag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum_sha256: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct ObjectBody {
    pub meta: ObjectMeta,
    pub body: Bytes,
}

#[derive(Clone, Debug)]
pub struct ListPage {
    pub objects: Vec<ObjectMeta>,
    pub next_cursor: Option<String>,
}

pub fn checksum_hex(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

/// Encode a tenant id into one safe path segment (opaque, no traversal).
pub fn tenant_segment(tenant: &str) -> String {
    let digest = hex::encode(Sha256::digest(tenant.as_bytes()));
    digest[..32].to_string()
}

/// Reject absolute/traversal keys before they touch a backend.
pub fn validate_key(key: &str) -> Option<String> {
    if key.is_empty() || key.chars().count() > 1024 {
        return Some("key must be 1..1024 characters".into());
    }
    if key.starts_with('/') || key.ends_with('/') {
        return Some("key must not start or end with /".into());
    }
    if key.contains('\\') || key.contains('\0') {
        return Some("key contains invalid characters".into());
    }
    if key
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Some("key contains an empty or traversal segment".into());
    }
    if !key.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                '!' | '_' | '.' | '*' | '\'' | '(' | ')' | '/' | ':' | '@' | '$' | '=' | '+' | '-'
            )
    }) {
        return Some("key contains unsupported characters".into());
    }
    None
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn safe_components(key: &str) -> Option<Vec<&str>> {
    let mut segments = Vec::new();
    for segment in key.split('/') {
        if segment == "." || segment == ".." {
            return None;
        }
        if !segment.is_empty() {
            segments.push(segment);
        }
    }
    if segments
        .iter()
        .any(|segment| Path::new(segment).components().count() != 1)
    {
        return None;
    }
    if Path::new(key)
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return None;
    }
    Some(segments)
}

#[derive(Clone, Debug)]
pub struct FileBackend {
    root: PathBuf,
}

impl FileBackend {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn object_path(&self, tenant: &str, key: &str) -> Option<PathBuf> {
        let segments = safe_components(key)?;
        let mut path = self.root.join("objects").join(tenant_segment(tenant));
        for segment in segments {
            path.push(segment);
        }
        Some(path)
    }

    fn meta_path(&self, tenant: &str, key: &str) -> PathBuf {
        self.root
            .join("meta")
            .join(tenant_segment(tenant))
            .join(format!("{}.json", checksum_hex(key.as_bytes())))
    }

    fn upload_dir(&self, tenant: &str, id: &str) -> Option<PathBuf> {
        let valid = !id.is_empty()
            && id.len() <= 128
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        valid.then(|| {
            self.root
                .join("uploads")
                .join(tenant_segment(tenant))
                .join(id)
        })
    }

    async fn write_meta(&self, tenant: &str, meta: &ObjectMeta) -> Result<(), String> {
        let path = self.meta_path(tenant, &meta.key);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| error.to_string())?;
        }
        let body = serde_json::to_vec(meta).map_err(|error| error.to_string())?;
        tokio::fs::write(path, body)
            .await
            .map_err(|error| error.to_string())
    }

    async fn read_meta(&self, tenant: &str, key: &str) -> Option<ObjectMeta> {
        let body = tokio::fs::read(self.meta_path(tenant, key)).await.ok()?;
        serde_json::from_slice(&body).ok()
    }

    pub async fn put(
        &self,
        tenant: &str,
        key: &str,
        body: &[u8],
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<ObjectMeta, String> {
        let path = self
            .object_path(tenant, key)
            .ok_or_else(|| "invalid object key".to_string())?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| error.to_string())?;
        }
        tokio::fs::write(&path, body)
            .await
            .map_err(|error| error.to_string())?;
        let now = now_iso();
        let previous = self.read_meta(tenant, key).await;
        let meta = ObjectMeta {
            key: key.to_string(),
            size: body.len() as u64,
            content_type: content_type.to_string(),
            etag: checksum_hex(body),
            checksum_sha256: checksum_sha256.map(str::to_string),
            created_at: previous
                .as_ref()
                .map(|meta| meta.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };
        self.write_meta(tenant, &meta).await?;
        Ok(meta)
    }

    pub async fn get(&self, tenant: &str, key: &str) -> Option<ObjectBody> {
        let meta = self.read_meta(tenant, key).await?;
        let path = self.object_path(tenant, key)?;
        let body = tokio::fs::read(path).await.ok()?;
        Some(ObjectBody {
            meta,
            body: Bytes::from(body),
        })
    }

    pub async fn head(&self, tenant: &str, key: &str) -> Option<ObjectMeta> {
        self.read_meta(tenant, key).await
    }

    pub async fn delete(&self, tenant: &str, key: &str) -> bool {
        if self.read_meta(tenant, key).await.is_none() {
            return false;
        }
        if let Some(path) = self.object_path(tenant, key) {
            let _ = tokio::fs::remove_file(path).await;
        }
        let _ = tokio::fs::remove_file(self.meta_path(tenant, key)).await;
        true
    }

    pub async fn list(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> ListPage {
        let dir = self.root.join("meta").join(tenant_segment(tenant));
        let mut names = Vec::new();
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(entries) => entries,
            Err(_) => {
                return ListPage {
                    objects: Vec::new(),
                    next_cursor: None,
                }
            }
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                if name.ends_with(".json") {
                    names.push(name.to_string());
                }
            }
        }
        let mut metas = Vec::new();
        for name in names {
            let path = self
                .root
                .join("meta")
                .join(tenant_segment(tenant))
                .join(name);
            if let Ok(body) = tokio::fs::read(path).await {
                if let Ok(meta) = serde_json::from_slice::<ObjectMeta>(&body) {
                    if meta.key.starts_with(prefix) {
                        metas.push(meta);
                    }
                }
            }
        }
        metas.sort_by(|a, b| a.key.cmp(&b.key));
        let start = cursor
            .map(|cursor| {
                metas
                    .iter()
                    .position(|meta| meta.key.as_str() > cursor)
                    .unwrap_or(metas.len())
            })
            .unwrap_or(0);
        let end = start.saturating_add(limit).min(metas.len());
        let slice = &metas[start..end];
        let next_cursor = if end < metas.len() {
            slice.last().map(|meta| meta.key.clone())
        } else {
            None
        };
        ListPage {
            objects: slice.to_vec(),
            next_cursor,
        }
    }

    pub async fn usage(&self, tenant: &str) -> (usize, u64) {
        let page = self.list(tenant, "", 10_000, None).await;
        (
            page.objects.len(),
            page.objects.iter().map(|meta| meta.size).sum(),
        )
    }

    pub async fn create_multipart(
        &self,
        tenant: &str,
        key: &str,
        content_type: &str,
    ) -> Result<String, String> {
        let id = Uuid::new_v4().to_string();
        let dir = self
            .upload_dir(tenant, &id)
            .ok_or_else(|| "invalid upload id".to_string())?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|error| error.to_string())?;
        let manifest = serde_json::json!({
            "key": key,
            "contentType": content_type,
            "createdAt": now_iso(),
        });
        tokio::fs::write(dir.join("manifest.json"), manifest.to_string())
            .await
            .map_err(|error| error.to_string())?;
        Ok(id)
    }

    pub async fn upload_part(
        &self,
        tenant: &str,
        upload_id: &str,
        part_number: u64,
        body: &[u8],
    ) -> Result<String, String> {
        let dir = self
            .upload_dir(tenant, upload_id)
            .ok_or_else(|| "invalid upload id".to_string())?;
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::write(dir.join(format!("{part_number}.part")), body)
            .await
            .map_err(|error| error.to_string())?;
        Ok(checksum_hex(body))
    }

    pub async fn complete_multipart(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
        parts: &[(u64, String)],
    ) -> Result<ObjectMeta, String> {
        let dir = self
            .upload_dir(tenant, upload_id)
            .ok_or_else(|| "invalid upload id".to_string())?;
        let manifest_body = tokio::fs::read(dir.join("manifest.json"))
            .await
            .map_err(|error| error.to_string())?;
        let manifest: serde_json::Value =
            serde_json::from_slice(&manifest_body).map_err(|error| error.to_string())?;
        let content_type = manifest
            .get("contentType")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("application/octet-stream")
            .to_string();
        let mut ordered = parts.to_vec();
        ordered.sort_by_key(|(part_number, _)| *part_number);
        let mut body = Vec::new();
        for (part_number, _) in ordered {
            let chunk = tokio::fs::read(dir.join(format!("{part_number}.part")))
                .await
                .map_err(|error| error.to_string())?;
            body.extend_from_slice(&chunk);
        }
        let meta = self.put(tenant, key, &body, &content_type, None).await?;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        Ok(meta)
    }

    pub async fn abort_multipart(&self, tenant: &str, upload_id: &str) -> Result<(), String> {
        if let Some(dir) = self.upload_dir(tenant, upload_id) {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct S3Backend {
    client: S3Client,
}

impl S3Backend {
    pub fn new(client: S3Client) -> Self {
        Self { client }
    }

    pub fn client(&self) -> &S3Client {
        &self.client
    }

    fn full(tenant: &str, key: &str) -> String {
        format!("tenants/{}/{key}", tenant_segment(tenant))
    }

    pub async fn put(
        &self,
        tenant: &str,
        key: &str,
        body: &[u8],
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<ObjectMeta, String> {
        let etag = self
            .client
            .put(
                &Self::full(tenant, key),
                body,
                content_type,
                checksum_sha256,
            )
            .await?;
        let now = now_iso();
        Ok(ObjectMeta {
            key: key.to_string(),
            size: body.len() as u64,
            content_type: content_type.to_string(),
            etag,
            checksum_sha256: checksum_sha256.map(str::to_string),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub async fn get(&self, tenant: &str, key: &str) -> Result<Option<ObjectBody>, String> {
        let Some(object) = self.client.get(&Self::full(tenant, key)).await? else {
            return Ok(None);
        };
        Ok(Some(ObjectBody {
            meta: s3_object_meta(key, &object),
            body: object.body,
        }))
    }

    pub async fn head(&self, tenant: &str, key: &str) -> Result<Option<ObjectMeta>, String> {
        let Some(object) = self.client.head(&Self::full(tenant, key)).await? else {
            return Ok(None);
        };
        Ok(Some(s3_object_meta(key, &object)))
    }

    pub async fn delete(&self, tenant: &str, key: &str) -> Result<bool, String> {
        if self.head(tenant, key).await?.is_none() {
            return Ok(false);
        }
        self.client.delete(&Self::full(tenant, key)).await?;
        Ok(true)
    }

    pub async fn list(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ListPage, String> {
        let base = format!("tenants/{}/", tenant_segment(tenant));
        let page = self
            .client
            .list(&format!("{base}{prefix}"), limit, cursor)
            .await?;
        let objects = page
            .objects
            .into_iter()
            .map(|object| {
                let key = object
                    .key
                    .strip_prefix(&base)
                    .unwrap_or(&object.key)
                    .to_string();
                ObjectMeta {
                    key,
                    size: object.size,
                    content_type: "application/octet-stream".into(),
                    etag: object.etag,
                    checksum_sha256: None,
                    created_at: object.last_modified.clone().unwrap_or_else(now_iso),
                    updated_at: object.last_modified.unwrap_or_else(now_iso),
                }
            })
            .collect();
        Ok(ListPage {
            objects,
            next_cursor: page.next,
        })
    }

    pub async fn usage(&self, tenant: &str) -> Result<(usize, u64), String> {
        let mut cursor = None;
        let mut objects = 0usize;
        let mut bytes = 0u64;
        for _ in 0..100 {
            let page = self.list(tenant, "", 1000, cursor.as_deref()).await?;
            objects += page.objects.len();
            bytes += page.objects.iter().map(|meta| meta.size).sum::<u64>();
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok((objects, bytes))
    }

    pub fn presign(
        &self,
        tenant: &str,
        method: &str,
        key: &str,
        expires_in: u64,
    ) -> Result<String, String> {
        self.client
            .presign(method, &Self::full(tenant, key), expires_in)
    }

    pub async fn create_multipart(
        &self,
        tenant: &str,
        key: &str,
        content_type: &str,
    ) -> Result<String, String> {
        self.client
            .create_multipart(&Self::full(tenant, key), content_type)
            .await
    }

    pub async fn upload_part(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
        part_number: u64,
        body: &[u8],
    ) -> Result<String, String> {
        self.client
            .upload_part(&Self::full(tenant, key), upload_id, part_number, body)
            .await
    }

    pub async fn complete_multipart(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
        parts: &[(u64, String)],
    ) -> Result<ObjectMeta, String> {
        self.client
            .complete_multipart(&Self::full(tenant, key), upload_id, parts)
            .await?;
        self.head(tenant, key)
            .await?
            .ok_or_else(|| "multipart complete but object is missing".into())
    }

    pub async fn abort_multipart(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
    ) -> Result<(), String> {
        self.client
            .abort_multipart(&Self::full(tenant, key), upload_id)
            .await
    }
}

fn s3_object_meta(key: &str, object: &S3Object) -> ObjectMeta {
    ObjectMeta {
        key: key.to_string(),
        size: object.size,
        content_type: object.content_type.clone(),
        etag: object.etag.clone(),
        checksum_sha256: None,
        created_at: object.last_modified.clone().unwrap_or_else(now_iso),
        updated_at: object.last_modified.clone().unwrap_or_else(now_iso),
    }
}

#[derive(Clone, Debug)]
pub enum Backend {
    Fs(FileBackend),
    S3(S3Backend),
}

impl Backend {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Fs(_) => "fs",
            Self::S3(_) => "s3",
        }
    }

    pub fn supports_presign(&self) -> bool {
        matches!(self, Self::S3(_))
    }

    pub fn supports_multipart(&self) -> bool {
        true
    }

    pub async fn put(
        &self,
        tenant: &str,
        key: &str,
        body: &[u8],
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<ObjectMeta, String> {
        match self {
            Self::Fs(backend) => {
                backend
                    .put(tenant, key, body, content_type, checksum_sha256)
                    .await
            }
            Self::S3(backend) => {
                backend
                    .put(tenant, key, body, content_type, checksum_sha256)
                    .await
            }
        }
    }

    pub async fn get(&self, tenant: &str, key: &str) -> Result<Option<ObjectBody>, String> {
        match self {
            Self::Fs(backend) => Ok(backend.get(tenant, key).await),
            Self::S3(backend) => backend.get(tenant, key).await,
        }
    }

    pub async fn head(&self, tenant: &str, key: &str) -> Result<Option<ObjectMeta>, String> {
        match self {
            Self::Fs(backend) => Ok(backend.head(tenant, key).await),
            Self::S3(backend) => backend.head(tenant, key).await,
        }
    }

    pub async fn delete(&self, tenant: &str, key: &str) -> Result<bool, String> {
        match self {
            Self::Fs(backend) => Ok(backend.delete(tenant, key).await),
            Self::S3(backend) => backend.delete(tenant, key).await,
        }
    }

    pub async fn list(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ListPage, String> {
        match self {
            Self::Fs(backend) => Ok(backend.list(tenant, prefix, limit, cursor).await),
            Self::S3(backend) => backend.list(tenant, prefix, limit, cursor).await,
        }
    }

    pub async fn usage(&self, tenant: &str) -> Result<(usize, u64), String> {
        match self {
            Self::Fs(backend) => Ok(backend.usage(tenant).await),
            Self::S3(backend) => backend.usage(tenant).await,
        }
    }

    pub fn presign(
        &self,
        tenant: &str,
        method: &str,
        key: &str,
        expires_in: u64,
    ) -> Result<Option<String>, String> {
        match self {
            Self::Fs(_) => Ok(None),
            Self::S3(backend) => Ok(Some(backend.presign(tenant, method, key, expires_in)?)),
        }
    }

    pub async fn create_multipart(
        &self,
        tenant: &str,
        key: &str,
        content_type: &str,
    ) -> Result<String, String> {
        match self {
            Self::Fs(backend) => backend.create_multipart(tenant, key, content_type).await,
            Self::S3(backend) => backend.create_multipart(tenant, key, content_type).await,
        }
    }

    pub async fn upload_part(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
        part_number: u64,
        body: &[u8],
    ) -> Result<String, String> {
        match self {
            Self::Fs(backend) => {
                backend
                    .upload_part(tenant, upload_id, part_number, body)
                    .await
            }
            Self::S3(backend) => {
                backend
                    .upload_part(tenant, upload_id, key, part_number, body)
                    .await
            }
        }
    }

    pub async fn complete_multipart(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
        parts: &[(u64, String)],
    ) -> Result<ObjectMeta, String> {
        match self {
            Self::Fs(backend) => {
                backend
                    .complete_multipart(tenant, upload_id, key, parts)
                    .await
            }
            Self::S3(backend) => {
                backend
                    .complete_multipart(tenant, upload_id, key, parts)
                    .await
            }
        }
    }

    pub async fn abort_multipart(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
    ) -> Result<(), String> {
        match self {
            Self::Fs(backend) => backend.abort_multipart(tenant, upload_id).await,
            Self::S3(backend) => backend.abort_multipart(tenant, upload_id, key).await,
        }
    }
}

pub fn create_backend(env: &HashMap<String, String>, _config: &Config) -> Result<Backend, String> {
    let env_value = |name: &str| env.get(name).cloned().unwrap_or_default();
    let kind = env_value("STORAGE_BACKEND").trim().to_lowercase();
    if kind == "s3" {
        let cfg = S3Config {
            endpoint: env_value("STORAGE_S3_ENDPOINT"),
            bucket: env_value("STORAGE_S3_BUCKET"),
            region: {
                let region = env_value("STORAGE_S3_REGION");
                if region.is_empty() {
                    "us-east-1".into()
                } else {
                    region
                }
            },
            access_key: env_value("STORAGE_S3_ACCESS_KEY"),
            secret_key: env_value("STORAGE_S3_SECRET_KEY"),
            path_style: env
                .get("STORAGE_S3_PATH_STYLE")
                .map(|value| value != "false")
                .unwrap_or(true),
        };
        let mut missing = Vec::new();
        if cfg.endpoint.is_empty() {
            missing.push("endpoint");
        }
        if cfg.bucket.is_empty() {
            missing.push("bucket");
        }
        if cfg.access_key.is_empty() {
            missing.push("accessKey");
        }
        if cfg.secret_key.is_empty() {
            missing.push("secretKey");
        }
        if !missing.is_empty() {
            return Err(format!(
                "[storage] STORAGE_BACKEND=s3 requires {}",
                missing.join(", ")
            ));
        }
        return Ok(Backend::S3(S3Backend::new(S3Client::new(cfg)?)));
    }
    if !kind.is_empty() && kind != "fs" {
        return Err(format!(
            "[storage] unknown STORAGE_BACKEND '{kind}' (want fs|s3)"
        ));
    }
    let root = {
        let configured = env_value("STORAGE_FS_ROOT");
        if configured.is_empty() {
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(".storage")
        } else {
            PathBuf::from(configured)
        }
    };
    Ok(Backend::Fs(FileBackend::new(root)?))
}
