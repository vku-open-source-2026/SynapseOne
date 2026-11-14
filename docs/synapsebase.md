# SynapseBase — documents with object ↔ data mapping

SynapseBase is the self-managed document database of the platform: collections of
JSON documents with server-side validation, a logical **object ↔ data mapping**,
queries, optimistic concurrency, atomic counters, batch writes and a change feed.

- Service: `apps/base-service` · port **4005** · gateway prefix `/v1/base`
- Storage: Postgres (`DATABASE_URL`) with an in-memory fallback for dev/tests
- Auth: gateway JWT/API key (`either`); direct calls need
  `x-synapseone-internal: <SYNAPSEONE_INTERNAL_SECRET>` when the secret is configured
- SDKs: `client.base` (Python/JS), `Client.*Base*` (Go/Rust)

## Databases and collections

SynapseBase is namespaced as **tenant → database → collection → documents**.
A database is the isolation boundary applications should use: two apps can both
have a `users` collection without sharing data or colliding on names, even when
they run in the same org/account.

```text
org/account
└── database "analytics"
    ├── collection "events"
    └── collection "users"
└── database "billing"
    └── collection "users"      # same name, independent documents
```

- Database names follow the same rule as collection names:
  `[A-Za-z][A-Za-z0-9_-]{0,63}` and are unique per tenant scope.
- Collection names are unique **inside a database**, not across the tenant.
- A collection inherits the database tenant (`orgId`/`accountId`). Moving a
  collection between databases is not supported; create it in the target
  database and migrate documents explicitly.
- `GET/POST /v1/base/databases` and
  `GET/PATCH/DELETE /v1/base/databases/:database` manage namespaces.
- Every collection route also exists below a database:
  `/v1/base/databases/:database/collections/:collection/...`.
- The legacy flat routes (`/v1/base/collections/...`) keep working and target
  the caller's **`default`** database, which is created on first write. Use
  `?database=<name>` on a flat route to address another database without
  changing the URL shape. `GET /v1/base/collections` is the exception: without
  `?database=` it lists every visible collection (each item carries its
  `database`) so existing dashboards keep working.
- `DELETE /v1/base/databases/:database` refuses to delete a non-empty database
  (`409 database_not_empty`); pass `?cascade=true` to delete its collections and
  documents too.

```bash
# create a database and a collection inside it
curl -s -XPOST localhost:8080/v1/base/databases \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"analytics","description":"Analytics workspace"}'

curl -s -XPOST localhost:8080/v1/base/databases/analytics/collections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"events"}'

# documents are addressed inside the database
curl -s -XPOST localhost:8080/v1/base/databases/analytics/collections/events/documents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"evt-1","data":{"type":"signup"}}'

# legacy route, explicitly scoped to the same database
curl -s "localhost:8080/v1/base/collections/events?database=analytics" \
  -H "Authorization: Bearer $TOKEN"
```

### Applying the migration

Migration `0008_base_databases` creates `synapseone_base_databases`, adds
`synapseone_base_collections.database_id`, attaches every existing collection
to a `default` database in its current tenant scope and replaces the old
`(org, account, name)` unique index with `(database_id, name)`. It is
replay-safe: running it twice is a no-op and no document is rewritten. The
service runs it automatically at boot; for a manual Postgres upgrade:

```bash
# Use the direct/session connection when PgBouncer runs in transaction mode.
psql "${DATABASE_DIRECT_URL:-$DATABASE_URL}" -v ON_ERROR_STOP=1 \
  -f apps/base-service/drizzle/0008_base_databases.sql
```

Verify the result:

```sql
SELECT d.name, d.org_id, d.account_id, c.name
FROM synapseone_base_collections c
JOIN synapseone_base_databases d ON d.id = c.database_id
ORDER BY d.name, c.name;
```

After the upgrade, keep clients on the flat routes (they target `default`) or
move them to the nested `/v1/base/databases/...` routes. The outbox payload now
also carries `database_id` and `database_name`.

## Why a mapping?

Your application works with objects; the database stores JSON. Instead of
repeating field paths everywhere, declare a mapping once per collection:

```json
{
  "fields": {
    "fullName":  {"path": "profile.name", "type": "string", "required": true},
    "age":       {"path": "profile.age", "type": "number"},
    "joinedAt":  {"path": "meta.joinedAt", "type": "date"},
    "tags":      {"path": "profile.tags", "type": "array"}
  },
  "additional": false
}
```

Then:

- write logical `object` payloads instead of raw `data` — the service stores
  each key at its mapped dot path;
- read `?as=object` (or query with `"as": "object"`) to get logical keys back;
- let the service enforce `required` and `type` on every write.

