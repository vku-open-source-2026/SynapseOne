# Resource capability matrix

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->

Canonical operation coverage for the shipping runtime. Status vocabulary:
**verified** (source + tests), **implemented** (source, representative tests),
**bounded** (supported with an explicit limit), **N/A** (the operation does not
fit the resource), **unsupported** (intentionally rejected).

Unless a row says otherwise, “verified” means representative unit/contract tests
on the in-memory backend (and, for unchanged flows, the prior isolated PostgreSQL/
Valkey QA evidence). New PostgreSQL branches use the same Drizzle statements and
were type-checked but not re-run against a live database in this session.

The public contract is `docs/api.md` + the gateway table
(`apps/gateway/routes.yaml`). The Console try-it catalog has 275 entries and is
gated by `node tools/catalog-check.mjs`. Health, metrics, `/internal/*` and SCIM
routes are intentionally outside that catalog.

## IAM (`iam-service`, Node)

| Resource | Operations | Status / notes |
|---|---|---|
| Organization | list, get (platform), create, update display name, suspend/reactivate, usage, audit, resources | verified; hard delete unsupported (BF-22 retention) |
| Account | list, get, create, update display name, retire, reactivate | verified; hard delete unsupported |
| User | list, get, invite, update display name, assign/unassign role, disable/enable, unlock, reset MFA, revoke sessions | verified; global identity delete unsupported |
| Role | list (account-scoped), create, update description, delete, attach/detach policy, assign/unassign | verified; dependency protection on delete |
| Policy | list, create (custom/managed), update description/document, delete | verified; document validated on every write |
| API key | create, list, get by id, rotate, revoke, verify | verified; secret is returned only at create/rotate |
| Service account | create, list, get by id, mint token, grant/revoke role, revoke | verified; tokens are account-bound |
| Session | list, revoke one, revoke all, refresh rotation | verified |
| MFA | status, TOTP setup/enable, recovery codes, disable, admin reset | verified |
| SCIM | users/groups/tokens | implemented; not claimed as full SCIM 2.0 compliance |
| Platform admin | list, grant/revoke, last-owner guard | verified; step-up for sensitive mutations |
| Audit / usage | list, filter, export, ingest (internal) | verified; tenant-scoped |
| Execution grant | issue/verify/revoke (internal) | verified; rejected when org/account/user state is invalid |

## SynapseBase (`base-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Database | list, get, create, update, delete (cascade required), stats | verified |
| Collection | list, get, create, update mapping, delete, stats | verified; delete emits document tombstones |
| Document | create, get, list, replace, patch, delete, upsert, increment, batch | verified; version/If-Match conflicts return 409 |
| Query | equality, ne, in/nin, gt/gte/lt/lte, exists, contains, startsWith/endsWith, text, near/within, and/or/not | verified; bounded limit and cursor |
| Change feed / outbox | list changes, cursor, event identity, internal replay | bounded; replay is internal/authorized |
| Graph | node/edge upsert, node get/delete, query, stats | implemented; no independent graph database |
| Geo | feature upsert/list/delete, near, within, stats | implemented; not full GIS |
| Vector | vector field search, top-k, filters, scores | implemented; dimensions declared in mapping |
| SynapseSearch | full-text, semantic, hybrid, filters (`status`/`type`), facets, reindex, status | bounded (50k candidate scan; metrics disclose bounds) |

## Faststore (`faststore-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Key/value | get, set, delete, TTL, expire, incr, batch, bounded scan | verified |
| Hash | get/list, set field, delete field/hash, length, incr | verified |
| List | range, push, pop, trim, length, delete | verified |
| Set | list, add, remove, contains, cardinality, delete | verified |
| Sorted set | range, add, incr, remove, score, rank, cardinality, delete | verified |
| Lock | acquire, extend, release (owner token) | verified; foreign release rejected |

## SynapseQueue (`queue-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Queue | list, get, create/update, delete, purge, stats | verified; implicit provisioning is preserved |
| Message | publish, batch publish, delay, dedupe, consume, heartbeat, ack, nack | verified; at-least-once |
| Dead letter | list, replay, delete | verified; list returns full payloads, so a separate GET-by-id is N/A |
| Lease | visibility timeout, attempt cap, stale receipt rejection | verified |

## SynapseStream (`stream-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Topic | list, get, create/update, delete, stats, retention | verified |
| Event | publish, batch publish, read, range, immutable history | verified |
| Consumer group | create/update, delete, read, ack | verified |
| Reclaim | `claimIdleMs` + XAUTOCLAIM | implemented; the memory engine is unit-verified for `410 retention_gap`, the Redis path checks `XAUTOCLAIM` deleted ids (no Valkey integration rerun this session) |
| Lag/pending | stats expose group count/pending/last id | bounded; per-consumer lag is derived |

## SynapseOCS (`ocs-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Bucket | list, get/head, create, stats, delete (force for non-empty) | verified; default bucket protected |
| Object | put, get, head, list (prefix/delimiter/cursor), copy, delete | verified; tenant-prefixed |
| Multipart | initiate, upload part, complete, abort | verified; abandoned upload cleanup is operator-driven |
| Presign | create, signed GET/PUT/DELETE/HEAD | verified; tenant/bucket/key/method/expiry bound |
| Lakehouse safety | ordinary OCS keys live under the tenant prefix; Iceberg lives under `lakehouse/` | structural separation verified |

