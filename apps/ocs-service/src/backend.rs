// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Object storage backends: local filesystem (dev/single-node) and
//! S3-compatible stores (SeaweedFS / MinIO / AWS S3 / R2).

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use bytes::Bytes;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
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

/// On-disk metadata. `bodyFile` names an immutable, content-addressed body
/// file; the metadata rename is the commit point for a new object version.
/// Metadata written by older releases has no `bodyFile` and keeps using the
/// legacy key-shaped body path.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredMeta {
    #[serde(flatten)]
    meta: ObjectMeta,
    #[serde(default, rename = "bodyFile", skip_serializing_if = "Option::is_none")]
    body_file: Option<String>,
}

fn valid_body_file(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".blob") else {
        return false;
    };
    let Some((key_hash, etag)) = stem.split_once('.') else {
        return false;
    };
    key_hash.len() == 64
        && etag.len() == 64
        && key_hash
            .bytes()
            .chain(etag.bytes())
            .all(|byte| byte.is_ascii_hexdigit())
}

fn body_path_for_segment(
    root: &Path,
    segment: &str,
    key: &str,
    stored: &StoredMeta,
) -> Option<PathBuf> {
    if let Some(name) = stored.body_file.as_deref() {
        if !valid_body_file(name) {
            return None;
        }
        // Committed bodies live in a dedicated top-level directory so a
        // legacy user key can never collide with a content-addressed body
        // file of another object.
        return Some(root.join("bodies").join(segment).join(name));
    }
    let mut path = root.join("objects").join(segment);
    for part in safe_components(key)? {
        path.push(part);
    }
    Some(path)
}

/// Write `data` to a unique temporary file in `dir`, fsync it, and return the
/// temporary path. The caller renames it into place.
async fn write_temp(dir: &Path, stem: &str, data: &[u8]) -> Result<PathBuf, String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|error| format!("create directory {}: {error}", dir.display()))?;
    let temp = dir.join(format!(
        ".tmp-{stem}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|error| format!("create temporary file {}: {error}", temp.display()))?;
    if let Err(error) = file.write_all(data).await {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("write temporary file {}: {error}", temp.display()));
    }
    if let Err(error) = file.sync_all().await {
        drop(file);
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(format!("fsync temporary file {}: {error}", temp.display()));
    }
    drop(file);
    Ok(temp)
}

