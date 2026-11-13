# OLTP → OLAP Data Platform — Master Plan

Status: **IMPLEMENTED, VERIFIED IN ISOLATED + PRODUCTION CANARY**
Owner: SynapseOne Tier-1
Baseline commit: `38a87d2`
Last updated: 2026-11-13

This document is the authoritative execution checklist. It is updated as evidence
is produced. It does not replace the API reference; the source code remains the
final truth.

## A. Existing Architecture (verified from source)

| Layer | Implementation |
|---|---|
| OLTP | PostgreSQL 16 + SynapseBase (`apps/base-service`) |
| Documents | `synapseone_base_documents` (JSONB, `version`, timestamps) |
| Collections | `synapseone_base_collections` (org/account scoped) |
| Change API | `GET /v1/base/collections/:name/changes` (upserts only today) |
| Stream | SynapseStream (`apps/stream-service`, Valkey Streams or memory) |
| Queue | SynapseQueue (`apps/queue-service`) — not the analytical path |
| OLAP | Synapse Warehouse (`apps/warehouse-service`), DuckDB file per tenant |
| Warehouse API | datasets, rows, read-only SQL, batch/stream ETL jobs |
| Usage telemetry | Gateway → IAM `usage_events` in PostgreSQL |
| Usage rollups | IAM `usage-rollup.ts` → Warehouse `_usage_hourly*` |
| Auth | Gateway JWT/API-key + tenant headers; internal secret for direct calls |
| Console | React Console, Warehouse page (uncommitted work) |

Production baseline: IAM/Gateway/Console `0.9.2-auth`; Warehouse `0.9.0`.
Warehouse data lives on the `synapseone_warehouse_data` volume.

External Google Docs/Sheets were not accessible from this environment. Nothing
from them is asserted as fact; this plan is based on repository source and
runtime behavior.

## B. Target Architecture

```
SynapseBase PostgreSQL
  document mutation ──► transactional outbox row (same DB transaction)
                              │
                              ▼
                    Base outbox relay (at-least-once)
                              │ event_id = outbox id
                              ▼
                        SynapseStream topic
                              │
                              ▼
                 Warehouse stream worker
             durable _ingest_events dedup marker
                              │
                              ▼
                     DuckDB dataset tables
                              │
                              ▼
                  read-only Analytics API / SDK
```

Usage analytics follows an equivalent but pre-aggregated path:

```
Gateway usage events → IAM PostgreSQL usage_events
  → hourly rollup (idempotent window replace)
  → Warehouse _usage_hourly / _usage_hourly_user
  → IAM merges warehouse history + raw tail for exact dashboard totals
```

Guarantees:

- At-least-once delivery.
- Exactly-once observable effects through durable event-id deduplication.
- Updates ordered by document version; stale events are ignored.
- Deletes are tombstones, not silently lost.
- Every stream ack happens only after the DuckDB transaction committed.

## C. Feature Gap Matrix