Raw `data` access still works (and is what the change feed/list endpoints return
unless you ask for `object`). The mapping is a **view and validation contract**,
not a separate table: changing it does not rewrite stored documents.

### Canonical and shorthand forms

```json
{"fields": {"name": {"path": "profile.name", "type": "string"}}}
```

```json
{"name": "profile.name", "capacity": "profile.capacity"}
```

Both are accepted by the service and all SDKs. Shorthand fields have no type
and are optional.

### Mapping rules

| Rule | Value |
|---|---|
| Logical field name | `[A-Za-z_][A-Za-z0-9_-]{0,63}` |
| Path | dot-separated segments `[A-Za-z0-9_$-]{1,64}`, at most 16 segments |
| Duplicate paths | rejected (`400 invalid_mapping`) |
| Fields per mapping | ≤ 100 |
| Types | `string`, `number`, `boolean`, `date`, `array`, `object`, `vector`, `any` (default) |
| `vector` | array of finite numbers, with optional `dimension` validation and `metric` (`cosine` (default), `l2`, `ip`) |
| `required` | enforced on full writes (`POST`, `PUT`) and object writes; skipped on `PATCH` |
| `additional` | `false` (default): object writes reject keys not declared in `fields`; `true`: undeclared keys are stored at their own path |
| `null` | always allowed and preserved; `required` means the key must be present |
| `date` | an ISO-8601-parseable **string** |
| Reserved keys | `__proto__`, `prototype`, `constructor` are rejected in data, paths and `unset` |

Raw `data` writes are validated against the mapping (required/typed logical
fields) but are **not** restricted to mapped paths: unmapped keys are kept.
Reads with `as=object` expose only declared fields.

## Quick start

```bash
TOKEN=$(curl -s -XPOST localhost:8080/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@acme.local","orgSlug":"acme"}' | jq -r .accessToken)

# 1. Create a collection with a mapping
curl -s -XPOST localhost:8080/v1/base/collections \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "name": "parks",
        "mapping": {
          "name": {"path": "profile.name", "type": "string", "required": true},
          "capacity": {"path": "profile.capacity", "type": "number"}
        }
      }'

# 2. Write a logical object
curl -s -XPOST localhost:8080/v1/base/collections/parks/documents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"park-1","object":{"name":"Central","capacity":120}}'
# → stored data: {"profile":{"name":"Central","capacity":120}}

# 3. Read it back as an object, then query it
curl -s "localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \
  -H "Authorization: Bearer $TOKEN"
curl -s -XPOST localhost:8080/v1/base/collections/parks/query \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"where":{"capacity":{"gte":100}},"orderBy":[{"field":"name","direction":"asc"}],"as":"object"}'
```

## Collections

