# Base service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseBase is the tenant-scoped document database: JSON documents, logical
object-to-data mapping, validation, queries, optimistic concurrency, atomic
counters, batch writes, a change feed, property graphs, and GeoJSON features.

See [SynapseBase guide](../synapsebase.md), [Search](search.md),
[Warehouse](warehouse.md), and [API reference](../api.md).

## Main gateway routes

All collection routes also exist below `/v1/base/databases/:database/collections`.
Flat routes target the tenant's `default` database unless `?database=` is used.

| Method | Route | Purpose |
| --- | --- | --- |
| GET/POST | `/v1/base/databases` | List/create database namespaces. |
| GET/PATCH/DELETE | `/v1/base/databases/:database` | Read, rename, or delete a database. |
| GET | `/v1/base/databases/:database/stats` | Database collection/document/byte stats. |
| GET/POST | `/v1/base/collections` | List/create collections. |
| GET/PATCH/DELETE | `/v1/base/collections/:collection` | Collection lifecycle. |
| GET | `/v1/base/collections/:collection/stats` | Collection stats. |
| POST | `/v1/base/collections/:collection/documents` | Create a document. |
| GET | `/v1/base/collections/:collection/documents/:id` | Read `data` or mapped `object`. |
| PUT/PATCH/DELETE | `/v1/base/collections/:collection/documents/:id` | Upsert/replace, patch, or delete. |
| GET | `/v1/base/collections/:collection/documents` | Id-ordered page. |
| POST | `/v1/base/collections/:collection/query` | Filter/order/project/cursor query. |
| POST | `/v1/base/collections/:collection/vector-search` | Vector similarity search. |
| POST | `/v1/base/collections/:collection/documents/:id/increment` | Atomic numeric field increment. |
| POST | `/v1/base/collections/:collection/documents:batch` | Up to 100 ordered document operations. |
| GET | `/v1/base/collections/:collection/changes` | Upserts and delete tombstones since a cursor. |
| POST/GET/DELETE | `/v1/base/collections/:collection/graph/...` | Property-graph nodes, edges, traversal, stats. |
| POST/GET/DELETE | `/v1/base/collections/:collection/geo/...` | GeoJSON upsert, bbox/near/within, stats. |

## Important semantics and limits

- **Namespace:** tenant → database → collection → document. Database and
  collection names match `[A-Za-z][A-Za-z0-9_-]{0,63}` and are unique in their
  parent scope. A collection cannot move between databases.
- **Destructive database delete:** a non-empty database returns
  `409 database_not_empty` unless `?cascade=true` is supplied.
- **Writes:** send exactly one of `data` (stored JSON) or `object` (logical
  mapped keys). Create returns the data view. Duplicate create ids return
  `409 document_exists`.
- **Mapping:** mappings contain at most 100 fields with dot paths of at most 16
  segments. Types include `string`, `number`, `boolean`, `date`, `array`,
  `object`, `vector`, and `any`. Mapping changes affect validation/views, not
  stored data migration.
- **Optimistic concurrency:** `ifVersion` or `If-Match` protects replace, patch,
  delete, and increment. A stale version returns `409 version_conflict`.
- **Query:** supports `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`,
  `contains`, `startsWith`, `endsWith`, and `exists`, plus `and`/`or`/`not`
  groups and shorthand comparisons. Responses include `items`, `total`,
  pagination, and `nextCursor`.
- **Batch:** 1–100 ordered `create|set|update|delete|increment` operations.
  Per-operation results are returned; overall `ok` is true only if all succeed.
- **Increment:** `field` is a raw dot path. A missing document is created at
  version 1; `ifVersion:0` is the explicit create form.
- **Change feed:** reuse `nextSince`; delete entries are tombstones with
  `deleted:true`.
- **Graph:** traversal depth is at most 5 and results at most 1,000; node upsert
  accepts up to 1,000 nodes and edge upsert up to 2,000 edges.
- **GIS:** feature geometry is stored as PostGIS `geometry(Geometry,4326)`.
  Feature upsert accepts up to 1,000 features; near queries use metres.
- **Vector search:** supports `cosine`, `l2`, and `ip`, with metadata filters and
  declared vector dimensions.

## Authentication and scopes

Base accepts a Bearer JWT or API key. Gateway action mapping is:

- Ordinary reads/listing/stats: `base:read`.
- Ordinary writes/deletes: `base:write` / `base:delete`.
- `POST .../query` and `POST .../vector-search`: `base:read` overrides.
- `base:*` covers the namespace.

With `AUTHZ_MODE=enforce`, IAM policies are evaluated in addition to scopes.
Org principals see org-bound resources; account-only principals are
account-bound; platform callers must use explicit org/account selectors and can
receive `409 ambiguous_database` for an ambiguous name.

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
const db = client.base.database('analytics');
await db.createCollection({
  name: 'parks',
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
const document = await db.createDocument('parks', {
  id: 'park-1',
  object: { name: 'Central', capacity: 120 },
});
const page = await db.queryDocuments('parks', {
  where: { capacity: { gte: 100 } },
  orderBy: [{ field: 'name', direction: 'asc' }],
  limit: 20,
  as: 'object',
});
console.log(document, page.items);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
db = client.base.database("analytics")
db.create_collection(
    "parks", mapping={"name": "profile.name", "capacity": "profile.capacity"}
)
document = db.create_document(
    "parks", id="park-1", object={"name": "Central", "capacity": 120}
)
page = db.query_documents(
    "parks",
    where={"capacity": {"gte": 100}},
    order_by=[{"field": "name", "direction": "asc"}],
    limit=20,
    as_view="object",
)
print(document, page.items)
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
    db := client.WithBaseDatabase("analytics")

    _, err := db.CreateBaseCollection(map[string]any{
        "name": "parks",
        "mapping": map[string]any{
            "name": "profile.name", "capacity": "profile.capacity",
        },
    })
    if err != nil {
        panic(err)
    }
    document, err := db.CreateBaseDocument("parks", synapseone.BaseDocumentInput{
        ID: "park-1", Object: map[string]any{"name": "Central", "capacity": 120},
    })
    if err != nil {
        panic(err)
    }
    page, err := db.QueryBaseDocuments("parks", synapseone.BaseQuery{
        Where:   map[string]any{"capacity": map[string]any{"gte": 100}},
        OrderBy: []synapseone.BaseOrderBy{{Field: "name", Direction: "asc"}},
        Limit:   20,
        As:      "object",
    })
    if err != nil {
        panic(err)
    }
    fmt.Println(document, page.Items)
}
```

### Rust

```rust
use synapseone::{Credentials, OrderBy, Query, SynapseOneClient};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = SynapseOneClient::new(
        std::env::var("SYNAPSEONE_BASE_URL")
            .unwrap_or_else(|_| "https://api.synapseone.space".to_string()),
        Credentials::api_key(std::env::var("SYNAPSEONE_API_KEY")?),
    )?;
    let db = client.base().database("analytics");
    db.create_collection(
        "parks",
        None,
        Some(json!({"name": "profile.name", "capacity": "profile.capacity"})),
        None,
        None,
    ).await?;
    // The Rust create_document wrapper sends raw data, so use mapped paths.
    let document = db.create_document(
        "parks",
        json!({"profile": {"name": "Central", "capacity": 120}}),
        Some("park-1"),
    ).await?;
    let page = db.query_documents(
        "parks",
        Query::new()
            .filter(json!({"capacity": {"gte": 100}}))
            .order_by(vec![OrderBy::asc("name")])
            .limit(20)
            .as_view("object"),
    ).await?;
    println!("{document} {}", page.items.len());
    Ok(())
}
```
