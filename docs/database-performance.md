# Database performance: PgBouncer, Postgres tuning and the Base read cache

This guide covers the Phase 1/2 database performance work:

1. **PgBouncer** in transaction-pooling mode between the application services
   and Postgres.
2. **Postgres tuning** for the production host.
3. **L2 document-read cache** in SynapseBase backed by Synapse Faststore
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
