# SynapseOne — Tham chiếu service

[English](../../agents/services.md) · Tiếng Việt

Bản đồ endpoint, file, dữ liệu, quy tắc và biến môi trường theo service. Cổng mặc
định theo Compose. Ngoài route gateway công khai, service production cần
`x-synapseone-internal` khi đặt shared secret.

Implementation: gateway, base, faststore, queue, stream, lds, ocs, notifications,
warehouse và ai chạy Rust/Axum. IAM/Workflow chạy Node/TypeScript; inference và
Lakehouse chạy Python/FastAPI. TypeScript còn lại là behavioral reference.

## Gateway — `apps/gateway` (:8080)

**Mục đích:** entry point duy nhất: route matching, authn, principal stamping,
edge hardening, telemetry và readiness tổng hợp.

**File:** `src/index.ts` (proxy/auth/limits), `routes.yaml`, `src/usage.ts`,
`src/quotas.ts` (TS reference), `src/quotas.rs` (Rust client).

**Endpoint:** `GET /`, `/health`, `/ready`, `/metrics`; các API path proxy tới
upstream. Route gồm auth, IAM, workflow, AI, inference, LDS, Base, Faststore,
Queue, Stream, OCS/storage, Notifications, Warehouse và Lakehouse.

**Quy tắc:**

- Auth mode `none|jwt|apikey|either`; route cụ thể hơn thắng route prefix.
- Xóa mọi `x-synapseone-*` từ client rồi stamp lại principal đã verify; thêm
  `x-synapseone-anon: 1` cho public route không principal.
- Verify API-key qua IAM `/v1/keys/verify` (timeout 5s, fail-closed).
- Không buffer body proxy; timeout theo route 1–300s.
- Limiter in-memory: auth 120/min, ready 30/min.
- Quota service `ai`/`inference`/`workflow`: IAM effective quota cache ~30s;
  tenant dùng `POST /internal/quota/check` cho admission nguyên tử cửa sổ cố định
  epoch-minute, epoch-five-hour và UTC-day. Anonymous và IAM/Valkey outage dùng
  minute limiter cục bộ. 429 có `window`, `limit`, `retryAfterSeconds`,
  `Retry-After`.
- Token/day vẫn best-effort. Workflow execution/hour và concurrency dùng chung một
  budget lease IAM nguyên tử: gateway admit route execute/test-run/inference-job
  thường trước request admission, còn workflow-service admit từng MCP tool call
  thật (gồm batch) qua cùng endpoint và subject `org:<id>`.
- Service-account account → org được resolve từ IAM principal verification và
  chỉ mang ở `x-synapseone-quota-org`; authorization vẫn account-bound.
- Central authorization chạy trước shared quota. Policy-denied/authz-unavailable
  không tiêu thụ budget request hay execution.
- `/mcp` dùng workflow request quota mà không buffer body.
- Scope `<service>:read|write|*` hoặc verb cụ thể; user JWT mang `*`.
- Usage telemetry bật mặc định; `USAGE_TELEMETRY=false` tắt.

**Env:** `PORT`/`GATEWAY_PORT`, `IAM_SERVICE_URL`, các `*_SERVICE_URL`,
`IAM_JWT_SECRET`, `SYNAPSEONE_INTERNAL_SECRET`, `GATEWAY_ROUTES_PATH`,
`GATEWAY_VERIFY_APIKEY`, `PROXY_TIMEOUT_MS`, `CORS_ORIGIN`, `HSTS_ENABLED`,
`USAGE_TELEMETRY`, `AI_QUOTA_REQUESTS_PER_MIN` (30),
`INFERENCE_QUOTA_REQUESTS_PER_MIN` (60), `WORKFLOW_QUOTA_REQUESTS_PER_MIN` (120),
các `*_QUOTA_REQUESTS_PER_5H` (minute × 300), `*_QUOTA_REQUESTS_PER_DAY`
(minute × 1440), `AI_QUOTA_TOKENS_PER_DAY`, `INFERENCE_QUOTA_TOKENS_PER_DAY` (1M),
`WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` (1000), `WORKFLOW_QUOTA_CONCURRENT` (10),
`QUOTA_CACHE_TTL_MS` (30s). `INFERENCE_RATE_LIMIT_PER_MIN` là fallback cũ.

