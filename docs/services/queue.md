# Queue service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseQueue is a tenant-scoped work queue with delayed and deduplicated
publishing, visibility-timeout leases, ack/nack/heartbeat, retries, dead letters,
and replay. Delivery is **at-least-once**, so consumers must be idempotent.

See [Queue guide](../queue.md), [Stream](stream.md),
[Workflow runners](workflow-runners.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/queue/queues` | List tenant queues. |
| PUT | `/v1/queue/queues/:queue` | Idempotent create/update. |
| GET/DELETE | `/v1/queue/queues/:queue` | Config/stats or delete queue and all messages. |
| POST | `/v1/queue/queues/:queue/purge` | Clear all message states and counters, keep config. |
| GET | `/v1/queue/queues/:queue/stats` | Pending/in-flight/dead and lifetime counters. |
| POST | `/v1/queue/queues/:queue/messages` | Publish one message. |
| POST | `/v1/queue/queues/:queue/messages:batch` | Publish up to 100 messages. |
| POST | `/v1/queue/queues/:queue/consume` | Lease up to 100 ready messages. |
| POST | `/v1/queue/queues/:queue/ack` | Ack one receipt or up to 100 receipts. |
| POST | `/v1/queue/queues/:queue/nack` | Requeue or dead-letter a delivery. |
| POST | `/v1/queue/queues/:queue/heartbeat` | Extend a delivery lease. |
| GET | `/v1/queue/queues/:queue/messages` | Peek without leasing. |
| GET | `/v1/queue/queues/:queue/dead` | List dead letters. |
| POST | `/v1/queue/queues/:queue/dead/:id/replay` | Replay a dead letter. |
| DELETE | `/v1/queue/queues/:queue/dead/:id` | Permanently delete a dead letter. |

## Important semantics and limits

- **Queue names:** `[A-Za-z][A-Za-z0-9_-]{0,63}`, unique per tenant.
- **Configuration:** `maxAttempts` is 1–100 (default 5); visibility timeout is
  1–3,600 seconds (default 30). Publishing/consuming a missing queue implicitly
  creates it with defaults.
- **Delivery:** consume atomically leases ready messages and returns an opaque
  `receipt` plus `leaseExpiresAt` per message. Ack deletes the message; nack
  requeues or dead-letters it.
- **At-least-once:** an expired lease returns the message to pending. A worker
  crash can therefore redeliver work. Deduplicate side effects using a stable
  business/event id.
- **Attempt cap:** `maxAttempts` is enforced on nack, not on lease expiry.
  Repeated crashes can redeliver indefinitely; positive rejection exhausts the
  retry budget.
- **Receipts:** receipts are capability tokens. Unknown/forged/already-used
  receipts return `404 receipt_not_found`. Do not log or share them.
- **Publishing:** delay is 0–604,800 seconds (7 days). Payloads are limited by
  `QUEUE_MAX_PAYLOAD_BYTES` (default 256 KiB). Batch publish is 1–100 messages.
- **Custom ids:** a caller-supplied id is 1–128 characters from
  `[A-Za-z0-9_@.:+-]`; reusing a live id returns `409 conflict`.
- **Dedupe:** `dedupeKey` suppresses duplicates only while the original message
  still exists (pending, in-flight, or dead). It is not permanent uniqueness.
- **Purge:** clears pending, delayed, in-flight, and dead messages and resets
  counters. Existing consumers later receive `404 receipt_not_found`.
- **Platform tenancy:** platform callers select a tenant with
  `x-synapseone-tenant`/SDK `tenant` or `?tenant=`; principal callers cannot
  override their verified tenant.

## Authentication and scopes

Queue accepts a Bearer JWT or API key:

- Reads/peek/stats: `queue:read`.
- Queue creation/purge/publish/consume: `queue:write`, with action-specific
  alternatives such as `queue:purge` and `queue:consume`.
- Ack/nack/heartbeat: `queue:ack`, `queue:nack`, `queue:heartbeat`, or
  `queue:write`.
- Queue/dead-letter deletion: `queue:delete`.
- `queue:*` covers the namespace.

IAM policy checks are additional in enforce mode. A runner key normally uses
`queue:*`; narrower workers can request only consume/ack/nack/heartbeat.

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
await client.queue.createQueue('emails', {
  maxAttempts: 5,
  visibilityTimeoutSeconds: 30,
});
await client.queue.publish('emails', { to: 'user@example.com' }, {
  dedupeKey: 'welcome:user@example.com',
});
const consumed = await client.queue.consume('emails', {
  maxMessages: 1,
  consumer: 'mailer-1',
});
if (consumed.messages.length > 0) {
  await client.queue.ack('emails', consumed.messages[0].receipt);
}
console.log(consumed);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.queue.create_queue("emails", max_attempts=5, visibility_timeout_seconds=30)
client.queue.publish(
    "emails",
    {"to": "user@example.com"},
    dedupe_key="welcome:user@example.com",
)
consumed = client.queue.consume("emails", max_messages=1, consumer="mailer-1")
if consumed["messages"]:
    client.queue.ack("emails", consumed["messages"][0]["receipt"])
print(consumed)
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

    _, err := client.CreateQueue("emails", synapseone.QueueConfig{
        MaxAttempts: 5, VisibilityTimeoutSeconds: 30,
    })
    if err != nil {
        panic(err)
    }
    _, err = client.PublishMessage("emails", map[string]any{"to": "user@example.com"},
        synapseone.QueuePublishOptions{DedupeKey: "welcome:user@example.com"})
    if err != nil {
        panic(err)
    }
    consumed, err := client.ConsumeMessages("emails", synapseone.QueueConsumeOptions{
        MaxMessages: 1, Consumer: "mailer-1",
    })
    if err != nil {
        panic(err)
    }
    messages := consumed["messages"].([]any)
    if len(messages) > 0 {
        receipt := messages[0].(map[string]any)["receipt"].(string)
        if _, err := client.AckMessage("emails", receipt); err != nil {
            panic(err)
        }
    }
    fmt.Println(consumed)
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
    client.queue().create_queue("emails", Some(5), Some(30)).await?;
    client.queue().publish(
        "emails", json!({"to": "user@example.com"}), None, None, None, None,
        Some("welcome:user@example.com"),
    ).await?;
    let consumed = client.queue()
        .consume("emails", Some(1), Some(30), Some("mailer-1"))
        .await?;
    if let Some(receipt) = consumed["messages"][0]["receipt"].as_str() {
        client.queue().ack("emails", receipt).await?;
    }
    println!("{consumed}");
    Ok(())
}
```