| # | Capability | Current status | Gap / action | Files |
|---|---|---|---|---|
| 1 | Base CRUD | Implemented, tested | Verify tenant + optimistic version | `apps/base-service/src/{index,store}.ts` |
| 2 | Base atomic batch | Partial | Batch loops per-op and exposes per-op errors; no all-or-nothing transaction | `index.ts` batch route |
| 3 | Base outbox | **Missing** | Add outbox table + same-transaction write on create/update/delete/batch | `schema.ts`, `store.ts`, migration |
| 4 | Base deletes in change feed | **Missing** | Tombstone rows from outbox; feed reads outbox | `index.ts` |
| 5 | Outbox relay to Stream | **Missing** | Relay unpublished rows, mark published; retry/DLQ counters | new `outbox.ts` |
| 6 | Warehouse dataset lifecycle | Implemented | Verify delete/persistence | `duck.ts` |
| 7 | Read-only SQL safety | Implemented but needs adversarial review | Add tests for DuckDB-specific escapes | `sql.ts` |
| 8 | Durable stream dedup | **Missing** | Durable `_ingest_events(event_id)` inserted in same DuckDB transaction | `duck.ts`, `index.ts` |
| 9 | Stream crash recovery | Partial | Ack after write exists; add crash/redelivery test | `index.ts` tests |
| 10 | Consumer checkpoints | Delegated to Stream group | Verify durable group state and restart | stream tests |
| 11 | Update ordering | **Missing** | Compare document version in projection; skip stale | `duck.ts` |
| 12 | Delete tombstones | **Missing** | Stream event `delete` writes tombstone/current-state delete | `duck.ts` |
| 13 | Historical backfill | **Missing** | Base snapshot endpoint + warehouse backfill job | Base + Warehouse |
| 14 | Usage analytics flow | Implemented uncommitted | Verify exact totals, idempotent windows, restart | IAM/warehouse files |
| 15 | Base change analytics flow | **Missing** | Outbox → Stream → dataset | Base/Warehouse |
| 16 | Analytics API | Implemented | Add pipeline status/freshness | Warehouse |
| 17 | SDK | Warehouse methods exist? | Verify JS/Python/Go contracts; add only missing calls | `sdks/*` |
| 18 | Metrics/observability | Partial | Add counters/freshness/status endpoint | Warehouse |
| 19 | Backup/restore | Infra backup exists | Verify warehouse volume backup and restore procedure | infra |
| 20 | Production deployment | Warehouse `0.9.0` | Deploy verified Warehouse/Base changes after CI | compose/source images |

## D. Work Breakdown

### WP-1 — Base transactional outbox and change feed

- **Objective:** Every committed document mutation produces exactly one durable
  outbox event; rolled-back mutations produce none.
- **Changes:** `base_outbox` table (`event_id` UUID, org/account, collection,
  document id, op, version, occurred_at, payload, published_at, attempts,
  last_error); write in the same transaction as document mutation.
- **APIs:** change feed switches to outbox; add `includeDeleted`/tombstones;
  internal backfill endpoint.
- **Security:** payload is an allowlisted projection, no secrets; tenant scope
  enforced by collection ownership.
- **Tests:** create/update/delete visibility, rollback emits nothing, tenant
  isolation, duplicate relay.
- **DoD:** outbox rows exactly match committed operations; test evidence.
- **Rollback:** additive table/migration; old change feed remains available.

### WP-2 — Outbox relay

- **Objective:** Publish unpublished outbox rows to a SynapseStream topic with
  at-least-once retry; mark published only after Stream accepted the event.
- **Changes:** relay loop in Base, deterministic event id, batch publish,
  exponential backoff, max attempts / DLQ marker.
- **Tests:** Stream 503 then recovery; duplicate publish is harmless.
- **Rollback:** disable relay via env; outbox rows remain.

### WP-3 — Warehouse idempotent materialization

- **Objective:** Redelivery cannot double-count; crash after insert before ack
  is safe.
- **Changes:** `_ingest_events` durable table; `applyStreamEvents` performs
  dedup check + dataset writes + marker insert in one DuckDB transaction.
  Add `version`/`op` projection semantics.
- **Tests:** insert, kill/restart worker, redeliver same event, exact count.
- **Rollback:** additive table; old API unchanged.

### WP-4 — Backfill

- **Objective:** Snapshot/backfill emits events idempotently and hands off to
  live ingestion.
- **Changes:** Base snapshot pagination endpoint with stable `(updated_at,id)`
  cursor; warehouse backfill job uses the same event envelope.
- **Tests:** interrupt/restart, no gaps/duplicates, tenant mismatch rejected.

### WP-5 — Flow A usage analytics

- **Objective:** Verify the uncommitted IAM/warehouse rollup path with exact
  source totals.
- **Tests:** 1,000+ events, duplicate-safe window replace, empty hours,
  restart, exact aggregation, cross-tenant isolation.

### WP-6 — Flow B Base changes

- **Objective:** Real Base create/update/delete → Stream → Warehouse dataset.
- **Tests:** at least 1,000 events, duplicates, out-of-order update, delete,
  backfill, restart, exact SQL aggregates.

