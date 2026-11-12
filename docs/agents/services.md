# SynapseOne — Service Reference

Per-service map for agents: purpose, key files, API surface, data, rules, env.
Ports assume Compose defaults. Apart from explicit public gateway routes
(`/v1/auth/*`, LDS public reads, `/webhook/*`), services are internal in
production and require `x-synapseone-internal` when the shared secret is set.

---

## Gateway — `apps/gateway` (:8080)

**Purpose:** single public entry point. Route matching, authn, principal
stamping, edge hardening, telemetry, aggregate readiness.

**Files:** `src/index.ts` (proxy + auth + limits), `routes.yaml` (routing table),
`src/usage.ts` (batched usage events → IAM).

**Endpoints:** `GET /`, `/health`, `/ready`, `/metrics`; all API paths proxy to
upstreams. `routes.yaml` covers `/v1/auth`, IAM resources, `/v1/workflows`,
`/v1/templates`, `/v1/executions`, `/v1/credentials`, public `/webhook`,
`/v1/ai`, `/v1/inference`, LDS public + management, `/v1/base`,
`/v1/faststore`, `/v1/queue`, `/v1/stream`, `/v1/ocs` (legacy `/v1/storage`), `/v1/notifications`.

**Rules:**
- Auth modes per route: `none|jwt|apikey|either`; route specificity by literal
  length; `*` = one segment, trailing `/*` = remainder.
- Strips all client `x-synapseone-*`, re-stamps verified identity, adds
  `x-synapseone-anon: 1` for public routes without a principal.
- API-key verification calls IAM `/v1/keys/verify` (5 s timeout, fail-closed).
- No global `express.json()` (must preserve raw proxy body). No path rewrite.
- Per-route `timeoutMs` 1–300 s (LLM/webhook routes are longer); 502 on upstream
  failure, 504 on timeout.
- In-memory per-client limits: `/v1/auth/*` 120/min, `/ready` 30/min,
  inference/AI per-tenant `INFERENCE_RATE_LIMIT_PER_MIN` (default 60, 429 +
  `Retry-After`). Keys on `req.ip`; set `TRUST_PROXY` behind the edge.
- Per-route scope enforcement (`src/scopes.ts`): `<service>:read|write|*` or a
  concrete verb; 403 `scope_denied` before proxying. User JWTs carry `*`.
- `/ready` probes iam/workflow/ai/lds/base/faststore/queue plus stream,
  inference, storage and notifications when their URLs are configured.
- Usage telemetry on by default (`USAGE_TELEMETRY=false` disables); excluded
  paths are in `usage.ts`.
- `/ready` probes IAM, Workflow, AI, LDS, Base, Faststore, Queue (not Inference).

**Env:** `PORT`/`GATEWAY_PORT`, `IAM_SERVICE_URL`, all `*_SERVICE_URL`,
`IAM_JWT_SECRET`, `SYNAPSEONE_INTERNAL_SECRET`, `GATEWAY_ROUTES_PATH`,
`GATEWAY_VERIFY_APIKEY`, `PROXY_TIMEOUT_MS`, `CORS_ORIGIN`, `HSTS_ENABLED`,
`USAGE_TELEMETRY`.

---

## IAM — `apps/iam-service` (:4001)

**Purpose:** AWS-style identity/authorization, tokens, OIDC federation, audit,
usage analytics.

**Files:** `src/index.ts` (routes + tenant checks), `src/db.ts` (pg/memory
accessors + seed), `src/tokens.ts` (JWT/refresh/API keys), `src/policy.ts`
(evaluator/validator), `src/oidc.ts` (discovery/JWKS/state), `src/schema.ts`,
`src/usage.ts`, `drizzle/`.

**API:**
- Auth: `GET /v1/auth/oidc/config`, `GET /v1/auth/oidc/start`,
  `POST /v1/auth/oidc/callback`, `POST /v1/auth/login` (dev-only),
  `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/logout-all`,
  `GET /v1/auth/me`, `GET /v1/auth/verify`.
- Tenancy: `GET/POST /v1/orgs`, `GET/POST /v1/orgs/:orgId/accounts`,
  `GET/POST /v1/orgs/:orgId/users`, `GET/POST /v1/accounts/:accountId/roles`,
  `GET/POST /v1/accounts/:accountId/policies`,
  `DELETE /v1/policies/:policyId`;
  role/policy attach + detach (`POST /v1/roles/:roleId/attach`,
  `DELETE /v1/roles/:roleId/policies/:policyId`,
  `DELETE /v1/roles/:roleId`);
  user role assign + unassign (`POST /v1/users/:userId/assign`,
  `DELETE /v1/users/:userId/roles/:roleId`), plus
  `GET /v1/roles/:roleId/policies`, `GET /v1/users/:userId/policies|roles`.
