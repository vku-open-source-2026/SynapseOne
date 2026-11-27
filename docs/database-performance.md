# Database performance: PgBouncer, Postgres tuning, IAM audit reads, quota metering and the Base read cache

[Tiếng Việt](vi/database-performance.md) · English

This guide covers the Phase 1/2 database performance work:

1. **PgBouncer** in transaction-pooling mode between the application services
   and Postgres.
2. **Postgres tuning** for the production host.
3. **Optional IAM audit read replica** for tenant/platform audit list and count.
4. **Atomic IAM quota metering** in Valkey for fixed request windows.
5. **L2 document-read cache** in SynapseBase backed by Synapse Faststore
   (Valkey).

It applies to the single-node Compose deployment. The app services still use
the same `DATABASE_URL`; only its host changes from `postgres:5432` to
`pgbouncer:6432`.

## Connection topology

```text
iam / workflow / base
        │  DATABASE_URL (transaction pooling)
        ▼
    pgbouncer:6432  ──►  postgres:5432
        ▲
        │  DATABASE_DIRECT_URL (migrations, advisory locks)
        └─────────────── application bootstrap code
```

- `DATABASE_URL` → PgBouncer. Use it for normal request traffic.
- `DATABASE_DIRECT_URL` → Postgres. Use it for anything session-scoped:
  Drizzle migrations, `pg_advisory_lock`, `LISTEN/NOTIFY`, session `SET`.
- `iam`, `workflow` and `base` migrations already bypass the pooler through
  `DATABASE_DIRECT_URL`; IAM usage-rollup uses the direct pool for its advisory
  lock.
- `lds` and `notifications` intentionally stay on the direct connection in the
  current deployment: their in-progress Rust images bootstrap the schema with a
  multi-statement prepared statement, which transaction pooling rejects. Move
  them after that bootstrap is split into individual statements.
- Authentik, `pg-backup` and `postgres-exporter` keep connecting directly to
  Postgres. Do not move Authentik to transaction pooling.

### Pool sizing

`infra/pgbouncer/pgbouncer.ini` keeps 5 warm server connections, allows 25 per
user/database (30 with the reserve pool), and caps server connections at 60.
Postgres keeps `max_connections = 100`, leaving room for Authentik, backups,
exporters and migrations. Raise `default_pool_size` only after checking
Postgres CPU, `pg_stat_activity` wait events and pgbouncer `SHOW POOLS`.

## Optional IAM audit read replica

`DATABASE_READ_URL` is an opt-in, IAM-only connection for the final SELECTs of
`GET /v1/audit` and `GET /v1/platform/audit`. It is empty by default, so existing
deployments keep using `DATABASE_URL` with no behavior change. For example:

```dotenv
DATABASE_READ_URL=postgresql://synapse_readonly:REPLACE_ME@synapse-read-replica-proxy:6433/synapseone
```

Use a dedicated role with database `CONNECT`, schema `USAGE`, and only `SELECT`
on `audit_log` (and no migration, authentication, quota, usage, session, export
or write privileges). Primary connections remain `DATABASE_URL` /
`DATABASE_DIRECT_URL`. The replica pool is capped at 4 connections with a 2s
connect timeout, 5s statement/query timeout, 1s lock timeout and 5s
idle-in-transaction timeout.

Each replica operation runs in its own `BEGIN READ ONLY` transaction with
`transaction_read_only=on`; the client handle is private to that operation. The
same transaction checks `pg_is_in_recovery()`. If the endpoint is not a
replica, cannot be reached, times out, or the audit query fails, IAM logs a
structured counter event (without connection strings or error messages) and
falls back to the existing primary query/count implementation. A primary error
still propagates normally.

Replica data is **eventually consistent**. A newly written audit row may be
absent briefly, and list/count are separate snapshots, so paged totals can lag
or differ from the returned page. Do not use this path for read-after-write
checks or security decisions. Caller org/platform-admin authorization,
including session and MFA checks, always completes on primary before the
replica SELECT. Audit export, `logAudit`, auth, quota, usage summary/meter,
platform sessions and all mutations intentionally stay on primary.

To disable the path, unset `DATABASE_READ_URL` (or set it empty) and recreate
only the IAM service. No schema migration or data rollback is required.

## Atomic organization quota metering

`org_quotas` remains in Postgres because it is durable platform configuration;
request counters live in Valkey under
`quota:v1:<service>:<subject>:<window>:<bucket>`. IAM uses a dedicated lazy
`ioredis` client (`IAM_QUOTA_VALKEY_URL`, falling back to `VALKEY_URL` then
`REDIS_URL`) with offline queueing disabled, bounded retries, a 1 s connect
timeout and a 1.5 s command timeout. It never uses the optional audit read
replica.

