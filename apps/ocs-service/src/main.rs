// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOCS binary entrypoint: boot, production fail-closed checks, health
//! probe mode and graceful shutdown.

use std::time::Duration;

use synapseone_ocs::build_app;
use synapseone_ocs::config::{self, Config};
use synapseone_ocs::create_backend;

fn warn_production_storage(env: &std::collections::HashMap<String, String>) {
    if env.get("NODE_ENV").map(String::as_str) != Some("production") {
        return;
    }
    if env.get("STORAGE_BACKEND").map(String::as_str) != Some("s3") {
        return;
    }
    let endpoint = env
        .get("STORAGE_S3_ENDPOINT")
        .map(|value| value.trim())
        .unwrap_or("");
    let is_mock = {
        let lower = endpoint.to_lowercase();
        ["s3mock", "adobe", "localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|needle| lower.contains(needle))
    };
    if is_mock {
        let banner = "=".repeat(72);
        eprintln!("{banner}");
        eprintln!("[storage] WARNING: production object storage is pointed at a test mock");
        eprintln!("[storage] endpoint: {endpoint}");
        eprintln!(
            "[storage] This is NOT durable production storage. Configure a real S3-compatible"
        );
        eprintln!("[storage] endpoint (bundled SeaweedFS, MinIO, AWS S3 or Cloudflare R2) via");
        eprintln!("[storage] STORAGE_S3_ENDPOINT with matching STORAGE_S3_ACCESS_KEY/SECRET_KEY.");
        eprintln!("{banner}");
    }
}

fn check_health(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buffer = String::new();
    if stream.read_to_string(&mut buffer).is_err() {
        return false;
    }
    buffer.starts_with("HTTP/1.1 200") || buffer.starts_with("HTTP/1.0 200")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    config::apply_env_compat();
    let env = config::env_map();
    let config = Config::from_env_map(&env)?;
    if std::env::args().any(|argument| argument == "--healthcheck") {
        std::process::exit(if check_health(config.port) { 0 } else { 1 });
    }
    warn_production_storage(&env);
    if !config.is_prod && config.cors_origins.is_empty() {
        tracing::warn!(
            "[storage][security] CORS_ORIGIN not set — allowing all origins (dev default)."
        );
    }
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[storage][security] SYNAPSEONE_INTERNAL_SECRET not set — tenant headers are trusted (dev default)."
        );
    }
    let backend = create_backend(&env, &config)?;
    tracing::info!("[storage] Active object backend: {}", backend.name());
    let app = build_app(backend, config.clone());
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[ocs] SynapseOCS v{} listening on :{}",
        env!("CARGO_PKG_VERSION"),
        config.port
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