## SynapseLDS (`lds-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Datasource | list, get, create, update, delete, stats | verified |
| Attributes | get, replace | verified |
| Entity | ingest (upsert), list, get, projection, visibility | verified; entity hard delete unsupported |
| License | list | implemented; license catalog is read-only |
| Public surface | anonymous GET/HEAD for public entities only | verified; management routes stay authenticated |

## SynapseNotifications (`notifications-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Notification | enqueue, get, list (status/limit), cancel, retry failed/dead, attempts | verified; retry resets the attempt budget |
| Preferences | get, set channels, unsubscribe | verified |
| Delivery | queue or local outbox, exponential backoff, DLQ/dead | verified; at-least-once |
| Templates | None | **unsupported by design** — `{{var}}` inline rendering only; stored templates belong to Tier 2 |

## Synapse Warehouse (`warehouse-service`, Rust)

| Resource | Operations | Status / notes |
|---|---|---|
| Dataset | list (name/mode/page), get, create, update name/description, delete, schema, preview rows | verified |
| Rows | append 1..5000 validated rows | verified |
| SQL | read-only SELECT/WITH/DESCRIBE/EXPLAIN, bounded rows/timeout, sandboxed | verified; no host file/network access |
| ETL job | list (status/mode/target/name/page), get, create, rename (non-stream or paused stream), run, pause, resume, delete | verified; a running stream worker rejects rename |
| Path A | Base snapshot → Warehouse | verified |
| Path B | Base snapshot + outbox → Stream → Iceberg change log | verified; commit-bound backfill documented |
| Path C | Lakehouse snapshot/table → Warehouse | verified |
| OCS import | preview + CSV/JSONL/Parquet import, replace/append | verified; bounded readers |
| Reports/dashboards | None | **unsupported** — speculative Rust SDK methods were removed; no BI subsystem |

## Lakehouse (`lakehouse-service`, Python)

| Resource | Operations | Status / notes |
|---|---|---|
| Namespace | list, create, delete | verified; no metadata update |
| Table | list, get, create, drop (retains files), schema, append, query | verified; Iceberg v2 |
| Snapshot | list, historical query by `snapshotId`, maintenance report | verified; snapshots are immutable |
| Concurrency | PostgreSQL session advisory lock, fail-closed readiness | verified; one active writer; 409 commit conflicts are catalog-level |
| Quota | current-snapshot bytes vs limit | bounded; historical/orphan bytes excluded and labelled as such |

## Workflow (`workflow-service`, Node)

| Resource | Operations | Status / notes |
|---|---|---|
| Workflow | list, get, create, replace (PUT), delete, activate/deactivate, validate, execute | verified; delete blocked by active executions; revisions pinned to executions |
| Trigger | manual, webhook, cron, template, MCP | verified through existing workflow contract |
| Execution | list/filter, get, node results, cancel, human resume | verified; terminal states immutable |
| Human task | create, list/filter, get, claim, complete, reject, expire | verified; concurrent decision returns 409 |
| Credential | list, get metadata, create, rotate, delete | verified; plaintext never returned |
| Secret | list, read (authorized), rotate, revoke, delete | verified |
| Runner | register, get, list, update, rotate key, heartbeat, enable/disable, drain, delete | verified; delete guarded while work would strand; migration `0015` backfills audience |
| Recovery | resume reclaimer, stale lease reclaim, duplicate-safe resume | verified |

## AI and Inference

| Resource | Operations | Status / notes |
|---|---|---|
| AI guidance | agent query, health | verified; guidance-only, no data mutation |
| Inference | chat, embeddings, decision, usage | verified against synthetic providers; queued inference jobs via Workflow |
| Provider status | health/readiness | verified; no secrets exposed; no real provider in QA |

## Interfaces

| Surface | Coverage |
|---|---|
| Tenant Console | 45 routes; all resource pages listed in `apps/console/src/App.jsx`; account/org/user rename, SA role management, notification retry/preferences and warehouse rename wired |
| Super Admin | overview, orgs, accounts, users, admins, audit, usage, health, runner fleet |
| JS / Python / Go / Rust SDKs | All four cover IAM, Workflow, LDS, Base/Search, Faststore, Queue, Stream, OCS, Notifications, Warehouse, Lakehouse, AI, Inference and health. Convenience-method differences are documented in `docs/sdk-parity.md`; the generic request method covers unwrapped endpoints. |
| CLI | 45 top-level commands, including `orgs/accounts/users update`, `keys get`, `service-accounts get`, `notifications retry`, `warehouse dataset|job update`, `etl-base`, `etl-lakehouse` |

## Explicit limitations

- Hard organization/account/user deletion is not supported.
- Notifications delivers through configured providers; no real provider is required for local outbox/template tests.
- Warehouse has no reports/dashboards/BI subsystem.
- OCS supports CSV/JSONL/Parquet structured ingestion only.
- Stream retention gaps are reported as errors; recovery requires rebuild/reset.
- Workflow node retries cannot guarantee exactly-once external side effects.
- Gateway session cache delays lifecycle revocation by up to 2 s; policy edits by up to 30 s (`GATEWAY_SESSION_CACHE_MS`, `AUTHZ_CACHE_TTL_MS`).
- Physical Iceberg maintenance (snapshot expiry/orphan cleanup) remains disabled.