## IAM — `apps/iam-service` (:4001)

**Mục đích:** identity/authorization AWS-style, token, OIDC, audit và usage.

**File:** `src/index.ts`, `src/db.ts`, `src/tokens.ts`, `src/policy.ts`,
`src/oidc.ts`, `src/schema.ts`, `src/usage.ts`, `src/quotas.ts`,
`src/quota-meter.ts`, `drizzle/`.

**API:**

- Auth: OIDC config/start/callback, login, refresh, logout/all, me, verify.
- Tenancy: `GET/POST /v1/orgs`, `GET /v1/orgs/:orgId`,
  `GET /v1/orgs/:orgId/quotas` (an toàn qua `canActForOrg`), accounts/users,
  roles/policies và các route attach/assign.
- Authz: authorize, dry-run, audit.
- Keys: create/list/get/revoke/rotate, verify; service account/token.
- Usage: ingest internal, summary/events.
- Platform: session, step-up, me, overview, orgs/resources/audit, accounts,
  users, usage, admins; tạo/xoay vòng API-key tenant bằng step-up; quota
  override/default/effective bằng step-up.
- Internal: bootstrap/recovery; `/internal/quotas[/org/:orgId]`,
  `POST /internal/quota/check`, `/internal/usage/meter`. Không có route gateway
  công khai; cần internal secret khi cấu hình.

**Dữ liệu:** organizations, accounts, users, roles, policies, role_policies,
user_roles, api_keys, service_accounts, `org_quotas` (nullable override, NULL =
default; request window cố định minute/5h/UTC-day), refresh_tokens, workflows,
usage_events, audit_log.

**Quy tắc:**

- Access JWT HS256 `iss=synapseone-iam`; refresh token single-use, rotate nguyên tử.
- API-key hash at rest; plaintext chỉ trả về một lần khi tạo/rotate. List/detail
  chỉ metadata; create/rotate có `Cache-Control: noStore`.
- Stamped tenant header chỉ tin khi có internal secret; dev verify credential.
- `canActForAccount` ưu tiên membership rồi same-org fallback cho user; machine
  credential account-bound.
- `canActForOrg` chỉ same-org; tenant không đọc platform/internal endpoint.
- Policy explicit Deny > Allow > default deny.
- Audit read tenant-scoped; optional `DATABASE_READ_URL` chỉ dùng cho SELECT audit
  sau authorization primary. Auth/quota/usage/write vẫn primary.
- `/v1/auth/verify` trả `org_id` để gateway xác định org sở hữu service-account.
- Quota check Valkey dùng Lua kiểm tra ba counter trước increment, TTL nguyên tử;
  Valkey lỗi trả 503 để gateway fallback minute cục bộ.
- Production từ chối dev login/demo callback, thiếu internal secret/DB.

**Env:** `PORT`, `DATABASE_URL`, `REDIS_URL` (reserved), `IAM_JWT_SECRET`,
`IAM_JWT_EXPIRES_IN`, `IAM_REFRESH_EXPIRES_IN`, `IAM_API_KEY_PEPPER`,
`IAM_ALLOW_DEV_LOGIN`, `IAM_ALLOW_OIDC_DEMO_CALLBACK`,
`SYNAPSEONE_INTERNAL_SECRET`, `OIDC_*`, `AUDIT_RETENTION_DAYS`,
`USAGE_RETENTION_DAYS`, `HSTS_ENABLED`, `CORS_ORIGIN`, `IAM_QUOTA_VALKEY_URL`
(fallback `VALKEY_URL`/`REDIS_URL`), `AI_QUOTA_REQUESTS_PER_MIN` (30),
`INFERENCE_QUOTA_REQUESTS_PER_MIN` (60), `WORKFLOW_QUOTA_REQUESTS_PER_MIN` (120),
`*_QUOTA_REQUESTS_PER_5H` (minute × 300), `*_QUOTA_REQUESTS_PER_DAY`
(minute × 1440), `AI_QUOTA_TOKENS_PER_DAY`, `INFERENCE_QUOTA_TOKENS_PER_DAY` (1M),
`WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` (1000), `WORKFLOW_QUOTA_CONCURRENT` (10).

