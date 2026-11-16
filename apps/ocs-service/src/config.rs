// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Runtime configuration for SynapseOCS.
//!
//! Legacy `SYNAPSEDX_*` variables are mirrored to `SYNAPSEONE_*` at startup,
//! matching `env-compat.ts`. Production boot is fail-closed: internal secret,
//! storage backend and CORS origins are required.

use std::collections::HashMap;

pub const DEFAULT_PORT: u16 = 4010;
pub const DEFAULT_MAX_OBJECT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_OBJECT_BYTES_CEILING: u64 = 5 * 1024 * 1024 * 1024;
pub const DEFAULT_TENANT_QUOTA_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const MAX_TENANT_QUOTA_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
pub const DEFAULT_PRESIGN_SECRET: &str = "ocs-dev-presign-secret";
pub const DEFAULT_PUBLIC_BASE_URL: &str = "https://api.synapseone.space";

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub is_prod: bool,
    pub internal_secret: String,
    pub cors_origins: Vec<String>,
    pub max_object_bytes: usize,
    pub tenant_quota_bytes: u64,
    pub allowed_types: Vec<String>,
    pub presign_secret: String,
    pub public_base_url: String,
}

/// Mirror legacy `SYNAPSEDX_*` variables onto `SYNAPSEONE_*` when the new
/// name is not already set. New names always win.
pub fn apply_env_compat() {
    let legacy = std::env::vars()
        .filter_map(|(key, value)| {
            key.strip_prefix("SYNAPSEDX_")
                .map(|suffix| (format!("SYNAPSEONE_{suffix}"), value))
        })
        .collect::<Vec<_>>();
    for (key, value) in legacy {
        let missing = std::env::var(&key)
            .map(|current| current.is_empty())
            .unwrap_or(true);
        if missing {
            std::env::set_var(key, value);
        }
    }
}

pub fn env_map() -> HashMap<String, String> {
    std::env::vars().collect()
}

fn env_value(env: &HashMap<String, String>, name: &str) -> String {
    env.get(name).cloned().unwrap_or_default()
}

/// `Number(value)` semantics for the numeric limits. Non-numeric values fall
/// back to the documented default instead of poisoning every request.
fn clamp_number(raw: &str, fallback: u64, min: u64, max: u64) -> u64 {
    let parsed = raw.trim().parse::<f64>().ok().filter(|v| v.is_finite());
    let value = parsed.unwrap_or(fallback as f64);
    let clamped = value.max(min as f64).min(max as f64);
    clamped as u64
}

fn csv_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_lowercase())
        .collect()
}

pub fn assert_production_config(env: &HashMap<String, String>) -> Result<(), String> {
    if env.get("NODE_ENV").map(String::as_str) != Some("production") {
        return Ok(());
    }
    if env_value(env, "SYNAPSEONE_INTERNAL_SECRET").is_empty() {
        return Err("[storage] SYNAPSEONE_INTERNAL_SECRET must be set in production.".into());
    }
    let backend = env_value(env, "STORAGE_BACKEND");
    if backend.is_empty() {
        return Err("[storage] STORAGE_BACKEND must be set in production (fs|s3).".into());
    }
    if backend == "s3" {
        for key in [
            "STORAGE_S3_ENDPOINT",
            "STORAGE_S3_BUCKET",
            "STORAGE_S3_ACCESS_KEY",
            "STORAGE_S3_SECRET_KEY",
        ] {
            if env_value(env, key).is_empty() {
                return Err(format!("[storage] {key} must be set for the S3 backend."));
            }
        }
    }
    if csv_list(&env_value(env, "CORS_ORIGIN")).is_empty() {
        return Err("[storage] CORS_ORIGIN must be set in production.".into());
    }
    Ok(())
}

impl Config {
    pub fn from_env_map(env: &HashMap<String, String>) -> Result<Self, String> {
        assert_production_config(env)?;
        let is_prod = env.get("NODE_ENV").map(String::as_str) == Some("production");
        let internal_secret = env_value(env, "SYNAPSEONE_INTERNAL_SECRET");
        let presign_secret =
            match env_value(env, "OCS_PRESIGN_SECRET") {
                secret if !secret.is_empty() => secret,
                _ if !internal_secret.is_empty() => internal_secret.clone(),
                _ if is_prod => return Err(
                    "SynapseOCS presign requires OCS_PRESIGN_SECRET or SYNAPSEONE_INTERNAL_SECRET"
                        .into(),
                ),
                _ => DEFAULT_PRESIGN_SECRET.into(),
            };
        let port = env_value(env, "PORT")
            .trim()
            .parse::<u16>()
            .unwrap_or(DEFAULT_PORT);
        let max_object_bytes = clamp_number(
            &env_value(env, "STORAGE_MAX_OBJECT_BYTES"),
            DEFAULT_MAX_OBJECT_BYTES,
            1024,
            MAX_OBJECT_BYTES_CEILING,
        ) as usize;
        let tenant_quota_bytes = clamp_number(
            &env_value(env, "STORAGE_TENANT_QUOTA_BYTES"),
            DEFAULT_TENANT_QUOTA_BYTES,
            1024,
            MAX_TENANT_QUOTA_BYTES,
        );
        let public_base_url = match env_value(env, "OCS_PUBLIC_BASE_URL") {
            base if !base.is_empty() => base,
            _ => DEFAULT_PUBLIC_BASE_URL.into(),
        }
        .trim_end_matches('/')
        .to_string();
        Ok(Self {
            port,
            is_prod,
            internal_secret,
            cors_origins: csv_list(&env_value(env, "CORS_ORIGIN")),
            max_object_bytes,
            tenant_quota_bytes,
            allowed_types: csv_list(&env_value(env, "STORAGE_ALLOWED_CONTENT_TYPES")),
            presign_secret,
            public_base_url,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::from_env_map(&env_map())
    }

    pub fn for_test() -> Self {
        Self {
            port: 0,
            is_prod: false,
            internal_secret: String::new(),
            cors_origins: Vec::new(),
            max_object_bytes: DEFAULT_MAX_OBJECT_BYTES as usize,
            tenant_quota_bytes: DEFAULT_TENANT_QUOTA_BYTES,
            allowed_types: Vec::new(),
            presign_secret: DEFAULT_PRESIGN_SECRET.into(),
            public_base_url: DEFAULT_PUBLIC_BASE_URL.into(),
        }
    }
}
