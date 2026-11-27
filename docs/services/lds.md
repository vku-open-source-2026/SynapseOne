# LDS service guide

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

## Purpose

SynapseLDS publishes licensed linked data as NGSI-LD. A datasource owns its
entity type, license, JSON-LD contexts, and attribute registry; ingested source
records are projected into public NGSI-LD entities without exposing private
platform metadata.

See [API reference](../api.md) and the
[LDS specification](../specs/synapseone-lds.md).

## Main gateway routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/lds/licenses` | Public built-in SPDX/license catalog. |
| GET/POST | `/v1/lds/datasources` | List or create datasources. |
| GET/PATCH/DELETE | `/v1/lds/datasources/:id` | Read, update, or delete a datasource. |
| GET/PUT | `/v1/lds/datasources/:id/attributes` | Read or atomically replace the attribute registry. |
| POST | `/v1/lds/datasources/:id/records` | Ingest one record or up to 1,000 records. |
| GET | `/v1/lds/datasources/:id/entities` | Public/restricted NGSI-LD export. |
| GET | `/v1/lds/datasources/:id/entities/:entityId` | Single-entity export. |
| GET | `/v1/lds/datasources/:id/stats` | Record and attribute counts. |

## Important semantics and limits

- **Three-region storage:** `_core` holds private ids/tenant/source/version/actor,
  `entity` holds public identity, and `attributes` holds dynamic business
  fields. Exports use a structural allowlist, so `_core` cannot leak.
- **Visibility:** attributes are `public`, `restricted`, or `internal`. A
  datasource defaults to `internal` unless configured otherwise. Unregistered
  attributes are stored but default-deny for export.
- **Reserved names:** `id`, `type`, `@context`, `internalId`, `tenantId`, and
  related identity fields are rejected in the registry. Reserved source fields
  are quarantined during ingest, never promoted.
- **Public identity:** source `id` becomes `_core.sourceRecordId`; the default
  public IRI is `urn:ngsi-ld:<entityType>:<id>`. An explicit `ngsiLdId` or `@id`
  can provide another valid IRI.
- **Upsert/versioning:** re-ingesting the same source id updates the entity and
  increments its version. Ingest returns created/updated/quarantined counts and
  public entity identities.
- **Pagination:** entity `limit` is 1–500 (default 100), and `offset` must be
  non-negative. Invalid values return `400`, not a clamped page.
- **Anonymous reads:** license catalog and public entity routes are public.
  Anonymous callers always receive only the public projection and cannot ask
  for `restricted` data (`401 auth_required`).
- **Restricted reads:** an authenticated caller inside the datasource tenant can
  request `?visibility=restricted`; responses are `private, no-store`. A caller
  from another tenant receives `404`. `internal` never leaves the API.
- **License metadata:** exports carry `X-LDS-License`, a `Link` license relation,
  and the license URL in `@context`.
- **Deletion:** deleting a datasource cascades its registry and records.
  Individual entity hard deletion is not exposed.

## Authentication and scopes

Datasource management accepts a Bearer JWT or API key and uses the `lds`
namespace:

- Reads/stats: `lds:read`.
- Create/update/attribute replacement/ingest: `lds:write`.
- Datasource deletion: `lds:delete`.
- `lds:*` covers all management operations.

Public license/entity routes are authenticated optionally: supplying a valid
Bearer token enables same-tenant restricted reads, while omitting it returns
only public data. Org/account filters can narrow a principal's visible
datasources but cannot escape its tenant.

## SDK usage

Full references: [JavaScript/TypeScript](../sdk-js.md),
[Python](../sdk-python.md), [Go](../sdk-go.md),
[Rust](../sdk-rust.md).

These examples create a CC0 organization datasource, register two public
attributes, ingest one wrapped record, and read the public projection.

### JavaScript/TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const client = new SynapseOneClient({
  baseUrl: process.env.SYNAPSEONE_BASE_URL,
  apiKey: process.env.SYNAPSEONE_API_KEY,
});
const datasource = await client.lds.createDatasource({
  name: 'Organizations',
  entityType: 'Organization',
  license: 'CC0-1.0',
  defaultVisibility: 'public',
}) as { id: string };
const id = datasource.id;
await client.lds.setAttributes(id, [
  { name: 'name', ngsiLdType: 'Property', visibility: 'public' },
  { name: 'locatedIn', ngsiLdType: 'Relationship', visibility: 'public' },
]);
const ingested = await client.lds.ingest(id, {
  records: [{ id: '55001', name: 'Example Organization' }],
});
const entities = await client.lds.entities(id, { limit: 20, visibility: 'public' });
console.log(ingested, entities);
```

### Python

```python
import os
from synapseone_sdk import SynapseOneClient

client = SynapseOneClient(
    base_url=os.environ.get("SYNAPSEONE_BASE_URL"),
    api_key=os.environ["SYNAPSEONE_API_KEY"],
)
datasource = client.lds.create_datasource(
    name="Organizations",
    entity_type="Organization",
    license="CC0-1.0",
    default_visibility="public",
)
ds_id = datasource["id"]
client.lds.set_datasource_attributes(ds_id, [
    {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
    {"name": "locatedIn", "ngsiLdType": "Relationship", "visibility": "public"},
])
ingested = client.lds.ingest_records(
    ds_id, {"records": [{"id": "55001", "name": "Example Organization"}]}
)
entities = client.lds.list_entities(ds_id, limit=20, visibility="public")
print(ingested, entities)
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

    datasource, err := client.CreateLDSDatasource(map[string]any{
        "name": "Organizations", "entityType": "Organization",
        "license": "CC0-1.0", "defaultVisibility": "public",
    })
    if err != nil {
        panic(err)
    }
    id := datasource["id"].(string)
    _, err = client.SetLDSAttributes(id, []any{
        map[string]any{"name": "name", "ngsiLdType": "Property", "visibility": "public"},
        map[string]any{"name": "locatedIn", "ngsiLdType": "Relationship", "visibility": "public"},
    })
    if err != nil {
        panic(err)
    }
    ingested, err := client.IngestLDSRecords(id, map[string]any{
        "records": []any{map[string]any{"id": "55001", "name": "Example Organization"}},
    })
    if err != nil {
        panic(err)
    }
    entities, err := client.ListLDSEntities(id, map[string]string{"limit": "20", "visibility": "public"})
    if err != nil {
        panic(err)
    }
    fmt.Println(ingested, entities)
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
    let datasource = client.lds().create_datasource(
        "Organizations", "Organization", "CC0-1.0", None, None, None,
        Some("public"), None, None, None,
    ).await?;
    let id = datasource["id"].as_str().ok_or("missing datasource id")?;
    client.lds().set_datasource_attributes(id, json!([
        {"name": "name", "ngsiLdType": "Property", "visibility": "public"},
        {"name": "locatedIn", "ngsiLdType": "Relationship", "visibility": "public"}
    ])).await?;
    let ingested = client.lds().ingest_records(id, json!({
        "records": [{"id": "55001", "name": "Example Organization"}]
    })).await?;
    let entities = client.lds().list_entities(id, Some(20), None, Some("public")).await?;
    println!("{ingested} {entities}");
    Ok(())
}
```
