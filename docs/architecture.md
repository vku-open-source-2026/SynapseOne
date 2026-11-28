# Architecture — SynapseOne

SynapseOne is one Apache-2.0 platform with six planes. Capabilities have exactly
one canonical owner; logical separation does not require a service per box.

## Planes and canonical owners

| Plane | Component | Port | Canonical responsibility |
|---|---|---|---|
| Experience | Console (`apps/console`) | 3000/80 | Tenant administration, data browser, Super Admin |
| Experience | SDKs (`sdks/*`), CLI (`tools/cli`) | — | API clients; never an authorization authority |
| Edge | Gateway (`apps/gateway`, Rust) | 8080 | Public entry, JWT/API-key verification, scopes, principal stamping, routing, limits, usage, `/ready` |
| Control | IAM (`apps/iam-service`, Node) | 4001 | Organizations, accounts, users, roles, policies, sessions, MFA, API keys, service accounts, audit |
| Control | Workflow (`apps/workflow-service`, Node) | 4002 | DAG engine, triggers, executions, human tasks, runners, credentials |
| Operational data | Base (`apps/base-service`, Rust) | 4005 | Document transactions, query, search index, change feed, transactional outbox |
| Operational data | Faststore (`apps/faststore-service`, Rust) | 4006 | Cache/KV, data structures, distributed locks |
| Operational data | Queue (`apps/queue-service`, Rust) | 4007 | Work distribution, leases, retries, dead letters |
| Operational data | Stream (`apps/stream-service`, Rust) | 4009 | Event log, consumer groups, retention |
| Operational data | OCS (`apps/ocs-service`, Rust) | 4010 | Bucket/object storage, multipart, presign, quotas |
| Operational data | LDS (`apps/lds-service`, Rust) | 4004 | NGSI-LD datasources, projection, licensed exports |
| Operational data | Notifications (`apps/notifications-service`, Rust) | 4011 | Outbox, templates, preferences, delivery |
| Analytical | ETL (Warehouse module, `apps/warehouse-service`) | 4012 | Sources, transforms, checkpoints, destination commits |
| Analytical | Warehouse (`apps/warehouse-service`, Rust) | 4012 | Tenant DuckDB datasets, sandboxed SQL, query execution |
| Analytical | Lakehouse (`apps/lakehouse-service`, Python/PyIceberg) | 4013 | Iceberg catalog, Parquet tables, snapshots, schema evolution |
| AI | AI (`apps/ai-service`, Rust) | 4003 | Guidance-only API docs assistant |
| AI | Inference (`apps/inference-service`, Python) | 4008 | LLM proxy, embeddings, decision routing |
| Infrastructure | Postgres 16 + pgvector/PostGIS | 5432 | Source of truth for IAM/Workflow/Base/LDS/Notifications/Lakehouse catalog |
| Infrastructure | Valkey 8 | 6379 | Faststore, Queue, Stream |
| Infrastructure | SeaweedFS or S3 | 9090 | OCS bytes and Lakehouse data files |
| Infrastructure | Prometheus | 9091 | Metrics and alerts |

## Runtime ownership

The shipping image is authoritative. TypeScript sources for services with Rust
binaries are behavioural references and are not production verification.

| Runtime | Services |
|---|---|
| Rust/Axum | Gateway, Base, Faststore, Queue, Stream, OCS, LDS, Notifications, Warehouse, AI |
| Node/TypeScript | IAM, Workflow; Console (React/Vite) |
| Python | Inference (FastAPI), Lakehouse (FastAPI + PyIceberg) |

`make test` runs the Node/TypeScript suites. `make test-rust` runs the shipping
Rust binaries. Warehouse links the pinned official DuckDB shared library in its
image and CI; the bundled feature remains available for offline builds. The
Rust SDK is in `sdks/sdk-rust`; the Go SDK in `sdks/sdk-go`. CI must run both; a
TypeScript-only pass does not certify a Rust service.

## Request path and trust boundary

```
Console / SDK / CLI
   │ Bearer JWT, refresh token at /v1/auth, or X-API-Key
   ▼
Gateway :8080 ── routes.yaml
   │ verify JWT locally (IAM_JWT_SECRET) / API key via IAM
   │ enforce route scopes (service:read|write|*)
   │ delete client x-synapseone-*; stamp verified org/account/user/kind/roles
   ▼
internal services ── require x-synapseone-internal when configured
   │ derive tenant from stamped principal; org > account > user
   ▼
Postgres · Valkey · S3-compatible storage · relays
```

- Production exposes only the gateway (plus the TLS edge and explicitly public
  routes: `/v1/auth/*`, LDS public reads, `/webhook/*`).
- Internal services reject direct traffic when `SYNAPSEONE_INTERNAL_SECRET` is
  set; production boot fails without it.
- A tenant identifier in a request body never widens the caller's scope.
- Cross-tenant reads return `404`/`403`; existence is not leaked.

## Data flows

**Document write + change propagation**

```
Base document mutation ── same Postgres transaction ──▶ outbox row
outbox relay ── at-least-once, backoff, quarantine ──▶ Stream `base-changes`
Stream consumer group ──▶ Warehouse stream ETL (replace/delete by document_id)
```

