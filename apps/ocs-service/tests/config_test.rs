// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Configuration, fail-closed and key-validation tests.

use std::collections::HashMap;

use synapseone_ocs::backend::{checksum_hex, tenant_segment, validate_key};
use synapseone_ocs::config::{
    assert_production_config, Config, DEFAULT_MAX_OBJECT_BYTES, DEFAULT_TENANT_QUOTA_BYTES,
    MAX_OBJECT_BYTES_CEILING, MAX_TENANT_QUOTA_BYTES,
};
use synapseone_ocs::{create_backend, Backend};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

#[test]
fn production_fails_closed_without_secret_backend_and_cors() {
    let error = assert_production_config(&env(&[("NODE_ENV", "production")])).unwrap_err();
    assert!(error.contains("SYNAPSEONE_INTERNAL_SECRET"));

    let error = assert_production_config(&env(&[
        ("NODE_ENV", "production"),
        ("SYNAPSEONE_INTERNAL_SECRET", "s"),
    ]))
    .unwrap_err();
    assert!(error.contains("STORAGE_BACKEND"));

    let error = assert_production_config(&env(&[
        ("NODE_ENV", "production"),
        ("SYNAPSEONE_INTERNAL_SECRET", "s"),
        ("STORAGE_BACKEND", "fs"),
    ]))
    .unwrap_err();
    assert!(error.contains("CORS_ORIGIN"));

    assert!(assert_production_config(&env(&[
        ("NODE_ENV", "production"),
        ("SYNAPSEONE_INTERNAL_SECRET", "s"),
        ("STORAGE_BACKEND", "fs"),
        ("CORS_ORIGIN", "https://a.example"),
    ]))
    .is_ok());

    let error = assert_production_config(&env(&[
        ("NODE_ENV", "production"),
        ("SYNAPSEONE_INTERNAL_SECRET", "s"),
        ("STORAGE_BACKEND", "s3"),
        ("CORS_ORIGIN", "https://a.example"),
    ]))
    .unwrap_err();
    assert!(error.contains("STORAGE_S3_ENDPOINT"));
}

#[test]
fn non_production_config_does_not_require_secrets() {
    assert!(assert_production_config(&env(&[("NODE_ENV", "test")])).is_ok());
    assert!(assert_production_config(&HashMap::new()).is_ok());
}

#[test]
fn config_parses_limits_types_and_public_url() {
    let config = Config::from_env_map(&env(&[
        ("PORT", "4100"),
        ("STORAGE_MAX_OBJECT_BYTES", "1"),
        ("STORAGE_TENANT_QUOTA_BYTES", "999999999999999999"),
        (
            "STORAGE_ALLOWED_CONTENT_TYPES",
            " Image/PNG, application/pdf ,, ",
        ),
        ("OCS_PUBLIC_BASE_URL", "https://cdn.example.test///"),
        ("OCS_PRESIGN_SECRET", "presign"),
    ]))
    .unwrap();
    assert_eq!(config.port, 4100);
    assert_eq!(config.max_object_bytes, 1024);
    assert_eq!(config.tenant_quota_bytes, MAX_TENANT_QUOTA_BYTES);
    assert_eq!(
        config.allowed_types,
        vec!["image/png".to_string(), "application/pdf".to_string()]
    );
    assert_eq!(config.public_base_url, "https://cdn.example.test");
    assert_eq!(config.presign_secret, "presign");

    let defaults = Config::from_env_map(&HashMap::new()).unwrap();
    assert_eq!(defaults.port, 4010);
    assert_eq!(defaults.max_object_bytes as u64, DEFAULT_MAX_OBJECT_BYTES);
    assert_eq!(defaults.tenant_quota_bytes, DEFAULT_TENANT_QUOTA_BYTES);
    assert_eq!(defaults.presign_secret, "ocs-dev-presign-secret");
    assert_eq!(defaults.public_base_url, "https://api.synapseone.space");

    let ceiling =
        Config::from_env_map(&env(&[("STORAGE_MAX_OBJECT_BYTES", "999999999999")])).unwrap();
    assert_eq!(ceiling.max_object_bytes as u64, MAX_OBJECT_BYTES_CEILING);
}

#[test]
fn create_backend_rejects_unknown_and_incomplete_s3() {
    let config = Config::for_test();
    let error = create_backend(&env(&[("STORAGE_BACKEND", "gcs")]), &config).unwrap_err();
    assert!(error.contains("unknown STORAGE_BACKEND"));

    let error = create_backend(
        &env(&[
            ("STORAGE_BACKEND", "s3"),
            ("STORAGE_S3_ENDPOINT", "https://s3.example.com"),
        ]),
        &config,
    )
    .unwrap_err();
    assert!(error.contains("bucket"));
    assert!(error.contains("accessKey"));
    assert!(error.contains("secretKey"));

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let backend = create_backend(
        &env(&[("STORAGE_BACKEND", "fs"), ("STORAGE_FS_ROOT", root)]),
        &config,
    )
    .unwrap();
    assert_eq!(backend.name(), "fs");

    let backend = create_backend(
        &env(&[
            ("STORAGE_BACKEND", "s3"),
            ("STORAGE_S3_ENDPOINT", "https://s3.example.com"),
            ("STORAGE_S3_BUCKET", "bucket"),
            ("STORAGE_S3_ACCESS_KEY", "key"),
            ("STORAGE_S3_SECRET_KEY", "secret"),
        ]),
        &config,
    )
    .unwrap();
    assert_eq!(backend.name(), "s3");
    assert!(matches!(backend, Backend::S3(_)));
}

#[test]
fn key_validation_contract() {
    assert_eq!(validate_key("reports/2026/photo.png"), None);
    assert_eq!(validate_key("a!b*c(d)e:f@h$i=j+k-l_m.n'o"), None);
    assert!(validate_key("").is_some());
    assert!(validate_key(&"a".repeat(1025)).is_some());
    assert!(validate_key("/absolute").is_some());
    assert!(validate_key("trailing/").is_some());
    assert!(validate_key("back\\slash").is_some());
    assert!(validate_key("a//b").is_some());
    assert!(validate_key("a/./b").is_some());
    assert!(validate_key("a/../b").is_some());
    assert!(validate_key("white space").is_some());
    assert!(validate_key("unicode/é").is_some());
}

#[test]
fn tenant_segment_and_checksum_are_stable() {
    let segment = tenant_segment("org:acme");
    assert_eq!(segment.len(), 32);
    assert_eq!(segment, tenant_segment("org:acme"));
    assert_ne!(segment, tenant_segment("org:other"));
    assert!(segment
        .chars()
        .all(|character| character.is_ascii_hexdigit()));
    assert_eq!(
        checksum_hex(b"hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}