Every path below has a database-scoped equivalent by prefixing
`/v1/base/databases/:database` (for example
`GET /v1/base/databases/analytics/collections`). Flat routes target the
`default` database unless `?database=<name>` is supplied.

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/base/collections` | List visible collections; `?orgId` / `?accountId` narrow the list |
| `POST` | `/v1/base/collections` | Create a collection (201) |
| `GET` | `/v1/base/collections/:collection` | Collection + `stats` |
| `PATCH` | `/v1/base/collections/:collection` | Rename, change description or mapping |
| `DELETE` | `/v1/base/collections/:collection` | Delete the collection and all documents |
| `GET` | `/v1/base/collections/:collection/stats` | `{documents, bytes, lastUpdatedAt}` |

Create body:

```json
{
  "name": "parks",
  "description": "Public parks",
  "database": "analytics",
  "mapping": {"fields": {"name": {"path": "profile.name", "type": "string", "required": true}}},
  "orgId": "org-1",
  "accountId": "acc-1"
}
```

- `name` is unique **per database** and must match `[A-Za-z][A-Za-z0-9_-]{0,63}`.
- `database` is optional on the flat route (default: `default`). If it is also
  present in the path or `?database=`, all three must agree or the request is
  `400 invalid_database`. A named database must already exist.
- `description` ≤ 500 chars; `PATCH {"description": null}` clears it.
- `PATCH` accepts `name`, `description`, `mapping`; at least one is required.
- Collection names are resolved **inside a database**, and databases are
  resolved inside the caller's scope. A platform caller that sees an ambiguous
  database name gets `409 ambiguous_database` and must add `?orgId=` or
  `?accountId=` (or use the nested route with a unique database).

Collection object returned by the API:

```json
{
  "id": "uuid",
  "databaseId": "uuid",
  "database": "analytics",
  "name": "parks",
  "description": "Public parks",
  "mapping": {"additional": false, "fields": {"name": {"path": "profile.name", "type": "string", "required": true}}},
  "orgId": "org-1",
  "accountId": "acc-1",
  "createdAt": "2026-10-21T08:00:00.000Z",
  "updatedAt": "2026-10-21T08:00:00.000Z",
  "stats": {"documents": 12, "bytes": 2048, "lastUpdatedAt": "2026-10-21T09:00:00.000Z"}
}
```

## Documents

Every document response carries `{id, version, createdAt, updatedAt}` and exactly
one payload view: `data` (default) or `object` when requested.

### Create

`POST /v1/base/collections/:collection/documents`

```json
{"id": "park-1", "object": {"name": "Central", "capacity": 120}}
```

or raw data:

```json
{"id": "park-1", "data": {"profile": {"name": "Central", "capacity": 120}}}
```

- Send **exactly one** of `data` / `object` (otherwise `400 mapping_error`).
- `id` is optional; the server generates a UUID. Allowed characters:
  `[A-Za-z0-9_@.:+-]{1,256}`; `/`, `\`, `.` and `..` are rejected.
- Duplicate id → `409 document_exists`.
- Response is always the **data** view (with `collection`).

### Read

`GET /v1/base/collections/:collection/documents/:id?as=data|object`

```bash
curl -s "localhost:8080/v1/base/collections/parks/documents/park-1?as=object" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "park-1",
  "object": {"name": "Central", "capacity": 120},
  "version": 2,
  "createdAt": "2026-10-21T08:00:00.000Z",
  "updatedAt": "2026-10-21T08:05:00.000Z",
  "collection": "parks"
}
```

### Replace / upsert (`PUT`)

`PUT /v1/base/collections/:collection/documents/:id`

```json
{"object": {"name": "Central Park", "capacity": 150}, "ifVersion": 2}
```

| Field | Meaning |
|---|---|
| `data` / `object` | exactly one; full replacement unless `merge` |
| `merge` | `true` deep-merges the payload into the existing document (arrays and scalars replace) |
| `ifVersion` | optimistic concurrency; also accepted as `If-Match: "<version>"` |
| `id` | from the URL |

- Upsert semantics: `201` when the document was created, `200` when replaced/merged.
- `ifVersion: 0` means "must not exist yet" (create-only). A mismatch returns
  `409 version_conflict` with the current version in the message.
- A newly created document starts at `version: 1`; every successful write bumps it.

### Patch (`PATCH`)

`PATCH /v1/base/collections/:collection/documents/:id`

```json
{
  "object": {"capacity": 160},
  "unset": ["profile.obsolete", "meta.oldFlag"],
  "ifVersion": 3
}
```

- Provide `data`/`object` and/or `unset`; otherwise `400 invalid_body`.
- Data is deep-merged, then each `unset` dot path is removed.
- The final document is re-validated against the mapping, so a patch can never
  leave a document violating the declared types.
- `unset` accepts at most 100 valid dot paths; prototype-chain segments are rejected.
- `ifVersion` may also be sent as `If-Match`.

### Delete

`DELETE /v1/base/collections/:collection/documents/:id?ifVersion=3`

`ifVersion` can be sent as a query parameter, in the body, or as `If-Match`.
Unknown id → `404 not_found`; stale version → `409 version_conflict`.

### List (raw data)

`GET /v1/base/collections/:collection/documents?limit=100&offset=0`

- `limit` 1..1000 (default 100), `offset` ≥ 0 (default 0).
- Returns an array of data-view documents in id order.

## Queries

`POST /v1/base/collections/:collection/query`

```json
{
  "where": {
    "or": [
      {"field": "capacity", "op": "gte", "value": 100},
      {"and": [
        {"field": "profile.tags", "op": "contains", "value": "family"},
        {"field": "$updatedAt", "op": "gt", "value": "2026-10-01T00:00:00Z"}
      ]}
    ]
  },
  "orderBy": [{"field": "name", "direction": "asc"}],
  "limit": 20,
  "offset": 0,
  "select": ["name", "capacity"],
  "as": "object"
}
```

`where` accepts:

- **leaf** nodes: `{field, op, value}` (`op` defaults to `eq`);
- **groups**: `{and: [...]}`, `{or: [...]}`, `{not: {...}}` (nesting ≤ 8);
- **arrays**: implicit `and`;
- **shorthand**: `{"status": "active", "capacity": {"gte": 100}}`.

`field` may be a mapping **logical name** or a dot path. Document metadata is
addressable with `$id`, `$version`, `$createdAt`, `$updatedAt`.

### Operators

| Op | Meaning |
|---|---|
| `eq` / `ne` | deep JSON equality / inequality (missing counts as not equal) |
| `gt` / `gte` / `lt` / `lte` | number/string/boolean comparison; incomparable → no match |
| `in` / `nin` | value is / is not in a non-empty array (≤ 1000 items) |
| `contains` | substring for strings, membership for arrays |
| `text` | Postgres full-text match (simple dictionary) over one field; all query terms must match |
| `$text` field | document-wide full-text match over every string value (uses the FTS GIN index) |
| `near` | `{lat,lng,maxDistanceKm?}` radius search over a geo point field |
| `within` | GeoJSON Polygon `{type:"Polygon",coordinates}` (≤500 vertices) or `{bbox:[minLng,minLat,maxLng,maxLat]}` |
| `$id` / `$version` / `$createdAt` / `$updatedAt` | document metadata |
| `startsWith` / `endsWith` | string prefix/suffix |
| `exists` | `true`/`false` based on presence (including `null`) |

### Ordering, pagination and projection

- `orderBy` accepts a string or `{field, direction}` (default `asc`), up to **3**
  fields. Documents are tie-broken by id. With no `orderBy`, results are id-ordered.
- Use **either** `offset` **or** `cursor` (the `nextCursor` from the previous page),
  not both. `offset` is 0..10,000,000; `limit` is 1..1000 (default 100).
- `select` accepts up to 100 logical names/dot paths and projects the `data`
  before the object conversion.
- **Postgres executes the query** (`#29`): filters, `ORDER BY`, `LIMIT/OFFSET`
  and `COUNT(*)` are compiled to parameterised SQL; only the requested page is
  returned to the API process. Equality filters compile to `data @> $n::jsonb`
  and use the `idx_base_documents_data` GIN index; `$text` uses the
  `idx_base_documents_fts` GIN index (migration `0004_query_indexes`); default
  id order uses the primary key. Range and geo predicates are pushed down but
  are not index-accelerated without PostGIS.
