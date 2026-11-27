# Production readiness — current release candidate

Baseline HEAD: `3364c32`; the working tree contains the uncommitted hardening
and analytical-platform work. Nothing has been committed, deployed to
production, or migrated against a live database.

**Verdict:** implementation, compile, unit/contract and isolated integration
verification are green for the capabilities below. This is **not** a claim that
the live production stack already runs this code. Production deployment,
SSO/DNS/TLS changes, provider secrets and cross-browser certification remain
operator gates. Shipping Rust suites total **268 passed** (including the new
stream retention-gap regression); Node/TypeScript suites **964 pass entries
across 15 workspaces**; IAM **195/195**; Python SDK **49**, inference
**18 + 1 skipped**, Lakehouse **4**, Console client **74/74**; Rust SDK
**8 + doc test**. The Node total includes the TypeScript reference suites for
the ten Rust-shipped services; per ADR 0003 those are contract-oracle evidence,
not a second shipping runtime — the Rust suites are the shipping evidence.
Operation-level coverage lives in [capability-matrix.md](capability-matrix.md).

## Verification matrix

| Area | Implemented | Verified | Remaining risk |
|---|---|---|---|
| Gateway | Rust proxy, JWT/API-key auth, route scopes, stripped/re-stamped principals, edge limits, usage telemetry, readiness | Rust **47/47**; live QA: anonymous denied, spoofed tenant ignored, cross-tenant hidden, direct Base/Lakehouse/Warehouse access rejected; live API-key `base:read` read `200` / write `403`; legacy `base:Read` casing normalized | Production still exposes only the gateway; edge rate limiting must also exist at the TLS edge |
| IAM | Password lifecycle, TOTP/recovery, sessions, rotating refresh with consumed-token replay detection, API keys, service accounts, roles/policies, audit, platform owners, account retirement, mutable display metadata | Node **195/195**; PostgreSQL platform-owner concurrency **1/1**; live PostgreSQL refresh replay + explicit-revoke isolation | Legacy MFA seals need the old-key fallback; `AUDIT_RETENTION_DAYS` now deletes old rows (back up first) |
| Workflow | Queue-backed DAGs, triggers, executions, cancellation, human-task checkpoints, resume reconciliation, runner audience, credentials | Node **296/296**; live QA human-task pause/claim/complete/resume and queued cancellation | Self-hosted runner fleet and mixed-version rolling deploy not played end-to-end; legacy unbound pauses fail closed |
| Base | Document DB, mappings, queries, counters, change feed, search index, transactional outbox with backoff/quarantine/replay, collection-delete tombstones | Rust **53/53**; PostgreSQL lifecycle/outbox **2/2**; live outbox→Stream→Warehouse and dead-letter replay | Best-effort outbox ordering; consumers must dedupe by event id |
| Queue | Delayed/deduped publish, leases, ack/nack, dead letters, replay | Rust **30/30**; live QA dedupe, retry, dead-letter, replay, ack | Dedupe is bounded by message retention, not permanent |
| Stream | Topics, consumer groups, acks, pending reclaim, blocking reads, range replay, caps | Rust **12/12**; live Base-change and Warehouse consumer pipeline; live Valkey reclaim of an unacked batch after `claimIdleMs`; trimmed pending entries now return `410 retention_gap` | At-least-once; ordering is per topic stream, not global; a retention gap requires operator rebuild/reset |
| OCS | Buckets/objects, multipart, presign, quotas, tenant prefixes | Rust **23/23**; live QA upload/download/HEAD/list/presign/cross-tenant denial; S3 backup restore | Object backup is on-host; copy snapshots off-host |
| LDS | NGSI-LD datasources, default-deny registry, structural projection, licenses, migration journal | Rust **12/12**; live QA public/restricted projection, internal hiding, cross-tenant 404 | License catalogue is built-in; custom licenses require an operator URL |
| Notifications | Durable outbox, inline `{{var}}` rendering, reusable versioned templates, preferences, unsubscribe, manual retry of failed/dead deliveries, queue delivery, SSRF guard | Rust **16/16**; live QA idempotent enqueue, preferences, unsubscribe, cross-tenant denial | No real provider configured in QA; webhook delivery was not sent to a live external endpoint |
| Warehouse | Tenant DuckDB datasets, sandboxed read-only SQL, batch/stream ETL, Base/Lakehouse/OCS file connectors, Base→Lakehouse change-log stream worker, current-state high-water mark, atomic snapshot replace, cancellation/pause | Rust **40/40**; live QA SQL sandbox denials, Base snapshot, stream upsert/delete, Lakehouse materialization, Base→Lakehouse append with ACK-after-commit, restart persistence, 1005-document paged backfill + incremental update; failed snapshot preserves the previous dataset; CSV/JSONL/Parquet structured OCS import previews schema and replaces/appends transactionally | DuckDB is a query engine, not the Lakehouse catalog; one writer per tenant; Path B commit-bound backfill throughput |
| ETL | Base snapshot, Base-outbox→Stream incremental, batch SQL, OCS CSV/JSONL/Parquet import, Lakehouse materialization, Base→Lakehouse change log, checkpoints/markers | Live QA Path A batch 3 rows with update/delete/restart catch-up; Path B 3-doc replay and 1005-doc paged backfill (2 pages, 1005 change rows) plus incremental update; duplicate delivery suppressed; OCS preview/replace/append; cross-tenant `404` | Path B backfill is commit-bound (~2–3 rows/s in QA); OCS formats are limited to CSV/JSONL/Parquet |
| Lakehouse | Real Iceberg v2 + Parquet on S3, SQL catalog, tenant namespaces, snapshots/time travel, additive schema evolution, idempotent append, enforced byte quota, single-writer lock, maintenance report, Console/SDK/CLI | PyIceberg **4/4**; live QA real Parquet + 5 metadata + 6 manifests, current/historical scans, schema evolution, restart persistence, cross-tenant `404`, drop retains files, append over byte quota `409 quota_exceeded`, second replica fails startup on the advisory lock, maintenance report is non-destructive | Single-writer topology is intentional; physical snapshot expiry/orphan cleanup is disabled (report-only); crash between Parquet write and catalog commit can leave orphans |
| Search | Base full-text/semantic/hybrid, filters, facets, reindex, status, ACL | Base Rust **53/53** (includes search); live QA relevance, reindex, status, cross-tenant exclusion | 50k-row scan window is a documented bound; no Elasticsearch protocol compatibility |
| Console | All tenant pages, Search, Warehouse, Lakehouse, Base outbox, Notifications, workflow cancel/approvals, Super Admin pages, bilingual Docs for every service with four SDK language panels | Build + **77/77** client tests + SSR smoke; all **22 Docs tabs** render in both `en` and `vi`; Chromium-only automation from the prior pass | No Firefox/WebKit certification |
| SDK/CLI | JS, Python, Go, Rust SDK `0.10.2`; zero-dependency CLI incl. Lakehouse and Warehouse dataset/job updates | JS **74/74**, Python **58 passed**, Go **51 package tests + vet**, Rust **20 + doc test**, clean npm/Python/Cargo package builds; CLI live login/search/Lakehouse query from the prior pass | Tagged npm/PyPI/crates.io/Go proxy publication must be verified after Actions runners are available; see `docs/sdk-0.10.2.md` |
| Migrations | IAM `0013`/`0014`, Workflow `0014`/`0015`, Base outbox `0010`, LDS journal | Upgrade rehearsed from prior journals: IAM `0012→0013` added `consumed_at`; Workflow `0013→0015` added pause columns and now backfills existing runners to `audience='org'`; Base `0009→0010` added outbox retry/quarantine columns. IAM `0014` was applied fresh in QA and verified `accounts.status/retired_*` with 15 journal rows. | No production rehearsal; migrations are additive; back up before rollout |
| Backup/restore | `pg-backup --once`, `s3-backup once/restore`, restore scripts; BF-20 inventory covers Postgres, S3/catalog, Warehouse DuckDB and Valkey AOF | QA PG dump 31 KiB + SHA256/status; restored into a separate database and read 2 Iceberg tables (6 rows each) plus a historical snapshot; S3 snapshot 50 objects/176,960 bytes; Warehouse restart did not duplicate already-appended change rows | Warehouse/Valkey backup automation is not shipped; off-host copy and production drill remain operator actions |
| Release gates | Version/catalog/migration/license checks plus shared SDK tag/version gate | `make build` and all Node suites green; catalog **289** endpoints in sync; version **0.9.0**; SDKs **0.10.2**; no copyleft; compose base+prod config valid | Warehouse image pins official DuckDB 2.0.0 shared libs; verify image digests at release |

