# Inference service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Synapse Inference provides an OpenAI-compatible chat proxy, local embeddings,
structured decision evaluation, and semantic routing. The same service also
supports queued inference jobs claimed by inference/hybrid runners.

See [API reference](../api.md), [AI assistant](ai-assistant.md),
[Workflow runners](workflow-runners.md), and [Search](search.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/inference/health` | Provider/model/component readiness. |
| POST | `/v1/inference/chat/completions` | Chat completion; SSE when `stream:true`. |
| POST | `/v1/inference/embeddings` | Embed one string or a string array. |
| POST | `/v1/inference/decision` | Evaluate structured questions against a state. |
| POST | `/v1/inference/decision/route` | Choose among semantic routing candidates. |
| GET/POST | `/v1/inference-jobs` | Create a queued job or list tenant jobs. |
| GET | `/v1/inference-jobs/:id` | Poll a queued job; `includeData=true` includes request/result data. |
| POST | `/v1/runner/inference/jobs/:id/claim` | Runner claim protocol. |
| POST | `/v1/runner/inference/jobs/:id/heartbeat`, `/release`, `/complete` | Runner lease/report protocol. |

The service also accepts `/v1/chat/completions`, `/v1/embeddings`, and
`/v1/decision*` aliases internally. The public gateway exposes the
`/v1/inference` namespaced routes.

## Important semantics and limits

- **Chat:** messages use OpenAI-style `role` and `content`. The HTTP API supports
  `tools`, `tool_choice`, and `response_format`; some SDK convenience types cover
  only common options, so use a generic request for the full body.
- **Streaming:** `stream:true` returns SSE. JavaScript and Python SDKs expose
  incremental iterators; the Rust helper buffers the SSE body and extracts text.
- **Embeddings:** `input` is a string or string array. Model/dimension readiness
  is reported by `/v1/inference/health`.
- **Decision:** question types are `choice`, `noul`, or `score`; each question
  supplies `instructions` and optional `criteria`.
- **Routing:** `choices` maps candidate ids to descriptions. The response
  includes `best_choice`, `confidence`, and `probabilities`.
- **Queued jobs:** `type` is `chat`, `embeddings`, `decision`, `route`, or
  `generic`. `generic` uses `payload.path` and `payload.body`. `wait:true`
  blocks for a result; otherwise poll the returned job id.
- **Timeout:** synchronous inference SDK calls use a 120-second budget to match
  the gateway. Inference jobs can outlive the creating HTTP request.
- **Quotas:** organization request/token quotas apply and can return `429`.
  Token accounting is best-effort when a provider omits usage data.
- **Runner backend:** an inference/hybrid runner's local model URL and API key
  are separate from the SynapseOne gateway credential.

## Authentication and scopes

Synchronous inference accepts a Bearer JWT or API key:

- `GET /v1/inference/health`: `inference:read`.
- `POST /v1/inference/*`: `inference:invoke`.
- `inference:*` covers both.

Queued job creation maps to `inference:Invoke`; job listing/detail uses
`inference:read`. Runner claim/report routes require a machine runner API key,
not a user JWT, and the key must include the permissions required by its lane.
See [Workflow runners](workflow-runners.md).

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
const messages = [{ role: 'user', content: 'Explain idempotent queue consumers.' }];

const completion = await client.inference.chat(messages, { max_tokens: 256 });
const vectors = await client.inference.embeddings(['queue consumer']);

// Generic escape hatch: no typed queued-job wrapper is exposed.
const job = await client.call('POST', '/v1/inference-jobs', {
  type: 'chat',
  payload: { messages },
  wait: true,
});
console.log(completion, vectors, job);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
messages = [{"role": "user", "content": "Explain idempotent queue consumers."}]
completion = client.inference.chat(messages, max_tokens=256)
vectors = client.inference.embeddings(["queue consumer"])

# Generic escape hatch: no typed queued-job wrapper is exposed.
job = client.call(
    "POST",
    "/v1/inference-jobs",
    {"type": "chat", "payload": {"messages": messages}, "wait": True},
)
print(completion, vectors, job)
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
    messages := []synapseone.ChatMessage{{Role: "user", Content: "Explain idempotent queue consumers."}}

    completion, err := client.InferenceChat(
        messages, synapseone.ChatCompletionOptions{MaxTokens: 256},
    )
    if err != nil {
        panic(err)
    }
    vectors, err := client.InferenceEmbeddings([]string{"queue consumer"})
    if err != nil {
        panic(err)
    }

    // Generic escape hatch: no typed queued-job wrapper is exposed.
    job, err := client.Call("POST", "/v1/inference-jobs", map[string]any{
        "type":    "chat",
        "payload": map[string]any{"messages": messages},
        "wait":    true,
    })
    if err != nil {
        panic(err)
    }
    fmt.Println(completion, vectors, job)
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
    let messages = json!([{"role": "user", "content": "Explain idempotent queue consumers."}]);

    let completion = client.inference()
        .chat(messages.clone(), None, None, Some(256), None)
        .await?;
    let vectors = client.inference()
        .embeddings(json!(["queue consumer"]), None)
        .await?;

    // Generic escape hatch: no typed queued-job wrapper is exposed.
    let job = client.client().post(
        "/v1/inference-jobs",
        json!({"type": "chat", "payload": {"messages": messages}, "wait": true}),
    ).await?;
    println!("{completion} {vectors} {job}");
    Ok(())
}
```
