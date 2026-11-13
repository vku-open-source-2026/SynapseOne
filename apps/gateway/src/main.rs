// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOne Tier-1 gateway: the single public API edge.

mod app;
mod auth;
mod authz;
mod config;
mod headers;
mod metrics;
mod proxy;
mod rate_limit;
mod routes;
mod scopes;
mod usage;

#[cfg(test)]
mod tests;

use std::error::Error;
use std::net::SocketAddr;

use tokio::net::TcpListener;

use crate::config::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    if std::env::args().any(|arg| arg == "--healthcheck") {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8080);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build();
        let ok = match client {
            Ok(client) => client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false),
            Err(_) => false,
        };
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    config::apply_env_compat();
    let config = Config::from_env()?;
    let routes = routes::load_routes()?;
    tracing::info!(
        "[gateway] central authorization mode: {}",
        config.authz_mode.as_str()
    );
    tracing::info!(
        "[gateway] loaded {} routes: {}",
        routes.len(),
        routes
            .iter()
            .map(|route| format!(
                "{}->{}[{}]",
                route.path,
                routes::expand_env(&route.target),
                route.auth.as_str()
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let port = config.port;
    let (router, state) = app::create_app_with_state(config, routes)?;
    if state.usage.enabled() {
        tracing::info!("[gateway] usage telemetry enabled");
    }
    let usage_task = app::start_background(&state);
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("[gateway] listening on :{port}");

    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;

    // Best-effort: ship the last telemetry batch before exiting.
    state.usage.flush_now().await;
    if let Some(task) = usage_task {
        task.abort();
    }
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
    tracing::info!("[gateway] shutting down...");
}
