<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->
# SynapseOne Rust SDK

The `synapseone` crate is an async Rust 1.82+ client for the public SynapseOne
gateway. It uses `reqwest` with rustls, keeps platform error codes/bodies, bounds
response sizes, handles redirects without leaking credentials and retries only
requests that are safe to retry.

## Install

```bash
cargo add synapseone@0.10.2
cargo add tokio --features macros,rt-multi-thread
cargo add serde_json
cargo add http
```

```toml
[dependencies]
synapseone = "0.10.2"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
serde_json = "1"
http = "1"
```

Full generated API reference: <https://docs.rs/synapseone>.

## Client and authentication

```rust
use synapseone::{Credentials, SynapseOneClient};

#[tokio::main]
async fn main() -> synapseone::Result<()> {
    let client = SynapseOneClient::new(
        "https://api.synapseone.space",
        Credentials::token("user-jwt"),
    )?;

    let me = client.iam().me().await?;
    println!("{}", me["email"]);
    Ok(())
}
```

Use `Credentials::api_key("synapseone_...")` for an API key. The low-level
`Client::builder` supports `.tenant(...)`, trusted redirect origins, timeouts and
body limits. `SynapseOneClient::from_env()` reads `SYNAPSEONE_BASE_URL`,
`SYNAPSEONE_TOKEN` and `SYNAPSEONE_API_KEY`.

## Service namespaces

| Handle | Coverage |
| --- | --- |
| `iam()` | password/OIDC auth, MFA, orgs/accounts/users, roles/policies, authorization, audit, API keys, SCIM, service accounts |
| `workflow()` | templates, workflows, executions, runners, inference jobs, human tasks, credentials, secrets, webhooks |
| `base()` | databases, collections/documents, mapping, query, vector/GIS/graph search, batches, change feed |
| `faststore()` | KV/TTL, counters, hashes, lists, sets, sorted sets, scans, batches, locks |
| `queue()` | queues, delayed/deduplicated publish, leases, ack/nack/heartbeat, retries, DLQ, replay |
| `stream()` | topics, publish/read/range, consumer groups and acknowledgements |
| `lds()` | licenses, datasources, attributes, ingestion and NGSI-LD entities |
| `ocs()` / `storage()` | buckets, binary objects, metadata, presign and multipart upload |
| `notifications()` | outbox, templates, preferences, unsubscribe and delivery status |
| `ai()` | API documentation assistant |
| `inference()` | chat/SSE, embeddings, structured decisions and semantic routing |
| `warehouse()` | datasets, read-only SQL, ETL jobs and pipeline status |
| `lakehouse()` | Iceberg namespaces/tables, append/query, snapshots and schema evolution |
| `health()` | gateway health, readiness and projected status |

See [per-service SDK examples](services/README.md) for copyable JavaScript,
Python, Go and Rust snippets.

## Generic request escape hatch

Use a typed wrapper when one exists. For a newly added route, the low-level
client preserves the same authentication, redirect, timeout and error behavior:

```rust
use http::Method;
use serde_json::json;

let value = client
    .client()
    .request(Method::POST, "/v1/example", Some(json!({ "name": "demo" })))
    .await?;
```

## Retries and errors

- `GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` retry transient network errors and
  `429/502/503/504` with exponential backoff.
- `POST`/`PATCH` retry only with an explicit idempotency key.
- `Retry-After` is honored up to 30 seconds.
- Errors expose `status()`, `code()`, `body()` and `base_url()`.

Queue delivery is at-least-once: make consumers idempotent and acknowledge only
after durable processing.

## Release

The crate and all other SDKs share version `0.10.2`. Push
`sdk-rust-v0.10.2` to run formatting, Clippy, tests, tag/version verification and
the idempotent crates.io publish workflow. See [sdk-0.10.2.md](sdk-0.10.2.md).