One Lua call reads the minute, five-hour and UTC-day counters, checks all three,
and only then increments accepted requests and sets fixed-window TTLs. This
prevents a rejected request from consuming another window and makes admission
atomic across IAM replicas. The most constrained denied window (highest usage
ratio, earliest reset on ties) supplies `window`, `count`, `limit`,
`retryAfterSeconds` and `resetAt`.

If Valkey is absent or unavailable, `/internal/quota/check` returns
`503 quota_unavailable`; the gateway deliberately fails open to its existing
in-memory minute limiter. Monitor that fallback: it is per gateway replica and
does not enforce 5h/day limits. Do not put quota counters in the audit read
replica or flush the whole Valkey database during rollback; keys expire by TTL.

Migration `0018` creates `org_quotas`; its timestamp is above hackathon `0017`.
The original live-worktree 0015 was never applied in production. Migration `0019`
adds nullable `requests_per_5h` and `requests_per_day`. Both fresh and 0014-upgrade
paths are supported. Keep the additive table/columns on rollback and restore
previous application images/env instead.

## Postgres tuning

`docker-compose.yml` passes these settings with `postgres -c`; override them in
`.env` when the host size changes:

| Setting | Default | Why |
|---|---|---|
| `shared_buffers` | 2GB | Keeps hot pages in Postgres shared memory without starving the runner/inference containers |
| `effective_cache_size` | 6GB | Planner hint for the host page cache |
| `work_mem` | 16MB | Sorts/hash joins; bounded by the pooler's server-side connection count |
| `maintenance_work_mem` | 256MB | VACUUM / index builds |
| `wal_buffers` | 16MB | Smoother WAL writes |
| `max_wal_size` / `min_wal_size` | 4GB / 1GB | Fewer checkpoints, fewer I/O spikes |
| `checkpoint_completion_target` | 0.9 | Spread checkpoint I/O |
| `effective_io_concurrency` | 200 | SSD/NVMe |
| `random_page_cost` | 1.1 | SSD random reads |
| `track_io_timing` | on | `pg_stat_statements` / `pg_stat_database` I/O visibility |
| `shared_preload_libraries` | `pg_stat_statements` | Slow-query attribution |
| `jit` | off | OLTP latency; avoids JIT compile overhead on small queries |
| `idle_in_transaction_session_timeout` | 60s | Releases abandoned transactions |
| `idle_session_timeout` | 10min | Reaps abandoned direct sessions |

`shm_size: 512mb` gives parallel query workers enough dynamic shared memory.

Enable query stats once on an existing database (new databases do it in
`infra/postgres/init.sql`):

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## SynapseBase document cache

`apps/base-service/src/cache.ts` is a fail-open read-through cache for
`GET /v1/base/collections/:collection/documents/:id`.

- Key: `base:doc:v1:<collection_id>:<document_id>`; Faststore adds the
  tenant namespace (`org:`, `account:`, `user:`), so cross-tenant reads are
  impossible.
- TTL: `BASE_CACHE_TTL_SECONDS` (default 60s).
- Timeout: `BASE_CACHE_TIMEOUT_MS` (default 250ms); a timeout or any Faststore
  error falls back to Postgres.
- Invalidation: create / set / update / patch / delete / increment and batch
  writes delete the affected keys. The change feed and query/list endpoints are
  not cached.
- Disable: set `FASTSTORE_SERVICE_URL` empty.

Observability is exposed on `/metrics`:

```text
synapseone_base_cache_enabled
synapseone_base_cache_document_total{result="hit|miss|error"}
synapseone_base_cache_write_total{result="set|delete"}
```

The cache is a latency optimization, not a consistency boundary: a failed
invalidation can serve a document for at most the TTL. Keep the TTL short for
collections that require read-after-write consistency.

## Verification

```bash
# Pooler sees sessions, Postgres sees few direct connections. The Postgres
# image already carries psql and the credentials.
docker exec synapseone-postgres-1 sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h pgbouncer -p 6432 -U "$POSTGRES_USER" -d pgbouncer -c "show pools"'

docker exec synapseone-postgres-1 sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select application_name,count(*) from pg_stat_activity where backend_type='\''client backend'\'' group by 1"'

# Tuning is live.
docker exec synapseone-postgres-1 sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select name,setting,unit from pg_settings where name in ('\''shared_buffers'\'','\''work_mem'\'','\''effective_io_concurrency'\'','\''shared_preload_libraries'\'')"'
```

## Rollback

1. Point `DATABASE_URL` back at `postgres:5432` (or remove the pgbouncer
   override) and recreate only the app services.
2. Stop `pgbouncer`; Postgres keeps running.
3. Restore the previous postgres container command if the tuning must be
   reverted. Data lives in the `pgdata` volume and is not affected by a
   container recreate.
4. Set `FASTSTORE_SERVICE_URL=` to disable the Base cache without a rebuild.
