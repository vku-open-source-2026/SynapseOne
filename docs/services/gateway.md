# Gateway service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

The gateway is the public entry point for SynapseOne. It authenticates callers,
checks credential scopes and IAM policies, stamps a trusted principal context,
and proxies requests to the product services. Applications should use the
gateway URL, not service-network addresses.

The complete HTTP contract is in [API reference](../api.md).

## Main gateway routes

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Public, shallow gateway health. |
| GET | `/ready` | Public aggregate readiness; `503` means degraded, with an upstream report. |
| GET | `/metrics` | Public Prometheus metrics. |
| POST | `/v1/auth/login`, `/v1/auth/register`, `/v1/auth/refresh` | Public credential endpoints; individual routes may require a Bearer token or refresh token in the body. |
| GET | `/v1/auth/verify`, `/v1/auth/me` | Verify the current Bearer token or API key / read the current user. |
| Various | `/v1/orgs`, `/v1/accounts`, `/v1/users`, `/v1/roles`, `/v1/policies`, `/v1/keys`, `/v1/service-accounts` | IAM control plane; Bearer JWT or `X-API-Key`. |
| Various | `/v1/workflows`, `/v1/executions`, `/v1/human-tasks`, `/v1/credentials`, `/v1/templates` | Workflow service; Bearer JWT or API key. |
| Various | `/v1/workflow-runners` | Tenant runner management; Bearer JWT or API key. |
| Various | `/v1/runner` | Runner job protocol; machine API key only. |
| POST | `/v1/ai/agent` | Guidance-only API assistant. |
| Various | `/v1/inference`, `/v1/inference-jobs` | Synchronous inference and queued inference jobs. |
| Various | `/v1/lds` | Linked-data management and exports; selected reads are public. |
| Various | `/v1/base`, `/v1/search` | Document database and its search projection. |
| Various | `/v1/faststore`, `/v1/queue`, `/v1/stream` | Cache/data structures, work queue, and event log. |
| Various | `/v1/ocs`, `/v1/storage` | Bucket-aware and legacy default-bucket object storage. |
| Various | `/v1/notifications` | Durable notification outbox and delivery status. |
| Various | `/v1/warehouse`, `/v1/lakehouse` | Analytical datasets and Iceberg tables. |
| ANY | `/webhook/:path` | Public inbound workflow webhook; workflow-level auth, rate limits, and idempotency still apply. |
| POST | `/mcp` | Workflow-backed MCP JSON-RPC; public tools require explicit read-only opt-in. |
| Various | `/v1/platform/runners` | Owner-scoped runner management; platform-admin JWT only. |

Product prefixes are not interchangeable: for example, Search is served by Base
but uses `/v1/search`, while OCS uses the `storage` authorization namespace.
Follow the per-service guides:

- [IAM](iam.md), [Workflow](workflow.md), [Workflow runners](workflow-runners.md)
- [AI assistant](ai-assistant.md), [Inference](inference.md), [LDS](lds.md)
- [Base](base.md), [Search](search.md), [Faststore](faststore.md)
- [Queue](queue.md), [Stream](stream.md), [OCS](ocs.md)
- [Notifications](notifications.md), [Warehouse](warehouse.md), [Lakehouse](lakehouse.md)

## Important semantics and limits

- **Base URL:** SDKs default to `https://api.synapseone.space` and honor
  `SYNAPSEONE_BASE_URL`. A local gateway commonly uses `http://localhost:8080`.
- **Principal propagation:** the gateway strips client-supplied
  `x-synapseone-*` identity headers and re-stamps them from the verified
  principal. Do not try to select another user, org, or account with headers.
- **Platform tenant selection:** `x-synapseone-tenant` is intentionally forwarded
  for platform callers. Principal callers remain bound to their own tenant.
  Faststore and Queue also accept `?tenant=` for platform calls.
- **Direct service calls:** bypassing the gateway additionally requires
  `x-synapseone-internal: <SYNAPSEONE_INTERNAL_SECRET>` when that secret is
  configured. This is an operator credential, not an application credential.
- **Timeouts:** the default proxy budget is 30 seconds. AI, inference, Warehouse,
  and Lakehouse routes allow 120 seconds; workflow execution and public webhooks
  allow up to 300 seconds. Long workflows should normally be queued and polled.
- **Request tracing:** the gateway returns `x-request-id` and forwards it to the
  upstream. Include it when reporting a failed request.
- **Quotas:** AI, Inference, and Workflow have organization-level request and
  execution limits. A rejected quota returns `429` with `Retry-After`, window,
  limit, and reset information.
- **Errors:** expect `400` for invalid input, `401` for missing/invalid
  credentials, `403` for scope or policy denial, `404` for inaccessible or
  missing tenant resources, `409` for state/version conflicts, and `429` for
  rate/quota limits.

## Authentication and scopes

Most `/v1/*` product routes accept either:

```http
Authorization: Bearer <access-token>
```

or:

```http
X-API-Key: <api-key>
```

Exceptions are route-specific: `/v1/auth/*`, public LDS reads, signed OCS URLs,
and `/webhook/:path` are public at the gateway; `/v1/runner` requires an API key;
platform runner administration requires a platform-admin JWT; SCIM data routes
require a scoped SCIM Bearer token.

Credential scopes use service/action patterns such as:

- `*` — full authority; avoid for narrowly scoped automation.
- `*:read` or `*:write` — read or write across services.
- `base:read`, `base:write`, or `base:*`.
- `workflow:execute`, `queue:consume`, `queue:ack`, `inference:invoke`.

The gateway normalizes scope/action casing, but lowercase is the conventional
form. With `AUTHZ_MODE=enforce`, credential scopes are only the first layer: IAM
role policies and org-admin authority are also evaluated. Explicit policy deny
wins; otherwise the default for a non-admin principal is deny. See
[IAM model](../iam-model.md) for policy examples.

## SDK usage

Full transport and authentication references:
[JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md),
[Go](../sdk-go.md), and
[Rust](../sdk-rust.md).

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});

const health = await client.health.health();
const ready = await client.health.ready(); // returns the parsed 503 payload by default
const identity = await client.iam.verify();
console.log({ health, ready, identity });
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)

health = client.health.health()
ready = client.health.ready()  # parsed payload even when status is degraded
identity = client.iam.verify()
print({"health": health, "ready": ready, "identity": identity})
```

### Go

```go
package main

import (
    "fmt"
    "os"

    synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"
)

func main() {
    client := synapseone.New(os.Getenv("SYNAPSEONE_BASE_URL"))
    client.SetAPIKey(os.Getenv("SYNAPSEONE_API_KEY"))

    health, err := client.Health()
    if err != nil {
        panic(err)
    }
    ready, err := client.Ready()
    if err != nil {
        panic(err)
    }
    identity, err := client.Verify()
    if err != nil {
        panic(err)
    }
    fmt.Println(health, ready, identity)
}
```

### Rust

```rust
use synapseone::{Credentials, SynapseOneClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = std::env::var("SYNAPSEONE_BASE_URL")
        .unwrap_or_else(|_| "https://api.synapseone.space".to_string());
    let client = SynapseOneClient::new(
        base_url,
        Credentials::api_key(std::env::var("SYNAPSEONE_API_KEY")?),
    )?;

    let health = client.health().health().await?;
    let ready = client.health().ready(false).await?;
    let identity = client.iam().verify().await?;
    println!("{health} {ready} {identity}");
    Ok(())
}
```