## Workflow — `apps/workflow-service` (:4002)

**Mục đích:** DAG engine built-in và control plane.

**File:** `src/index.ts`, `engine.ts`, `sandbox-runner.ts`, `store.ts`,
`schema.ts`, `drizzle/`, `worker.ts`, `runner.ts`.

**API:** workflow CRUD/execute/activate/deactivate, test-run, execution
list/detail/cancel, runner registration/config/heartbeat/command, job
claim/heartbeat/complete/release/credentials, inference jobs, templates,
credentials, public webhook, MCP, health/metrics.

**Engine:** DAG queue/fan-out; expression `={{ ... }}` và `{{ ... }}` với
`$json`, `$input`, `$now`; node native/alias, `n8n-nodes-base.*`,
`synapseone.*`, `synapseone.api`.

**Trigger:** manual/test, webhook (secret-header/hmac/jwt), cron, MCP. Khi có
`QUEUE_SERVICE_URL`, trigger enqueue job; `WORKFLOW_EXECUTION_MODE=queue|inline|auto`.
Self-hosted runner dùng blocking consume, heartbeat, lease và capacity guard.

**Template:** 10 template built-in gồm webhook-to-log, cron-etl, iam-webhook,
code-transform, manual-starter, self-check, webhook-to-lds, github-push-to-log,
ai-triage-ops, customer-360.

**Dữ liệu:** workflows, executions, runners, runner instances, inference jobs,
credentials (AES-256-GCM envelope).

**Quy tắc:**

- Workflow tenant-scoped: account match HOẶC org match; không bind ngoài org.
- Execution filter theo principal snapshot; thiếu tenant scope fail-closed.
- Webhook path unique; definition 200KB, settings 8KB, ít nhất một trigger.
- Production code node chạy child process env rỗng; dev ts-node dùng vm fallback.
- Gateway và workflow-service dùng chung lease execution/hour và concurrency IAM
  nguyên tử. Accepted execute/test-run/inference-job create và MCP `tools/call`
  thật tiêu thụ cùng budget `org:<id>`; denial/read/status mutation không tiêu thụ.
- Owner-scoped platform runner dùng key hệ thống, không phải tenant credential;
  delegated token mang principal execution để data-plane đúng tenant.

**Env:** `PORT`, `DATABASE_URL`, `IAM_SERVICE_URL`, `SYNAPSEONE_IAM_API_KEY`,
`SYNAPSEONE_INTERNAL_SECRET`, `SYNAPSEONE_CREDENTIAL_KEY`,
`WORKFLOW_CRON_TICK_MS`, `WORKFLOW_TIMEOUT_MS`, `INFERENCE_TIMEOUT_MS`,
`QUEUE_SERVICE_URL`, `WORKFLOW_EXECUTION_MODE`, worker/runner/queue settings,
`HSTS_ENABLED`, `CORS_ORIGIN`.

## LDS — `apps/lds-service` (:4004)

**File:** Rust `src/main.rs`, `projector.rs`, `store.rs`, `licenses.rs`; TS
`src/index.ts` là reference.

**API:** public licenses/entity exports; management datasource,
attribute registry, record ingest, stats/export.

**Semantics:** record `{_core, entity, attributes}`; projector chỉ serialize
`entity` và attribute đã đăng ký. `_core` không bao giờ lộ. Attribute chưa đăng ký
default-deny. Visibility `public|restricted|internal`, restricted cần in-org
principal. Ingest cross-tenant trả 404. Export có `X-LDS-License` và Link license.
Anonymous chỉ GET public export/licenses.

**Env:** `PORT`, `DATABASE_URL`, `SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`,
`CORS_ORIGIN`.

## Base — `apps/base-service` (:4005)