- The in-memory dev/test fallback keeps the scan engine and is still bounded by
  `BASE_QUERY_SCAN_LIMIT` (batched, default **200,000**). Only that fallback can
  return `413 collection_too_large`; a Postgres-backed deployment does not.
- Cursors are offset cursors. Pages are stable for a static collection; a
  concurrent insert/delete before the offset can shift later pages, so long
  exports should re-query by `$updatedAt`/`$id` for a consistent snapshot.
- `GET /documents?limit=&offset=` fetches only the requested page in Postgres.
  Add `withTotal=1` for an `{items,total,limit,offset,nextCursor}` envelope;
  `X-Total-Count` is always set and the default response stays a bare array.

Response:

```json
{
  "items": [
    {"id": "park-1", "version": 3, "createdAt": "...", "updatedAt": "...",
     "object": {"name": "Central", "capacity": 160, "tags": ["family", "lake"]}}
  ],
  "total": 42,
  "limit": 20,
  "offset": 0,
  "nextCursor": "eyJ2IjoxLCJvZmZzZXQiOjIwfQ"
}
```

`total` is the number of matching documents before pagination. `nextCursor` is
`null` on the last page.

## Vector Search (SynapseBase Vector)

SynapseBase supports vector similarity search over embedding fields with
metadata filters (hybrid search). The tenant search index
(`/v1/search`) stores real 384-d inference embeddings in
`embedding_vec vector(384)` with an HNSW cosine index; `semantic` and `hybrid`
queries use it and fall back to the local hashed embedding when inference is
unavailable. The per-collection `/vector-search` endpoint still scores the
filtered candidate documents in the service, so narrow large collections with
indexed equality filters when using that endpoint.

### Declaring vector fields in a mapping

```json
{
  "fields": {
    "title": {"path": "title", "type": "string", "required": true},
    "category": {"path": "meta.category", "type": "string"},
    "embedding": {
      "path": "vec",
      "type": "vector",
      "dimension": 384,
      "metric": "cosine"
    }
  }
}
```

- `type`: `"vector"`
- `dimension` *(optional)*: enforces exact float array length (e.g. 384 for MiniLM, 1536 for OpenAI)
- `metric` *(optional)*: `"cosine"` (default), `"l2"`, or `"ip"` (inner product)

### Dedicated endpoint: `POST /v1/base/collections/:collection/vector-search`

```json
{
  "vector": [0.12, 0.45, -0.23, ...],
  "limit": 5,
  "metric": "cosine",
  "where": {"category": {"eq": "ai"}},
  "as": "object"
}
```

Response:
```json
{
  "items": [
    {
      "id": "doc-1",
      "similarity": 0.942,
      "distance": 0.058,
      "version": 1,
      "createdAt": "2026-10-22T00:00:00Z",
      "updatedAt": "2026-10-22T00:00:00Z",
      "object": {
        "title": "Intro to AI",
        "category": "ai",
        "embedding": [0.12, 0.45, -0.23, ...]
      }
    }
  ],
  "total": 1,
  "limit": 5,
  "metric": "cosine"
}
```

