# AI assistant service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

The AI assistant turns a natural-language question about SynapseOne into a
suggested API method, path, path values, request body, and explanation. It is a
guidance service only: it never executes the suggested request.

For model execution, use [Inference](inference.md). For workflow AI nodes, see
[Workflow](workflow.md). The HTTP contract is in [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/ai/agent` | Ask for an endpoint suggestion and draft request. |
| GET | `/health` | Public AI-service health when called directly on the service network. |

Request body:

```json
{
  "question": "How do I create a workflow from a template?",
  "history": [
    { "role": "user", "text": "I am using the JavaScript SDK." },
    { "role": "ai", "text": "Use the workflow service." }
  ]
}
```

## Important semantics and limits

- `question` is required and limited to 1–2,000 characters.
- History is optional. The service keeps at most the last 10 turns, with at most
  500 characters per turn.
- A successful answer includes `ok`, `method`, `path`, `auth`, `pathValues`,
  `body`, `explanation`, and `reason`. How-to questions can return `guidance`
  instead of a single endpoint.
- The returned body is a draft. Validate it, substitute real resource ids, and
  obtain the caller's consent before sending it through the relevant service.
- The route has a 120-second gateway budget for slow model calls.
- The service requires its operator-side `AI_API_KEY`. If no provider is
  configured, it returns `503 ai_not_configured`; this is not fixed by changing
  the application's SynapseOne API key.
- Organization-level AI request/token quotas can return `429` with
  `Retry-After`.

## Authentication and scopes

`POST /v1/ai/agent` accepts a Bearer JWT or `X-API-Key`. The gateway maps it to
`ai:Invoke`; use credential scopes such as `ai:invoke` or `ai:*`. Central IAM
policy evaluation is additional when `AUTHZ_MODE=enforce`.

Do not put provider keys, SynapseOne access tokens, or private customer data in
the question unless the deployment's data-handling policy permits it.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});

const suggestion = await client.ai.agent(
  'How do I create a workflow from a template?',
  [{ role: 'user', text: 'I am using the JavaScript SDK.' }],
);
console.log(suggestion.method, suggestion.path, suggestion.body);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
suggestion = client.ai.agent(
    "How do I create a workflow from a template?",
    history=[{"role": "user", "text": "I am using the Python SDK."}],
)
print(suggestion["method"], suggestion["path"], suggestion.get("body"))
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

    suggestion, err := client.AIAgent(
        "How do I create a workflow from a template?",
        synapseone.AiHistoryItem{Role: "user", Text: "I am using the Go SDK."},
    )
    if err != nil {
        panic(err)
    }
    fmt.Println(suggestion.Method, suggestion.Path, suggestion.Body)
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
    let suggestion = client.ai().agent(
        "How do I create a workflow from a template?",
        Some(json!([{"role": "user", "text": "I am using the Rust SDK."}])),
    ).await?;
    println!("{} {} {}", suggestion["method"], suggestion["path"], suggestion["body"]);
    Ok(())
}
```
