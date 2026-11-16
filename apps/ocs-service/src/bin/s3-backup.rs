// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//!
//! Rust replacement for `tools/backup/s3-backup.mjs`.
//!
//! Runs inside the SynapseOCS image and reuses its hand-rolled S3 client, so
//! the backup sidecar no longer needs Node or a second runtime.
//!
//! ```text
//! s3-backup once
//! s3-backup loop
//! s3-backup list
//! s3-backup restore [name|latest] [--prefix P] [--dry-run]
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use synapseone_ocs::s3::{ListedObject, S3Client, S3Config};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SnapshotObject {
    key: String,
    size: u64,
    etag: String,
    #[serde(rename = "contentType", default)]
    content_type: String,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Snapshot {
    #[serde(rename = "createdAt")]
    created_at: String,
    bucket: String,
    objects: Vec<SnapshotObject>,
}

#[derive(Clone, Debug)]
struct Config {
    dir: PathBuf,
    retention_days: i64,
    interval_seconds: u64,
    bucket: String,
    s3: S3Config,
}

impl Config {
    fn from_env() -> Self {
        let env = |name: &str| std::env::var(name).ok();
        let dir = env("BACKUP_DIR").unwrap_or_else(|| "/backups".into());
        let retention_days = env("BACKUP_RETENTION_DAYS")
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(7)
            .max(1);
        let interval_seconds = env("BACKUP_INTERVAL_SECONDS")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(86_400)
            .max(60);
        let bucket = env("STORAGE_S3_BUCKET").unwrap_or_else(|| "synapseone-core".into());
        let path_style = env("STORAGE_S3_PATH_STYLE")
            .map(|value| value != "false")
            .unwrap_or(true);
        Self {
            dir: PathBuf::from(dir),
            retention_days,
            interval_seconds,
            bucket: bucket.clone(),
            s3: S3Config {
                endpoint: env("STORAGE_S3_ENDPOINT").unwrap_or_else(|| "http://s3:9090".into()),
                bucket,
                region: env("STORAGE_S3_REGION").unwrap_or_else(|| "us-east-1".into()),
                access_key: env("STORAGE_S3_ACCESS_KEY").unwrap_or_else(|| "test".into()),
                secret_key: env("STORAGE_S3_SECRET_KEY").unwrap_or_else(|| "test".into()),
                path_style,
            },
        }
    }

    fn blobs_dir(&self) -> PathBuf {
        self.dir.join("blobs")
    }

    fn snapshots_dir(&self) -> PathBuf {
        self.dir.join("snapshots")
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.blobs_dir().join(&hash[..2]).join(hash)
    }
}

fn log(message: &str) {
    println!("[s3-backup] {message}");
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("create {}: {error}", path.display()))
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.part",
        path.extension().and_then(|value| value.to_str()).unwrap_or("tmp")
    ));
    fs::write(&tmp, data).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|error| format!("rename {}: {error}", path.display()))
}