### WP-7 — APIs, SDK, observability, release

- Add warehouse pipeline status/freshness metrics; verify SDK contracts.
- Run all workspace tests, Compose E2E, migrations, license/security.
- Commit, push, CI green; deploy only Warehouse + Base (+ IAM if usage rollup
  is included) with backups/rollback; production-safe canary.

## E. Risk Register

| Risk | Mitigation |
|---|---|
| Lost events | Outbox same transaction; relay retries; never delete unpublished |
| Duplicate effects | Durable event-id table; transaction around insert+marker |
| Out-of-order updates | `version` comparison; skip stale; tombstones for deletes |
| DuckDB concurrent writers | One process per tenant + per-tenant serialized queue; document single-writer |
| DuckDB corruption on crash | Commit before ack; test restart; backup volume |
| Cross-tenant leak | Per-tenant DB file + gateway headers; backend scope tests |
| SQL escape | Read-only parser + DuckDB setting/test adversarial corpus |
| Backfill double count | Same event-id dedup; snapshot cursor |
| Migration failure | Additive migrations; backup; migration test on clone |
| Worker restart loss | Stream pending entries remain unacked; worker resumes group |
| Performance | Batch inserts, bounded batches, latency measurement |

## F. Execution Order

1. WP-1 + WP-3 (correctness foundation).
2. WP-2 + WP-6 (real flow).
3. WP-4 + WP-5.
4. WP-7 (API/SDK/metrics, CI, release).

## G. Verification Strategy

- Unit tests per service.
- PostgreSQL isolated migration/outbox tests.
- Warehouse fake-Stream tests for duplicate/crash/ordering.
- Full 1,000-event numerical test with duplicates/interruption/restart.
- Cross-tenant API tests.
- SQL escape corpus.
- Compose E2E.
- Production canary only with a dedicated tenant; no customer data mutation.

## H. Release Strategy

- Clean worktree from `origin/main`; preserve unrelated CLI/Rust/warehouse UI
  work unless explicitly included.
- Additive migrations; pg_dump backup before deploy.
- Build exact image tags; rollback tags.
- Deploy Warehouse/Base only (IAM only if usage rollup requires it).
- Verify image digests, `/ready`, canary flow, and logs.
- Roll back on health/data-correctness failure.

## Progress Log

| Date | Work | Evidence |
|---|---|---|
| 2026-11-13 | Recon complete; plan written | source inspection, baseline `38a87d2` |
| 2026-11-13 | Base transactional outbox + tombstones | API tests, Postgres QA `create/update/delete`, rollback-safe duplicate |
| 2026-11-13 | Outbox → Stream relay | fake Stream test: publish once, second relay 0 |
| 2026-11-13 | Warehouse durable dedup + tombstones | 12/12 service tests; crash/replay marker |
| 2026-11-13 | SQL safety + timeout | literal-aware guard, DuckDB escape corpus, query timeout |
| 2026-11-13 | 1,000-event exact test | 1,000 unique rows, sum 500500, reopen, duplicate delivery, tenant isolation |
| 2026-11-13 | Flow B E2E | Base create/update/delete → outbox → Stream → DuckDB, duplicate + restart |
| 2026-11-13 | Flow A exactness | Production completed-hour warehouse 2,564 = Postgres 2,564 |
| 2026-11-13 | Production canary | platform tenant: 3 events, 3 rows, duplicate stayed 3; cleaned up |
| 2026-11-13 | Release | `96e902c` + `960947c`, images `0.9.2-data` |

## Deployed State

- Base/Warehouse/IAM/Gateway/Console: `0.9.2-data`.
- Warehouse volume backed up at `backups/pre-data-platform-20261113/warehouse-data.tgz`.
- Platform DB backup: `synapseone-pre-data.dump`.
- Migration `synapseone_base_outbox` applied.
- `/ready` includes warehouse (12/12).
- Production canary dataset/job/collection deleted after verification.