- Authz: `POST /v1/authorize`, `POST /v1/authorize/dry-run`, `GET /v1/audit`.
- Keys: `POST/GET /v1/accounts/:accountId/keys`, `POST /v1/keys/verify`,
  `DELETE /v1/keys/:id`; service accounts
  `POST/GET /v1/accounts/:accountId/service-accounts`,
  `POST /v1/service-accounts/:id/token`.
- Usage: `POST /v1/usage/ingest` (internal), `GET /v1/usage/summary`,
  `GET /v1/usage/events`.

**Data:** `organizations`, `accounts`, `users`, `roles`, `policies`,
`role_policies`, `user_roles`, `api_keys`, `service_accounts`,
`refresh_tokens`, legacy `workflows`, `usage_events`, `audit_log`.
Migrations seed demo org `acme` and account `prod`; the memory fallback seeds
`acme` too. Demo users are created on demand (dev login).

**Rules:**
- Access JWT HS256 `iss=synapseone-iam`; refresh tokens single-use and rotated
  atomically; API keys hashed at rest (optional pepper; legacy hash accepted).
- Stamped tenant headers are trusted only when `SYNAPSEONE_INTERNAL_SECRET` is
  set; otherwise the credential is verified directly (dev).
- `canActForAccount`: role/account membership, then same-org fallback for
  bootstrap; service-account tokens are account-bound (no org fallback).
- `canActForOrg`: same org only.
- Policy evaluation: explicit Deny > Allow > default deny; conditions
  `StringEquals`/`StringLike` (+`IfExists`); action/resource patterns capped.
- Audit reads are tenant-scoped; `actor_type=dry-run` rows use `callerOrg`.
- Production boot rejects dev login, demo OIDC callback, missing internal
  secret, missing `DATABASE_URL`.
- Usage events retention defaults 30 days; audit retention opt-in
  (`AUDIT_RETENTION_DAYS`).

**Env:** `PORT`, `DATABASE_URL`, `REDIS_URL` (reserved), `IAM_JWT_SECRET`,
`IAM_JWT_EXPIRES_IN`, `IAM_REFRESH_EXPIRES_IN`, `IAM_API_KEY_PEPPER`,
`IAM_ALLOW_DEV_LOGIN`, `IAM_ALLOW_OIDC_DEMO_CALLBACK`,
`SYNAPSEONE_INTERNAL_SECRET`, `OIDC_*`, `AUDIT_RETENTION_DAYS`,
`USAGE_RETENTION_DAYS`, `HSTS_ENABLED`, `CORS_ORIGIN`.

---

## Workflow — `apps/workflow-service` (:4002)

**Purpose:** built-in Apache-2.0 DAG engine and control plane.

**Files:** `src/index.ts` (routes, templates, cron loop, webhook ingress),
`src/engine.ts` (DAG, expressions, integrations), `src/sandbox-runner.ts`
(isolated code process), `src/store.ts` (Postgres/memory + credential crypto),
`src/schema.ts`, `drizzle/`.

**API:**
- `GET/POST /v1/workflows`, `GET/PUT/DELETE /v1/workflows/:id`,
  `POST /v1/workflows/:id/execute|activate|deactivate`,
  `POST /v1/workflows/test-run` (`execute` returns 202 queued in queue mode;
  `?wait=1` blocks).
- `GET /v1/executions`, `GET /v1/executions/:id`.
- `GET/POST /v1/workflow-runners`, `GET/PATCH/DELETE /v1/workflow-runners/:id`,
  `GET /v1/workflow-runners/options`, `GET .../config|connection`,
  `POST .../heartbeat|command`, `DELETE .../instances/:instanceId`,
  `POST /v1/runner/jobs/:id/claim|heartbeat|complete|release|credentials`.
- `POST/GET /v1/inference-jobs`, `GET /v1/inference-jobs/:id`,
  `POST /v1/runner/inference/jobs/:id/claim|heartbeat|complete|release`
  (inference/hybrid runner lane).
