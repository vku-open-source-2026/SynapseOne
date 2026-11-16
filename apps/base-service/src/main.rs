// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase — self-managed document database (Firebase-like) with
//! collections, typed object<->data mapping, queries, optimistic versions,
//! atomic counters, batch writes, a change feed, graph, GIS and search.

mod api;
mod audit;
mod cache;
mod error;
mod gis;
mod graph;
mod mapping;
mod outbox;
mod pg_query;
mod query;
mod search;
mod store;
mod util;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::net::TcpListener;

use cache::Cache;

pub const VERSION: &str = "0.7.1";

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub is_prod: bool,
    pub internal_secret: String,
    pub database_url: String,
    pub database_direct_url: String,
    pub cors_origins: Vec<String>,
    pub hsts_enabled: bool,
    pub max_document_bytes: usize,
    pub query_scan_limit: i64,
    pub faststore_service_url: String,
    pub cache_ttl_seconds: i64,
    pub cache_timeout_ms: u64,
    pub outbox_stream_topic: String,
    pub stream_service_url: String,
    pub outbox_relay_ms: u64,
    pub inference_service_url: String,
    pub synapseone_api_key: String,
    pub audit_enabled: bool,
    pub audit_ingest_url_override: Option<String>,
    pub iam_service_url: String,
    /// Collection-name prefixes reserved for operator/machine credentials
    /// (for example `synapsedx_` for the Tier-2 service account). Empty by
    /// default: a general PaaS deployment keeps every collection tenant-scoped.
    pub machine_collection_prefixes: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let cors_origins = std::env::var("CORS_ORIGIN")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect();
        let max_document_bytes = util::env_f64("BASE_MAX_DOCUMENT_BYTES", 262_144.0);
        let max_document_bytes = if max_document_bytes.is_finite() {
            max_document_bytes.clamp(1024.0, 4.0 * 1024.0 * 1024.0) as usize
        } else {
            262_144
        };
        let query_scan_limit = util::env_f64("BASE_QUERY_SCAN_LIMIT", 200_000.0);
        let query_scan_limit = if query_scan_limit.is_finite() {
            query_scan_limit.clamp(100.0, 1_000_000.0) as i64
        } else {
            200_000
        };
        let audit_ingest_url = util::env_string("AUDIT_INGEST_URL", "");
        let cache_ttl = util::env_u64("BASE_CACHE_TTL_SECONDS", 60).clamp(1, 3600) as i64;
        let cache_timeout = util::env_u64("BASE_CACHE_TIMEOUT_MS", 250).clamp(25, 5000);
        let outbox_relay_ms = util::env_u64("BASE_OUTBOX_RELAY_MS", 1000).clamp(100, 60_000);
        Self {
            port: util::env_u64("PORT", 4005) as u16,
            is_prod: std::env::var("NODE_ENV").as_deref() == Ok("production"),
            internal_secret: util::env_string("SYNAPSEONE_INTERNAL_SECRET", ""),
            database_url: std::env::var("DATABASE_URL").unwrap_or_default(),
            database_direct_url: std::env::var("DATABASE_DIRECT_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| std::env::var("DATABASE_URL").unwrap_or_default()),
            cors_origins,
            hsts_enabled: util::env_string("HSTS_ENABLED", "false") == "true",
            max_document_bytes,
            query_scan_limit,
            faststore_service_url: util::env_string("FASTSTORE_SERVICE_URL", "")
                .trim_end_matches('/')
                .to_string(),
            cache_ttl_seconds: cache_ttl,
            cache_timeout_ms: cache_timeout,
            outbox_stream_topic: util::env_string("BASE_OUTBOX_STREAM_TOPIC", "base-changes"),
            stream_service_url: std::env::var("STREAM_SERVICE_URL")
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string(),
            outbox_relay_ms,
            inference_service_url: util::env_string("INFERENCE_SERVICE_URL", "")
                .trim_end_matches('/')
                .to_string(),
            synapseone_api_key: util::env_string("SYNAPSEONE_API_KEY", ""),
            audit_enabled: util::env_string("AUDIT_TRAIL", "true") != "false",
            audit_ingest_url_override: if audit_ingest_url.is_empty() {
                None
            } else {
                Some(audit_ingest_url)
            },
            iam_service_url: util::env_string("IAM_SERVICE_URL", "http://iam:4001")
                .trim_end_matches('/')
                .to_string(),
            machine_collection_prefixes: util::parse_collection_prefixes(&util::env_string(
                "SYNAPSEONE_BASE_MACHINE_COLLECTION_PREFIXES",
                "",
            )),
        }
    }

    pub fn for_test() -> Self {
        Self {
            port: 0,
            is_prod: false,
            internal_secret: String::new(),
            database_url: String::new(),
            database_direct_url: String::new(),
            cors_origins: Vec::new(),
            hsts_enabled: false,
            max_document_bytes: 262_144,
            query_scan_limit: 200_000,
            faststore_service_url: String::new(),
            cache_ttl_seconds: 60,
            cache_timeout_ms: 250,
            outbox_stream_topic: "base-changes".into(),
            stream_service_url: String::new(),
            outbox_relay_ms: 1000,
            inference_service_url: String::new(),
            synapseone_api_key: String::new(),
            audit_enabled: true,
            audit_ingest_url_override: None,
            iam_service_url: "http://iam:4001".into(),
            machine_collection_prefixes: Vec::new(),
        }
    }

    pub fn audit_ingest_url(&self) -> String {
        match &self.audit_ingest_url_override {
            Some(url) => url.clone(),
            None => format!("{}/v1/audit/ingest", self.iam_service_url),
        }
    }

    pub fn is_production_config(&self) -> Result<(), String> {
        if !self.is_prod {
            return Ok(());
        }
        if self.internal_secret.is_empty() {
            return Err("[base] SYNAPSEONE_INTERNAL_SECRET must be set in production".into());
        }
        if self.database_url.trim().is_empty() {
            return Err(
                "[base] DATABASE_URL must be set in production (in-memory fallback would split-brain)"
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct Metrics {
    requests: Arc<Mutex<HashMap<String, u64>>>,
}

impl Metrics {
    pub fn record(&self, method: &str, route: &str, status: u16) {
        if let Ok(mut requests) = self.requests.lock() {
            let route = if requests.len() >= 300 {
                "**".to_string()
            } else if route.chars().count() > 64 {
                route.chars().take(64).collect::<String>()
            } else {
                route.to_string()
            };
            let key = format!("{method}|{route}|{status}");
            *requests.entry(key).or_insert(0) += 1;
        }
    }

    pub fn snapshot(&self) -> Vec<(String, u64)> {
        self.requests
            .lock()
            .map(|requests| {
                let mut entries: Vec<(String, u64)> = requests
                    .iter()
                    .map(|(key, value)| (key.clone(), *value))
                    .collect();
                entries.sort();
                entries
            })
            .unwrap_or_default()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: store::Store,
    pub config: Config,
    pub cache: Cache,
    pub audit: audit::Audit,
    pub metrics: Metrics,
    pub started_at: Instant,
}

impl AppState {
    pub fn new(store: store::Store, config: Config) -> Self {
        let cache = Cache::from_config(&config);
        let audit = audit::Audit::from_config(&config);
        Self {
            store,
            config,
            cache,
            audit,
            metrics: Metrics::default(),
            started_at: Instant::now(),
        }
    }
}

fn apply_env_compat() {
    let vars: Vec<(String, String)> = std::env::vars().collect();
    for (key, value) in vars {
        if let Some(rest) = key.strip_prefix("SYNAPSEDX_") {
            let next = format!("SYNAPSEONE_{rest}");
            if std::env::var(&next).is_err() {
                std::env::set_var(next, value);
            }
        }
    }
}

async fn check_health(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
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
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    apply_env_compat();
    let config = Config::from_env();
    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if check_health(config.port).await {
            0
        } else {
            1
        });
    }
    if let Err(error) = config.is_production_config() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    if !config.is_prod && config.internal_secret.is_empty() {
        tracing::warn!(
            "[base][security] SYNAPSEONE_INTERNAL_SECRET not set — service-to-service auth disabled (dev default)."
        );
    }
    if !config.is_prod && config.cors_origins.is_empty() {
        tracing::warn!(
            "[base][security] CORS_ORIGIN not set — allowing all origins (dev default)."
        );
    }
    if !config.machine_collection_prefixes.is_empty() {
        tracing::info!(
            "[base][security] machine-only collection prefixes: {}",
            config.machine_collection_prefixes.join(",")
        );
    }
    let store = store::Store::connect_with_direct(
        Some(&config.database_url),
        Some(&config.database_direct_url),
    )
    .await
    .map_err(|error| format!("[base] database setup failed: {error}"))?;
    let state = AppState::new(store.clone(), config.clone());
    let app = api::build_app(state.clone());
    let listener = TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!(
        "[base] SynapseBase listening on :{} (db={})",
        config.port,
        if store.uses_postgres() {
            "postgres"
        } else {
            "memory"
        }
    );
    let audit_state = state.clone();
    let audit_worker = tokio::spawn(async move {
        if !audit_state.audit.enabled() {
            return;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            audit_state.audit.flush_now().await;
        }
    });
    let relay_state = state.clone();
    let relay_worker = if config.stream_service_url.is_empty() {
        tracing::warn!("[base][outbox] STREAM_SERVICE_URL not set — outbox relay disabled");
        None
    } else {
        Some(tokio::spawn(async move {
            let interval = relay_state.config.outbox_relay_ms;
            let _ = outbox::relay_outbox_once(&relay_state.store, &relay_state.config, 100).await;
            loop {
                tokio::time::sleep(Duration::from_millis(interval)).await;
                let _ =
                    outbox::relay_outbox_once(&relay_state.store, &relay_state.config, 100).await;
            }
        }))
    };
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    audit_worker.abort();
    if let Some(worker) = relay_worker {
        worker.abort();
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
}
