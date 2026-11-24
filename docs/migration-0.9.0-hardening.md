# Migration and deployment notes — 0.9.0 hardening + analytical platform

**Do not execute this plan automatically.** It is the operator runbook for the
uncommitted work in this tree. No migration here has been applied to production.

## 1. Required migrations and bootstrap

### IAM service

- `apps/iam-service/drizzle/0013_shocking_shinobi_shaw.sql`
  - adds nullable `refresh_tokens.consumed_at`.
- `apps/iam-service/drizzle/0014_burly_silver_sable.sql`
  - adds `accounts.status` (`active|retired`), `retired_at`, `retired_by`,
    `retire_reason`. Retirement is additive; account resources are retained.

Rotation sets `revoked_at` and `consumed_at` atomically. A replayed consumed
token revokes the whole token family; a token revoked by logout/admin has
`consumed_at = NULL`, so its replay returns `401` without killing sibling
sessions. Tokens rotated before this migration have no `consumed_at` and are
treated as ordinary revoked tokens until they expire. Applied at startup under
`pg_advisory_lock(hashtext('synapseone_iam_migrations'))`.

### Workflow service

- `0014_yielding_thunderbird.sql` adds nullable `pause_task_id`, `pause_node`.
- `0015_first_callisto.sql` adds `audience` (`account|org`, default `account`)
  and backfills **all pre-existing runners** to `audience='org'` so an upgrade
  does not strand org-wide queued work. New runners opt into account scope
  explicitly when created from an account credential.

Applied at startup under `pg_advisory_lock(hashtext('synapseone_workflow_migrations'))`
using the direct Postgres connection. Journal timestamps are
1800000700000/1800000800000.

### Base service

- `apps/base-service/drizzle/0010_misty_pretty_boy.sql`
  - adds `next_attempt_at` (default now), `last_attempt_at`, `dead_lettered_at`;
  - adds the due-row index `idx_base_outbox_due`.
- Applied by the Rust bootstrap under `pg_advisory_lock(hashtext('synapseone_base_migrations'))`.
- The relay quarantines a permanent payload error immediately and a transient
  failure after `BASE_OUTBOX_MAX_ATTEMPTS`. Replay keeps the event id.

### LDS service

- The Rust LDS service creates `__drizzle_migrations_lds` and applies
  `drizzle/0000_absent_nemesis.sql` under an advisory lock if not recorded.
- The image includes `drizzle/` (Dockerfile updated).

### Lakehouse service (new)

- No Drizzle migration: PyIceberg creates its SQL catalog tables
  (`iceberg_tables`, `iceberg_namespace_properties`) on first use in the
  configured Postgres catalog.
- The service needs a service-owned S3 bucket/prefix and credentials; it never
  uses tenant credentials or accepts a client-supplied location.
- The Warehouse image now links the official DuckDB **2.0.0** shared library
  (pinned URL + SHA256 in `apps/warehouse-service/Dockerfile`) instead of
  compiling bundled DuckDB. The crate source is v2.0.0 and the ABI matches.

#### Base → Lakehouse change log (Path B)

`POST /v1/warehouse/etl/base-lakehouse` creates a durable Warehouse stream job
(`mode=stream`, `destination=lakehouse`) that consumes Base's change stream and
appends to an existing Iceberg table. The table must already contain:

`event_id, collection, document_id, operation, version, occurred_at, data, deleted`

`data` is a JSON string; the table stays append-only. The job first backfills
the current collection snapshot (when `backfill=true`), then follows increments.
It commits the Lakehouse append before ACKing the queue message, so a crash
replays rather than loses. Idempotency key:
`base:<collection_id>:<document_id>:<created_at>:<version>:<upsert|delete>` —
`create` and `update` at the same version share the upsert key; `delete` is a
separate tombstone; collection id and document creation time keep a
deleted/re-created incarnation from colliding.

The Lakehouse enforces one active writer with
`pg_try_advisory_lock('synapseone_lakehouse_single_writer')`; a second replica
fails startup until the old one is drained. Do not scale Lakehouse horizontally.
Byte quota is enforced from the current snapshot's `total-files-size` plus a
conservative incoming-JSON estimate; historical snapshots and orphans do not
count. Physical cleanup stays disabled; `GET .../maintenance` is report-only.

No migration should be applied to production without a tested backup and a
rollback plan.

## 2. Pre-deployment checks

1. Back up Postgres with `pg-backup --once`; verify the dump and `.sha256`.
2. Snapshot object storage with `s3-backup once`; verify the manifest. This
   covers OCS objects and **Lakehouse Parquet/metadata** because they share the
   bucket.
3. Ensure the DB role can create the migration journal, columns and indexes.
4. Count live refresh tokens if you need to bound pre-migration replay behavior;
   they expire normally.
5. Count existing paused executions and runners:
   - paused executions without `pause_task_id` are not resumable;
   - all pre-existing runners become `org` audience; new runners are account
     scoped unless an org admin creates an org runner.
6. Review stored IAM policies with a `Condition`; malformed conditions now fail
   closed.