## Isolated QA closure evidence

All checks ran in the disposable `s1qa-closure` Compose project with synthetic
credentials; production containers, data, `.env`, DNS/TLS and OIDC were not
touched.

- **Path B:** Base collection with 3 documents → 3 change rows; update + delete
  produced 5 rows; a replayed backfill produced no duplicate idempotency keys;
  stopping Warehouse, changing Base, and starting Warehouse caught up to 6 rows.
- **Materialization:** the change-log Iceberg table was materialized into a
  Warehouse dataset and queried with analytical SQL; delete rows were present.
- **Boundaries:** a second tenant received `404` for the table and a rejected
  ETL job; the over-quota append returned `409 quota_exceeded`.
- **Single writer:** `docker compose run` of a second Lakehouse replica exited
  with the advisory-lock startup error while the first stayed healthy.
- **Restart/replay:** restarting Warehouse did not re-append rows already
  acknowledged, and historical Iceberg snapshots remained queryable.
- **Migrate:** IAM, Workflow and Base upgrade rehearsals above; all legacy rows
  survived and only additive columns/indexes appeared.
- **Restore:** PG restore into `qa_lh_restore` and S3 snapshot both readable;
  PyIceberg scanned current and historical snapshots from the restored catalog.
- **Platform:** 9 Super Admin routes rendered; suspend/reactivate blocked and
  restored tenant login and wrote audit entries.