### Hybrid search in `/query`

You can also pass a `vectorSearch` block directly to `POST /v1/base/collections/:collection/query`:

```json
{
  "vectorSearch": {
    "vector": [0.12, 0.45, -0.23, ...],
    "limit": 10
  },
  "where": {"category": {"eq": "ai"}},
  "as": "object"
}
```

### Workflow Service & AI Agent Integration

1. **First-party Workflow block**:
   - Resource: `base`
   - Operation: `vector-search`
   - Parameters: `{ "collection": "docs", "query": "={{ $json.query }}", "limit": 5, "where": { "tag": "prod" } }` (supports natural language `query` with automatic embedding generation or pre-computed `vector`)
2. **AI Agent Tool in SynapseFlow**:
   - `synapsebase_vector_search`: Built-in agent tool allowing autonomous AI agents to semantically query documents in SynapseBase. The agent can provide natural language `query` (which is automatically embedded via Synapse Inference) or pre-computed `vector` floats, along with optional metadata filter (`where`) and result limit (`limit`).
   - `synapsebase_query`: Also supports `action: "vector_search"` with natural language `query` or `vector`.
   - **Canvas Node-as-Tool**: A `synapseone.base` node configured for `vector-search` can be wired into an AI Agent's purple `tools` port. The agent can invoke this canvas tool passing `{ input: { query: "..." } }` dynamically.

### SDK Usage

#### TypeScript / JavaScript
```ts
// Service level:
const results = await client.base.vectorSearch('articles', {
  vector: [0.1, 0.2, 0.3],
  limit: 5,
  where: { category: 'ai' },
});

// Typed collection level:
const articles = client.base.collection('articles');
const matches = await articles.vectorSearch({
  vector: [0.1, 0.2, 0.3],
  limit: 5,
});
console.log(matches.items[0].object);
```

#### Python
```python
# Service level:
results = client.base.vector_search("articles", [0.1, 0.2, 0.3], limit=5, where={"category": "ai"})

# Typed collection level:
articles = client.base.collection("articles", model=Article)
matches = articles.vector_search([0.1, 0.2, 0.3], limit=5)
```

#### Go
```go
// Service level:
results, err := client.VectorSearchBaseDocuments("articles", synapseone.BaseVectorSearchOptions{
    Vector: []float64{0.1, 0.2, 0.3},
    Limit:  5,
    Where:  map[string]any{"category": "ai"},
})

// Typed collection level:
articles := synapseone.NewBaseCollection[Article](client, "articles", mapping)
matches, err := articles.VectorSearch(synapseone.BaseVectorSearchOptions{
    Vector: []float64{0.1, 0.2, 0.3},
    Limit:  5,
})
```

## Graph (SynapseBase Graph)

A tenant-scoped property graph stored next to the collection in Postgres. Nodes
carry labels + JSON properties; edges are typed and reference existing nodes.
Traversal is a bounded recursive CTE (`depth <= 5`, `limit <= 1000`) so a query
cannot walk the whole database, and every node/edge is checked against the
collection's tenant scope.

```bash
# Upsert nodes
curl -X POST "$BASE/v1/base/collections/knowledge/graph/nodes" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"nodes":[{"id":"doc:1","labels":["Document"],"properties":{"title":"Bão số 12"}},
                 {"id":"province:hanoi","labels":["Province"],"properties":{"name":"Hà Nội"}}]}'

# Upsert an edge
curl -X POST "$BASE/v1/base/collections/knowledge/graph/edges" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"edges":[{"from":"doc:1","to":"province:hanoi","type":"MENTIONS"}]}'

# Bounded traversal
curl "$BASE/v1/base/collections/knowledge/graph/nodes/doc:1?depth=2&limit=100" \
  -H "Authorization: Bearer $TOKEN"
```

```ts
await c.base.graphUpsertNodes('knowledge', [
  { id: 'doc:1', labels: ['Document'], properties: { title: 'Bão số 12' } },
  { id: 'province:hanoi', labels: ['Province'], properties: { name: 'Hà Nội' } },
]);
await c.base.graphUpsertEdges('knowledge', [
  { from: 'doc:1', to: 'province:hanoi', type: 'MENTIONS' },
]);
const sub = await c.base.graphNode('knowledge', 'doc:1', { depth: 2 });
const matches = await c.base.graphQuery('knowledge', {
  start: ['doc:1'], depth: 2, edgeTypes: ['MENTIONS'],
});
```

