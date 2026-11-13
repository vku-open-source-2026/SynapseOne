# synapseone — Rust SDK

Async Rust client for the [SynapseOne](https://api.synapseone.space) Tier-1
platform gateway. It mirrors the published Python, JavaScript and Go SDKs:
one gateway client, namespaced service handles, bearer/API-key auth, retries
for idempotent requests and typed errors that retain the platform error code
and response body.

```toml
[dependencies]
synapseone = "0.9"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
serde_json = "1"
```

> The crate is prepared for crates.io publication. Until the first release,
> use the path dependency shown in `openinfra/datacollector/backend-rs`.

## Quick start

```rust
use serde_json::json;
use synapseone::{Client, Credentials, Query};

#[tokio::main]
async fn main() -> synapseone::Result<()> {
    let client = Client::builder("https://api.synapseone.space")
        .api_key("synapseone_...")
        .tenant("acme") // only needed by platform callers
        .build()?;

    let page = client
        .base()
        .query_documents(
            "contribution_features",
            Query::new()
                .filter(json!({ "city_synced": false }))
                .order_by(vec![synapseone::OrderBy::asc("created_at")])
                .limit(100),
        )
        .await?;

    for item in page.data() {
        println!("{}", item["id"]);
    }
    Ok(())
}
```

The high-level `SynapseOneClient` exposes every namespace as a method:

```rust
use synapseone::{Credentials, SynapseOneClient};

let client = SynapseOneClient::new(
    "https://api.synapseone.space",
    Credentials::token("user-jwt"),
)?;
let me = client.iam().me().await?;
let templates = client.workflow().list_templates().await?;
```

## Service coverage

| Namespace | Methods |
| --- | --- |
| `base()` | collections, documents, query, vector search, batch, changes, GIS, graph, search |
| `iam()` | auth, MFA, OIDC, orgs/accounts/users, authorize, audit, API keys, credentials, roles, policies, SCIM, service accounts |
| `workflow()` | templates, workflows, executions, runners, human tasks, credentials, secrets, webhooks |
| `queue()` | queues, publish/consume, ack/nack/heartbeat, dead letters |
| `stream()` | topics, publish/read, range, consumer groups |
| `faststore()` | KV, hashes, lists, sets, sorted sets, locks |
| `lds()` | licenses, datasources, attributes, records, NGSI-LD entities |
| `notifications()` | outbox, templates, preferences |
| `ai()` | API-docs assistant |
| `inference()` | chat, embeddings, decision, route |
| `ocs()` / `storage()` | buckets, objects, presign, multipart |
| `warehouse()` | OLAP datasets, SQL, ETL, reports, dashboards |
| `health()` | `/health`, `/ready`, projected status |

Methods that are not wrapped yet can use the raw escape hatch:

```rust
use http::Method;
let value = client.request(Method::GET, "/v1/whatever", None).await?;
```

## Authentication

* `Credentials::token(jwt)` → `Authorization: Bearer <jwt>`
* `Credentials::api_key(key)` → `X-API-Key: <key>`
* `tenant` → `x-synapseone-tenant` (platform callers of Faststore/Queue)
* Both token and API key can be supplied; the gateway decides which to verify.

## Retries and errors

* Idempotent methods (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`) retry on
  network errors and `429/502/503/504` with exponential backoff.
* `POST`/`PATCH` retry only when an `idempotency-key` is set explicitly.
* `Retry-After` is honoured (clamped to 30 s).
* Errors keep `status()`, `code()`, `body()` and `base_url()`:

```rust
match client.base().get_collection("missing").await {
    Err(error) if error.is_not_found() => { /* ... */ }
    Err(error) => eprintln!("{} {:?}", error, error.code()),
    Ok(collection) => println!("{collection}"),
}
```

The SDK detects HTML responses and reports `NonJsonResponse` when the base URL
points at the console instead of the API gateway.

## Development

```bash
cargo test
cargo clippy --all-targets
cargo fmt --check
```

MSRV: 1.82. License: Apache-2.0.

## Publishing

Manual:

```bash
cargo publish --dry-run
cargo publish
```

CI (recommended): add the `CARGO_REGISTRY_TOKEN` repository secret and push a
tag that matches `Cargo.toml`:

```bash
git tag sdk-rust-v0.9.0
git push origin sdk-rust-v0.9.0
```

`.github/workflows/sdk-rust-publish.yml` runs format/clippy/tests, verifies the
tag, checks whether that exact version already exists and publishes only when
needed. Re-running a release tag is a no-op.

If the name `synapseone` is unavailable, rename the package in `Cargo.toml`
(the library name can stay `synapseone` via `[lib] name = "synapseone"`).