- `GET /v1/templates`, `GET /v1/templates/:name`.
- `GET/POST /v1/credentials`, `DELETE /v1/credentials/:id` (secrets never
  returned).
- Public `ALL /webhook/:path` (no gateway auth; per-workflow auth/method).
- `GET /health`, `GET /metrics`.

**Engine:** executes a DAG with a queue/fan-out model; expressions support
`={{ ... }}` and `{{ ... }}` with `$json`, `$input`, `$now`. In queue execution
mode the *trigger* publishes a SynapseQueue job and workers run the DAG
(`queue.ts`, `worker.ts`, `runner.ts`); the in-memory node queue remains the DAG
fan-out mechanism. Node families:
- native/aliases: `webhook`, `cron`, `manualTrigger`, `noOp`, `set`, `if`,
  `httpRequest`, `code`, `decision`, `aiAgent`, `synapseone.api`;
- integration nodes: `synapseone.iam|base|faststore|queue|lds|inference|flow`;
- `synapseone.api` operations cover IAM resources (users/roles/policies/
  authorize/keys/service-accounts), workflows/executions/templates, plus
  `lds.*`, `base.*` (incl. `vector-search`), `faststore.*`, `queue.*` and
  `inference.*` (`chat|embeddings|decision|route`).
- n8n-compatible type names are accepted and preserved for editor/import.

**Triggers:** manual execute/test; public webhooks with `secret-header`,
`hmac-sha256`, or `jwt` auth, per-workflow rate limit and optional idempotency
header/TTL; cron scheduler tick (`WORKFLOW_CRON_TICK_MS`, default 15 s) runs
active cron workflows. Activation gates cron + webhooks, not manual runs.
With `QUEUE_SERVICE_URL` set (default in Compose), triggers enqueue a job:
platform worker (`WORKFLOW_WORKER_ENABLED`, concurrency 4), tenant custom
runner, or hybrid shared queue. `WORKFLOW_EXECUTION_MODE=queue|inline|auto`
controls the transport; tests/unit runs stay inline.

**Self-hosted runners:** `POST/GET /v1/workflow-runners`, heartbeat/connection
check, and `/v1/runner/jobs/*` claim/heartbeat/complete/release/credentials.
The runner image is `apps/workflow-runner/Dockerfile` (release + CD publish
`synapseone-workflow-runner`). Credentials are resolved per claimed execution,
never embedded in queue messages. See `docs/workflow-runners.md`.

**Templates (10):** `webhook-to-log`, `cron-etl`, `iam-webhook`,
`code-transform`, `manual-starter`, `synapseone-self-check`, `webhook-to-lds`,
`github-push-to-log`, `ai-triage-ops`, `customer-360-orchestrator`.

**Data:** `synapseone_workflows` (nodes/connections/settings/active/tenant/
run_as/revision), `synapseone_executions` (input/output/node runs/principal/
trigger + queue/runner/worker/attempt/lease/resume), `synapseone_workflow_runners`
(kind workflow/inference/hybrid, queues, tenant/API-key metadata),
`synapseone_workflow_runner_instances` (per-connector hostname/version/
concurrency/last heartbeat), `synapseone_inference_jobs` (queued inference
chat/embeddings/decision work for inference/hybrid runners),
`synapseone_credentials` (AES-256-GCM envelope, `SYNAPSEONE_CREDENTIAL_KEY`
32-byte hex required in prod; dev uses an ephemeral key).

**Rules:**
- Workflows are tenant-scoped: visibility = account match OR org match; create/
  update cannot bind outside the caller's org; anonymous direct calls keep the
  dev/test global view.
- Executions are filtered by the run-time principal snapshot; callers without
  tenant scope fail closed.
- Webhook paths are unique among active workflows; template creation suffixes
  collisions (`-2`, `-3`).
- Definition cap 200 KB; settings cap 8 KB; at least one trigger required.
- Production code nodes run in a throwaway child process with empty env, Node
  permission model, and a null-prototype `vm` context; no fs/child_process/
  workers. Running from `src` via ts-node falls back to the hardened in-process
  `vm` path (dev only).
- `code`/`httpRequest` nodes are powerful: never expose a workflow editor to
  untrusted users without the platform's auth model.