```python
c.base.graph_upsert_nodes("knowledge", [
    {"id": "doc:1", "labels": ["Document"], "properties": {"title": "Bão số 12"}},
    {"id": "province:hanoi", "labels": ["Province"], "properties": {"name": "Hà Nội"}},
])
c.base.graph_upsert_edges("knowledge", [
    {"from": "doc:1", "to": "province:hanoi", "type": "MENTIONS"},
])
sub = c.base.graph_node("knowledge", "doc:1", depth=2)
matches = c.base.graph_query("knowledge", ["doc:1"], depth=2, edge_types=["MENTIONS"])
```

Endpoints: `POST .../graph/nodes`, `POST .../graph/edges`,
`GET .../graph/nodes/:id?depth=`, `POST .../graph/query`,
`GET .../graph/stats`, `DELETE .../graph/nodes/:id`.

## GIS (SynapseBase GIS / PostGIS)

GeoJSON features are stored as `geometry(Geometry,4326)` with a GiST index;
properties stay in `jsonb`. Bounding-box, radius (metres) and polygon
containment run inside Postgres.

```bash
curl -X POST "$BASE/v1/base/collections/knowledge/geo/features" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"features":[{"id":"p1","properties":{"name":"Hà Nội"},
       "geometry":{"type":"Point","coordinates":[105.85,21.03]}}]}'

curl -X POST "$BASE/v1/base/collections/knowledge/geo/near" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"lat":21.03,"lng":105.85,"radiusMeters":5000}'
```

```ts
await c.base.geoUpsert('knowledge', [{
  id: 'p1', properties: { name: 'Hà Nội' },
  geometry: { type: 'Point', coordinates: [105.85, 21.03] },
}]);
const nearby = await c.base.geoNear('knowledge', { lat: 21.03, lng: 105.85, radiusMeters: 5000 });
const inside = await c.base.geoWithin('knowledge', { geometry: polygon });
const page = await c.base.geoList('knowledge', { bbox: '105,20,107,22', limit: 200 });
```

```python
c.base.geo_upsert("knowledge", [{
    "id": "p1", "properties": {"name": "Hà Nội"},
    "geometry": {"type": "Point", "coordinates": [105.85, 21.03]},
}])
nearby = c.base.geo_near("knowledge", 21.03, 105.85, 5000)
inside = c.base.geo_within("knowledge", polygon)
page = c.base.geo_list("knowledge", bbox="105,20,107,22", limit=200)
```

Endpoints: `POST .../geo/features`, `GET .../geo/features?bbox=`,
`POST .../geo/near`, `POST .../geo/within`, `GET .../geo/stats`,
`DELETE .../geo/features/:id`.

## Atomic increment

`POST /v1/base/collections/:collection/documents/:id/increment`

```json
{"field": "profile.capacity", "by": 10, "ifVersion": 3}
```

- `field` is a **raw dot path** (not a logical mapping name); `by` is a finite
  number (default `1`).
- If the document is missing it is created at version 1 with the field set to
  `by`. Pass `"ifVersion": 0` to make that create explicit; a missing document
  with any other `ifVersion` is a `409 version_conflict`.
- An existing non-numeric value → `400 invalid_field`.
- The response is the updated data-view document.

## Batch writes

`POST /v1/base/collections/:collection/documents:batch`

```json
{
  "operations": [
    {"op": "create", "id": "park-2", "object": {"name": "Riverside"}},
    {"op": "set", "id": "park-1", "object": {"name": "Central", "capacity": 200}},
    {"op": "update", "id": "park-1", "data": {"profile": {"capacity": 210}}},
    {"op": "increment", "id": "park-1", "field": "profile.capacity", "by": 5},
    {"op": "delete", "id": "park-3", "ifVersion": 4}
  ]
}
```

- 1..100 operations, executed **in order**.
- Ops: `create`, `set` (replace/upsert; `merge` is not honored here),
  `update` (partial merge), `delete`, `increment`.
- The batch never fails as a whole: the response reports per-op results and
  `ok` is true only when every op succeeded.
- `ifVersion` is honored only by `delete` in a batch.

```json
{
  "results": [
    {"index": 0, "ok": true, "op": "create", "document": {"id": "park-2", "...": "..."}},
    {"index": 4, "ok": false, "op": "delete", "error": "not_found", "message": "..."}
  ],
  "ok": false
}
```

## Change feed

`GET /v1/base/collections/:collection/changes?since=<ISO-8601>&after=<event-id>&limit=100&as=data|object`

```json
{
  "changes": [
    {"id": "park-1", "version": 4, "createdAt": "...", "updatedAt": "...", "operation": "update", "eventId": "…", "data": {...}, "deleted": false},
    {"id": "park-2", "version": 3, "operation": "delete", "eventId": "…", "deleted": true}
  ],
  "nextSince": "2026-10-21T09:00:00.000Z",
  "nextAfter": "event-id",
  "hasMore": false
}
```

