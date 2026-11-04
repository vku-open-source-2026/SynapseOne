# Configuration (env reference)

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
| `STORAGE_SERVICE_URL` | `http://storage:4010` | SynapseObjectStorage upstream |
| `NOTIFICATIONS_SERVICE_URL` | `http://notifications:4011` | SynapseNotifications upstream |
| `AUTHZ_MODE` | `off` | central policy enforcement: `off` = tenant isolation only; `audit` = decide every authenticated request via IAM, log + header `x-synapseone-authz: would-deny`, never block; `enforce` = `403 access_denied`, IAM unreachable → `503 authz_unavailable` |
| `AUTHZ_CACHE_TTL_MS` | 30000 | decision cache per principal/action/resource (0 disables, max 300000) — policy changes take effect after at most this long |
| `IAM_JWT_SECRET` | — | **must match** IAM, used to verify Bearer tokens |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | routing table |
| `GATEWAY_VERIFY_APIKEY` | `true` | `true` → centralized `X-API-Key` verification via IAM (fail-closed 503 when IAM is down); `false` → edge presence check, upstream verifies (dev-only, forbidden in production) |
| `PROXY_TIMEOUT_MS` | 30000 | upstream timeout (504 when exceeded) |
| `CORS_ORIGIN` | (allow all) | `a.com,b.com` → only those origins (production) |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | gateway → service credential (`x-synapseone-internal` header); **identical** on every service in production |
| `HSTS_ENABLED` | `false` | `true` → send `Strict-Transport-Security` (only behind TLS) |
| `TRUST_PROXY` | `false` | Express trust-proxy: unset/`0` = direct exposure; `1` behind one nginx/Ingress hop; or a CIDR/name list. `true` is rejected (XFF spoofing). |
| `INFERENCE_RATE_LIMIT_PER_MIN` | `60` | per-tenant AI/inference quota; `429` + `Retry-After` when exceeded |
| `REDIS_URL` | — (memory) | `redis://...` → Redis-backed rate limiting (shared across replicas, fail-open when Redis is down) |
| `GATEWAY_HOST_PORT` | 8080 | host port (compose only) |

## IAM (`apps/iam-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4001 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → enables the Postgres backend |
| `REDIS_URL` | — | reserved (centralized session/ratelimit, v0.2) |
| `IAM_JWT_SECRET` | — | HS256 for access/service JWTs (≥32 random chars); boot fails in `NODE_ENV=production` when weak/default |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 (seconds) | token TTLs (clamped 60–86400 / 3600–315360000; garbage env falls back to default) |
| `IAM_API_KEY_PEPPER` | — (plain SHA-256) | HMAC pepper for API-key/refresh-token hashes at rest; keys created before the pepper still verify (legacy fallback) |
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
| `IAM_EXPOSE_LIFECYCLE_TOKENS` | `true` (dev) | return reset/verification tokens in API responses when no mailer is wired; forced off in production |
| `IAM_RESET_TOKEN_TTL_SECONDS` / `IAM_VERIFY_TOKEN_TTL_SECONDS` | `3600` / `86400` | single-use token TTLs (clamped) |
| `OIDC_ALLOWED_ORGS` | — (any slug) | comma-separated org **slugs** allowed through OIDC → `403 org_not_allowed` otherwise. A new slug is self-service (org is created on first login); joining an **existing** org always requires an existing membership (`403 org_membership_required`) |

## Workflow (`apps/workflow-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4002 | listen port |
| `DATABASE_URL` | — (memory) | `postgres://...` → Postgres backend (`synapseone_workflows` + `synapseone_executions`); required in production |
| `WORKFLOW_CRON_TICK_MS` | 15000 | cron scheduler tick (ms, clamped ≥10000) |
| `WORKFLOW_TIMEOUT_MS` | 60000 | hard execution budget for workflows without `settings.timeoutMs` (clamped 1000–300000). AI templates set 300000 |
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
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4005` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `BASE_SERVICE_HOST_PORT` | `127.0.0.1:4005` | compose host binding |

## Faststore — Synapse Faststore (`apps/faststore-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4006 | listen port (gateway route `/v1/faststore`, auth `either`) |
| `FASTSTORE_REDIS_URL` | falls back to `REDIS_URL` | `redis://...` → Redis backend; **required in production** |
| `SYNAPSEONE_INTERNAL_SECRET` | — (dev) | requires a matching `x-synapseone-internal` header on every `/v1/*` — blocks direct `:4006` bypass |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | same semantics as the other services |
| `FASTSTORE_SERVICE_HOST_PORT` | `127.0.0.1:4006` | compose host binding |

## Queue — SynapseQueue (`apps/queue-service`)

| Key | Default | Meaning |
|---|---|---|
| `PORT` | 4007 | listen port (gateway route `/v1/queue`, auth `either`) |
| `QUEUE_REDIS_URL` | falls back to `REDIS_URL` | `redis://...` → Redis backend; **required in production** (an in-memory queue would split-brain across replicas) |
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
| `STREAM_ENGINE` | derives from Redis | `redis`/`memory`/registered driver; **`memory` is forbidden in production** |
| `STREAM_REDIS_URL` | falls back to `REDIS_URL` | durable engine URL; required in production when `STREAM_ENGINE` is unset |
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
| `IAM_SERVICE_URL` | `http://iam:4001` | usage/token metering target |
| `INFERENCE_USAGE_REPORTING` | `true` | report prompt/completion tokens to IAM usage analytics |
| `SYNAPSEONE_INTERNAL_SECRET` | — | required in production |
| `CORS_ORIGIN` | — | required in production (wildcard CORS is rejected) |

## Object storage (`apps/storage-service`)

See `docs/object-storage.md`. Key settings: `STORAGE_BACKEND` (`fs|s3`, required in
production), `STORAGE_S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY/PATH_STYLE`,
`STORAGE_FS_ROOT`, `STORAGE_MAX_OBJECT_BYTES` (25 MiB), `STORAGE_TENANT_QUOTA_BYTES`
(5 GiB), `STORAGE_ALLOWED_CONTENT_TYPES`.

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

Postgres (`POSTGRES_*`; IAM, workflow, LDS and Base), Redis (`REDIS_URL`; gateway
rate limiting, Faststore and Queue), Authentik (`AUTHENTIK_*`, host ports
`AUTHENTIK_HTTP_PORT=19000`), S3 (`S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY`,
`S3_HOST_PORT=9090`).
