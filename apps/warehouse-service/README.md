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

## API

| Method | Path |
| --- | --- |
| GET | `/health` |
| GET/POST | `/v1/warehouse/datasets` |
| GET/DELETE | `/v1/warehouse/datasets/:id` |
| POST | `/v1/warehouse/datasets/:id/rows` |
| POST | `/v1/warehouse/query` |
| GET | `/v1/warehouse/templates` |
| GET/POST | `/v1/warehouse/jobs` |
| GET/DELETE | `/v1/warehouse/jobs/:id` |
| POST | `/v1/warehouse/jobs/:id/run` (batch) |
| POST | `/v1/warehouse/jobs/:id/pause` |
| POST | `/v1/warehouse/jobs/:id/resume` |
| POST | `/v1/warehouse/etl/batch` |
| POST | `/v1/warehouse/etl/stream` |

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4012` | HTTP port |
| `WAREHOUSE_DATA_DIR` | `/data/warehouse` | DuckDB file directory (volume) |
| `WAREHOUSE_THREADS` | `2` | DuckDB intra-op threads |
| `STREAM_SERVICE_URL` | `http://stream:4009` | SynapseStream base URL |
| `SYNAPSEONE_INTERNAL_SECRET` | — | Required in production |
| `CORS_ORIGIN` | — | Allowed console origin |

## Tests

```bash
npm run build --workspace=apps/warehouse-service
npm test --workspace=apps/warehouse-service
```

Tests use an in-memory DuckDB per tenant and a fake SynapseStream server to
cover create -> ingest -> aggregate query, SQL safety, batch ETL, stream
consume/ack and tenant isolation.
