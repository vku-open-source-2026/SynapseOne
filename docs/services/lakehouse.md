# Lakehouse service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Synapse Lakehouse owns durable Apache Iceberg v2 tables in a tenant-scoped
catalog. It provides logical namespaces, append-only Parquet data, immutable
snapshots, bounded time-travel queries, additive schema evolution, and usage
quotas.

See [Lakehouse and ETL guide](../lakehouse.md), [Warehouse](warehouse.md),
[OCS](ocs.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/lakehouse/usage` | Namespace/table counts, row limits, and byte quota. |
| GET/POST | `/v1/lakehouse/namespaces` | List/create logical namespaces. |
| DELETE | `/v1/lakehouse/namespaces/:namespace` | Delete an empty namespace. |
| GET/POST | `/v1/lakehouse/namespaces/:namespace/tables` | List/create Iceberg tables. |
| GET/DELETE | `/v1/lakehouse/namespaces/:namespace/tables/:table` | Metadata or catalog drop. |
| POST | `/v1/lakehouse/namespaces/:namespace/tables/:table/rows` | Append up to 5,000 rows. |
| POST | `/v1/lakehouse/namespaces/:namespace/tables/:table/query` | Bounded scan/time travel. |
| GET | `/v1/lakehouse/namespaces/:namespace/tables/:table/snapshots` | Snapshot history. |
| POST | `/v1/lakehouse/namespaces/:namespace/tables/:table/schema` | Add columns. |
| GET | `/v1/lakehouse/namespaces/:namespace/tables/:table/maintenance` | Non-destructive lifecycle report. |

## Important semantics and limits

- **Format:** Iceberg v2, unpartitioned, append-only tables. Parquet data and
  Iceberg metadata live in the shared S3-compatible store; the catalog is in
  platform Postgres.
- **Hidden physical namespace:** each org/account maps to a SHA-256-derived
  physical namespace. Clients cannot choose an object-store location.
- **Types:** `string`, `long`, `double`/`number`, `boolean`, `timestamp`, `date`,
  and `json` (stored as a string).
- **Rows:** append and query are each capped at 5,000 rows.
- **Idempotency:** pass `idempotencyKey` on append. A replay returns the existing
  snapshot with `duplicate:true` instead of writing again.
- **Snapshots:** every append creates an immutable snapshot. Snapshot ids are
  strings because they can exceed JavaScript's safe integer range. Pass a
  snapshot id to `query` for time travel.
- **Schema:** only additive evolution is exposed. Drop/rename columns is not
  supported.
- **Table deletion:** drops catalog metadata but retains data files
  (`dataFilesRetained:true`) for safe manual cleanup.
- **Maintenance:** physical cleanup is disabled. Snapshot expiry/orphan cleanup
  requires an operator-reviewed Iceberg maintenance job.
- **Quota accounting:** bytes are current-snapshot file size plus a conservative
  incoming-payload estimate. Historical snapshots and orphan files are excluded.
- **Concurrency:** one active writer per catalog is enforced with a PostgreSQL
  session advisory lock. A second replica fails startup; drain the old replica
  before rolling a new one. Catalog conflicts can still return `409 commit_conflict`.
- **Commit safety:** data files are written before the catalog commit. A crash
  before commit can leave orphan files; a committed snapshot survives restart.
- **Warehouse integration:** `/v1/warehouse/etl/lakehouse` materializes an
  authorized table/snapshot into a tenant DuckDB dataset without granting SQL
  filesystem access.

## Authentication and scopes

Lakehouse accepts a Bearer JWT or API key:

- `GET /v1/lakehouse/*`: `lakehouse:read`.
- `POST .../tables/*/query`: explicitly `lakehouse:read`.
- Namespace/table creation, append, and schema evolution: `lakehouse:write`.
- Namespace/table deletion: `lakehouse:delete`.
- `lakehouse:*` covers the namespace.

IAM policies are additional in enforce mode. Direct service calls require the
internal service secret when configured; applications should use the gateway.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

All four SDKs expose namespace/table lifecycle, usage, append/query, snapshots,
and additive schema evolution. Go's typed methods include `LakehouseUsage`,
`LakehouseDeleteNamespace`, `LakehouseCreateTable`, `LakehouseTable`,
`LakehouseDeleteTable`, `LakehouseSnapshots`, and `LakehouseEvolveSchema`, plus
the existing namespace/append/query methods. The maintenance report is still
unwrapped; the Go example uses `Call`, the SDK's generic escape hatch, only for
that route.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});
await client.lakehouse.createNamespace('analytics');
await client.lakehouse.createTable('analytics', {
  name: 'events',
  schema: [
    { name: 'event_id', type: 'string', required: true },
    { name: 'value', type: 'long', required: true },
  ],
});
const appended = await client.lakehouse.append(
  'analytics', 'events', [{ event_id: 'event-1', value: 42 }], 'event-1',
);
const page = await client.lakehouse.query('analytics', 'events', { limit: 100 });
const snapshots = await client.lakehouse.snapshots('analytics', 'events');
console.log(appended.snapshotId, page.rows, snapshots.items);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.lakehouse.create_namespace("analytics")
client.lakehouse.create_table("analytics", "events", [
    {"name": "event_id", "type": "string", "required": True},
    {"name": "value", "type": "long", "required": True},
])
appended = client.lakehouse.append(
    "analytics", "events", [{"event_id": "event-1", "value": 42}], "event-1"
)
page = client.lakehouse.query("analytics", "events", limit=100)
snapshots = client.lakehouse.snapshots("analytics", "events")
print(appended["snapshotId"], page["rows"], snapshots["items"])
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
    client.SetAPIKey(os.Getenv("SYNAPSEONE_API_KEY"))
    namespace := "analytics"
    table := "events"

    usage, err := client.LakehouseUsage()
    if err != nil {
        panic(err)
    }
    if _, err := client.LakehouseCreateNamespace(namespace); err != nil {
        panic(err)
    }
    if _, err := client.LakehouseCreateTable(namespace, map[string]any{
        "name": table,
        "schema": []map[string]any{
            {"name": "event_id", "type": "string", "required": true},
            {"name": "value", "type": "long", "required": true},
        },
    }); err != nil {
        panic(err)
    }
    metadata, err := client.LakehouseTable(namespace, table)
    if err != nil {
        panic(err)
    }
    appended, err := client.LakehouseAppend(namespace, table, []map[string]any{
        {"event_id": "event-1", "value": 42},
    }, "event-1")
    if err != nil {
        panic(err)
    }
    page, err := client.LakehouseQuery(namespace, table, 100, "")
    if err != nil {
        panic(err)
    }
    snapshots, err := client.LakehouseSnapshots(namespace, table)
    if err != nil {
        panic(err)
    }
    evolved, err := client.LakehouseEvolveSchema(namespace, table, map[string]any{
        "name": "source", "type": "string", "required": false,
    })
    if err != nil {
        panic(err)
    }
    // Generic escape hatch: the maintenance report has no typed Go wrapper.
    maintenance, err := client.Call(
        "GET",
        "/v1/lakehouse/namespaces/"+url.PathEscape(namespace)+"/tables/"+url.PathEscape(table)+"/maintenance",
        nil,
    )
    if err != nil {
        panic(err)
    }
    fmt.Println(usage, metadata, appended["snapshotId"], page["rows"], snapshots, evolved, maintenance)
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
    client.lakehouse().create_namespace("analytics").await?;
    client.lakehouse().create_table("analytics", json!({
        "name": "events",
        "schema": [
            {"name": "event_id", "type": "string", "required": true},
            {"name": "value", "type": "long", "required": true}
        ]
    })).await?;
    let appended = client.lakehouse().append(
        "analytics", "events", json!([{"event_id": "event-1", "value": 42}]),
        Some("event-1"),
    ).await?;
    let page = client.lakehouse().query("analytics", "events", Some(100), None).await?;
    let snapshots = client.lakehouse().snapshots("analytics", "events").await?;
    println!("{} {} {}", appended["snapshotId"], page["rows"], snapshots["items"]);
    Ok(())
}
```
