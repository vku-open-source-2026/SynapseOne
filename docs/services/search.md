# SynapseSearch service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

Search is the tenant-scoped index over SynapseBase documents. It supports
full-text, semantic, and hybrid retrieval with ACL-aware filtering, facets,
highlighted snippets, cursor pagination, reindexing, and freshness status.

Search is served by Base at `/v1/search`; it is not an independent datastore.
See [Base](base.md), [Inference](inference.md), and [API reference](../api.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/search` | Full-text, semantic, or hybrid query. |
| GET | `/v1/search?q=...` | Convenience query form. |
| POST | `/v1/search/reindex` | Idempotently rebuild the tenant-visible projection. |
| GET | `/v1/search/status` | Indexed document/collection counts and freshness. |

Query body:

```json
{
  "query": "accessible park",
  "mode": "hybrid",
  "collections": ["parks", "facilities"],
  "filters": { "status": "active" },
  "limit": 20,
  "cursor": "<opaque-cursor>"
}
```

## Important semantics and limits

- **Modes:** `fulltext` uses lexical matching, `semantic` uses embeddings, and
  `hybrid` blends both scores. The default is full-text.
- **Collection selection:** use `collection` for one collection or `collections`
  for several. Filters are string-valued metadata filters.
- **ACLs:** tenant and document ACLs are rechecked on every query. Indexing a
  document does not grant permission to read it.
- **Results:** matches include scores, highlighted snippets, ACL metadata,
  facets (`collection`, `type`, `status`), and an opaque `nextCursor`.
- **Reindex:** rebuilding removes deleted documents from the projection. It is
  idempotent and can be limited to selected collections.
- **Freshness:** `/status` reports index size/freshness; recently changed Base
  documents may not be immediately searchable.
- **Semantic index:** Base stores 384-dimensional inference embeddings with an
  HNSW cosine index. If inference is unavailable, semantic/hybrid search falls
  back to a deterministic local hashed embedding.
- **Bound:** candidate scanning is bounded (currently 50,000 documents); the
  status/metrics surface discloses index bounds. Search is not an unbounded
  analytical query engine.
- **Cursor:** treat `nextCursor` as opaque and reuse it with the same query and
  filters.

## Authentication and scopes

Search accepts a Bearer JWT or API key and uses the **`base`** authorization
namespace, not a separate `search` namespace:

- `POST /v1/search` is explicitly mapped to `base:read`.
- `GET /v1/search/status` uses `base:read`.
- `POST /v1/search/reindex` is a write and requires `base:write` (or
  `base:reindex`/`base:*` as accepted by the scope matcher).
- `base:*` covers query, status, and reindex.

IAM policies are evaluated in addition to scopes when central authorization is
enabled. Search never broadens the caller's Base/document visibility.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

JavaScript exposes `client.search`. Python exposes `search`, `search_fulltext`,
`search_semantic`, `search_hybrid`, `reindex_search`, and `search_status` on
`client.base`. Rust exposes the corresponding `search_*` methods on
`client.base()`. Go exposes `Search`, `ReindexSearch`, and `SearchStatus`.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});
const results = await client.search.hybrid('accessible park', {
  collections: ['parks', 'facilities'],
  filters: { status: 'active' },
  limit: 20,
});
const status = await client.search.status();
console.log(results, status);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
results = client.base.search_hybrid(
    "accessible park",
    collections=["parks", "facilities"],
    filters={"status": "active"},
    limit=20,
)
status = client.base.search_status()
print(results, status)
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

    results, err := client.Search(synapseone.SearchQuery{
        Query:       "accessible park",
        Mode:        "hybrid",
        Collections: []string{"parks", "facilities"},
        Filters:     map[string]string{"status": "active"},
        Limit:       20,
    })
    if err != nil {
        panic(err)
    }
    status, err := client.SearchStatus()
    if err != nil {
        panic(err)
    }
    fmt.Println(results, status)
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
    let results = client.base().search(
        "accessible park",
        "hybrid",
        None,
        Some(vec!["parks".to_string(), "facilities".to_string()]),
        Some(json!({"status": "active"})),
        20,
        None,
    ).await?;
    let status = client.base().search_status().await?;
    println!("{results} {status}");
    Ok(())
}
```