- The feed reads the transactional outbox, not the current document table.
  Create, update and delete are emitted; deletes are tombstones.
- Poll with `nextSince` + `nextAfter` so multiple events with the same timestamp
  are not skipped.
- Backfill an existing collection with
  `POST /internal/base/collections/:collection/backfill`
  (`x-synapseone-internal`, 500 docs/page, deterministic event ids).
- `BASE_OUTBOX_STREAM_TOPIC` (default `base-changes`) enables the relay to
  SynapseStream when `STREAM_SERVICE_URL` is configured.
- `limit` 1..1000 (default 100).
- Only upserts/updates are emitted. **Deletes are not emitted** — `deleted` is
  always `false`; consumers must handle removals separately.
- `hasMore` is true when the page was full; call again immediately with the new
  `nextSince`.

## Tenancy and access

SynapseBase requires an authenticated caller (anonymous calls are `401
auth_required`). Databases and collections use the same tenant rules. Access is
derived from the gateway-stamped principal:

| Caller | Sees | Creates |
|---|---|---|
| Org principal (`x-synapseone-org`) | databases/collections owned by that org | org-bound (`org_id=<org>`), optional `accountId` |
| Account-only principal | unbound-org namespaces owned by that account | `org_id=null, account_id=<account>` |
| Platform caller (internal) | only **unbound** namespaces by default | unbound unless `orgId`/`accountId` supplied |

- A platform caller reaches tenant databases/collections by adding `?orgId=` or
  `?accountId=` to the route; create requests accept the same parameters as an
  alternative to the body fields. With no scope it only sees global (unbound)
  namespaces.
- Cross-tenant creates are rejected with `403 cross_tenant`; foreign databases
  and collections read as `404 not_found` / `database_not_found`.
- Direct service calls (port 4005) must also carry the internal secret when
  `SYNAPSEONE_INTERNAL_SECRET` is set.

## Errors

All errors use `{error, message}`; mapping errors may add `details`.

| Status | `error` | Typical cause |
|---|---|---|
| 400 | `invalid_collection`, `invalid_database`, `invalid_name`, `invalid_description`, `invalid_mapping`, `invalid_tenant` | bad collection/database payload or conflicting database scope |
| 400 | `mapping_error` | missing/typed/unknown field, bad `data`/`object` combination |
| 400 | `invalid_query` | bad filter/operator/orderBy/limit/cursor |
| 400 | `invalid_document_id`, `invalid_view`, `invalid_version`, `invalid_field`, `invalid_unset`, `invalid_body` | bad request parameter |
| 400 | `invalid_batch` | operations not 1..100 |
| 400 | `invalid_since`, `invalid_limit`, `invalid_pagination` | bad change-feed/list paging |
| 401 | `auth_required`, `unauthorized` | anonymous caller / missing internal secret |
| 403 | `cross_tenant` | database/collection scope outside the caller |
| 404 | `not_found`, `database_not_found` | collection, document or database missing |
| 409 | `document_exists`, `collection_exists`, `database_exists`, `version_conflict`, `ambiguous_database`, `database_not_empty` | name conflict / stale version / ambiguous or non-empty database |
| 413 | `collection_too_large`, `payload_too_large` | query scan limit / body too large |
| 500 | `internal` | unexpected server error |

## Limits

| Limit | Value |
|---|---|
| Document size | `BASE_MAX_DOCUMENT_BYTES`, default 262144 (256 KB), clamped 1 KB..4 MB |
| Nesting depth | 32 |
| Array length | 10,000 items |
| Mapping | 100 fields, 16 path segments, 64-char names/segments |
| Query scan (memory fallback only) | `BASE_QUERY_SCAN_LIMIT`, default 200,000, clamped 100..1,000,000; Postgres queries are not scanned |
| Filters per query | 50 |
| Filter nesting | 8 |
| `orderBy` | 3 fields |
| Query `limit` | 1..1000 |
| `select` | 100 paths |
| Batch | 100 operations |
| Change feed `limit` | 1..1000 |
| List `limit` | 1..1000 |

## SDK usage

### Python

