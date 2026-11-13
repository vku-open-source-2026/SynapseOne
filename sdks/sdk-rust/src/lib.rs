// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Async Rust SDK for the SynapseOne platform gateway (Tier 1).
//!
//! ```no_run
//! use synapseone::{Client, Credentials, Query};
//! use serde_json::json;
//!
//! # async fn example() -> synapseone::Result<()> {
//! let client = Client::new(
//!     "https://api.synapseone.space",
//!     Credentials::api_key("synapseone_..."),
//! )?;
//!
//! let page = client
//!     .base()
//!     .query_documents(
//!         "contribution_features",
//!         Query::new().filter(json!({ "city_synced": false })).limit(100),
//!     )
//!     .await?;
//!
//! println!("{} documents", page.items.len());
//! # Ok(())
//! # }
//! ```
//!
//! The crate mirrors the published Python/JS/Go SDKs: one gateway client,
//! namespaced service handles, retries for idempotent requests and typed
//! errors that retain the platform error code and response body.

#![forbid(unsafe_code)]
// Thin wrappers intentionally mirror the HTTP API's argument lists and keep the
// full platform error body on the error type for callers to inspect.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

pub mod ai;
pub mod base;
pub mod client;
pub mod error;
pub mod faststore;
pub mod health;
pub mod iam;
pub mod inference;
pub mod lds;
pub mod notifications;
pub mod ocs;
pub mod queue;
pub mod storage;
pub mod stream;
pub mod types;
pub mod warehouse;
pub mod workflow;

pub use ai::AiService;
pub use base::{BaseService, Collection};
pub use client::{
    query_string, segment, BinaryResponse, Client, ClientBuilder, Credentials, Request, Response,
    DEFAULT_BASE_URL, DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_BASE, DEFAULT_TIMEOUT,
};
pub use error::{Error, ErrorSummary, Result};
pub use faststore::FaststoreService;
pub use health::HealthService;
pub use iam::IamService;
pub use inference::InferenceService;
pub use lds::LdsService;
pub use notifications::NotificationsService;
pub use ocs::OcsService;
pub use queue::QueueService;
pub use storage::StorageService;
pub use stream::StreamService;
pub use types::{
    BatchOperation, CollectionStats, HealthReport, OrderBy, Query, QueryResult, VectorSearchResult,
};
pub use warehouse::WarehouseService;
pub use workflow::{trigger_webhook, WorkflowService};

use http::Method;
use serde_json::Value;

impl Client {
    /// Base service handle.
    pub fn base(&self) -> BaseService {
        BaseService::new(self.clone())
    }

    pub fn iam(&self) -> IamService {
        IamService::new(self.clone())
    }

    pub fn workflow(&self) -> WorkflowService {
        WorkflowService::new(self.clone())
    }

    pub fn queue(&self) -> QueueService {
        QueueService::new(self.clone())
    }

    pub fn stream(&self) -> StreamService {
        StreamService::new(self.clone())
    }

    pub fn faststore(&self) -> FaststoreService {
        FaststoreService::new(self.clone())
    }

    pub fn lds(&self) -> LdsService {
        LdsService::new(self.clone())
    }

    pub fn notifications(&self) -> NotificationsService {
        NotificationsService::new(self.clone())
    }

    pub fn ai(&self) -> AiService {
        AiService::new(self.clone())
    }

    pub fn inference(&self) -> InferenceService {
        InferenceService::new(self.clone())
    }

    pub fn health(&self) -> HealthService {
        HealthService::new(self.clone())
    }

    pub fn storage(&self) -> StorageService {
        StorageService::new(self.clone())
    }

    pub fn ocs(&self) -> OcsService {
        OcsService::new(self.clone())
    }

    pub fn warehouse(&self) -> WarehouseService {
        WarehouseService::new(self.clone())
    }
}

/// One client, one HTTP layer, one namespace per platform service.
///
/// Service handles are cheap clones over the shared connection pool.
#[derive(Clone)]
pub struct SynapseOneClient {
    client: Client,
    base: BaseService,
    iam: IamService,
    workflow: WorkflowService,
    queue: QueueService,
    stream: StreamService,
    faststore: FaststoreService,
    lds: LdsService,
    notifications: NotificationsService,
    ai: AiService,
    inference: InferenceService,
    health: HealthService,
    storage: StorageService,
    ocs: OcsService,
    warehouse: WarehouseService,
}

impl SynapseOneClient {
    /// Build a client with default transport settings.
    pub fn new(base_url: impl Into<String>, credentials: Credentials) -> Result<Self> {
        Ok(Self::from_client(Client::new(base_url, credentials)?))
    }

    /// Build from `SYNAPSEONE_BASE_URL` / `SYNAPSEONE_API_KEY` / `SYNAPSEONE_TOKEN`.
    pub fn from_env() -> Result<Self> {
        Ok(Self::from_client(Client::from_env()?))
    }

    /// Build through the full builder.
    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        Client::builder(base_url)
    }

    /// Construct from an existing transport client.
    pub fn from_client(client: Client) -> Self {
        Self {
            base: BaseService::new(client.clone()),
            iam: IamService::new(client.clone()),
            workflow: WorkflowService::new(client.clone()),
            queue: QueueService::new(client.clone()),
            stream: StreamService::new(client.clone()),
            faststore: FaststoreService::new(client.clone()),
            lds: LdsService::new(client.clone()),
            notifications: NotificationsService::new(client.clone()),
            ai: AiService::new(client.clone()),
            inference: InferenceService::new(client.clone()),
            health: HealthService::new(client.clone()),
            storage: StorageService::new(client.clone()),
            ocs: OcsService::new(client.clone()),
            warehouse: WarehouseService::new(client.clone()),
            client,
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn base(&self) -> &BaseService {
        &self.base
    }

    pub fn iam(&self) -> &IamService {
        &self.iam
    }

    pub fn workflow(&self) -> &WorkflowService {
        &self.workflow
    }

    pub fn queue(&self) -> &QueueService {
        &self.queue
    }

    pub fn stream(&self) -> &StreamService {
        &self.stream
    }

    pub fn faststore(&self) -> &FaststoreService {
        &self.faststore
    }

    pub fn lds(&self) -> &LdsService {
        &self.lds
    }

    pub fn notifications(&self) -> &NotificationsService {
        &self.notifications
    }

    pub fn ai(&self) -> &AiService {
        &self.ai
    }

    pub fn inference(&self) -> &InferenceService {
        &self.inference
    }

    pub fn health(&self) -> &HealthService {
        &self.health
    }

    pub fn storage(&self) -> &StorageService {
        &self.storage
    }

    pub fn ocs(&self) -> &OcsService {
        &self.ocs
    }

    pub fn warehouse(&self) -> &WarehouseService {
        &self.warehouse
    }

    /// Raw gateway request escape hatch.
    pub async fn request(
        &self,
        method: Method,
        path: impl Into<String>,
        body: Option<Value>,
    ) -> Result<Value> {
        self.client.request(method, path, body).await
    }
}
