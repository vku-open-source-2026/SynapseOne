# Workflow service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseFlow owns versioned workflow definitions, activation, manual/webhook/cron
and MCP triggers, durable executions, human tasks, workflow credentials, and the
tenant secret vault. Queue-backed executions can run on the built-in worker or
on a [self-hosted runner](workflow-runners.md).

See [API reference](../api.md) for node types and the full execution contract.

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/templates`, `/v1/templates/:name` | Built-in workflow templates. |
| GET/POST | `/v1/workflows` | List or create workflows. |
| GET/PUT/DELETE | `/v1/workflows/:id` | Read, replace, or delete a definition. |
| POST | `/v1/workflows/:id/activate`, `/v1/workflows/:id/deactivate` | Lifecycle transitions. |
| POST | `/v1/workflows/:id/execute` | Manual execution; the JSON body is the run input. |
| POST | `/v1/workflows/test-run` | Validate and execute a definition without saving it. |
| GET | `/v1/executions`, `/v1/executions/:id` | Execution history and node results. |
| POST | `/v1/executions/:id/cancel` | Cancel a queued or human-paused execution. |
| GET/POST | `/v1/human-tasks` | List or create durable human tasks. |
| POST | `/v1/human-tasks/:id/claim`, `/complete`, `/reject`, `/expire` | Task state transitions. |
| GET/POST | `/v1/credentials[?accountId=]` | Account-scoped workflow credential metadata. |
| GET/DELETE | `/v1/credentials/:id` | Read metadata or delete a credential. |
| POST | `/v1/credentials/:id/rotate` | Replace a write-only credential secret. |
| GET/POST | `/v1/secrets`, `/v1/secrets/:name` | Tenant secret metadata and creation. |
| POST | `/v1/secrets/:name/read`, `/rotate`, `/revoke` | Authorized read, rotation, or revocation. |
| ANY | `/webhook/:path` | Public inbound trigger for an active workflow. |
| POST | `/mcp` | JSON-RPC MCP server backed by active `mcpTrigger` workflows. |

Runner registration and the worker claim/complete protocol are documented in
[Workflow runners](workflow-runners.md).

## Important semantics and limits

- **Definition limits:** updates are validated for structure, cycles, SSRF, and
  size: at most 200 KiB and 50 nodes. Every node needs a 1–128 character name.
  Every update increments `revision`.
- **Execution input:** `POST /v1/workflows/:id/execute` sends the input object
  directly, not `{input: ...}`. It works for any trigger type, active or not.
- **Queue mode:** normal execution returns `202 {queued:true, executionId,...}`.
  Add `?wait=1&timeoutMs=60000` for a blocking response, or poll the execution.
- **Revision precondition:** `expectedRevision=<positive integer>` is a query
  parameter. A stale definition returns `409 workflow_revision_conflict`
  without publishing a job.
- **Execution states:** `queued`, `running`, `paused`, `success`, `error`, and
  `cancelled`. Running/terminal executions cannot be cancelled; queued and
  human-paused executions can.
- **Owner-only access:** `settings.access = {"mode":"owner-only"}` limits the
  workflow to its stored creator, including execution and linked human tasks.
  Public webhooks cannot invoke an owner-only workflow.
- **Human tasks:** completion/rejection resumes a paused execution exactly once
  from its outgoing edges. Duplicate decisions return `409`.
- **Webhooks:** paths are 1–128 characters and match `[A-Za-z0-9_./-]` with no
  `..`. Per-node auth supports none, secret header, HMAC-SHA256, or HS256 JWT.
  Default rate limit is 600 requests/minute; idempotent replay returns
  `409 duplicate_delivery`.
- **Node behavior:** non-`if` nodes fan out; terminal outputs are keyed by node
  name when there are several terminals. `settings.onError:"continue"` records
  `partialErrors`; otherwise a node failure fails the run.
- **Credentials:** `bearer`, `api-key`, `basic`, and `hmac` secrets are encrypted
  at rest and never returned. Metadata is owner/account scoped.
- **Secrets:** values are encrypted, versioned, and read through an audited
  `/read` operation. Rotation grace defaults to 24 hours and is capped at 30
  days.
- **Exactly-once boundary:** queue claim prevents two runners from owning one
  job, but workflow node retries cannot guarantee exactly-once external side
  effects. Make HTTP/API nodes idempotent.

## Authentication and scopes

Workflow management accepts a Bearer JWT or API key. Gateway action mapping is:

- Read/list/history: `workflow:read`.
- Definition mutations and task/credential writes: `workflow:write`.
- Deletes: `workflow:delete`.
- `POST /v1/workflows/:id/execute` and `/v1/workflows/test-run`:
  `workflow:execute`.
- `workflow:*` covers all workflow operations.

The `/v1/secrets` vault is a separate authorization namespace: metadata reads
and `POST .../read` need `secrets:read`; create/rotate/revoke need
`secrets:write`; deletion needs `secrets:delete`; `secrets:*` covers the vault.

IAM policy checks are additional when `AUTHZ_MODE=enforce`. Public webhooks do
not use gateway auth; their workflow node configuration is the security boundary.
MCP tools marked both `public:true` and `readOnly:true` may be anonymous when the
deployment opts in; other tools require Bearer/API-key authentication.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

Replace `<template-name>` with a value returned by `listTemplates()`.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});

const templates = await client.workflow.listTemplates();
const workflow = await client.workflow.createWorkflowFromTemplate(
  '<template-name>',
  'SDK workflow',
) as { id: string };
await client.workflow.activateWorkflow(workflow.id);

const run = await client.workflow.executeWorkflow(workflow.id, {
  orderId: '<order-id>',
}) as { executionId?: string } & Record<string, unknown>;
const execution = run.executionId
  ? await client.workflow.waitForExecution(run.executionId, { timeoutMs: 60_000 })
  : run;
console.log(templates, execution);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)

templates = client.workflow.list_templates()
workflow = client.workflow.create_workflow_from_template(
    "<template-name>", "SDK workflow"
)
client.workflow.activate_workflow(workflow["id"])
run = client.workflow.execute_workflow(workflow["id"], {"orderId": "<order-id>"})
execution = (
    client.workflow.wait_for_execution(run["executionId"], timeout_ms=60_000)
    if run.get("executionId")
    else run
)
print(templates, execution)
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

    templates, err := client.ListTemplates()
    if err != nil {
        panic(err)
    }
    workflow, err := client.CreateWorkflowFromTemplate("<template-name>", "SDK workflow")
    if err != nil {
        panic(err)
    }
    id := workflow["id"].(string)
    if err := client.ActivateWorkflow(id); err != nil {
        panic(err)
    }
    run, err := client.ExecuteWorkflow(id, map[string]any{"orderId": "<order-id>"})
    if err != nil {
        panic(err)
    }
    fmt.Println(templates, run)
}
```

### Rust

```rust
use synapseone::{Credentials, SynapseOneClient};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = SynapseOneClient::new(
        std::env::var("SYNAPSEONE_BASE_URL")
            .unwrap_or_else(|_| "https://api.synapseone.space".to_string()),
        Credentials::api_key(std::env::var("SYNAPSEONE_API_KEY")?),
    )?;

    let templates = client.workflow().list_templates().await?;
    let workflow = client.workflow()
        .create_workflow_from_template("<template-name>", Some("SDK workflow"))
        .await?;
    let id = workflow["id"].as_str().ok_or("missing workflow id")?;
    client.workflow().activate_workflow(id).await?;
    let run = client.workflow()
        .execute_workflow(id, Some(json!({"orderId": "<order-id>"})), false, 30_000)
        .await?;
    println!("{templates} {run}");
    Ok(())
}
```
