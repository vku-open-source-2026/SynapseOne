# Configuration (env reference)

[Tiếng Việt](vi/configuration.md) · English

Copy `.env.example` → `.env` and replace every `*_change_me_*` value. Which service
reads which key (audited from source):

## Gateway (`apps/gateway`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` (fallback `GATEWAY_PORT`) | 8080 | listen port (inside the container) |
| `IAM_SERVICE_URL` | `http://iam:4001` | IAM upstream |
| `WORKFLOW_SERVICE_URL` | `http://workflow:4002` | workflow upstream |
| `AI_SERVICE_URL` | `http://ai:4003` | AI assistant upstream |
| `LDS_SERVICE_URL` | `http://lds:4004` | SynapseLDS upstream |
| `BASE_SERVICE_URL` | `http://base:4005` | SynapseBase upstream |
| `FASTSTORE_SERVICE_URL` | `http://faststore:4006` | Synapse Faststore upstream |
| `QUEUE_SERVICE_URL` | `http://queue:4007` | SynapseQueue upstream |
| `STREAM_SERVICE_URL` | `http://stream:4009` | SynapseStream upstream (also probed by `/ready`) |
| `INFERENCE_SERVICE_URL` | `http://inference:4008` | Inference upstream (also probed by `/ready`) |
| `OCS_SERVICE_URL` | `http://ocs:4010` | SynapseOCS upstream |
| `NOTIFICATIONS_SERVICE_URL` | `http://notifications:4011` | SynapseNotifications upstream |
| `WAREHOUSE_SERVICE_URL` | `http://warehouse:4012` | Synapse Warehouse upstream |
| `LAKEHOUSE_SERVICE_URL` | `http://lakehouse:4013` | Synapse Lakehouse upstream |
| `AUTHZ_MODE` | `off` | central policy enforcement: `off` = tenant isolation only; `audit` = decide every authenticated request via IAM, log + header `x-synapseone-authz: would-deny`, never block; `enforce` = `403 access_denied`, IAM unreachable → `503 authz_unavailable` |
| `AUTHZ_CACHE_TTL_MS` | 30000 | decision cache per principal/action/resource (0 disables, max 300000) — policy changes take effect after at most this long |
| `AUTHZ_MODE_REQUIRED` | `false` | production fail-closed guard: when `true`, gateway refuses to boot with `AUTHZ_MODE=off` |
| `AUTHZ_AUDIT_ACK` | unset | production-only, owner/expiry acknowledgement required to run `AUTHZ_MODE=audit` (e.g. `owner=security;expires=2026-12-01;reason=policy-backfill`). Without it the gateway refuses to boot in production |
| `PLATFORM_ADMIN_ENABLED` | `true` dev / `false` prod unless set | enables `/v1/platform/*` and the `/admin` console |
| `PLATFORM_ADMIN_REQUIRE_MFA` | `true` | platform session exchange requires an enrolled TOTP factor and a fresh code |
| `PLATFORM_ADMIN_REQUIRE_STEP_UP` | `true` | destructive platform actions require `x-platform-step-up` |
| `PLATFORM_ORG_SLUG` | `synapseone-platform` | reserved organization for platform staff |
| `PLATFORM_BOOTSTRAP_SECRET` | — | one-time internal first-owner bootstrap; empty disables the endpoint |
| `PLATFORM_RECOVERY_SECRET` | — | internal break-glass reset for a platform administrator who lost MFA |
| `IAM_SENSITIVE_MUTATION_MODE` | `audit` | `audit` logs would-deny; `enforce` requires an org administrator for privileged IAM mutations. Production boot **requires `enforce`**; `.env.example` sets it. |
| `IAM_ALLOW_DIRECT_ORG_CREATE` | `true` dev / `false` prod | direct `POST /v1/orgs`; platform API creates orgs with a first admin |
| `IAM_JWT_SECRET` | — | **must match** IAM, used to verify Bearer tokens |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | routing table |
| `GATEWAY_VERIFY_APIKEY` | `true` | `true` → centralized `X-API-Key` verification via IAM (fail-closed 503 when IAM is down); `false` → edge presence check, upstream verifies (dev-only, forbidden in production) |
| `PROXY_TIMEOUT_MS` | 30000 | upstream timeout (504 when exceeded) |
| `CORS_ORIGIN` | (allow all) | `a.com,b.com` → only those origins (production) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | gateway → service credential (`x-synapseone-internal` header); **identical** on every service in production |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| `TRUST_PROXY` | `false` | Express trust-proxy: unset/`0` = direct exposure; `1` behind one nginx/Ingress hop; or a CIDR/name list. `true` is rejected (XFF spoofing). |
| `AI_QUOTA_REQUESTS_PER_MIN` / `INFERENCE_QUOTA_REQUESTS_PER_MIN` / `WORKFLOW_QUOTA_REQUESTS_PER_MIN` | 30 / 60 / 120 | canonical per-tenant request/minute defaults; legacy `AI_RATE_LIMIT` and `INFERENCE_RATE_LIMIT_PER_MIN` remain fallback inputs |
| `AI_QUOTA_REQUESTS_PER_5H` / `INFERENCE_QUOTA_REQUESTS_PER_5H` / `WORKFLOW_QUOTA_REQUESTS_PER_5H` | minute × 300 | fixed epoch-five-hour request defaults |
| `AI_QUOTA_REQUESTS_PER_DAY` / `INFERENCE_QUOTA_REQUESTS_PER_DAY` / `WORKFLOW_QUOTA_REQUESTS_PER_DAY` | minute × 1440 | fixed UTC-calendar-day request defaults |
| `AI_QUOTA_TOKENS_PER_DAY` / `INFERENCE_QUOTA_TOKENS_PER_DAY` | 1000000 / 1000000 | existing best-effort daily token budgets |
| `WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` / `WORKFLOW_QUOTA_CONCURRENT` | 1000 / 10 | shared workflow execution/hour and in-flight lease defaults for normal routes and MCP calls |
| `QUOTA_CACHE_TTL_MS` | 30000 | IAM effective-quota/meter cache (0–300000 ms) |
| `GATEWAY_SESSION_CACHE_MS` | `2000` | session/credential revalidation cache (1–30000 ms). Suspension, disable, account retirement and key revocation take effect within this window; 403 results are cached for the same window. |
| `AUTHZ_CACHE_TTL_MS` | `30000` | policy decision cache per principal/action/resource (0 disables, max 300000). Role/policy edits take effect within this window; lifecycle state is checked by the 2 s session cache first. |
| `VALKEY_URL` / `REDIS_URL` | — (memory) | `redis://...` → Redis-protocol backend for services that opt in (legacy name `REDIS_URL` still honoured). The gateway's edge limiter is in-memory. |
| `GATEWAY_HOST_PORT` | 8080 | host port (compose only) |