**File:** Rust `api.rs`, `mapping.rs`, `query.rs`, `store.rs`; schema TS + drizzle.

**API:** database/collection/document CRUD, query, vector-search, increment,
batch, changes, outbox.

**Semantics:** write `data` hoặc `object`; mapping logical field; filter eq/ne/
gt/gte/lt/lte/in/contains/startsWith/endsWith/exists/text/near/within; order,
limit/cursor; Postgres pushdown filter/order/count, GIN/FTS/vector index;
optimistic concurrency `ifVersion`/`If-Match`; atomic numeric increment; batch
1–100 partial failure; change feed `since` + cursor. Document ≤256KB, nesting
≤32, array ≤10k, prototype key bị từ chối.

**Data:** databases, collections, documents, vectors. Memory fallback dev/test;
production cần DB + internal secret.

**Env:** `PORT`, `DATABASE_URL`, `BASE_MAX_DOCUMENT_BYTES`,
`BASE_QUERY_SCAN_LIMIT`, `STREAM_SERVICE_URL`, outbox settings,
`SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`, `CORS_ORIGIN`.

## Faststore — `apps/faststore-service` (:4006)

**File:** `src/index.ts`, `src/store.ts`.

**API:** string, hash, list, set, zset, lock, bulk/scan, stats.

**Semantics:** TTL tối đa 30 ngày; key ≤512 ký tự, field ≤256; batch ≤100; điều
kiện `ifNotExists`/`ifExists`; lock token-owned. Key dưới
`synapseone:faststore:v1:<tenant>:`; anonymous bị từ chối; platform caller phải
chọn tenant; production cần Valkey.

**Env:** `PORT`, `FASTSTORE_VALKEY_URL`/`FASTSTORE_REDIS_URL` fallback
`VALKEY_URL`/`REDIS_URL`, `SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`,
`CORS_ORIGIN`.

## Queue — `apps/queue-service` (:4007)

**File:** `src/index.ts`, `src/store.ts`.

**API:** queue CRUD/purge/stats, publish/batch, consume/wait, ack/nack/heartbeat,
inspect/dead/replay.

**Semantics:** at-least-once; delay/dedupe; visibility lease; retry/DLQ; long-poll
bằng subscriber connection riêng và activity signal. Queue name hợp lệ
`[A-Za-z][A-Za-z0-9_-]{0,63}`; payload ≤256KB; batch/receipt ≤100. Key dưới
`synapseone:queue:v1:<tenant>:`; production cần Valkey để tránh split-brain.

**Env:** `PORT`, `QUEUE_VALKEY_URL`/`QUEUE_REDIS_URL` fallback
`VALKEY_URL`/`REDIS_URL`, `QUEUE_MAX_PAYLOAD_BYTES`,
`SYNAPSEONE_INTERNAL_SECRET`, `HSTS_ENABLED`, `CORS_ORIGIN`.

## AI assistant — `apps/ai-service` (:4003)

**Mục đích:** trợ lý hướng dẫn/kiểm thử API trong Console, guidance-only.

**File:** `src/index.ts`, `src/catalog.ts`.

**API:** `POST /v1/ai/agent`, `POST /v1/ai/guide`, health/ready.

**Quy tắc:** provider OpenAI-compatible; API key server-side; agent không gọi
chính nó/inference để tránh recursion và đốt LLM budget; output không thay thế
authorization. `AI_RATE_LIMIT` là limiter cục bộ service, tách khỏi gateway
`AI_QUOTA_*`.

**Env:** `PORT`, `AI_BASE_URL`, `AI_API_KEY`, model/fallback/timeout/retry,
`AI_RATE_LIMIT`, `SYNAPSEONE_INTERNAL_SECRET`, `IAM_SERVICE_URL`, `AUDIT_TRAIL`,
`HSTS_ENABLED`, `CORS_ORIGIN`.

## Warehouse — `apps/warehouse-service` (:4012, Rust/Axum)

**Mục đích:** OLAP DuckDB tenant-scoped: dataset, SQL query, batch/stream ETL.

