# Synapse Lakehouse and analytical ETL

Synapse Lakehouse owns durable open-format analytical tables. Warehouse owns
tenant SQL execution; Base owns document transactions; Stream owns change
transport. There is one canonical catalog and one search owner.

## Lakehouse model

- **Format:** Apache Iceberg v2, unpartitioned, append-only tables with additive
  schema evolution.
- **Files:** Parquet data files + Iceberg metadata/manifests in the shared
  S3-compatible store.
- **Catalog:** SQL catalog in platform Postgres (PyIceberg `SqlCatalog`).
- **Tenant mapping:** every organization/account gets a SHA-256-derived physical
  namespace; clients never choose an object-store location.
- **Snapshots:** every append creates a snapshot; query with `snapshotId` for
  time travel. Snapshot ids are strings because they exceed JS safe integer
  range.
- **Idempotency:** pass `idempotencyKey` to append. The key is stored in the
  snapshot summary; a replay returns the existing snapshot with
  `duplicate:true`.
- **Schema evolution:** `POST .../schema` adds columns. Dropping/renaming is not
  exposed yet.
- **Quotas:** namespace, table, rows-per-append and tenant byte quotas are
  enforced. Bytes are the current-snapshot file size plus a conservative estimate
  of the incoming JSON payload; historical snapshots and orphan files are not
  counted. Direct object-store writes are operator-only and bypass this guard.
- **Deletion:** table drop removes catalog metadata only; data files are retained
  for safe manual cleanup. `GET .../tables/:t/maintenance` reports the
  unsupported/destructive operations; physical cleanup is disabled until an
  operator-reviewed Iceberg maintenance job is run.
- **Commit safety:** PyIceberg writes data files before the catalog commit. If
  the process dies before commit, orphan files can remain; they are not part of
  any snapshot. A committed snapshot survives restart.
- **Deployment topology:** one active writer per catalog. A PostgreSQL
  session-level advisory lock makes a second Lakehouse replica fail startup
  (`pg_try_advisory_lock`); drain the old replica before rolling a new one.
  PyIceberg still returns `409 commit_conflict` if concurrent commits reach the
  catalog.

## API summary

```text
GET    /v1/lakehouse/namespaces
POST   /v1/lakehouse/namespaces                  {name}
DELETE /v1/lakehouse/namespaces/:ns
GET    /v1/lakehouse/namespaces/:ns/tables
POST   /v1/lakehouse/namespaces/:ns/tables       {name, schema:[{name,type,required?}]}
GET    /v1/lakehouse/namespaces/:ns/tables/:t
DELETE /v1/lakehouse/namespaces/:ns/tables/:t
POST   /v1/lakehouse/namespaces/:ns/tables/:t/rows    {rows, idempotencyKey?}
POST   /v1/lakehouse/namespaces/:ns/tables/:t/query   {limit?, snapshotId?}
GET    /v1/lakehouse/namespaces/:ns/tables/:t/snapshots
GET    /v1/lakehouse/namespaces/:ns/tables/:t/maintenance
POST   /v1/lakehouse/namespaces/:ns/tables/:t/schema  {add:[{name,type}]}
GET    /v1/lakehouse/usage
```

Types: `string`, `long`, `double`/`number`, `boolean`, `timestamp`, `date`,
`json` (stored as string). Max append 5000 rows; max query 5000 rows.

## ETL paths

### Base snapshot (full copy)

`POST /v1/warehouse/etl/base {collection, targetDatasetId, database?, writeMode?}`

- Calls Base as the tenant with the internal secret.
- Inserts document `data` plus `document_id`, `collection`, `version`,
  `created_at`, `updated_at` when those columns exist.
- `replace` clears the target once; `append` is at-least-once.
- Bounded by `maxRows` (default 100 000) and page size (max 1000).

### Base incremental (current-state stream materialization)

Base outbox → Stream `base-changes` → Warehouse stream ETL:

- `create`/`update` replace the row keyed by `document_id`;
- `delete` removes it;
- `_ingest_events` prevents duplicate event application;
- ack happens after the DuckDB transaction commits;
- restart resumes from the Stream consumer group;
- ordering is best-effort because a failing event backs off independently.

### Batch SQL

`POST /v1/warehouse/etl/batch {targetDatasetId, sql, writeMode?, name?}` runs one
sandboxed read-only statement into a Warehouse dataset.

### Base → Lakehouse automated change log

`POST /v1/warehouse/etl/base-lakehouse {collection, namespace, table, database?, streamTopic?, streamGroup?, batchSize?, intervalMs?, backfill?}`

This is the supported **Path B** ingestion. It creates a durable Warehouse ETL
job that consumes the Base outbox topic (`base-changes` by default) and appends
rows to an Iceberg table. When `database` is supplied, the backfill and the
live stream are both scoped to that Base database so same-named collections in
different databases cannot mix in one table.

Required Iceberg columns:

| Column | Type | Meaning |
|---|---|---|
| `event_id` | string | Base outbox event identity |
| `collection` | string | source collection name |
| `document_id` | string | source document id |
| `operation` | string | `create`, `update` or `delete` |
| `version` | long | Base document version |
| `occurred_at` | timestamp | source change timestamp |
| `data` | string | JSON-encoded document data (`null` for delete) |
| `deleted` | boolean | delete tombstone |

Semantics:

- The table is an **append-only change log**, not an in-place current-state
  replica. Consumers derive current state with `version`/`deleted`.
- `backfill=true` pages through Base's deterministic collection backfill
  (limit 1000, `afterId` until `hasMore=false`) before the worker starts. The
  consumer group starts at `0`, so it reads existing and new events; the
  idempotency key is
  `base:<collection_id>:<document_id>:<created_at>:<version>:<upsert|delete>`
  and suppresses duplicate backfill/event delivery. `create` and `update` at
  the same version are one upsert state; `delete` is a separate tombstone. The
  collection id and document creation timestamp keep a deleted/re-created
  collection or document from colliding with its previous incarnation.
- The worker acknowledges Stream only after Lakehouse append succeeds or returns
  a duplicate snapshot.
- Durable checkpoint = the Stream consumer group; Lakehouse idempotency key =
  durable destination identity. Delivery is at-least-once, destination
  idempotency is verified.
- Restart resumes from the consumer group; duplicate events are suppressed by
  the Iceberg snapshot summary key.
- Cross-tenant job creation is denied by the tenant-scoped Warehouse/Lakehouse
  APIs.
- Cancellation is `POST /v1/warehouse/jobs/:id/pause` or `DELETE`; a paused
  stream job stops reading but retains its consumer group.
- Each change is one durable Iceberg commit, so initial backfill throughput is
  commit-bound (roughly 2–3 rows/second in the QA profile). Size large initial
  imports accordingly; use Path A/Warehouse for bulk snapshots and Path B for
  the change stream.

### Lakehouse → Warehouse materialization

`POST /v1/warehouse/etl/lakehouse {namespace, table, targetDatasetId, snapshotId?, limit?, writeMode?}`

- Scans the authorized Iceberg table through the Lakehouse service.
- Inserts rows into the tenant-owned DuckDB dataset.
- Does **not** grant tenant SQL filesystem/external access.
- Max 5000 rows per materialization; query historical snapshots by id.

## Operations

- Alert on `synapseone_lakehouse_errors_total`, service `up`, and Warehouse
  backlog.
- Back up Postgres catalog + S3 prefix together; a catalog without data files
  (or vice versa) is not a valid restore.
- Restore into a separate project/host; verify Parquet metadata and a historical
  snapshot before switching traffic.
- Do not delete data files referenced by retained snapshots.
