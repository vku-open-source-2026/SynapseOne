# Faststore service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Synapse Faststore is a Valkey/Redis-protocol, tenant-scoped key/value and
data-structure service: JSON values, TTLs, atomic counters, hashes, lists, sets,
sorted sets, batches, key scans, and distributed locks.

See [Faststore guide](../faststore.md), [Queue](queue.md), and
[API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/faststore/stats` | Tenant key counts by type. |
| GET | `/v1/faststore/keys?prefix=&limit=&cursor=` | Bounded key scan. |
| GET/PUT/DELETE | `/v1/faststore/keys/:key` | Read, write, or delete any key type. |
| GET | `/v1/faststore/keys/:key/ttl` | Remaining TTL. |
| POST | `/v1/faststore/keys/:key/expire`, `/incr` | Set/clear TTL or atomic increment. |
| POST | `/v1/faststore/batch` | Up to 100 key/value operations. |
| GET/PUT/DELETE | `/v1/faststore/hashes/:key` | Whole-hash operations. |
| GET/PUT/DELETE | `/v1/faststore/hashes/:key/:field` | Hash-field operations. |
| POST | `/v1/faststore/hashes/:key/incr` | Atomic hash-field increment. |
| GET/DELETE | `/v1/faststore/lists/:key` | List range/delete. |
| POST | `/v1/faststore/lists/:key/push`, `/pop`, `/trim` | List mutation. |
| GET/DELETE | `/v1/faststore/sets/:key` | Set members/delete. |
| POST | `/v1/faststore/sets/:key/add`, `/remove`, `/contains` | Set mutation/membership. |
| GET | `/v1/faststore/sets/:key/card` | Set cardinality. |
| GET/DELETE | `/v1/faststore/zsets/:key` | Sorted-set range/delete. |
| POST | `/v1/faststore/zsets/:key/add`, `/incr`, `/remove`, `/score`, `/rank` | Sorted-set operations. |
| POST | `/v1/faststore/locks/:name/acquire`, `/release`, `/extend` | Owner-token distributed lock. |

## Important semantics and limits

- **Tenancy:** keys are isolated by org, account, or user principal. Platform
  callers must select `x-synapseone-tenant` (SDK `tenant`) or `?tenant=`;
  missing selection returns `400 tenant_required`.
- **Values:** a string key can hold any JSON value. Missing key reads return
  `404 not_found`; key-type mismatches return `409 wrong_type`.
- **TTL:** 1–2,592,000 seconds (30 days). `ttlSeconds:0` clears an existing TTL.
  Read responses use `null` for no expiry; the TTL endpoint uses `-1`.
- **Conditional writes:** `ifNotExists` and `ifExists` are mutually exclusive.
  A failed condition returns `409 key_exists` or `404 not_found`.
- **Counters:** `by` is an integer from -1,000,000,000 to 1,000,000,000. Missing
  numeric keys start at zero; non-numeric values return `400 not_a_number`.
- **Batch:** 1–100 ordered `set|get|delete|incr|expire` operations. Failures are
  per-operation and do not abort the batch.
- **Scans:** `limit` is 1–500 (default 100). `truncated:true` means the internal
  scan cap was reached, not merely that another page exists.
- **Hashes:** whole-hash writes accept 1–500 fields; field names are 1–256
  printable characters.
- **Lists:** push/pop accept 1–1,000 values. Indexes use Redis semantics,
  including negative offsets and `-1` for the last element.
- **Sets/sorted sets:** add/remove operations accept up to 1,000 members. Sorted
  sets support score/rank/range operations.
- **Locks:** acquire success/failure is HTTP 200 with `acquired:true|false`.
  Release/extend require the owner token; a foreign token is rejected. A lock
  is not a transaction and expires after its TTL.

## Authentication and scopes

Faststore accepts a Bearer JWT or API key:

- GET/HEAD and membership/score/rank queries: `faststore:read`.
- Writes: `faststore:write` (or the HTTP-verb scope `faststore:put`).
- Increments: `faststore:write` or `faststore:incr`.
- Deletes: `faststore:delete`.
- `faststore:*` covers the namespace.

The gateway explicitly maps set membership and sorted-set score/rank POSTs to
`faststore:Read`. IAM policy checks are additional in enforce mode.

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
await client.faststore.set('cache:park:1', { name: 'Central' }, { ttlSeconds: 300 });
const value = await client.faststore.get('cache:park:1');
const counter = await client.faststore.incr('counter:visits', { by: 1, ttlSeconds: 300 });
console.log(value, counter);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.faststore.set("cache:park:1", {"name": "Central"}, ttl_seconds=300)
value = client.faststore.get("cache:park:1")
counter = client.faststore.incr("counter:visits", by=1, ttl_seconds=300)
print(value, counter)
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

    _, err := client.FaststoreSet("cache:park:1", map[string]any{"name": "Central"},
        synapseone.FaststoreSetOptions{TTLSeconds: 300})
    if err != nil {
        panic(err)
    }
    value, err := client.FaststoreGet("cache:park:1")
    if err != nil {
        panic(err)
    }
    counter, err := client.FaststoreIncr("counter:visits", 1, 300)
    if err != nil {
        panic(err)
    }
    fmt.Println(value, counter)
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
    client.faststore().set(
        "cache:park:1", json!({"name": "Central"}), Some(300), false, false,
    ).await?;
    let value = client.faststore().get("cache:park:1").await?;
    let counter = client.faststore().incr("counter:visits", 1, Some(300)).await?;
    println!("{value} {counter}");
    Ok(())
}
```