## IAM (`apps/iam-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4001 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → enables the Postgres backend |
| `IAM_QUOTA_VALKEY_URL` | falls back to `VALKEY_URL`, then `REDIS_URL` | Valkey used by atomic `/internal/quota/check`; unavailable/empty → 503 so the gateway uses its local minute fallback |
| `AI_QUOTA_REQUESTS_PER_MIN` / `AI_QUOTA_REQUESTS_PER_5H` / `AI_QUOTA_REQUESTS_PER_DAY` | 30 / 9000 / 43200 | AI global request defaults; 5h/day derive from the effective minute value when unset |
| `INFERENCE_QUOTA_REQUESTS_PER_MIN` / `INFERENCE_QUOTA_REQUESTS_PER_5H` / `INFERENCE_QUOTA_REQUESTS_PER_DAY` | 60 / 18000 / 86400 | inference global request defaults; 5h/day derive when unset |
| `WORKFLOW_QUOTA_REQUESTS_PER_MIN` / `WORKFLOW_QUOTA_REQUESTS_PER_5H` / `WORKFLOW_QUOTA_REQUESTS_PER_DAY` | 120 / 36000 / 172800 | workflow global request defaults; 5h/day derive when unset |
| `AI_QUOTA_TOKENS_PER_DAY` / `INFERENCE_QUOTA_TOKENS_PER_DAY` | 1000000 / 1000000 | nullable-inherited effective token defaults |
| `WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` / `WORKFLOW_QUOTA_CONCURRENT` | 1000 / 10 | workflow execution and concurrency defaults |
| `IAM_JWT_SECRET` | — | HS256 for access/service JWTs (≥32 random chars); boot fails in `NODE_ENV=production` when weak/default |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 (seconds) | token TTLs (clamped 60–86400 / 3600–315360000; garbage env falls back to default) |
| `IAM_API_KEY_PEPPER` | — (plain SHA-256) | HMAC pepper for API-key/refresh-token hashes at rest; keys created before the pepper still verify (legacy fallback) |
| `IAM_MFA_ENCRYPTION_KEY` | — (HKDF of `IAM_JWT_SECRET`) | 32-byte key (hex/base64) sealing TOTP secrets with AES-256-GCM. Set it explicitly in production. Existing seals made with the legacy HKDF key remain readable (fallback); new seals use this key. Keep the old key available until all users re-enrol. |
| `IAM_MFA_ISSUER` | `SynapseOne` | issuer label in the `otpauth://` URL shown by authenticator apps |
| `IAM_LOGIN_MAX_FAILURES` / `IAM_LOGIN_LOCKOUT_SECONDS` | `5` / `900` | consecutive wrong passwords or MFA codes before a temporary lock (`429 account_locked` + `Retry-After`); org admins can `POST /v1/users/:id/unlock` |
| `IAM_LOGIN_RATE_LIMIT_PER_MIN` / `IAM_MFA_RATE_LIMIT_PER_MIN` | `60` / `60` | per-IP request ceiling on `POST /v1/auth/login` and on the MFA, MFA-reset and unlock routes (`429 rate_limited`); complements the per-user lockout |
| `AUDIT_RETENTION_DAYS` | `0` (disabled) | hourly purge of `audit_log` rows older than N days (batched, clamped 1–3650); prod e.g. `180` |
| `AUDIT_TRAIL` | `true` | data-plane services (Base/Faststore/Queue/Stream/Workflow/LDS) emit one mutation audit event per write to IAM (`POST /v1/audit/ingest`). Set `false` only in local dev |
| `AUDIT_INGEST_URL` | `${IAM_SERVICE_URL}/v1/audit/ingest` | override the data-plane audit sink (tests/staging) |
| `IAM_ALLOW_DEV_LOGIN` | `true` | controls only the passwordless dev login path; `false` in production still allows email+password, OIDC and API keys |
| `IAM_ALLOW_OIDC_DEMO_CALLBACK` | `true` | demo callback trusts the caller-supplied email (impersonation possible) — production **must** be `false` (then a real IdP `code` is required) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` (except `/v1/auth/*`) — blocks direct `:4001` bypass |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| `OIDC_PROVIDER` | `authentik` | IdP display name (`authentik`\|`keycloak`) |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | see `.env.example` | federated OIDC (Authentik/Keycloak). For SPA login, point `OIDC_REDIRECT_URI` at the Console's `/oidc/callback` page (e.g. `https://cloud.example.com/oidc/callback`) |
| `IAM_REGISTRATION_ENABLED` | `true` | first-party registration (`POST /v1/auth/register`); set `false` for OIDC-only deployments |
| `IAM_REGISTRATION_ALLOW_NEW_ORGS` | `true` | self-service creation of a brand-new org on register; joining an existing org always requires an invitation |
| `IAM_EXPOSE_LIFECYCLE_TOKENS` | `false` | **opt-in** dev convenience for self-service **password-reset and email-verify** tokens when no mailer is wired. Always off in production (`NODE_ENV=production`, or `SYNAPSEONE_ENV`/`SYNAPSEDX_ENV`/`APP_ENV`/`ENVIRONMENT` = `production`/`prod`). Organization/user activation codes are returned only by authorized admin/platform routes (platform owner/operator + step-up where required), never by public recovery endpoints. |
| `IAM_RESET_TOKEN_TTL_SECONDS` / `IAM_VERIFY_TOKEN_TTL_SECONDS` | `3600` / `86400` | single-use token TTLs (clamped) |
| `OIDC_ALLOWED_ORGS` | — (any slug) | comma-separated org **slugs** allowed through OIDC → `403 org_not_allowed` otherwise. A new slug is self-service (org is created on first login); joining an **existing** org always requires an existing membership (`403 org_membership_required`) |

## Quota enforcement and rollout

Use the same canonical `*_QUOTA_*` values on IAM and gateway. Request windows are
fixed epoch-minute, epoch-five-hour and UTC-day buckets; they are not sliding.
IAM's Valkey Lua operation checks all three before incrementing any and applies
TTLs atomically. A Valkey outage produces `503 quota_unavailable`, and the
gateway fails open to its in-memory minute limiter. Anonymous traffic always
uses that local limiter. Production should keep `IAM_QUOTA_VALKEY_URL` (or
`VALKEY_URL`) reachable and monitor 503s; a local-only fallback is per replica
and is not a substitute for shared quota enforcement.

For rollback, restore previous images/env first and keep the additive
`org_quotas` table plus migration journal. Old images ignore the new columns.
Counters expire by fixed-window TTL; do not flush unrelated Valkey namespaces.

## Workflow (`apps/workflow-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4002 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend (`synapseone_workflows` + `synapseone_executions`); required in production |
| `WORKFLOW_CRON_TICK_MS` | 15000 | cron scheduler tick (ms, clamped ≥10000) |
| `WORKFLOW_TIMEOUT_MS` | 60000 | hard execution budget for workflows without `settings.timeoutMs` (clamped 1000–300000). AI templates set 300000 |
| `WORKFLOW_EXECUTION_MODE` | `queue` (Compose) / `auto` | `queue` requires SynapseQueue; `inline` runs in the request; `auto` picks queue when `QUEUE_SERVICE_URL` is set |
| `QUEUE_SERVICE_URL` | `http://queue:4007` | internal SynapseQueue base URL for publishing/consuming workflow jobs |
| `WORKFLOW_WORKER_ENABLED` | true | run the built-in platform worker |
| `WORKFLOW_WORKER_CONCURRENCY` | 4 | parallel platform jobs (1–32) |
| `WORKFLOW_WORKER_POLL_MS` | 500 | platform worker queue poll interval |
| `WORKFLOW_QUEUE_VISIBILITY_SECONDS` | 300 | job lease / visibility timeout (30–3600) |
| `WORKFLOW_QUEUE_MAX_ATTEMPTS` | 5 | queue delivery attempts before DLQ |
| `WORKFLOW_QUEUE_PLATFORM` | `synapseone-wf-platform` | queue for `platform` workflows |
| `WORKFLOW_QUEUE_CUSTOM` | `synapseone-wf-custom` | queue for `custom` workflows |
| `WORKFLOW_QUEUE_SHARED` | `synapseone-wf-shared` | queue for `hybrid` workflows |
| `WORKFLOW_QUEUE_INFERENCE` | `synapseone-inference` | queue for inference/hybrid runner jobs |
| `WORKFLOW_SYSTEM_QUEUE_TENANT_MAX` | 100 | max queued+running system-runner executions per tenant (0 disables the admission cap) |
| `MCP_ALLOW_ANONYMOUS` | `false` | opt-in anonymous MCP; only structurally read-only public tools are exposed. The gateway still requires authentication for `/mcp` |
| `MCP_ANONYMOUS_RATE_LIMIT_PER_MIN` | 30 | per-source-IP anonymous MCP request limit when the opt-in above is enabled |
| `WORKFLOW_MCP_QUOTA_ENFORCEMENT` | true in production / false in dev | MCP-only switch for the shared IAM execution-hour/concurrency admission on every actual `tools/call`, including batches; normal gateway execution routes always enforce it and quota-store failure fails closed |
| `SYNAPSEONE_PUBLIC_URL` | `https://api.synapseone.space` | gateway URL embedded in runner commands |
| `WORKFLOW_RUNNER_IMAGE` | `ghcr.io/.../synapseone-workflow-runner:latest` | runner image embedded in commands |
| `WORKFLOW_RUNNER_HEARTBEAT_SECONDS` | 15 | connector heartbeat interval (5–300) |
| `WORKFLOW_RUNNER_STALE_SECONDS` | 60 | a connector is offline after this many seconds without heartbeat (30–3600) |
| `WORKFLOW_RUNNER_MAX_CONCURRENCY` | 32 | max per-connector concurrency (1–64) |
| `INFERENCE_TIMEOUT_MS` | 120000 | per-call budget for workflow → inference LLM requests (clamped 1000–300000) |
| `IAM_SERVICE_URL` | `http://iam:4001` | internal base URL for `synapseone.api` IAM nodes (users/roles/policies/audit/keys) |
| `SYNAPSEONE_IAM_API_KEY` | — | service API key sent as `X-API-Key` on `synapseone.api` IAM calls; IAM requires a real caller credential even with the internal secret. Create it on the workflow service account (`POST /v1/accounts/:accountId/keys`, scope `*`). Unset → IAM nodes fail with a clear configuration error |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4002` bypass (`/webhook/*` stays public) |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |

## AI agent (`apps/ai-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4003 | listen port |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible LLM provider (key stays server-side, never reaches the browser) |
| `AI_API_KEY` | — | provider key; unset → `/v1/ai/agent` answers `503 ai_not_configured` |
| `AI_DECISION_MODEL` / `AI_LLM_MODEL` | `inception/mercury-2.5` / `liquid/lfm-2.5-2.6b:free` | endpoint-picker model / call-generator model |
| `AI_TIMEOUT_MS` | 20000 | per-LLM-call timeout (clamped 1s–300s) |
| `AI_RETRIES` | 2 | extra attempts on empty/invalid/5xx LLM replies (clamped 0–3; 4xx fail fast) |
| `AI_LLM_FALLBACK_MODEL` | decision model | different-provider fallback for generate/guide after the primary exhausts retries; empty disables |
| `AI_RATE_LIMIT` | 30 | agent calls per principal per minute (clamped 1–1000; LLM calls cost money) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4003` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |

## Linked data — SynapseLDS (`apps/lds-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4004 | listen port (gateway route `/v1/lds`, auth `either`) |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend (`lds_datasources` + `lds_attributes` + `lds_records`); required in production |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4004` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |

Records are stored as `{_core, entity, attributes}`; the NGSI-LD projector only reads
`entity` + registry-approved `attributes` (structural allowlist), so `_core` (tenant,
internal id, source id, actor, any future field) can never be serialized. Unregistered
attributes default-deny; visibility is resolved at read time from the registry
(`public|restricted|internal`, restricted needs an in-org principal).

## Base — SynapseBase (`apps/base-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4005 | listen port (gateway route `/v1/base`, auth `either`) |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend; **required in production** (otherwise a per-process in-memory store) |
| `BASE_MAX_DOCUMENT_BYTES` | 262144 | max serialized document size, clamped 1024..4194304 |
| `BASE_QUERY_SCAN_LIMIT` | 200000 | in-memory fallback only: max documents scanned per query (batched), clamped 100..1000000. Postgres queries use pushdown and never hit this cap |
| `STREAM_SERVICE_URL` | — | enables the transactional-outbox relay to SynapseStream; empty disables delivery |
| `BASE_OUTBOX_STREAM_TOPIC` | `base-changes` | destination topic |
| `BASE_OUTBOX_RELAY_MS` | 1000 | relay poll interval, clamped 100..60000 |
| `BASE_OUTBOX_MAX_ATTEMPTS` | 20 | transient failures before quarantine, clamped 1..1000 |
| `BASE_OUTBOX_RETRY_BASE_MS` | 1000 | first exponential-backoff step, clamped 50..600000 |
| `BASE_OUTBOX_RETRY_MAX_MS` | 300000 | backoff cap, clamped between base and 3600000 |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4005` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `BASE_SERVICE_HOST_PORT` | `127.0.0.1:4005` | compose host binding |

## Warehouse — Synapse Warehouse (`apps/warehouse-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4012 | listen port (gateway route `/v1/warehouse`) |
| `WAREHOUSE_DATA_DIR` | `/data/warehouse` | durable DuckDB directory; `:memory:` is rejected in production |
| `WAREHOUSE_OCS_MAX_FILE_BYTES` | `67108864` | maximum staged OCS object size for CSV/JSONL/Parquet import |
| `OCS_SERVICE_URL` | `http://ocs:4010` | trusted OCS object source for Warehouse file ingestion |
| `WAREHOUSE_THREADS` | 2 | DuckDB worker threads per tenant connection |
| `WAREHOUSE_QUERY_TIMEOUT_MS` | 15000 | query timeout, bounded by the service |
| `WAREHOUSE_MAX_BODY` | 8mb | request body cap |
| `STREAM_SERVICE_URL` | `http://stream:4009` | stream ETL source and topic setup |
| `BASE_SERVICE_URL` | `http://base:4005` | Base snapshot ETL source |
| `SYNAPSEONE_INTERNAL_SECRET` | — | required in production; service-to-service auth |
| `CORS_ORIGIN` | — | allowed browser origins (comma-separated) |
| `WAREHOUSE_SERVICE_HOST_PORT` | `127.0.0.1:4012` | compose host binding |

Warehouse images link the official DuckDB 2.0.0 shared library (pinned URL +
SHA256 in the Dockerfile) instead of compiling the bundled C++ engine. Tenant
SQL still runs with external file/network access disabled.

## Lakehouse — Apache Iceberg (`apps/lakehouse-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4013 | listen port (gateway route `/v1/lakehouse`) |
| `LAKEHOUSE_CATALOG_URI` | — (SQLite dev fallback) | SQLAlchemy URI for the Iceberg SQL catalog; production requires Postgres (`postgresql+pg8000://...`, BSD-licensed driver) |
| `LAKEHOUSE_WAREHOUSE` | — (file dev fallback) | `s3://bucket/prefix` for Parquet/metadata; production requires S3 |
| `LAKEHOUSE_S3_ENDPOINT` | — | S3-compatible endpoint (SeaweedFS/OCS backend) |
| `LAKEHOUSE_S3_ACCESS_KEY` / `LAKEHOUSE_S3_SECRET_KEY` | — | service-owned S3 credentials (never tenant credentials) |
| `LAKEHOUSE_S3_REGION` | `us-east-1` | S3 signing region |
| `LAKEHOUSE_MAX_NAMESPACES` | 20 | per-tenant namespace quota |
| `LAKEHOUSE_MAX_TABLES_PER_NAMESPACE` | 100 | per-namespace table quota |
| `LAKEHOUSE_MAX_ROWS_PER_APPEND` | 5000 | append row cap |
| `LAKEHOUSE_MAX_BYTES` | 1073741824 | tenant byte quota; estimated from current-snapshot file sizes plus the incoming JSON payload |
| `SYNAPSEONE_INTERNAL_SECRET` | — | required in production; tenant headers are trusted only with it |
| `LAKEHOUSE_SERVICE_HOST_PORT` | `127.0.0.1:4013` | compose host binding |

The service creates real Iceberg v2 metadata, Parquet files, manifests and
snapshots through PyIceberg. Data files are retained on table drop; snapshot
expiration/orphan cleanup is an explicit operator action, not automatic.
Warehouse reads tables through a trusted internal materialization
(`POST /v1/warehouse/etl/lakehouse`), never by granting tenant SQL filesystem
access.

## Faststore — Synapse Faststore (`apps/faststore-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4006 | listen port (gateway route `/v1/faststore`, auth `either`) |
| `FASTSTORE_VALKEY_URL` | falls back to `FASTSTORE_REDIS_URL`, `VALKEY_URL`, `REDIS_URL` | `redis://...` → Valkey backend (Redis protocol); **required in production** |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4006` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `FASTSTORE_SERVICE_HOST_PORT` | `127.0.0.1:4006` | compose host binding |

## Queue — SynapseQueue (`apps/queue-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4007 | listen port (gateway route `/v1/queue`, auth `either`) |
| `QUEUE_VALKEY_URL` | falls back to `QUEUE_REDIS_URL`, `VALKEY_URL`, `REDIS_URL` | `redis://...` → Valkey backend (Redis protocol); **required in production** (an in-memory queue would split-brain across replicas) |
| `QUEUE_MAX_PAYLOAD_BYTES` | 262144 | max serialized message payload, clamped 1024..1048576 |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4007` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `QUEUE_SERVICE_HOST_PORT` | `127.0.0.1:4007` | compose host binding |

The three data services share the platform tenancy model: principal callers are
scoped to their org/account/user; platform callers must select a tenant with
`x-synapseone-tenant` (Faststore/Queue) or `?orgId`/`?accountId` (Base). The gateway
forwards `x-synapseone-tenant` and strips the other client-supplied identity headers.
API-key principals now also carry the owning **org** (resolved by IAM), so JWT and
API-key traffic of one org share the `org:<id>` namespace and usage attribution (#28).

## Stream — SynapseStream (`apps/stream-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4009 | listen port (gateway route `/v1/stream`) |
| `STREAM_ENGINE` | derives from the URL | `valkey`/`redis` (same engine)/`memory`/registered driver; **`memory` is forbidden in production** |
| `STREAM_VALKEY_URL` | falls back to `STREAM_REDIS_URL`, `VALKEY_URL`, `REDIS_URL` | durable engine URL; required in production when `STREAM_ENGINE` is unset |
| `STREAM_MAX_PAYLOAD_BYTES` | 262144 | max message payload |
| `SYNAPSEONE_INTERNAL_SECRET` | — | required in production (boot aborts without it) |
| `CORS_ORIGIN` | — | required in production (wildcard CORS is rejected) |

## Inference (`apps/inference-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4008 | listen port (gateway route `/v1/inference`) |
| `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter defaults | LLM provider + model |
| `OPENROUTER_TIMEOUT_MS` / `OPENROUTER_RETRIES` | 30000 / 2 | upstream call budget/retries |
| `EMBEDDING_MODEL_NAME` / `DECISION_MODEL_NAME` | local models | self-hosted model ids |
| `DECISION_BACKEND` | `local` | `local` Decision-2.0 or `openrouter` `/api/alpha/decisions` |
| `IAM_SERVICE_URL` | `http://iam:4001` | usage/token metering target |
| `INFERENCE_USAGE_REPORTING` | `true` | report prompt/completion tokens to IAM usage analytics |
| `SYNAPSEONE_INTERNAL_SECRET` | — | required in production |
| `CORS_ORIGIN` | — | required in production (wildcard CORS is rejected) |

## Object storage (`apps/ocs-service`)

See `docs/object-storage.md`. Key settings: `STORAGE_BACKEND` (`fs|s3`, required in
production), `STORAGE_S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY/PATH_STYLE`,
`STORAGE_FS_ROOT`, `STORAGE_MAX_OBJECT_BYTES` (25 MiB by default; production
sets 128 MiB for signed release uploads), `STORAGE_TENANT_QUOTA_BYTES`
(5 GiB), `STORAGE_ALLOWED_CONTENT_TYPES`.

## Backups (`pg-backup`, `s3-backup` in docker-compose.yml)

| Key | Default | Meaning |
|---|---|---|
| `BACKUP_INTERVAL_SECONDS` | `86400` | time between runs of both backup services |
| `BACKUP_RETENTION_DAYS` | `7` | Postgres dumps and object snapshots older than this are removed (the newest snapshot is always kept) |
| `BACKUP_DATABASES` | `${POSTGRES_DB} authentik` | space-separated databases `pg-backup` dumps (missing ones are skipped) |

`pg-backup` uses `POSTGRES_USER`/`POSTGRES_PASSWORD`; `s3-backup` uses the same
`STORAGE_S3_*` settings as OCS. Volumes: `pgbackups`, `s3backups`. See
`docs/production.md` and `docs/object-storage.md`.

## Notifications (`apps/notifications-service`)

See `docs/notifications.md`. Key settings: `DATABASE_URL` (required in production),
`NOTIFICATIONS_QUEUE_URL`/`_QUEUE_NAME` (SynapseQueue delivery),
`NOTIFICATIONS_EMAIL_RELAY_URL`/`_SMS_RELAY_URL`/`_PUSH_RELAY_URL`,
`NOTIFICATIONS_MAX_ATTEMPTS` (5), `NOTIFICATIONS_RETRY_BASE_SECONDS` (5),
`NOTIFICATIONS_RATE_LIMIT_PER_MIN` (120).

## Console (`apps/console`, runtime via `config.js`)

| Key | Default | Meaning |
|---|---|---|
| `SYNAPSEONE_PUBLIC_BASE_URL` | `http://localhost:8080` | gateway URL the **browser** calls (must be browser-reachable, not a docker hostname) |
| `CONSOLE_APP_URL` | `http://localhost:3000` | canonical app host; the landing domain redirects sign-in here in multi-domain deploys |

## Core data / external engines

> **Valkey, not Redis.** The datastore is [Valkey](https://valkey.io) 8 (BSD-3,
> Linux Foundation). It is wire-compatible with Redis 7: the same client
> library, Lua scripts, Streams and pub/sub work unchanged, and it loads an
> existing Redis AOF/RDB. Redis 7.4+ switched to a non-OSI licence, so the
> platform no longer ships it. Preferred env names are `VALKEY_URL`,
> `FASTSTORE_VALKEY_URL`, `QUEUE_VALKEY_URL`, `STREAM_VALKEY_URL`; the
> `*_REDIS_URL` names remain supported as aliases. In compose the service is
> `valkey` and the volume keeps its original name (`redisdata`) so an in-place
> upgrade preserves data.

Postgres (`POSTGRES_*`; IAM, workflow, LDS and Base), Valkey (`VALKEY_URL`;
Faststore, Queue and Stream; `REDIS_URL` is still accepted as the legacy alias and
the URL keeps the `redis://` scheme), Authentik (`AUTHENTIK_*`, host ports
`AUTHENTIK_HTTP_PORT=19000`), object storage = SeaweedFS (`s3` service; its only
identity is `STORAGE_S3_ACCESS_KEY`/`STORAGE_S3_SECRET_KEY`, falling back to
`S3_ACCESS_KEY`/`S3_SECRET_KEY`; host port `S3_HOST_PORT=9090`; data volume
`seaweeddata`).