fn snapshot_names(cfg: &Config) -> Result<Vec<String>, String> {
    ensure_dir(&cfg.snapshots_dir())?;
    let mut names = Vec::new();
    let entries = fs::read_dir(cfg.snapshots_dir())
        .map_err(|error| format!("read {}: {error}", cfg.snapshots_dir().display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn read_snapshot(cfg: &Config, name: &str) -> Result<Snapshot, String> {
    let path = cfg.snapshots_dir().join(name);
    let raw = fs::read_to_string(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}

async fn take_snapshot(cfg: &Config, client: &S3Client) -> Result<String, String> {
    ensure_dir(&cfg.blobs_dir())?;
    let names = snapshot_names(cfg)?;
    let mut previous: BTreeMap<String, SnapshotObject> = BTreeMap::new();
    if let Some(last) = names.last() {
        for object in read_snapshot(cfg, last)?.objects {
            previous.insert(object.key.clone(), object);
        }
    }

    let mut listed: Vec<ListedObject> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = client
            .list("", 1000, token.as_deref())
            .await
            .map_err(|error| format!("list s3 objects: {error}"))?;
        listed.extend(page.objects);
        match page.next {
            Some(next) if !next.is_empty() => token = Some(next),
            _ => break,
        }
    }

    let mut objects = Vec::with_capacity(listed.len());
    let mut downloaded = 0usize;
    let mut reused = 0usize;
    let mut total_bytes = 0u64;

    for object in listed {
        if let Some(prev) = previous.get(&object.key) {
            if prev.size == object.size
                && prev.etag == object.etag
                && cfg.blob_path(&prev.sha256).exists()
            {
                total_bytes += object.size;
                reused += 1;
                objects.push(prev.clone());
                continue;
            }
        }

        let Some(fetched) = client
            .get(&object.key)
            .await
            .map_err(|error| format!("get {}: {error}", object.key))?
        else {
            continue;
        };
        let hash = sha256_hex(&fetched.body);
        let target = cfg.blob_path(&hash);
        if !target.exists() {
            write_atomic(&target, &fetched.body)?;
        }
        total_bytes += fetched.body.len() as u64;
        downloaded += 1;
        objects.push(SnapshotObject {
            key: object.key,
            size: fetched.body.len() as u64,
            etag: if object.etag.is_empty() {
                fetched.etag
            } else {
                object.etag
            },
            content_type: fetched.content_type,
            sha256: hash,
        });
    }

    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let name = format!("{stamp}.json");
    let snapshot = Snapshot {
        created_at: iso_now(),
        bucket: cfg.bucket.clone(),
        objects,
    };
    write_atomic(
        &cfg.snapshots_dir().join(&name),
        serde_json::to_string_pretty(&snapshot)
            .map_err(|error| error.to_string())?
            .as_bytes(),
    )?;
    log(&format!(
        "snapshot {name}: {} objects, {total_bytes} bytes ({downloaded} downloaded, {reused} unchanged)",
        snapshot.objects.len()
    ));
    prune(cfg)?;
    Ok(name)
}

fn prune(cfg: &Config) -> Result<(), String> {
    let names = snapshot_names(cfg)?;
    let cutoff = Utc::now().timestamp_millis() - cfg.retention_days * 86_400_000;
    let mut keep = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let newest = index + 1 == names.len();
        let created = parse_timestamp(&read_snapshot(cfg, name)?.created_at).unwrap_or(0);
        if !newest && created < cutoff {
            let _ = fs::remove_file(cfg.snapshots_dir().join(name));
            log(&format!("expired snapshot {name}"));
        } else {
            keep.push(name.clone());
        }
    }

    let mut referenced = BTreeSet::new();
    for name in &keep {
        for object in read_snapshot(cfg, name)?.objects {
            referenced.insert(object.sha256);
        }
    }

    let mut removed = 0usize;
    if let Ok(shards) = fs::read_dir(cfg.blobs_dir()) {
        for shard in shards.flatten() {
            if !shard.path().is_dir() {
                continue;
            }
            if let Ok(files) = fs::read_dir(shard.path()) {
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().to_string();
                    if !referenced.contains(&name) {
                        let _ = fs::remove_file(file.path());
                        removed += 1;
                    }
                }
            }
        }
    }
    if removed > 0 {
        log(&format!("removed {removed} unreferenced blobs"));
    }
    Ok(())
}

async fn list_snapshots(cfg: &Config) -> Result<(), String> {
    for name in snapshot_names(cfg)? {
        let snapshot = read_snapshot(cfg, &name)?;
        let bytes: u64 = snapshot.objects.iter().map(|object| object.size).sum();
        println!("{name}\t{} objects\t{bytes} bytes", snapshot.objects.len());
    }
    Ok(())
}

async fn restore(cfg: &Config, client: &S3Client, args: &[String]) -> Result<(), String> {
    let names = snapshot_names(cfg)?;
    if names.is_empty() {
        return Err("no snapshots".into());
    }
    let wanted = args
        .iter()
        .find(|value| !value.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| "latest".into());
    let name = if wanted == "latest" {
        names.last().cloned().unwrap()
    } else {
        names
            .iter()
            .find(|candidate| **candidate == wanted || **candidate == format!("{wanted}.json"))
            .cloned()
            .ok_or_else(|| format!("snapshot {wanted} not found (run: s3-backup list)"))?
    };
    let prefix = args
        .iter()
        .position(|value| value == "--prefix")
        .and_then(|index| args.get(index + 1))
        .cloned()
        .unwrap_or_default();
    let dry_run = args.iter().any(|value| value == "--dry-run");

    let snapshot = read_snapshot(cfg, &name)?;
    let mut restored = 0usize;
    let mut same = 0usize;
    let mut failed = 0usize;
    for object in &snapshot.objects {
        if !prefix.is_empty() && !object.key.starts_with(&prefix) {
            continue;
        }
        let result: Result<bool, String> = async {
            if let Some(current) = client
                .head(&object.key)
                .await
                .map_err(|error| format!("head {}: {error}", object.key))?
            {
                if current.size == object.size && current.etag == object.etag {
                    same += 1;
                    return Ok(false);
                }
            }
            if dry_run {
                log(&format!("would restore {}", object.key));
                return Ok(true);
            }
            let path = cfg.blob_path(&object.sha256);
            let body = fs::read(&path).map_err(|error| format!("read {}: {error}", path.display()))?;
            if sha256_hex(&body) != object.sha256 {
                return Err(format!("blob checksum mismatch for {}", object.key));
            }
            client
                .put(
                    &object.key,
                    &body,
                    if object.content_type.is_empty() {
                        "application/octet-stream"
                    } else {
                        &object.content_type
                    },
                    Some(&object.sha256),
                )
                .await
                .map_err(|error| format!("put {}: {error}", object.key))?;
            Ok(true)
        }
        .await;
        match result {
            Ok(true) => restored += 1,
            Ok(false) => {}
            Err(error) => {
                failed += 1;
                eprintln!("[s3-backup] restore {}: {error}", object.key);
            }
        }
    }
    log(&format!(
        "restore from {name}{}{}: {restored} restored, {same} already identical, {failed} failed",
        if prefix.is_empty() {
            String::new()
        } else {
            format!(" (prefix {prefix})")
        },
        if dry_run { " [dry-run]" } else { "" }
    ));
    if failed > 0 {
        return Err(format!("{failed} object(s) failed to restore"));
    }
    Ok(())
}

async fn run(cfg: &Config, command: &str, args: &[String]) -> Result<(), String> {
    let client = S3Client::new(cfg.s3.clone()).map_err(|error| format!("s3 client: {error}"))?;
    match command {
        "once" => {
            take_snapshot(cfg, &client).await?;
        }
        "list" => list_snapshots(cfg).await?,
        "restore" => restore(cfg, &client, args).await?,
        "loop" => {
            log(&format!(
                "every {}s, keep {} days, bucket {}",
                cfg.interval_seconds, cfg.retention_days, cfg.bucket
            ));
            loop {
                if let Err(error) = take_snapshot(cfg, &client).await {
                    eprintln!("[s3-backup] snapshot failed: {error}");
                }
                tokio::time::sleep(Duration::from_secs(cfg.interval_seconds)).await;
            }
        }
        other => {
            return Err(format!(
                "usage: s3-backup once|loop|list|restore [name|latest] [--prefix P] [--dry-run] (got {other})"
            ));
        }
    }
    Ok(())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "once".into());
    let rest: Vec<String> = args.collect();
    let cfg = Config::from_env();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[s3-backup] runtime: {error}");
            std::process::exit(1);
        }
    };
    match runtime.block_on(run(&cfg, &command, &rest)) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("[s3-backup] {error}");
            let _ = std::io::stderr().flush();
            std::process::exit(1);
        }
    }
}