/// Best-effort directory fsync so a rename is durable across a crash.
async fn sync_directory(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = tokio::fs::File::open(dir).await {
        let _ = handle.sync_all().await;
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[derive(Clone, Debug)]
pub struct FileBackend {
    root: PathBuf,
    /// Per-object read/write locks. Writes publish body+metadata atomically;
    /// readers hold the shared side so they never observe a half-committed
    /// version.
    key_locks: Arc<StdMutex<HashMap<String, Arc<tokio::sync::RwLock<()>>>>>,
}

impl FileBackend {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let backend = Self {
            root,
            key_locks: Arc::new(StdMutex::new(HashMap::new())),
        };
        backend.recover_orphans();
        Ok(backend)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn key_lock(&self, tenant: &str, key: &str) -> Arc<tokio::sync::RwLock<()>> {
        let mut locks = self
            .key_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(format!("{tenant}\u{0}{key}"))
            .or_insert_with(|| Arc::new(tokio::sync::RwLock::new(())))
            .clone()
    }

    fn objects_dir(&self, tenant: &str) -> PathBuf {
        self.root.join("objects").join(tenant_segment(tenant))
    }

    fn bodies_dir(&self, tenant: &str) -> PathBuf {
        self.root.join("bodies").join(tenant_segment(tenant))
    }

    fn meta_dir(&self, tenant: &str) -> PathBuf {
        self.root.join("meta").join(tenant_segment(tenant))
    }

    fn object_path(&self, tenant: &str, key: &str) -> Option<PathBuf> {
        let segments = safe_components(key)?;
        let mut path = self.objects_dir(tenant);
        for segment in segments {
            path.push(segment);
        }
        Some(path)
    }

    fn body_path(&self, tenant: &str, name: &str) -> PathBuf {
        self.bodies_dir(tenant).join(name)
    }

    fn body_path_for(&self, tenant: &str, key: &str, stored: &StoredMeta) -> Option<PathBuf> {
        body_path_for_segment(&self.root, &tenant_segment(tenant), key, stored)
    }

    fn meta_path(&self, tenant: &str, key: &str) -> PathBuf {
        self.meta_dir(tenant)
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

    /// Read the stored metadata record. Only a missing meta file (ENOENT)
    /// means "no such object"; any other read error (EACCES, …) or corrupt
    /// JSON propagates as a backend error instead of masquerading as a 404
    /// (#100).
    async fn read_stored_meta(
        &self,
        tenant: &str,
        key: &str,
    ) -> Result<Option<StoredMeta>, String> {
        let path = self.meta_path(tenant, key);
        let body = match tokio::fs::read(&path).await {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!("read metadata for object '{key}': {error}"));
            }
        };
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(|error| format!("corrupt metadata for object '{key}': {error}"))
    }

    /// Verify that the committed metadata points at an existing body of the
    /// declared size. This prevents HEAD/GET from reporting a version whose
    /// body was never written or was replaced by a partial file.
    async fn checked_body_path(
        &self,
        tenant: &str,
        key: &str,
        stored: &StoredMeta,
    ) -> Result<PathBuf, String> {
        let path = self
            .body_path_for(tenant, key, stored)
            .ok_or_else(|| format!("invalid body reference for object '{key}'"))?;
        let metadata = tokio::fs::metadata(&path).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!("object body missing for '{key}'")
            } else {
                format!("stat object '{key}': {error}")
            }
        })?;
        if !metadata.is_file() {
            return Err(format!("object body for '{key}' is not a regular file"));
        }
        if metadata.len() != stored.meta.size {
            return Err(format!(
                "object body size mismatch for '{key}': metadata says {} bytes, body is {} bytes",
                stored.meta.size,
                metadata.len()
            ));
        }
        Ok(path)
    }

    pub async fn put(
        &self,
        tenant: &str,
        key: &str,
        body: &[u8],
        content_type: &str,
        checksum_sha256: Option<&str>,
    ) -> Result<ObjectMeta, String> {
        let _validated = self
            .object_path(tenant, key)
            .ok_or_else(|| "invalid object key".to_string())?;
        let lock = self.key_lock(tenant, key);
        let _guard = lock.write().await;
        let now = now_iso();
        let previous = self.read_stored_meta(tenant, key).await?;
        let etag = checksum_hex(body);
        let key_hash = checksum_hex(key.as_bytes());
        let body_name = format!("{key_hash}.{etag}.blob");
        let body_path = self.body_path(tenant, &body_name);
        let bodies_dir = self.bodies_dir(tenant);
        let meta = ObjectMeta {
            key: key.to_string(),
            size: body.len() as u64,
            content_type: content_type.to_string(),
            etag,
            checksum_sha256: checksum_sha256.map(str::to_string),
            created_at: previous
                .as_ref()
                .map(|stored| stored.meta.created_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now,
        };
        // Body first, then metadata: the body file is unreferenced until the
        // metadata rename commits, so a crash can only leave an orphan body,
        // never metadata that points at a missing/partial body.
        let body_temp = write_temp(&bodies_dir, &key_hash, body).await?;
        if let Err(error) = tokio::fs::rename(&body_temp, &body_path).await {
            let _ = tokio::fs::remove_file(&body_temp).await;
            return Err(format!("replace object body for '{key}': {error}"));
        }
        sync_directory(&bodies_dir).await;

        let stored = StoredMeta {
            meta: meta.clone(),
            body_file: Some(body_name.clone()),
        };
        let meta_body = serde_json::to_vec(&stored).map_err(|error| error.to_string())?;
        let meta_dir = self.meta_dir(tenant);
        let meta_temp = match write_temp(&meta_dir, &key_hash, &meta_body).await {
            Ok(path) => path,
            Err(error) => {
                let previous_body = previous
                    .as_ref()
                    .and_then(|stored| self.body_path_for(tenant, key, stored));
                if previous_body.as_deref() != Some(body_path.as_path()) {
                    let _ = tokio::fs::remove_file(&body_path).await;
                }
                return Err(error);
            }
        };
        if let Err(error) = tokio::fs::rename(&meta_temp, self.meta_path(tenant, key)).await {
            let _ = tokio::fs::remove_file(&meta_temp).await;
            let previous_body = previous
                .as_ref()
                .and_then(|stored| self.body_path_for(tenant, key, stored));
            if previous_body.as_deref() != Some(body_path.as_path()) {
                let _ = tokio::fs::remove_file(&body_path).await;
            }
            return Err(format!("commit metadata for object '{key}': {error}"));
        }
        sync_directory(&meta_dir).await;

        if let Some(previous) = &previous {
            if let Some(previous_path) = self.body_path_for(tenant, key, previous) {
                if previous_path != body_path {
                    let _ = tokio::fs::remove_file(previous_path).await;
                }
            }
        }
        self.cleanup_key_bodies(tenant, key, &body_name).await;
        Ok(meta)
    }

    /// Remove stale bodies/temps for this key left by an interrupted older
    /// version or a previous crash. The newly committed body is kept.
    async fn cleanup_key_bodies(&self, tenant: &str, key: &str, keep: &str) {
        let dir = self.bodies_dir(tenant);
        let key_hash = checksum_hex(key.as_bytes());
        let body_prefix = format!("{key_hash}.");
        let temp_prefix = format!(".tmp-{key_hash}-");
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == keep {
                continue;
            }
            let stale_body = name.starts_with(&body_prefix) && name.ends_with(".blob");
            let stale_temp = name.starts_with(&temp_prefix);
            if stale_body || stale_temp {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    pub async fn get(&self, tenant: &str, key: &str) -> Result<Option<ObjectBody>, String> {
        let lock = self.key_lock(tenant, key);
        let _guard = lock.read().await;
        let Some(stored) = self.read_stored_meta(tenant, key).await? else {
            return Ok(None);
        };
        let path = self.checked_body_path(tenant, key, &stored).await?;
        let body = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("read object '{key}': {error}"))?;
        if body.len() as u64 != stored.meta.size {
            return Err(format!(
                "object body size mismatch for '{key}': metadata says {} bytes, body is {} bytes",
                stored.meta.size,
                body.len()
            ));
        }
        Ok(Some(ObjectBody {
            meta: stored.meta,
            body: Bytes::from(body),
        }))
    }

    /// Read only `[start, end]` from the object file. Used by ranged GETs so
    /// a small range never materializes the whole object.
    pub async fn get_range(
        &self,
        tenant: &str,
        key: &str,
        start: u64,
        end: u64,
    ) -> Result<Option<ObjectBody>, String> {
        let lock = self.key_lock(tenant, key);
        let _guard = lock.read().await;
        let Some(stored) = self.read_stored_meta(tenant, key).await? else {
            return Ok(None);
        };
        let path = self.checked_body_path(tenant, key, &stored).await?;
        if start >= stored.meta.size || end < start || end >= stored.meta.size {
            return Err(format!("range not satisfiable for object '{key}'"));
        }
        let length = end - start + 1;
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|error| format!("read object '{key}': {error}"))?;
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(|error| format!("seek object '{key}': {error}"))?;
        let mut buffer = vec![0u8; length as usize];
        file.read_exact(&mut buffer)
            .await
            .map_err(|error| format!("read object '{key}' range: {error}"))?;
        Ok(Some(ObjectBody {
            meta: stored.meta,
            body: Bytes::from(buffer),
        }))
    }

    pub async fn head(&self, tenant: &str, key: &str) -> Result<Option<ObjectMeta>, String> {
        let lock = self.key_lock(tenant, key);
        let _guard = lock.read().await;
        let Some(stored) = self.read_stored_meta(tenant, key).await? else {
            return Ok(None);
        };
        self.checked_body_path(tenant, key, &stored).await?;
        Ok(Some(stored.meta))
    }

    pub async fn delete(&self, tenant: &str, key: &str) -> Result<bool, String> {
        let lock = self.key_lock(tenant, key);
        let _guard = lock.write().await;
        let Some(stored) = self.read_stored_meta(tenant, key).await? else {
            return Ok(false);
        };
        // Metadata first: once it is gone the object is deleted. A crash or
        // failure afterwards can only leave an orphan body, which startup
        // recovery removes.
        match tokio::fs::remove_file(self.meta_path(tenant, key)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("delete metadata for object '{key}': {error}")),
        }
        if let Some(path) = self.body_path_for(tenant, key, &stored) {
            let _ = tokio::fs::remove_file(path).await;
        }
        self.cleanup_key_bodies(tenant, key, "").await;
        Ok(true)
    }

    pub async fn list(
        &self,
        tenant: &str,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> ListPage {
        let dir = self.meta_dir(tenant);
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
            let path = self.meta_dir(tenant).join(name);
            if let Ok(body) = tokio::fs::read(path).await {
                if let Ok(stored) = serde_json::from_slice::<StoredMeta>(&body) {
                    if stored.meta.key.starts_with(prefix) {
                        metas.push(stored.meta);
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

    /// Startup recovery for a filesystem volume: drop temporary files,
    /// stale metadata whose body is gone, and body files that no committed
    /// metadata references. Runs before the service starts serving traffic.
    fn recover_orphans(&self) {
        let meta_root = self.root.join("meta");
        let objects_root = self.root.join("objects");
        let bodies_root = self.root.join("bodies");
        let mut referenced: HashSet<PathBuf> = HashSet::new();
        let mut protected_tenants: HashSet<String> = HashSet::new();
        let mut removed_meta = 0usize;
        let mut removed_bodies = 0usize;
        let mut removed_temps = 0usize;

        match std::fs::read_dir(&meta_root) {
            Ok(tenants) => {
                for tenant in tenants.flatten() {
                    let segment = tenant.file_name().to_string_lossy().into_owned();
                    let dir = tenant.path();
                    let Ok(entries) = std::fs::read_dir(&dir) else {
                        // Do not delete bodies when their metadata directory
                        // is unreadable; recovery must never turn a permissions
                        // problem into data loss.
                        protected_tenants.insert(segment);
                        continue;
                    };
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        if name.starts_with(".tmp-") {
                            if std::fs::remove_file(entry.path()).is_ok() {
                                removed_temps += 1;
                            }
                            continue;
                        }
                        if !name.ends_with(".json") {
                            continue;
                        }
                        let Ok(raw) = std::fs::read(entry.path()) else {
                            protected_tenants.insert(segment.clone());
                            continue;
                        };
                        let Ok(stored) = serde_json::from_slice::<StoredMeta>(&raw) else {
                            // Corrupt metadata: keep every body in this tenant
                            // so an operator can still recover the bytes
                            // manually.
                            protected_tenants.insert(segment.clone());
                            continue;
                        };
                        let Some(body_path) =
                            body_path_for_segment(&self.root, &segment, &stored.meta.key, &stored)
                        else {
                            protected_tenants.insert(segment.clone());
                            continue;
                        };
                        match std::fs::metadata(&body_path) {
                            Ok(metadata) if metadata.is_file() => {
                                referenced.insert(body_path);
                            }
                            Ok(_) => {
                                // A directory/special file at the body path is
                                // corruption; keep the reference so recovery
                                // does not silently delete it, and let HEAD/GET
                                // report a backend error.
                                referenced.insert(body_path);
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                // Metadata was committed without a durable body
                                // (older releases wrote metadata first). The
                                // object is not readable; remove the stale entry.
                                if std::fs::remove_file(entry.path()).is_ok() {
                                    removed_meta += 1;
                                }
                            }
                            Err(_) => {
                                referenced.insert(body_path);
                            }
                        }
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                // The metadata root exists but cannot be read. Deleting
                // bodies would risk data loss, so leave recovery to an
                // operator.
                tracing::warn!(
                    "[storage] filesystem recovery skipped: cannot read {}: {error}",
                    meta_root.display()
                );
                return;
            }
        }

        for storage_root in [&bodies_root, &objects_root] {
            if let Ok(tenants) = std::fs::read_dir(storage_root) {
                for tenant in tenants.flatten() {
                    let segment = tenant.file_name().to_string_lossy().into_owned();
                    if protected_tenants.contains(&segment) {
                        continue;
                    }
                    let Ok(file_type) = tenant.file_type() else {
                        continue;
                    };
                    if file_type.is_dir() {
                        self.recover_objects_dir(
                            &tenant.path(),
                            &referenced,
                            &mut removed_bodies,
                            &mut removed_temps,
                        );
                    }
                }
            }
        }

        if removed_meta > 0 || removed_bodies > 0 || removed_temps > 0 {
            tracing::warn!(
                removed_meta,
                removed_bodies,
                removed_temps,
                "[storage] filesystem recovery removed orphaned metadata/bodies/temp files"
            );
        }
    }

    fn recover_objects_dir(
        &self,
        dir: &Path,
        referenced: &HashSet<PathBuf>,
        removed_bodies: &mut usize,
        removed_temps: &mut usize,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                self.recover_objects_dir(&path, referenced, removed_bodies, removed_temps);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".tmp-") {
                if std::fs::remove_file(&path).is_ok() {
                    *removed_temps += 1;
                }
                continue;
            }
            if !referenced.contains(&path) && std::fs::remove_file(&path).is_ok() {
                *removed_bodies += 1;
            }
        }
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
        let manifest_key = manifest
            .get("key")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if manifest_key != key {
            return Err("multipart upload key does not match the initiation key".into());
        }
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

    /// Sizes of the uploaded parts of a multipart upload (the part files on
    /// disk), so the final object size can be checked against the
    /// tenant/bucket quotas before assembling.
    pub async fn part_sizes(
        &self,
        tenant: &str,
        upload_id: &str,
    ) -> Result<Vec<(u64, u64)>, String> {
        let dir = self
            .upload_dir(tenant, upload_id)
            .ok_or_else(|| "invalid upload id".to_string())?;
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| error.to_string())?;
        let mut parts = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(number) = name
                .strip_suffix(".part")
                .and_then(|raw| raw.parse::<u64>().ok())
            else {
                continue;
            };
            let size = entry
                .metadata()
                .await
                .map_err(|error| error.to_string())?
                .len();
            parts.push((number, size));
        }
        parts.sort_by_key(|(number, _)| *number);
        Ok(parts)
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

    pub async fn get_range(
        &self,
        tenant: &str,
        key: &str,
        start: u64,
        end: u64,
    ) -> Result<Option<ObjectBody>, String> {
        let Some(object) = self
            .client
            .get_range(&Self::full(tenant, key), start, end)
            .await?
        else {
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

    /// Sizes of the uploaded parts of a multipart upload via ListParts, so
    /// the final object size can be checked against the tenant/bucket
    /// quotas before assembling.
    pub async fn part_sizes(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
    ) -> Result<Vec<(u64, u64)>, String> {
        let mut all = Vec::new();
        let mut marker: Option<u64> = None;
        // 1000 parts per page with at most 10k parts per upload → 12 pages
        // is a hard safety ceiling; a server that never stops paginating
        // fails closed instead of returning a partial (undercounted) list.
        for _ in 0..12 {
            let page = self
                .client
                .list_parts(&Self::full(tenant, key), upload_id, marker)
                .await?;
            let next = page.next;
            all.extend(page.parts);
            marker = match next {
                Some(next_marker) => Some(next_marker),
                None => return Ok(all),
            };
        }
        Err("s3 list parts: pagination did not terminate".into())
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
            Self::Fs(backend) => backend.get(tenant, key).await,
            Self::S3(backend) => backend.get(tenant, key).await,
        }
    }

    /// Read only the requested byte range. Filesystem reads seek in place;
    /// S3 uses a signed `Range` request. Handlers use this so a small ranged
    /// GET does not materialize the whole object.
    pub async fn get_range(
        &self,
        tenant: &str,
        key: &str,
        start: u64,
        end: u64,
    ) -> Result<Option<ObjectBody>, String> {
        match self {
            Self::Fs(backend) => backend.get_range(tenant, key, start, end).await,
            Self::S3(backend) => backend.get_range(tenant, key, start, end).await,
        }
    }

    pub async fn head(&self, tenant: &str, key: &str) -> Result<Option<ObjectMeta>, String> {
        match self {
            Self::Fs(backend) => backend.head(tenant, key).await,
            Self::S3(backend) => backend.head(tenant, key).await,
        }
    }

    pub async fn delete(&self, tenant: &str, key: &str) -> Result<bool, String> {
        match self {
            Self::Fs(backend) => backend.delete(tenant, key).await,
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

    /// Sizes of the uploaded parts for a multipart upload, keyed by part
    /// number. Used to compute the final object size before assembling so
    /// the tenant/bucket quotas apply to multipart completes as well.
    pub async fn part_sizes(
        &self,
        tenant: &str,
        upload_id: &str,
        key: &str,
    ) -> Result<Vec<(u64, u64)>, String> {
        match self {
            Self::Fs(backend) => backend.part_sizes(tenant, upload_id).await,
            Self::S3(backend) => backend.part_sizes(tenant, upload_id, key).await,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_body_name(key: &str, body: &[u8]) -> String {
        format!(
            "{}.{}.blob",
            checksum_hex(key.as_bytes()),
            checksum_hex(body)
        )
    }

    fn test_meta(key: &str, body: &[u8]) -> ObjectMeta {
        ObjectMeta {
            key: key.into(),
            size: body.len() as u64,
            content_type: "application/octet-stream".into(),
            etag: checksum_hex(body),
            checksum_sha256: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        }
    }

    #[tokio::test]
    async fn concurrent_puts_and_reads_never_see_mismatched_versions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = Arc::new(FileBackend::new(dir.path()).expect("backend"));
        let mut tasks = Vec::new();
        for index in 0..24u8 {
            let backend = backend.clone();
            tasks.push(tokio::spawn(async move {
                let body = vec![index; 64 + index as usize];
                backend
                    .put(
                        "org:concurrent",
                        "shared.bin",
                        &body,
                        "application/octet-stream",
                        None,
                    )
                    .await
                    .expect("put");
            }));
        }
        for _ in 0..8 {
            let backend = backend.clone();
            tasks.push(tokio::spawn(async move {
                for _ in 0..100 {
                    if let Some(object) = backend
                        .get("org:concurrent", "shared.bin")
                        .await
                        .expect("get")
                    {
                        assert_eq!(object.meta.size, object.body.len() as u64);
                        assert_eq!(object.meta.etag, checksum_hex(&object.body));
                        assert!(object.body.iter().all(|byte| *byte == object.body[0]));
                    }
                    tokio::task::yield_now().await;
                }
            }));
        }
        for task in tasks {
            task.await.expect("task");
        }
        let object = backend
            .get("org:concurrent", "shared.bin")
            .await
            .expect("get")
            .expect("object");
        assert_eq!(object.meta.size, object.body.len() as u64);
        assert_eq!(object.meta.etag, checksum_hex(&object.body));
    }

    #[tokio::test]
    async fn failed_body_commit_preserves_the_previous_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = FileBackend::new(dir.path()).expect("backend");
        backend
            .put("org:fault", "key.bin", b"first", "text/plain", None)
            .await
            .expect("first put");
        // Make the would-be body path a directory so the atomic rename fails
        // after metadata validation but before the new body can be committed.
        let blocked = backend.body_path("org:fault", &stored_body_name("key.bin", b"second"));
        std::fs::create_dir_all(&blocked).expect("blocker");
        let error = backend
            .put("org:fault", "key.bin", b"second", "text/plain", None)
            .await
            .expect_err("put must fail");
        assert!(error.contains("replace object body"), "{error}");
        let object = backend
            .get("org:fault", "key.bin")
            .await
            .expect("get")
            .expect("previous version");
        assert_eq!(object.body.as_ref(), b"first");
        assert_eq!(object.meta.etag, checksum_hex(b"first"));
        let stored = backend
            .read_stored_meta("org:fault", "key.bin")
            .await
            .expect("metadata")
            .expect("metadata");
        assert_eq!(
            stored.body_file.as_deref(),
            Some(stored_body_name("key.bin", b"first").as_str())
        );
        std::fs::remove_dir_all(&blocked).expect("unblock");
        backend
            .put("org:fault", "key.bin", b"second", "text/plain", None)
            .await
            .expect("second put");
        let object = backend
            .get("org:fault", "key.bin")
            .await
            .expect("get")
            .expect("object");
        assert_eq!(object.body.as_ref(), b"second");
    }

    #[tokio::test]
    async fn recovery_removes_orphans_and_stale_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = FileBackend::new(dir.path()).expect("backend");
        backend
            .put("org:recover", "kept.bin", b"kept", "text/plain", None)
            .await
            .expect("put");
        let bodies = backend.bodies_dir("org:recover");
        let orphan = bodies.join("deadbeef.orphan.blob");
        tokio::fs::write(&orphan, b"orphan").await.expect("orphan");
        let temp = bodies.join(".tmp-deadbeef-0-0");
        tokio::fs::write(&temp, b"temp").await.expect("temp");

        let missing_key = "missing.bin";
        let stale = StoredMeta {
            meta: test_meta(missing_key, b"gone"),
            body_file: Some(format!(
                "{}.{}.blob",
                checksum_hex(missing_key.as_bytes()),
                checksum_hex(b"gone")
            )),
        };
        tokio::fs::write(
            backend
                .meta_dir("org:recover")
                .join(format!("{}.json", checksum_hex(missing_key.as_bytes()))),
            serde_json::to_vec(&stale).expect("stale metadata"),
        )
        .await
        .expect("stale metadata");

        backend.recover_orphans();
        assert!(!orphan.exists());
        assert!(!temp.exists());
        assert!(backend
            .get("org:recover", missing_key)
            .await
            .expect("get stale")
            .is_none());
        let kept = backend
            .get("org:recover", "kept.bin")
            .await
            .expect("get kept")
            .expect("kept object");
        assert_eq!(kept.body.as_ref(), b"kept");
    }

    #[tokio::test]
    async fn legacy_metadata_without_body_file_still_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = FileBackend::new(dir.path()).expect("backend");
        let legacy_key = "legacy/object.bin";
        let body = b"legacy-body";
        let legacy_path = backend
            .object_path("org:legacy", legacy_key)
            .expect("legacy path");
        tokio::fs::create_dir_all(legacy_path.parent().unwrap())
            .await
            .expect("legacy dir");
        tokio::fs::write(&legacy_path, body)
            .await
            .expect("legacy body");
        let meta = test_meta(legacy_key, body);
        tokio::fs::create_dir_all(backend.meta_dir("org:legacy"))
            .await
            .expect("meta dir");
        tokio::fs::write(
            backend.meta_path("org:legacy", legacy_key),
            serde_json::to_vec(&meta).expect("legacy meta"),
        )
        .await
        .expect("legacy meta");

        let object = backend
            .get("org:legacy", legacy_key)
            .await
            .expect("get")
            .expect("legacy object");
        assert_eq!(object.body.as_ref(), body);

        backend
            .put("org:legacy", legacy_key, b"new-body", "text/plain", None)
            .await
            .expect("upgrade put");
        assert!(!legacy_path.exists(), "legacy body must be removed");
        let object = backend
            .get("org:legacy", legacy_key)
            .await
            .expect("get")
            .expect("upgraded object");
        assert_eq!(object.body.as_ref(), b"new-body");
    }

    #[tokio::test]
    async fn filesystem_range_read_returns_only_the_requested_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = FileBackend::new(dir.path()).expect("backend");
        let body = vec![7u8; 1024 * 1024];
        backend
            .put(
                "org:range",
                "big.bin",
                &body,
                "application/octet-stream",
                None,
            )
            .await
            .expect("put");
        let object = backend
            .get_range("org:range", "big.bin", 10, 19)
            .await
            .expect("range")
            .expect("object");
        assert_eq!(object.meta.size, body.len() as u64);
        assert_eq!(object.body.as_ref(), &body[10..=19]);
        assert_eq!(object.body.len(), 10);
    }
    #[tokio::test]
    async fn a_legacy_key_cannot_collide_with_a_content_addressed_body() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = FileBackend::new(dir.path()).expect("backend");
        let victim = b"victim-body";
        backend
            .put("org:collide", "victim.bin", victim, "text/plain", None)
            .await
            .expect("victim");
        // A legacy key deliberately shaped like another object's body file
        // must not be able to overwrite it in the filesystem namespace.
        let colliding_key = stored_body_name("victim.bin", victim);
        backend
            .put(
                "org:collide",
                &colliding_key,
                b"attacker-body",
                "text/plain",
                None,
            )
            .await
            .expect("colliding key");
        let object = backend
            .get("org:collide", "victim.bin")
            .await
            .expect("get")
            .expect("victim");
        assert_eq!(object.body.as_ref(), victim);
        assert_eq!(object.meta.etag, checksum_hex(victim));
    }
}