The relay retries transient failures with exponential backoff, quarantines
permanent payload errors or exhausted attempts, exposes tenant dead letters at
`GET /v1/base/outbox`, and lets operators replay via
`POST /internal/base/outbox/:id/replay`. Delivery is at-least-once with
best-effort ordering; consumers dedupe by event id.

**Batch and analytical flows**

```
Base collection ── trusted internal API ──▶ Warehouse ETL (replace/append)
Warehouse dataset ── read-only SQL ──▶ Warehouse dataset (batch ETL)
Iceberg table ── trusted Lakehouse scan ──▶ Warehouse materialization
```

Warehouse tenant SQL is sandboxed: one read-only statement, external file and
network access disabled, configuration locked, only the tenant's datasets
addressable. Lakehouse files are never exposed to tenant SQL; Warehouse scans
them through the Lakehouse service and inserts authorized rows.

**Lakehouse commit path**

```
append API ──▶ validate tenant namespace + quota ──▶ PyArrow rows
          ──▶ PyIceberg writes Parquet + manifests to S3
          ──▶ SQL catalog commit (Postgres)
          ──▶ snapshot visible (idempotency key recorded in snapshot summary)
```

A committed snapshot is queryable immediately and survives service restarts.
Catalog drops remove metadata but retain data files; snapshot expiry/orphan
cleanup is an explicit operator action.

## Queue versus Stream

- Queue: work distribution, visibility leases, ack/nack, retry, DLQ, replay.
- Stream: event transport, consumer groups, retention, ordered reads within a
  topic/partition boundary.
- Do not use Queue as an event-history store or Stream as a transactional task
  scheduler. Delivery is at-least-once in both; consumers are idempotent.

## Tenant and storage ownership

- Organization is the primary boundary; account is a subordinate scope.
- Base/LDS/Notifications/Workflow store rows with tenant columns in Postgres and
  filter every operation by caller scope.
- Warehouse keeps one DuckDB file per tenant under `WAREHOUSE_DATA_DIR`.
- Lakehouse maps each tenant to a SHA-256-derived physical namespace; clients
  cannot select an object-store location. Catalog metadata is in Postgres, data
  files under the service-owned S3 prefix.
- OCS resolves bucket names inside the caller's tenant and prefixes object keys
  per tenant; presigned URLs carry a signed tenant/bucket/key payload.
- Faststore/Queue/Stream namespace Valkey keys by tenant.

## SynapseSearch

Base Search (`/v1/search`) is the only product search API: PostgreSQL full-text
+ pgvector, full-text/semantic/hybrid modes, collection/metadata filters,
facets, cursor pagination, ACL rechecks, reindex and status. There is no second
search engine. The 50k-row scan window is an explicit bounded-query limit, not
Elasticsearch compatibility.

## Analytical limits

- Iceberg v2, unpartitioned append-only tables with additive schema evolution.
- Lakehouse reads are bounded (max 5000 rows per scan); Warehouse materializes
  that bounded result.
- Warehouse query timeout, result cap and tenant dataset isolation are enforced;
  no arbitrary external paths or extensions.
- No Spark/Hadoop/Kafka cluster is required or shipped.

## Failure and recovery

- IAM/Workflow/Base/LDS/Notifications/Lakehouse catalog: Postgres migrations at
  startup under per-service advisory locks/journals; back up before upgrades.
- Base outbox: durable rows + retry/quarantine; Warehouse stream ingestion
  records `_ingest_events` before ack.
- Queue/Stream: Valkey persistence; at-least-once; leases/consumer groups recover
  after restart.
- Lakehouse: catalog commits are atomic; idempotency keys suppress duplicate
  appends; data files persist independently of the service.
- Backups: `pg-backup` (pg_dump custom format + sha256) and `s3-backup`
  (content-addressed snapshots + restore); restore drill is documented in
  `docs/production.md`.


## Reference basis for supported guarantees

These official references were reviewed for the current release. They are
behavioural guidance, not claims that SynapseOne implements the full upstream
feature set.

- AWS IAM policy evaluation: identity/resource policies are unioned; explicit
  deny overrides allow; permissions boundaries/SCPs intersect. SynapseOne keeps
  explicit-deny precedence, default deny, credential scope ceilings and
  org/account constraints.
- Redis `XREADGROUP`/`XAUTOCLAIM`: pending entries are reclaimed only after the
  configured idle time; claiming resets idle time and can increment delivery
  attempts. SynapseOne uses this for `claimIdleMs` recovery and keeps ack after
  destination commit.
- Amazon SQS visibility timeout/dead-letter guidance: leases are bounded,
  retries are capped and poison work is quarantined for inspection/redrive.
  SynapseOne does not promise FIFO exactly-once delivery.
- Apache Iceberg maintenance: snapshot expiry, orphan removal and manifest
  rewriting are separate destructive operations. SynapseOne keeps physical
  cleanup disabled and exposes a non-destructive maintenance report.
- DuckDB concurrency: one read-write process owns a native database file; writer
  conflicts are optimistic. SynapseOne keeps one Warehouse DuckDB owner and a
  tenant-scoped sandbox rather than multi-process writes.
- OWASP API Security API1/API5: every object and function needs server-side
  authorization, not merely a hidden UI control. SynapseOne enforces tenant,
  account, scope and platform-role checks in the owning service.
