// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseOCS — bucket-aware object cloud storage.
//!
//! Direct binary upload/download, presigned URLs, multipart uploads,
//! checksums, size/type limits and per-tenant quotas. Filesystem for
//! dev/single-node, S3-compatible object storage in production.

pub mod api;
pub mod audit;
pub mod backend;
pub mod config;
pub mod ocs;
pub mod ocs_api;
pub mod s3;
pub mod util;

pub use api::build_app;
pub use backend::{create_backend, Backend, FileBackend, ObjectMeta, S3Backend};
pub use config::Config;

#[derive(Clone)]
pub struct AppState {
    pub backend: Backend,
    pub config: Config,
}

#[derive(Clone, Debug)]
pub struct Tenant(pub String);