```python
from dataclasses import dataclass
from synapseone_sdk import SynapseOneClient

@dataclass
class Park:
    name: str
    capacity: int | None = None

c = SynapseOneClient(token=jwt)

# Unbound/dynamic API
c.base.create_collection(
    "parks",
    mapping={
        "name": {"path": "profile.name", "type": "string", "required": True},
        "capacity": {"path": "profile.capacity", "type": "number"},
    },
)
doc = c.base.create_document("parks", object={"name": "Central", "capacity": 120}, id="park-1")
doc = c.base.get_document("parks", "park-1", as_view="object")
page = c.base.query_documents(
    "parks",
    {"capacity": {"gte": 100}},
    order_by=[{"field": "name", "direction": "asc"}],
    as_view="object",
)
print(page.total, page.next_cursor)

# Typed collection: model attributes must equal logical mapping names
parks = c.base.collection("parks", model=Park, mapping={"name": "profile.name", "capacity": "profile.capacity"})
parks.create(Park("Riverside", 80), id="park-2")
for park in parks.query({"capacity": {"gte": 100}}):
    print(park.name, park.capacity)

parks.update("park-1", Park("Central Park"), unset=["profile.obsolete"], if_version=1)
parks.increment("park-1", "profile.capacity", by=10)
feed = parks.changes("2026-10-01T00:00:00Z")
```

Python notes:

- `get_document(..., as_view=...)` because `as` is a keyword.
- `data`/`object` use an `UNSET` sentinel so explicit `None` is distinguishable
  from an omitted argument.
- `query_documents()` returns a `QueryResult` with `items`, `total`, `limit`,
  `offset`, `next_cursor`; it is iterable and supports `len()`.
- Typed `BaseCollection` converts list/increment/changes (raw-data endpoints)
  locally with its `mapping`; writes use logical `object` payloads.

### JavaScript / TypeScript

```ts
import { SynapseOneClient } from '@synapseone/sdk';

const c = new SynapseOneClient({ token: jwt });

await c.base.createCollection({
  name: 'parks',
  mapping: {
    name: { path: 'profile.name', type: 'string', required: true },
    capacity: { path: 'profile.capacity', type: 'number' },
  },
});

const doc = await c.base.createDocument('parks', { id: 'park-1', object: { name: 'Central', capacity: 120 } });
const page = await c.base.queryDocuments('parks', {
  where: { capacity: { gte: 100 } },
  orderBy: [{ field: 'name', direction: 'asc' }],
  as: 'object',
});

// Typed collection
type Park = { name: string; capacity: number };
const parks = c.base.collection<Park>('parks', {
  mapping: { name: 'profile.name', capacity: 'profile.capacity' },
});
await parks.create({ name: 'Riverside', capacity: 80 }, { id: 'park-2' });
const [first] = await parks.query({ where: { capacity: { gte: 100 } } }).then((r) => r.items);
await parks.update('park-1', { capacity: 200 }, { ifVersion: doc.version });
await parks.increment('park-1', { field: 'profile.capacity', by: 10 });
const changes = await parks.changes({ since: '2026-10-01T00:00:00Z' });
```

### Go

```go
c := synapseone.New("")
c.SetToken(jwt)

_, err := c.CreateBaseCollection(map[string]any{
    "name": "parks",
    "mapping": map[string]any{"fields": map[string]any{
        "name":     map[string]any{"path": "profile.name", "type": "string", "required": true},
        "capacity": map[string]any{"path": "profile.capacity", "type": "number"},
    }},
})

type Park struct {
    Name     string `json:"name"`
    Capacity int    `json:"capacity"`
}
parks := synapseone.NewBaseCollection[Park](c, "parks",
    synapseone.NewBaseMapping(map[string]string{"name": "profile.name", "capacity": "profile.capacity"}),
)
park, err := parks.Create(Park{Name: "Central", Capacity: 120}, "park-1")
park, err = parks.Get("park-1")
page, err := parks.Query(synapseone.BaseQuery{
    Where: map[string]any{"capacity": map[string]any{"gte": 100}},
    OrderBy: []synapseone.BaseOrderBy{{Field: "name", Direction: "asc"}},
})
park, err = parks.Increment("park-1", "profile.capacity", 10, 0)
feed, err := parks.Changes("2026-10-01T00:00:00Z", 100)
```

Go model fields are converted through `encoding/json`, so use `json` tags that
match the logical mapping names. `NewBaseMapping` builds the simple
`logical -> dot path` form; construct a full `BaseMapping` when you need types or
`required`.

## Operations

- `GET /health` → `{status, service:"base", version, db:"postgres"|"memory", collections, time}`
- `GET /metrics` → `synapseone_base_up`, `synapseone_base_collections_total`,
  `synapseone_base_http_requests_total{key="METHOD|route|status"}`,
  `synapseone_base_process_uptime_seconds`
- Production requires `SYNAPSEONE_INTERNAL_SECRET` and `DATABASE_URL`; without a
  database the service uses an in-memory store (single process, no persistence).
- Request bodies are limited to 5 MB by the HTTP layer; the document limit is
  enforced separately.