- **Stream recovery:** a live Valkey consumer read an event without acking;
  an immediate second read did not steal it, and after `claimIdleMs` the batch
  was reclaimed and then acknowledged exactly once.
- **Workflow suspension:** inline webhook `200` → org suspended → `403
  org_suspended` → reactivated → `200`, with the five-second status cache
  respected.
- **Bulk Path B:** 1005 Base documents backfilled in 2 cursor pages, appended
  as 1005 Iceberg rows, then a source update appeared as an incremental
  `update` row.
- **Account retirement:** organization admin retired one account; its API key
  and service-account token were rejected, a sibling account stayed usable,
  and reactivation did not restore revoked credentials.
- **Structured OCS:** browser previewed a CSV object and created an OCS→dataset
  ETL job; rows were queried from Warehouse.
- **Console UI:** Chromium completed account retire/reactivate, notification
  queue, OCS ETL preview/create and human-task approval with zero console errors.

## Release blockers

1. Deploy from one commit to staging/production; the live stack predates this
   tree. Back up Postgres and object storage first.
2. Configure production OIDC issuer/client, DNS/TLS and gateway CORS.
3. Run the migration guide against a staging copy and verify a rollback window.
4. Rehearse backup/restore with an off-host copy; restore into a separate host.
5. Decide the Lakehouse retention/GC policy. Byte quotas are enforced and
   single-writer startup is guarded, but physical snapshot expiry/orphan cleanup
   is intentionally disabled; the maintenance endpoint only reports candidates.
   External lifecycle policy is an operator decision.
6. Validate the notification provider relays and one real (synthetic) delivery.
7. Validate the self-hosted runner fleet in queue mode and a mixed-version
   rolling deploy.
8. Migrate production Redis to Valkey 8 or record an explicit licence exception.
9. Certify Firefox/WebKit if the Console must support them; current evidence is
   Chromium.

## Operator prerequisites

- `SYNAPSEONE_INTERNAL_SECRET`, `IAM_JWT_SECRET`, `IAM_MFA_ENCRYPTION_KEY`,
  `SYNAPSEONE_CREDENTIAL_KEY`, `PLATFORM_BOOTSTRAP_SECRET`.
- `STORAGE_S3_*` for OCS *and* Lakehouse; the Lakehouse service uses only
  service-owned credentials.
- `LAKEHOUSE_CATALOG_URI` (Postgres) and `LAKEHOUSE_WAREHOUSE`
  (`s3://bucket/prefix`), plus `LAKEHOUSE_S3_*`.
- A clean `pg-backup` and `s3-backup` before any migration or rollout.

See `docs/migration-0.9.0-hardening.md` for migration order, compatibility and
rollback; `docs/production.md` for the full operational checklist.
