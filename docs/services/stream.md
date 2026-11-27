# Stream service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseStream is a tenant-scoped append-only event log over Valkey/Redis
Streams. It provides topics, retention controls, non-destructive reads,
historical range queries, consumer groups, idle-entry reclaim, and acknowledgments.
The Kafka driver is not shipped.

Use [Queue](queue.md) for work-queue leases and dead letters; use Stream when
multiple consumers need an ordered event history. See
[Warehouse](warehouse.md) and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/stream/topics` | List tenant topics. |
| PUT | `/v1/stream/topics/:topic` | Create/update retention configuration. |
| GET/DELETE | `/v1/stream/topics/:topic` | Read config or delete topic and events. |
| GET | `/v1/stream/topics/:topic/stats` | Length, first/last id, and group stats. |
| POST | `/v1/stream/topics/:topic/events` | Publish one event. |
| POST | `/v1/stream/topics/:topic/events:batch` | Publish up to 100 events. |
| POST | `/v1/stream/topics/:topic/read` | Non-destructive raw read. |
| GET | `/v1/stream/topics/:topic/range` | Historical id/time-range query. |
| PUT/DELETE | `/v1/stream/topics/:topic/groups/:group` | Create/destroy a consumer group. |
| POST | `/v1/stream/topics/:topic/groups/:group/read` | Group read with optional idle reclaim. |
| POST | `/v1/stream/topics/:topic/groups/:group/ack` | Ack processed event ids. |

## Important semantics and limits

- **Event envelope:** `{payload, key?, headers?, id?}`. Stream ids are opaque;
  do not parse them as timestamps or sequence numbers.
- **Ordering:** order is per topic stream, not global across topics.
- **Fan-out:** raw `read` is non-destructive and does not advance a consumer
  group. Each independent reader chooses its own `fromId`.
- **Consumer groups:** group delivery is at-least-once. A crash after read and
  before ack causes redelivery after `claimIdleMs` (default 30,000; `0` disables
  reclaim), so destination writes must be idempotent.
- **Group options:** `consumer`, `count`, `blockMs`, `autoAck`, and
  `claimIdleMs` are API fields. Current JS/Python/Go/Rust group-read wrappers
  expose only a subset; use a generic request when you need `claimIdleMs`.
- **Retention:** topics can set `maxLen`, `minId`, and `retentionMs`. Deleting a
  topic deletes all its events and group state.
- **Retention gaps:** when requested history has been trimmed, the service
  reports a retention gap (the memory engine uses `410 retention_gap`). Recovery
  requires rebuilding/resetting the consumer, not silently skipping data.
- **Batch:** publish is limited to 100 events per call.
- **Range:** `start`, `end`, and `count` are passed as query parameters; range is
  a read/replay operation, not a new subscription.
- **Auto-ack:** `autoAck:true` acknowledges on delivery. Leave it false when the
  destination write must succeed before acknowledgment.

## Authentication and scopes

Stream accepts a Bearer JWT or API key:

- Topic/group reads and raw reads: `stream:read`.
- `POST /v1/stream/topics/*/read` is explicitly mapped to `stream:Read`.
- Publish/topic/group mutations: `stream:write`.
- Group acknowledgment: `stream:write` or `stream:ack`.
- Delete: `stream:delete`.
- `stream:*` covers the namespace.

IAM policies are additional in enforce mode. Warehouse stream ETL needs a
credential that can read/ack its configured topic/group and write its dataset.

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
await client.stream.createTopic('orders', { maxLen: 10_000, retentionMs: 86_400_000 });
await client.stream.createGroup('orders', 'warehouse', { startId: '0' });
await client.stream.publish('orders', { orderId: 'order-1', total: 42 });
const batch = await client.stream.readGroup('orders', 'warehouse', {
  consumer: 'worker-1',
  count: 10,
  autoAck: false,
});
if (batch.events.length > 0) {
  await client.stream.ack('orders', 'warehouse', batch.events.map((event) => event.id));
}
console.log(batch);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.stream.create_topic("orders", max_len=10_000, retention_ms=86_400_000)
client.stream.create_group("orders", "warehouse", start_id="0")
client.stream.publish("orders", {"orderId": "order-1", "total": 42})
batch = client.stream.read_group(
    "orders", "warehouse", consumer="worker-1", count=10, auto_ack=False
)
if batch["events"]:
    client.stream.ack("orders", "warehouse", [event["id"] for event in batch["events"]])
print(batch)
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

    if _, err := client.CreateStreamTopic("orders", 10_000, "", 86_400_000); err != nil {
        panic(err)
    }
    if _, err := client.CreateStreamGroup("orders", "warehouse", "0"); err != nil {
        panic(err)
    }
    if _, err := client.PublishStreamEvent("orders", map[string]any{"orderId": "order-1", "total": 42},
        synapseone.StreamPublishOptions{}); err != nil {
        panic(err)
    }
    batch, err := client.ReadStreamGroup("orders", "warehouse", synapseone.StreamGroupReadOptions{
        Consumer: "worker-1", Count: 10, AutoAck: false,
    })
    if err != nil {
        panic(err)
    }
    events := batch["events"].([]any)
    ids := make([]string, 0, len(events))
    for _, event := range events {
        ids = append(ids, event.(map[string]any)["id"].(string))
    }
    if len(ids) > 0 {
        if _, err := client.AckStreamEvents("orders", "warehouse", ids); err != nil {
            panic(err)
        }
    }
    fmt.Println(batch)
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
    client.stream().create_topic("orders", Some(10_000), None, Some(86_400_000)).await?;
    client.stream().create_group("orders", "warehouse", Some("0")).await?;
    client.stream().publish(
        "orders", json!({"orderId": "order-1", "total": 42}), None, None, None,
    ).await?;
    let batch = client.stream().read_group(
        "orders", "warehouse", "worker-1", Some(10), None, Some(false),
    ).await?;
    let ids: Vec<String> = batch["events"].as_array().into_iter().flatten()
        .filter_map(|event| event["id"].as_str().map(str::to_string))
        .collect();
    if !ids.is_empty() {
        client.stream().ack("orders", "warehouse", ids).await?;
    }
    println!("{batch}");
    Ok(())
}
```
