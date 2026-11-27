# Warehouse service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Synapse Warehouse owns tenant-scoped DuckDB analytical datasets, bounded
read-only SQL, batch/stream ETL jobs, Base snapshot import, Lakehouse
materialization, and OCS CSV/JSONL/Parquet import.

See [Lakehouse](lakehouse.md), [Base](base.md), [Stream](stream.md),
[OCS](ocs.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/warehouse/datasets` | List or create datasets. |
| GET/PATCH/DELETE | `/v1/warehouse/datasets/:id` | Dataset lifecycle/schema metadata. |
| POST | `/v1/warehouse/datasets/:id/rows` | Append 1–5,000 validated rows. |
| POST | `/v1/warehouse/query` | One bounded read-only SQL statement. |
| GET | `/v1/warehouse/templates` | Built-in ETL recipes. |
| GET | `/v1/warehouse/pipeline/status` | Dataset/job counts and freshness. |
| GET/POST | `/v1/warehouse/jobs` | List/create durable ETL jobs. |
| GET/PATCH/DELETE | `/v1/warehouse/jobs/:id` | Job lifecycle/rename. |
| POST | `/v1/warehouse/jobs/:id/run`, `/pause`, `/resume` | Run or control a job. |
| POST | `/v1/warehouse/etl/batch` | One-shot read-only transform into a dataset. |
| POST | `/v1/warehouse/etl/stream` | Materialize a Stream topic into a dataset. |
| POST | `/v1/warehouse/etl/base` | Base collection snapshot into a dataset. |
| POST | `/v1/warehouse/etl/base-lakehouse` | Durable Base→Stream→Iceberg change log. |
| POST | `/v1/warehouse/etl/lakehouse` | Iceberg table/snapshot into a dataset. |
| POST | `/v1/warehouse/etl/ocs/preview` | Infer an authorized OCS object's schema/sample. |
| POST | `/v1/warehouse/etl/ocs` | Import OCS CSV/JSONL/Parquet into a dataset. |

## Important semantics and limits

- **SQL sandbox:** one `SELECT`, `WITH`, `DESCRIBE`, or `EXPLAIN` statement per
  query. External file/network access is disabled, configuration is locked, and
  only the tenant's datasets are addressable.
- **Dataset schema:** column types are `string`, `number`, `boolean`, `timestamp`,
  and `json`. Dataset ids are tenant-scoped slugs.
- **Rows:** append validates values against declared columns and accepts 1–5,000
  rows per call.
- **Pagination:** dataset/job lists default to and cap at 200 rows, with
  `limit`, `offset`, and `nextOffset`.
- **Write modes:** `replace` recreates/replaces target data; `append` is
  at-least-once unless the path explicitly provides idempotency.
- **Stream ETL:** event ids are recorded in `_ingest_events`; Stream is acked only
  after the DuckDB transaction commits. Restart resumes from the consumer group.
- **Base snapshot:** `replace` stages the full snapshot and atomically swaps it
  in after a successful source read. A failed read preserves previous rows.
  `pageSize` is at most 1,000 and `maxRows` defaults to 100,000.
- **Base→Lakehouse:** the target is an append-only change log, not current state.
  Required columns are `event_id`, `collection`, `document_id`, `operation`,
  `version`, `occurred_at`, `data`, and `deleted`. Delivery is at-least-once;
  Lakehouse idempotency keys suppress duplicate commits.
- **Lakehouse→Warehouse:** at most 5,000 rows per materialization. Tenant SQL
  never receives Iceberg filesystem access.
- **OCS import:** CSV/JSONL/Parquet only. File size is bounded by
  `WAREHOUSE_OCS_MAX_FILE_BYTES` (default 64 MiB) and rows by `maxRows`.
  `replace` is transactional; `append` is at-least-once.
- **Running stream jobs:** renaming a running stream job returns `409 job_running`.
  Pause first, or rename a non-stream job.
- **No BI subsystem:** reports/dashboards are not part of Warehouse.

## Authentication and scopes

Warehouse accepts a Bearer JWT or API key:

- `GET /v1/warehouse/*`: `warehouse:read`.
- `POST /v1/warehouse/query`: explicitly `warehouse:read`.
- Dataset/job/ETL mutations: `warehouse:write` or matching action scopes.
- Deletes: `warehouse:delete`.
- `warehouse:*` covers the namespace.

IAM policies are additional in enforce mode. ETL reads source services through
trusted internal calls after Warehouse/Lakehouse authorization; applications do
not need internal-secret access.

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
await client.warehouse.createDataset({
  id: 'orders',
  name: 'Orders',
  columns: [
    { name: 'order_id', type: 'string' },
    { name: 'total', type: 'number' },
  ],
});
await client.warehouse.ingest('orders', [{ order_id: 'order-1', total: 42 }]);
const result = await client.warehouse.query(
  'SELECT order_id, total FROM orders ORDER BY total DESC',
  { limit: 100 },
);
console.log(result.rows);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
client.warehouse.create_dataset({
    "id": "orders",
    "name": "Orders",
    "columns": [
        {"name": "order_id", "type": "string"},
        {"name": "total", "type": "number"},
    ],
})
client.warehouse.ingest("orders", [{"order_id": "order-1", "total": 42}])
result = client.warehouse.query(
    "SELECT order_id, total FROM orders ORDER BY total DESC", limit=100
)
print(result["rows"])
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

    _, err := client.CreateWarehouseDataset(map[string]any{
        "id": "orders", "name": "Orders",
        "columns": []map[string]any{
            {"name": "order_id", "type": "string"},
            {"name": "total", "type": "number"},
        },
    })
    if err != nil {
        panic(err)
    }
    _, err = client.IngestWarehouseRows("orders", []map[string]any{
        {"order_id": "order-1", "total": 42},
    })
    if err != nil {
        panic(err)
    }
    result, err := client.QueryWarehouse(
        "SELECT order_id, total FROM orders ORDER BY total DESC", 100,
    )
    if err != nil {
        panic(err)
    }
    fmt.Println(result["rows"])
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
    client.warehouse().create_dataset(json!({
        "id": "orders", "name": "Orders",
        "columns": [
            {"name": "order_id", "type": "string"},
            {"name": "total", "type": "number"}
        ]
    })).await?;
    client.warehouse().ingest("orders", json!([
        {"order_id": "order-1", "total": 42}
    ])).await?;
    let result = client.warehouse().query(
        "SELECT order_id, total FROM orders ORDER BY total DESC", Some(100),
    ).await?;
    println!("{}", result["rows"]);
    Ok(())
}
```
