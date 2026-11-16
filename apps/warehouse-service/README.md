# Synapse Warehouse (`@synapseone/warehouse-service`)

Tenant-scoped OLAP service behind the gateway's `/v1/warehouse` route.

- **Storage:** one DuckDB database per tenant (`WAREHOUSE_DATA_DIR`), or
  `:memory:` in tests. Dataset metadata, rows and ETL job state live together.
- **SQL:** read-only single-statement `SELECT`/`WITH`. DDL/DML, file readers,
  `ATTACH`, `COPY`, `PRAGMA` and extension loading are rejected. Results are
  capped and the HTTP response is limited to 5 MB.
- **Batch ETL:** `POST /v1/warehouse/etl/batch` runs a SQL transform into a
  target dataset (`append` or `replace`). `replace` also refreshes the dataset
  column metadata.
- **Stream ETL:** `POST /v1/warehouse/etl/stream` ensures a consumer-group job
  over SynapseStream. The worker reads a micro-batch, maps event payloads to
  dataset columns, appends rows and acks only after a successful write.
  `_ingest_events(event_id, dataset_id)` is written in the same DuckDB
  transaction, so redelivery after a crash is a no-op. Change-log datasets keep
  create/update/delete rows; current state is a query over the latest version.

## API

| Method | Path |
| --- | --- |
| GET | `/health` |
| GET/POST | `/v1/warehouse/datasets` |
| GET/DELETE | `/v1/warehouse/datasets/:id` |
| POST | `/v1/warehouse/datasets/:id/rows` |
| POST | `/v1/warehouse/query` |
| GET | `/v1/warehouse/templates` |
| GET | `/v1/warehouse/pipeline/status` |
| GET/POST | `/v1/warehouse/jobs` |
| GET/DELETE | `/v1/warehouse/jobs/:id` |
| POST | `/v1/warehouse/jobs/:id/run` (batch) |
| POST | `/v1/warehouse/jobs/:id/pause` |
| POST | `/v1/warehouse/jobs/:id/resume` |
| POST | `/v1/warehouse/etl/batch` |
| POST | `/v1/warehouse/etl/stream` |

Internal (no gateway route; IAM only, shared secret required):

| Method | Path |
| --- | --- |
| POST | `/internal/usage/rollup` |
| POST | `/internal/usage/summary` |
| GET | `/internal/usage/watermark` |

## Usage-analytics rollups

The dashboard does not scan raw request telemetry on every load. IAM writes
gateway events to Postgres and periodically pushes completed hours here:

- `_usage_hourly` — hour × feature × route × method × status class × auth kind
  × account × model, with request/success/error counters, token sums, duration
  sum and a fixed latency histogram for p95.
- `_usage_hourly_user` — hour × feature × method × status class × account ×
  user, used for distinct active users/accounts.
- `_usage_rollup_state` — exclusive coverage watermark per tenant. Empty hours
  still advance the watermark.

IAM merges warehouse history with the still-unaggregated Postgres tail, so
dashboard totals remain exact at range boundaries. Exact-status, actor and
free-text (`q`) filters intentionally stay on the Postgres path.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4012` | HTTP port |
| `WAREHOUSE_DATA_DIR` | `/data/warehouse` | DuckDB file directory (volume) |
| `WAREHOUSE_THREADS` | `2` | DuckDB intra-op threads |
| `STREAM_SERVICE_URL` | `http://stream:4009` | SynapseStream base URL |
| `SYNAPSEONE_INTERNAL_SECRET` | — | Required in production (also guards `/internal/*`) |
| `CORS_ORIGIN` | — | Allowed console origin |

## Tests

```bash
npm run build --workspace=apps/warehouse-service
npm test --workspace=apps/warehouse-service
```

Tests use an in-memory DuckDB per tenant and a fake SynapseStream server to
cover create -> ingest -> aggregate query, SQL safety, batch ETL, stream
consume/ack and tenant isolation.