**Env:** `PORT`, `DATABASE_URL`, `IAM_SERVICE_URL`, `SYNAPSEONE_IAM_API_KEY`,
`SYNAPSEONE_INTERNAL_SECRET`, `SYNAPSEONE_CREDENTIAL_KEY`,
`WORKFLOW_CRON_TICK_MS`, `WORKFLOW_TIMEOUT_MS`, `INFERENCE_TIMEOUT_MS`,
`HSTS_ENABLED`, `CORS_ORIGIN`.

---

## LDS — `apps/lds-service` (:4004)

**Purpose:** SynapseLDS — publish licensed data as NGSI-LD with a default-deny
attribute registry.

**Files:** `src/index.ts` (routes/visibility), `src/projector.ts` (security core),
`src/store.ts`, `src/licenses.ts`, `src/schema.ts`, `drizzle/`.

**API:**
- Public: `GET /v1/lds/licenses`,
  `GET /v1/lds/datasources/:id/entities`,
  `GET /v1/lds/datasources/:id/entities/:entityId`.
- Management: `GET/POST /v1/lds/datasources`, `GET/PATCH/DELETE
  /v1/lds/datasources/:id`, `GET/PUT /v1/lds/datasources/:id/attributes`,
  `POST /v1/lds/datasources/:id/records`,
  `GET /v1/lds/datasources/:id/stats`.
- `GET /health`, `GET /metrics`.

**Data model:** `lds_datasources` (slug, entity_type, license, contexts,
default_visibility, tenant), `lds_attributes` (name/type/visibility/source
field), `lds_records` (`core` metadata + `entity` + `attributes` per entity;
projector comments call the metadata `_core`).

**Rules:**
- Projector is a **structural allowlist**: only `entity.id`, `entity.type`,
  and registered `attributes` are serialized. `_core`/audit/security/storage/
  lineage are never read.
- Unregistered attributes are stored but never exported. Visibility at read
  time: `public|restricted|internal`; restricted requires an in-org principal;
  anonymous sees public only.
- Reserved names (`id`, `type`, `@context`, `internalId`, `tenantId`,
  `_core`, …) rejected at registration; unsafe prototype names rejected.
- Ingest splits records; tenant-bound records return 404 cross-tenant.
- Every export sets `X-LDS-License` + `Link rel="license"`.
- Anonymous callers may only GET public exports/licenses (gateway public routes).

**Env:** `PORT`, `DATABASE_URL`, `SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`,
`CORS_ORIGIN`.

---

## Base — `apps/base-service` (:4005)

**Purpose:** SynapseBase — self-managed document database with logical
object↔data mapping, validation, queries, vector search, optimistic concurrency,
atomic counters, batches and a change feed.

**Files:** `src/index.ts` (routes/scope/limits), `src/mapping.ts` (mapping +
validation), `src/query.ts` (filters/order/cursor/vector), `src/store.ts`
(Postgres/memory), `src/schema.ts`, `drizzle/`.

**API:**
- `GET/POST /v1/base/collections`, `GET/PATCH/DELETE
  /v1/base/collections/:collection`, `GET .../stats`.
- Documents: `POST .../documents`, `GET/PUT/PATCH/DELETE
  .../documents/:id`, `GET .../documents`, `POST .../query`,
  `POST .../vector-search`, `POST .../documents/:id/increment`,
  `POST .../documents:batch`, `GET .../changes`.

**Semantics:**
- Write either `data` (raw JSON) or `object` (logical keys); exactly one.
- Mapping: `{fields:{logical:{path,type,required,dimension,metric}},
  additional}`; types `string|number|boolean|date|array|object|vector|any`.
  Mapping is a view + validation contract, not a raw-data whitelist.
- Reads accept `as=object` to return mapped keys only.
- Filters: `eq, ne, gt, gte, lt, lte, in, nin, contains, startsWith, endsWith,
  exists, text, near, within`, composed with `and/or/not`; max 50 filters;
  orderBy array; limit 1..1000; `cursor` (base64 offset) xor `offset`.
