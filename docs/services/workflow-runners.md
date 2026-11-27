# Workflow runner service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Workflow runners are self-hosted connectors that claim SynapseFlow jobs from
SynapseQueue. A runner can serve the workflow lane, the inference lane, or both.
Registration, connector heartbeats, and job leases are managed by the workflow
service through the public gateway.

For deployment, networking, environment variables, and operations, see the
[Runner Engine guide](../workflow-runners.md). See also
[Workflow](workflow.md), [Queue](queue.md), [Inference](inference.md), and
[API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/workflow-runners/options` | Public URL, image, queues, timing, and concurrency defaults. |
| GET/POST | `/v1/workflow-runners` | List or register tenant runners. |
| GET/PATCH/DELETE | `/v1/workflow-runners/:id` | Read, rename/retarget, or delete a registration. |
| GET | `/v1/workflow-runners/:id/config` | Runner bootstrap configuration. |
| GET | `/v1/workflow-runners/:id/connection` | Connector instances and freshness. |
| POST | `/v1/workflow-runners/:id/heartbeat` | Upsert a connector instance heartbeat. |
| DELETE | `/v1/workflow-runners/:id/instances/:instanceId` | Remove a stale connector row. |
| POST | `/v1/workflow-runners/:id/command` | Render a Docker command, optionally with a supplied API key. |
| POST | `/v1/runner/jobs/:id/claim` | Atomically claim a workflow job. |
| POST | `/v1/runner/jobs/:id/heartbeat` | Extend the workflow job lease. |
| POST | `/v1/runner/jobs/:id/complete` | Complete as success, error, or paused. |
| POST | `/v1/runner/jobs/:id/release` | Release a retryable failure and nack the queue message. |
| POST | `/v1/runner/jobs/:id/credentials` | Resolve a credential for exactly that claimed run. |
| POST | `/v1/runner/inference/jobs/:id/claim` | Claim an inference job. |
| POST | `/v1/runner/inference/jobs/:id/heartbeat`, `/release`, `/complete` | Inference lease lifecycle. |
| GET/POST | `/v1/platform/runners[/:id]` | Owner-scoped platform runner administration. |
| POST | `/v1/platform/runners/:id/rotate-key`, `/disable`, `/enable`, `/revoke-key`, `/test`, `/command` | Platform runner operations. |

## Important semantics and limits

- **Modes:** `platform` uses the built-in worker, `custom` uses tenant runners,
  `hybrid` lets both compete, and `inline` runs in the request. Platform runners
  additionally serve workflows explicitly set to `system` mode.
- **Runner kinds:** `workflow`, `inference`, or `hybrid`. Inference/hybrid
  runners call a local OpenAI-compatible backend configured by
  `INFERENCE_RUNNER_URL`; the SynapseOne key is for queue/claim/report calls.
- **Delivery:** queue delivery is at-least-once. The atomic claim is the
  exactly-one-runner guard; duplicate queue delivery must be acknowledged without
  executing the job twice.
- **Leases:** claim/heartbeat/complete use `leaseSeconds`. A worker crash allows
  another runner to claim after lease expiry, with `attempt` incremented.
- **Connector freshness:** a connector is stale after
  `WORKFLOW_RUNNER_STALE_SECONDS` (default 60). Status is `waiting`, `connected`,
  `degraded`, or `offline`.
- **Retargeting:** queue/mode changes return `409 runner_connected` while a
  connector is online.
- **Credentials:** job snapshots never contain plaintext workflow credentials.
  `/credentials` returns a secret only for a job claimed by that runner and
  tenant; custom runners should keep it in memory only for that run.
- **Key lifecycle:** workflow-service never stores the plaintext runner key.
  Deleting a tenant runner registration does **not** revoke its API key; revoke
  it separately in IAM. Platform runner deletion/rotation does revoke keys.
- **Default tenant-runner scopes:** `workflow:*`, `queue:*`, `*:read`,
  `base:query`, `base:vector-search`, and `inference:*`. Add write scopes only
  when workflow nodes need them.
- **Resource admission:** platform claims can require fresh per-instance
  CPU/RAM telemetry. Enforced capacity failures return
  `409 runner_resources_unavailable` or `409 runner_capacity_unavailable` and
  should be nacked/requeued.

## Authentication and scopes

Tenant runner management accepts a Bearer JWT or API key and uses the `workflow`
authorization namespace: reads need `workflow:read`, mutations normally need
`workflow:write`, and deletion needs `workflow:delete`.

The `/v1/runner/*` job protocol accepts **machine API keys only**, not ordinary
user JWTs. Runner requests also use `X-Workflow-Runner-Id`, and claim/complete
bodies identify the `runnerId`. A workflow runner key needs workflow and queue
permissions; inference/hybrid keys additionally need inference permissions.

`/v1/platform/runners/*` requires a platform-admin JWT. Mutations require
`platform:Admin`, and workflow-service rechecks the active `owner` role. Platform
runner keys are rejected on tenant data APIs.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

JavaScript/TypeScript, Python, and Rust expose runner management under
`client.workflow`. Their registration wrappers cover `name`, `mode`, `queue`,
API-key metadata, scopes, and metadata, but do not expose every API field such
as `kind`, `inferenceQueue`, or a directly supplied `apiKey`. Use the language's
generic request method for those fields. The Go SDK has no runner-management
wrappers, so its example uses `Call`, the SDK's generic escape hatch.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  token: process.env.SYNAPSEONE_TOKEN,
});
const scopes = ['workflow:*', 'queue:*', '*:read', 'inference:*'];
const key = await client.iam.createApiKey(
  process.env.SYNAPSEONE_ACCOUNT_ID!,
  'edge-runner',
  scopes,
) as { apiKey: string; id: string; prefix: string };
const created = await client.workflow.createWorkflowRunner({
  name: 'edge-runner',
  mode: 'custom',
  apiKeyId: key.id,
  keyPrefix: key.prefix,
  scopes,
}) as { runner: { id: string } };
const command = await client.workflow.getWorkflowRunnerCommand(
  created.runner.id,
  key.apiKey,
) as { command: string };
void command; // contains the one-time key; handle it securely
console.log('Runner registered');
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    token=os.environ["SYNAPSEONE_TOKEN"],
)
scopes = ["workflow:*", "queue:*", "*:read", "inference:*"]
key = client.iam.create_api_key(
    os.environ["SYNAPSEONE_ACCOUNT_ID"], "edge-runner", scopes
)
created = client.workflow.create_workflow_runner(
    name="edge-runner",
    mode="custom",
    api_key_id=key["id"],
    key_prefix=key["prefix"],
    scopes=scopes,
)
command = client.workflow.get_workflow_runner_command(
    created["runner"]["id"], key["apiKey"]
)
_ = command  # contains the one-time key; handle it securely
print("Runner registered")
```

### Go

```go
package main

import (
    "fmt"
    "net/url"
    "os"

    synapseone "github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go"
)

func main() {
    client := synapseone.New(os.Getenv("SYNAPSEONE_BASE_URL"))
    client.SetToken(os.Getenv("SYNAPSEONE_TOKEN"))

    scopes := []string{"workflow:*", "queue:*", "*:read", "inference:*"}
    key, err := client.CreateAPIKey(os.Getenv("SYNAPSEONE_ACCOUNT_ID"), "edge-runner", scopes)
    if err != nil {
        panic(err)
    }

    // Generic escape hatch: the Go SDK does not wrap runner-management routes.
    created, err := client.Call("POST", "/v1/workflow-runners", map[string]any{
        "name":      "edge-runner",
        "mode":      "custom",
        "apiKeyId":  key["id"],
        "keyPrefix": key["prefix"],
        "scopes":    scopes,
    })
    if err != nil {
        panic(err)
    }
    runnerID := created.(map[string]any)["runner"].(map[string]any)["id"].(string)
    command, err := client.Call(
        "POST",
        "/v1/workflow-runners/"+url.PathEscape(runnerID)+"/command",
        map[string]any{"apiKey": key["apiKey"]},
    )
    if err != nil {
        panic(err)
    }
    _ = command // command contains the one-time key; handle it securely
    fmt.Println("Runner registered")
}
```

### Rust

```rust
use synapseone::{Credentials, SynapseOneClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = SynapseOneClient::new(
        std::env::var("SYNAPSEONE_BASE_URL")
            .unwrap_or_else(|_| "https://api.synapseone.space".to_string()),
        Credentials::token(std::env::var("SYNAPSEONE_TOKEN")?),
    )?;
    let scopes = vec![
        "workflow:*".to_string(),
        "queue:*".to_string(),
        "*:read".to_string(),
        "inference:*".to_string(),
    ];
    let key = client.iam().create_api_key(
        &std::env::var("SYNAPSEONE_ACCOUNT_ID")?,
        "edge-runner",
        Some(scopes.clone()),
        None,
        None,
    ).await?;
    let created = client.workflow().create_workflow_runner(
        "edge-runner",
        "custom",
        None,
        key["id"].as_str(),
        key["prefix"].as_str(),
        Some(scopes),
        None,
    ).await?;
    let runner_id = created["runner"]["id"].as_str().ok_or("missing runner id")?;
    let command = client.workflow()
        .get_workflow_runner_command(runner_id, key["apiKey"].as_str())
        .await?;
    let _ = command; // command contains the one-time key; handle it securely
    println!("Runner registered");
    Ok(())
}
```
