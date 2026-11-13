// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Synapse Warehouse — tenant-scoped OLAP datasets, SQL queries and
//! batch/stream ETL jobs. Production backend: one DuckDB file per tenant.

mod api;
mod audit;
mod error;
mod sql;
mod store;
mod stream;
mod templates;
mod types;
mod usage;
mod util;

#[cfg(test)]
mod tests;

use std::time::Duration;

use tokio::net::TcpListener;

use api::{build_app, AppState, Config, VERSION};
use store::{StoreOptions, WarehouseStore};
use stream::StreamRuntime;

async fn check_health(port: u16) -> bool {
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
    let config = Config::from_env();
    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if check_health(config.port).await {
            0
        } else {
            1
        });
    }
    config
        .assert_production_config()
        .map_err(std::io::Error::other)?;
    if config.internal_secret.is_empty() {
        tracing::warn!(
            "[warehouse][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    let store = WarehouseStore::new(StoreOptions::from_env());
    store.preflight().map_err(std::io::Error::other)?;
    let stream_base = std::env::var("STREAM_SERVICE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://stream:4009".into());
    let runtime = StreamRuntime::new(store.clone(), stream_base, config.internal_secret.clone());
    let state = AppState {
        store,
        config: config.clone(),
        stream: runtime,
    };
    let app = build_app(state.clone());
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[warehouse] Synapse Warehouse v{VERSION} listening on port {}",
        config.port
    );

    let audit_task = tokio::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            audit::flush_now().await;
        }
    });

    state.stream.start_running().await;
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    audit_task.abort();
    result?;
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