- Postgres executes filter/order/limit/count (#29): equality uses the
  `idx_base_documents_data` GIN index, `$text` uses `idx_base_documents_fts`
  (migration 0004), id order uses the PK. Geo/range predicates are pushed down
  but not index-accelerated (no PostGIS). Only the in-memory dev fallback is
  bounded by `BASE_QUERY_SCAN_LIMIT` (default 200k) and can return 413.
- Vector ranking is still computed in the service; `where` candidates are
  pushed to SQL. `GET /documents?withTotal=1` returns total + cursor and always
  sets `X-Total-Count`.
- Mutation audit: every non-GET `/v1/*` call emits actor/tenant/action/result to
  IAM (`POST /v1/audit/ingest`), batch-flushed, best-effort (`AUDIT_TRAIL`).
- Optimistic concurrency: `ifVersion` body or `If-Match` header; mismatch 409.
- Increment is atomic for numeric paths.
- Batch: 1..100 ops, partial-failure results.
- Change feed: `GET .../changes` requires `since` (ISO-8601), optional
  `limit` 1..1000 and `as=data|object`; upserts/updates only (deletes are not
  emitted); returns `nextSince` + `hasMore`.
- Vector fields are declared in mapping (`type=vector`, dimension ≤4096,
  metric `cosine|l2|ip`); `/vector-search` supports `vector` or `query` and
  optional `where`/`select`.
- Limits: document ≤ `BASE_MAX_DOCUMENT_BYTES` (default 256 KB, max 4 MB),
  nesting ≤32, arrays ≤10k; prototype keys rejected.

**Data:** `synapseone_base_collections` (scope + name unique, mapping),
`synapseone_base_documents` (PK collection+id, JSONB, version, GIN index),
`synapseone_base_vectors` (collection+document+field, embedding text,
dimension). Memory backend for dev/tests.

**Rules:** collection visibility = platform all, org-bound same org,
account-bound same account. Production requires DB + internal secret.

**Env:** `PORT`, `DATABASE_URL`, `BASE_MAX_DOCUMENT_BYTES`,
`BASE_QUERY_SCAN_LIMIT`, `SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`,
`CORS_ORIGIN`.

---

## Faststore — `apps/faststore-service` (:4006)

**Purpose:** tenant-scoped Redis data API.

**Files:** `src/index.ts` (routes/tenant), `src/store.ts` (Redis/memory).

**API groups:**
- Strings: `GET/PUT/POST/DELETE /v1/faststore/keys/:key`, `GET .../ttl`,
  `POST .../expire`, `POST .../incr`.
- Bulk/scan: `GET /v1/faststore/keys?prefix=&limit=&cursor=`,
  `POST /v1/faststore/batch` (≤100 ops), `GET /v1/faststore/stats`.
- Hashes: `GET/PUT/DELETE /v1/faststore/hashes/:key`,
  `GET .../length`, `GET/PUT/DELETE .../:field`, `POST .../incr`.
- Lists: `GET/DELETE /v1/faststore/lists/:key`, `POST .../push|pop|trim`,
  `GET .../length`.
- Sets: `GET/DELETE /v1/faststore/sets/:key`, `POST .../add|remove|contains`,
  `GET .../card`.
- Sorted sets: `GET/DELETE /v1/faststore/zsets/:key`,
  `POST .../add|incr|remove|score|rank`, `GET .../card`.
- Locks: `POST /v1/faststore/locks/:name/acquire|release|extend`.

**Semantics:** TTL max 30 days; key ≤512 chars (no `/` or `\`); field ≤256;
batch ≤100. Conditional writes `ifNotExists`/`ifExists`. Locks are token-owned
and must be released/extended with the returned token. Keys live under
`synapseone:faststore:v1:<tenant>:`; locks under `...:__lock__:<name>`.

**Rules:** anonymous rejected; platform callers must pass tenant. Redis required
in production (else split-brain). Memory fallback for tests/dev.

**Env:** `PORT`, `FASTSTORE_REDIS_URL`/`REDIS_URL`,
`SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`, `CORS_ORIGIN`.

---

## Queue — `apps/queue-service` (:4007)

**Purpose:** at-least-once queue with delayed/deduped publish, visibility
leases, retries, DLQ and replay.

**Files:** `src/index.ts` (routes/limits), `src/store.ts` (Redis Lua/memory).

**API:**
- Queues: `GET/PUT /v1/queue/queues`, `GET/DELETE /v1/queue/queues/:queue`,
  `POST .../purge`, `GET .../stats`.
- Publish: `POST /v1/queue/queues/:queue/messages`,
  `POST .../messages:batch`.
- Consume: `POST .../consume` → message + `receipt` + lease expiry;
  `POST .../ack|nack|heartbeat`.
- Inspect/DLQ: `GET .../messages`, `GET .../dead`,
  `POST .../dead/:id/replay`, `DELETE .../dead/:id`.
- `GET /health`, `GET /metrics`.

**Semantics:**
- Publish options: `id` (client-supplied), `delaySeconds` (≤7 d), `dedupeKey`,
  `maxAttempts`, headers.
- Consume leases for `visibilityTimeoutSeconds` (default 30, ≤3600); ack
  removes; nack or lease expiry retries; exhausted attempts → dead set.
- `maxMessages` ≤100 per consume; batch/receipts ≤100.
- Payload ≤256 KB (`QUEUE_MAX_PAYLOAD_BYTES`), headers ≤8 KB.
- Queue names `[A-Za-z][A-Za-z0-9_-]{0,63}`.
- Keys: `synapseone:queue:v1:<tenant>:...`.
- At-least-once by design → consumers must be idempotent; dedupe keys are the
  tool for duplicate suppression.

**Env:** `PORT`, `QUEUE_REDIS_URL`/`REDIS_URL`, `QUEUE_MAX_PAYLOAD_BYTES`,
`SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`, `CORS_ORIGIN`.

---

## AI assistant — `apps/ai-service` (:4003)

**Purpose:** Console API-docs chatbot. Two-step: decision model picks a catalog
endpoint; LLM fills path/body or returns guidance.

**Files:** `src/index.ts` (route/limits/internal auth), `src/agent.ts`
(orchestration + validation), `src/catalog.ts` (allowed endpoints), `src/llm.ts`
(OpenAI-compatible client, retries/fallback).

**API:** `POST /v1/ai/agent` only, plus `/health`. Internal secret required on
`/v1/*`; per-principal rate limit (`AI_RATE_LIMIT`, default 30/min); API key
stays server-side. Output is validated against the catalog and fails closed
(502 on invalid model output). Guidance-only; not a public API.

**Env:** `PORT`, `AI_BASE_URL`, `AI_API_KEY`, `AI_DECISION_MODEL`,
`AI_LLM_MODEL`, `AI_LLM_FALLBACK_MODEL`, `AI_TIMEOUT_MS`, `AI_RETRIES`,
`AI_RATE_LIMIT`, `SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`, `CORS_ORIGIN`.

---

## Warehouse — `apps/warehouse-service` (:4012, TypeScript)

**Purpose:** Tier-1 OLAP store behind the gateway's `/v1/warehouse` route.
Tenant-scoped DuckDB databases hold datasets, SQL query results and ETL jobs.
Batch jobs transform one dataset into another; stream jobs consume a
SynapseStream topic and append event payloads to a dataset.

**Files:** `src/index.ts` (Express + stream workers), `src/duck.ts` (tenant
store and metadata), `src/sql.ts` (identifier/SQL safety), `src/types.ts`;
tests in `src/index.test.ts`.

**API:** `GET /health`; datasets (`GET/POST /v1/warehouse/datasets`,
`GET/DELETE /v1/warehouse/datasets/:id`, `POST .../rows`), read-only SQL
(`POST /v1/warehouse/query`), ETL templates (`GET /v1/warehouse/templates`)
and jobs (`GET/POST /v1/warehouse/jobs`, `POST .../:id/run|pause|resume`,
`DELETE .../:id`).

**Invariants:** one DuckDB file per tenant (`WAREHOUSE_DATA_DIR`); every SQL
statement is a single read-only `SELECT`/`WITH` with file/DDL functions denied;
dataset ids are lower-case slugs and physical table names; stream jobs are
single-writer (`replicas: 1`).

**Env:** `PORT`, `WAREHOUSE_DATA_DIR`, `WAREHOUSE_THREADS`,
`STREAM_SERVICE_URL`, `SYNAPSEONE_INTERNAL_SECRET`, `CORS_ORIGIN`.

---

## Inference — `apps/inference-service` (:4008, Python)

**Purpose:** multi-model runtime behind the gateway's `/v1/inference` route.

**Files:** `src/main.py` (FastAPI), `src/llm.py`, `src/embedding.py`,
`src/decision.py`, `src/config.py`; tests in `tests/`.

**API:** `GET /health`; direct paths `POST /v1/chat/completions`
(OpenAI-compatible, SSE when `stream:true`), `/v1/embeddings`, `/v1/decision`
(structured questions), `/v1/decision/route` (workflow branch router), plus
`/v1/inference/*` aliases used through the gateway (no path rewrite); OpenAPI
at `/docs`.

**Models/defaults:** OpenRouter-compatible LLM (default
`liquid/lfm-2.5-2.6b:free`) with a fallback model, sentence-transformers
`all-MiniLM-L6-v2` (384-dim, ONNX int8 on CPU, torch/mock fallbacks), and
Decision-2.0-Eos-0.8B (FP32 CPU, ~3 GB RAM; `DECISION_ENABLED=false` disables).
Device auto-detected.

**Rules:** `/v1/*` requires `x-synapseone-internal` when configured; production
requires the secret. Not tenant-aware — callers must not send tenant data.
No auth beyond the internal secret.

**Env:** `PORT`, `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`,
`OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODEL`, `OPENROUTER_TIMEOUT_MS`,
`OPENROUTER_RETRIES`, `EMBEDDING_MODEL_NAME`, `EMBEDDING_DIM`,
`EMBEDDING_BACKEND`, `EMBEDDING_ONNX_PATH`, `EMBEDDING_ONNX_FILE`,
`EMBEDDING_BATCH_SIZE`, `EMBEDDING_MAX_LENGTH`, `DECISION_MODEL_NAME`,
`DECISION_ENABLED`, `DECISION_THREADS`, `DECISION_WARMUP`, `INFERENCE_DEVICE`,
`INFERENCE_CPU_THREADS`, `INFERENCE_MODEL_DOWNLOAD`, `INFERENCE_WARMUP`,
`MODEL_LOAD_RETRY_SECONDS`, `INFERENCE_MOCK_MODELS`,
`SYNAPSEONE_INTERNAL_SECRET`.

---

## Console — `apps/console` (:3000 → nginx :80)

**Purpose:** admin UI + public landing/docs/API explorer + workflow graph editor.

**Files:** `src/App.jsx` (routes), `src/pages/*` (Dashboard, Orgs, Accounts,
Users, Roles, Policies, Keys, ServiceAccounts, Workflows, SynapseBase,
SynapseQueue, SynapseFaststore, SynapseInference, LinkedData, Authorize, Audit,
ApiDocs, Docs, Login, OidcCallback, Landing), `src/lib/api.js` (fetch client +
single-flight refresh rotation), `src/lib/auth.jsx` (session context),
`src/components/WorkflowEditor.jsx`, `src/components/Chatbot.jsx`,
`public/config.js` (runtime `SYNAPSEONE_CONFIG.BASE_URL`), `nginx.conf`,
`docker-entrypoint.sh`.

**Rules:** calls the gateway only; API base URL comes from runtime config
(`SYNAPSEONE_PUBLIC_BASE_URL` substituted at container start) or
`VITE_SYNAPSEONE_BASE_URL` in dev. Auth tokens in local storage; 401 triggers one
single-flight refresh, then clears session. Dev proxy: `/api` → gateway.

---

## SDKs and CLI

- `sdks/sdk-js` — `@synapseone/sdk`, TypeScript, zero runtime deps; namespaces
  `iam`, `workflow`, `lds`, `base`, `faststore`, `queue`, `inference`; legacy
  flat methods deprecated.
- `sdks/sdk-python` — `synapseone-sdk`, Python 3.9+, `requests` only; same
  namespaces.
- `sdks/sdk-go` — `synapseone-sdk-go`, Go 1.22+, stdlib only; typed
  `BaseCollection`; install via `replace` (monorepo path has uppercase letters).
- `tools/cli` — `@synapseone/cli`, zero deps, Node 18+, `synapseone` binary.
  Commands cover auth, orgs/accounts/users/roles/policies/keys/service accounts,
  workflows/executions/templates/webhooks, LDS, and a generic `call` escape
  hatch; there are no first-class Base/Faststore/Queue/Inference commands yet.
  See `tools/cli/README.md`.

When adding/changing an API, update all three SDKs and the CLI tests if the
surface is user-facing.

---

## Infra

- `docker-compose.yml` — postgres, redis, s3 + s3-init, Authentik
  server/worker + DB init, all services, console, Prometheus + exporters.
- `docker-compose.prod.yml`/`.tls.yml` — production edge (nginx/Certbot),
  hardened secrets; `infra/prod/`.
- `infra/k8s/base/` — Kustomize manifests + secret examples.
- `infra/monitoring/prometheus/` — scrape config + alert rules.
- `infra/postgres/init.sql` — extensions + `drizzle` schema only.
- `examples/quickstart/`, `examples/workflow-templates/` — demo flows.
- `tests/e2e/` — smoke/API/SDK/inference checks (fixed slugs).