7. Confirm `IAM_MFA_ENCRYPTION_KEY` is backed up. New MFA seals use it; legacy
   seals remain readable through the fallback.
8. Confirm `AUDIT_RETENTION_DAYS` is intentional; positive values delete older
   audit rows hourly.
9. Confirm `IAM_SENSITIVE_MUTATION_MODE=enforce`; IAM refuses to boot in
   production with `audit`/`off` because that would silently allow member
   privilege escalation.
10. Confirm `CORS_ORIGIN`, `SYNAPSEONE_INTERNAL_SECRET`,
   `SYNAPSEONE_CREDENTIAL_KEY`, and the Lakehouse/Base/Stream service URLs.
11. Confirm the Lakehouse bucket/prefix exists and the service credentials can
    read/write it. Do not point it at a tenant prefix.
12. Confirm `WORKFLOW_EXECUTION_MODE=queue` and at least one worker/runner is
    reachable before activating production workflows.

## 3. Deployment order

1. Apply/verify a fresh Postgres and object-store backup.
2. Deploy **IAM** (migrations 0013, 0014) with MFA key and retention reviewed.
3. Deploy **Base** (outbox migration 0010) and **Stream**; verify the outbox
   relay reaches `base-changes`.
4. Deploy **Warehouse** (pinned DuckDB 2.0.0 image) and **Lakehouse**; verify
   catalog readiness and one tiny authorized append/query. Keep exactly one
   Lakehouse replica running. If Path B is used, create the change-log table
   with the documented schema before creating the ETL job.
5. Deploy **Workflow** (migrations 0014/0015). Drain old replicas before starting
   new ones if the runner fleet is mixed-version.
6. Deploy **LDS**, **Queue**, **Faststore**, **OCS**, **Notifications** with the
   documented env.
7. Deploy **Gateway** and **Console**; keep all service ports internal.
8. Verify `/ready`, login, consumed-refresh replay (`401` + family revoke),
   explicit session revoke isolation, a paused workflow cancel/resume, a runner
   claim, an LDS public read, a Base→Warehouse snapshot, a Base→Stream→Warehouse
   update/delete, a Lakehouse append + historical snapshot query, and a backup
   status file.

## 4. Rollback notes

- Workflow/Base migrations are additive. Rolling back the image leaves columns
  and indexes in place; old code ignores them.
- Rolling back IAM leaves `refresh_tokens.consumed_at` and account lifecycle
  columns; older code ignores `accounts.status`, so do not roll back while an
  account is retired (its data/credentials remain, but the old API has no
  retirement enforcement).
- Old workflow instances do not set `audience`; migration backfills existing
  rows to org-scoped, while new account-bound runners remain account-scoped. **Do not run mixed workflow versions longer than the rollout
  window.**
- Rolling back LDS leaves `__drizzle_migrations_lds`; older hand-DDL startup
  ignores it.
- Rolling back Lakehouse leaves the catalog tables and data files. Do not delete
  the bucket/prefix during rollback; restore the previous image or point it at
  the same catalog.
- Reverting Warehouse to a pre-sandbox image restores external-access behavior;
  verify no tenant query depends on the restriction before rollback.
- Reverting Compose IAM env stops retention/MFA-key propagation on the next
  recreate; it does not undo purged data or newly sealed MFA secrets.

## 5. Verification scope of this worktree

- **Path B acceptance:** 3 Base documents → 3 Iceberg change rows; update and
  delete → 5 rows; replayed backfill stayed duplicate-free; Warehouse stop/start
  caught up a later Base update to 6 rows; the table materialized into Warehouse
  and answered a grouped SQL query.
- **Lakehouse guards:** over-quota append returned `409 quota_exceeded`;
  a second replica refused startup on the single-writer advisory lock; the
  maintenance report returned `physicalCleanup=disabled`; cross-tenant access
  returned `404`.
- **Upgrade rehearsal:** previous journals were installed in disposable
  databases, legacy rows seeded, then the current runtime migrated them:
  IAM `0012→0013` (journal 14, `consumed_at`, user preserved), Workflow
  `0013→0015` (journal 16, pause columns, `audience='org'`, paused execution
  preserved), Base `0009→0010` (journal 11, outbox retry/quarantine columns,
  document version preserved).
- **Backup/restore:** `pg-backup --once` produced a 31 KiB dump plus SHA256 and
  status; it restored into a separate database with 2 Iceberg tables (6 rows
  each) and a readable historical snapshot. `s3-backup once` captured 50
  objects/176,960 bytes. Warehouse restart did not duplicate acknowledged rows.
- **Access control:** a tenant API key scoped `base:read` could list collections
  (`200`) but not create one (`403`); legacy action casing is normalized.
  Super Admin suspend/reactivate blocked and restored tenant login and wrote
  audit rows.
- Rust/Node/Python suites, disposable-QA integration, browser checks, migration
  rehearsal, and Postgres/S3 restore drills were executed against the isolated
  `s1qa-closure` project.
- **No production database, object store, DNS, TLS or credential was touched.**
- Production deployment remains an operator action requiring authorization and
  a fresh backup.