**File:** `src/api.rs`, `src/store.rs`, `src/stream.rs`, `src/tests.rs`.

**API:** dataset CRUD/search/page, job CRUD/filter/run/pause/resume/delete,
template, pipeline status, ETL Path A/B/C, OCS preview/import.

**Semantics:** DuckDB 2.0.0 shared library pinned; tenant SQL tát external access;
query timeout/body/result cap; dataset/job tenant isolation; stream ETL ghi
checkpoint và ack sau commit; retention gap dừng job `error`, không resume qua
history bị mất.

**Env:** `PORT`, `WAREHOUSE_DATA_DIR`, `WAREHOUSE_THREADS`,
`WAREHOUSE_QUERY_TIMEOUT_MS`, `WAREHOUSE_MAX_BODY`, `OCS_SERVICE_URL`,
`STREAM_SERVICE_URL`, `BASE_SERVICE_URL`, `SYNAPSEONE_INTERNAL_SECRET`,
`CORS_ORIGIN`.

## Lakehouse — `apps/lakehouse-service` (:4013, Python/FastAPI + PyIceberg)

**Mục đích:** Iceberg catalog/table/snapshot/schema evolution; Warehouse chỉ
materialize.

**File:** `src/main.py`, `src/catalog.py`, `src/store.py`, `src/api.py`.

**API:** namespace/table CRUD, snapshot, schema, append, ETL/materialization.

**Semantics:** tenant namespace/table quota; catalog lock một process; concurrent
replica có thể `409 commit_conflict`; data file giữ lại khi drop table; snapshot
expiration/orphan cleanup do operator; tenant SQL không được chỉnh object path.

**Env:** `PORT`, `LAKEHOUSE_CATALOG_URI`, `LAKEHOUSE_WAREHOUSE`,
`LAKEHOUSE_S3_*`, quota settings, `SYNAPSEONE_INTERNAL_SECRET`.

## Inference — `apps/inference-service` (:4008, Python)

**File:** `src/main.py`, `src/providers.py`, `src/usage.py`.

**API:** chat completions, embeddings, decision, route, health.

**Semantics:** OpenAI-compatible proxy + local embedding/decision; provider
usage được báo IAM. Usage thiếu có thể làm token/day undercount; patch quota này
không redesign token propagation. Request quota do gateway/IAM thực thi.

**Env:** `PORT`, `OPENROUTER_*`, embedding/decision model, `DECISION_BACKEND`,
`IAM_SERVICE_URL`, `INFERENCE_USAGE_REPORTING`, `SYNAPSEONE_INTERNAL_SECRET`,
`CORS_ORIGIN`.

## Console — `apps/console` (:3000 → nginx :80)

**File:** `src/App.jsx`, `src/lib/api.js`, `src/pages/`, `src/components/`.

**Quy tắc:** React 18 + Vite + Tailwind, JSX; `api.js` là HTTP layer duy nhất,
`authStore` xử lý refresh; runtime base URL qua `public/config.js`. Trang tenant
`/quotas` đọc org/effective quota; trang admin `/admin/quotas` và tab API Keys/
Quotas của OrganizationDetail hỗ trợ metadata, rotation và override. Bảng
responsive, tab ARIA. Test bằng `npm run test --workspace=apps/console`.

**Env:** `SYNAPSEONE_PUBLIC_BASE_URL`, `CONSOLE_APP_URL`, build-time
`VITE_SYNAPSEONE_BASE_URL`.

## SDK và CLI

SDK JS/Python/Go/Rust và CLI dùng gateway, Bearer JWT hoặc `X-API-Key`. Không đưa
secret vào URL/log. Các endpoint quota tenant mới có thể gọi trực tiếp; platform
endpoint vẫn dành cho human platform session.

## Hạ tầng

Postgres 16, Valkey 8, SeaweedFS, Prometheus. Production chỉ gateway/TLS edge
public. Object storage production phải đặt `STORAGE_BACKEND`; Valkey bắt buộc cho
stateful service. Xem `../../configuration.md` và `../../database-performance.md`.
