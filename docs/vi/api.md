# Tài liệu API

[English](../api.md) · Tiếng Việt

Base URL mặc định `http://localhost:8080`. Request/response JSON trừ binary/stream.
Lỗi dùng `{error, message}`; auth Bearer JWT hoặc `X-API-Key`.

## Principal propagation (gateway → upstream)

Gateway xóa header client rồi stamp principal đã verify:

| Header | Ý nghĩa |
|---|---|
| `x-synapseone-user` | user id |
| `x-synapseone-org` | org id |
| `x-synapseone-account` | account id |
| `x-synapseone-kind` | `user`, `apikey`, `service-account`, `platform-admin`, `platform-runner` |
| `x-synapseone-scopes` | scope đã verify |
| `x-synapseone-anon` | `1` cho public route không principal |

Legacy `x-synapsedx-*` vẫn được mirror trong giai đoạn rebrand.

## Validation

Input sai trả 400. UUID sai định dạng 400; resource không tồn tại/cross-tenant có
thể trả 404; known-resource denial trả 403; IAM/Valkey/quota store lỗi trả 503;
rate/quota vượt trả 429; upstream lỗi 502/504.

## Auth

- `GET /v1/auth/oidc/config` → issuer/client/redirect và khả năng SSO.
- `GET /v1/auth/oidc/start?org=` → URL authorization + state.
- `POST /v1/auth/oidc/callback {code,state}` → session.
- `POST /v1/auth/login {email,orgSlug,password?}` → access/refresh token, user,
  contexts; dev login chỉ khi bật.
- `POST /v1/auth/refresh {refreshToken}` → rotate token single-use.
- `POST /v1/auth/logout {refreshToken}` / `logout-all` → thu hồi phiên.
- `GET /v1/auth/me`, `GET /v1/auth/contexts`,
  `POST /v1/auth/contexts/switch {orgId,password}`.
- `POST /v1/auth/register`, `invite/accept`, `password/forgot`, `password/reset`,
  `email/verify`.
- `GET /v1/auth/verify` → `{valid,type,claims,org_id?}`; gateway dùng `org_id` để
  xác định org sở hữu service-account.

### MFA TOTP và lockout

- `GET /v1/auth/mfa`;
- `POST /v1/auth/mfa/totp/setup`;
- `POST /v1/auth/mfa/totp/enable {code}` → recovery codes một lần;
- `POST /v1/auth/mfa/verify {mfaToken,code|recoveryCode}`;
- `POST /v1/auth/mfa/recovery-codes {code}`;
- `POST /v1/auth/mfa/disable {code|recoveryCode}`.

Sai credential nhiều lần trả `429 account_locked` + `Retry-After`; org admin dùng
`POST /v1/users/:id/unlock`.

## Orgs / Accounts

- `GET /v1/orgs` → org của caller.
- `POST /v1/orgs {slug,displayName}` → tạo org nếu direct create được bật.
- `PATCH /v1/orgs/:orgId {displayName}` → org admin.
- `GET /v1/orgs/:orgId` → chi tiết org cùng tenant; cross-tenant `403`.
- `GET /v1/orgs/:orgId/quotas` → `{orgId,quotas,overrides,defaults}`; effective
  `ai`/`inference`/`workflow`, field-level override, nullable inheritance.
- `GET/POST /v1/orgs/:orgId/accounts`.
- `GET/POST /v1/orgs/:orgId/users`.
- `GET/PATCH /v1/accounts/:accountId`, retire/reactivate.
- `GET/PATCH /v1/users/:userId`, disable/enable, reset MFA, org-admin.

Management list nhận `limit` (1..200), `offset`, `sort`, `order`, `q`, `paged=1`.
Không `paged` trả bare array tối đa 1000 và header truncation nếu cắt.

## Roles / Policies / Authorize

- `GET/POST /v1/accounts/:accountId/roles`; `PATCH/DELETE /v1/roles/:id`.
- `GET/POST /v1/accounts/:accountId/policies`; `PATCH/DELETE /v1/policies/:id`.
- `POST /v1/roles/:roleId/attach {policyId}`; detach.
- `POST /v1/users/:userId/assign {roleId}`; unassign.
- `GET /v1/roles/:roleId/policies`, `GET /v1/users/:userId/policies|roles`.
- `GET /v1/managed-policies`.
- `POST /v1/authorize {userId,action,resource,context}`.
- `POST /v1/authorize/dry-run {documents,action,resource,context}`.
- `GET /v1/audit?limit&offset&actor&allowed&orgId&action&resource&from&to&paged=1`.

Policy dùng AWS-style Statement; explicit Deny thắng Allow, mặc định deny.
Condition `StringEquals`/`StringLike`/`IfExists` fail-closed.

### Central enforcement

Gateway với `AUTHZ_MODE=enforce` gọi IAM authorize cho authenticated service
route. Deny trả 403 kèm action/resource/reason; IAM lỗi trả 503. `audit` chỉ ghi
would-deny và header; `off` không gọi policy.

## Keys

- `POST /v1/accounts/:accountId/keys {name,scopes,userId?,expiresInSeconds?}` →
  secret một lần, `Cache-Control: noStore`.
- `GET /v1/accounts/:accountId/keys` → metadata only.
- `GET /v1/keys/:id` → metadata only.
- `POST /v1/keys/:id/rotate {graceSeconds?}` → successor secret một lần; key cũ
  hết hạn ngay hoặc sau grace ≤7 ngày.
- `DELETE /v1/keys/:id`.
- `POST /v1/keys/verify {apiKey}` internal → `{valid,account_id,org_id,user_id,scopes}`.

Hash/plaintext không bao giờ xuất hiện ở list/detail. Owner bị disable làm key
chết; scope không được mở rộng quyền caller.

## Service accounts

- `GET/POST /v1/accounts/:accountId/service-accounts`.
- `GET /v1/service-accounts/:id`.
- `POST /v1/service-accounts/:id/token` → JWT `kind=service-account`, account-bound.
- `GET/POST/DELETE /v1/service-accounts/:id/roles`.
- Revoke service account chặn token mới và verify token hiện tại.

## Credentials và secrets

- `GET/POST /v1/credentials`, `DELETE /v1/credentials/:id` — secret workflow node,
  AES-256-GCM, không trả plaintext.
- `GET/POST /v1/secrets`, `GET/PUT/DELETE /v1/secrets/:id`, reveal dành cho workflow
  execution có authorization.

## Human tasks

- `GET /v1/human-tasks`, `GET /v1/human-tasks/:id`.
- `POST /v1/human-tasks/:id/approve|reject|submit`.
Task gắn execution/pause checkpoint; API-created task không thể giả mạo checkpoint.

## Search

- `POST /v1/search {query,mode?,limit?,offset?}`.
- `GET /v1/search/status`, `POST /v1/search/reindex`.
Hybrid text/vector search tenant-scoped.

## SCIM 2.0

- `/scim/v2/Users`, `/scim/v2/Users/:id` (GET/POST/PATCH/PUT/DELETE).
- `/scim/v2/Groups`, `/scim/v2/Groups/:id`.
- `GET/POST/DELETE /v1/scim/tokens`.
SCIM bearer token scoped org; user/group mapping role; last admin được bảo vệ.

## Workflows

- `GET/POST /v1/workflows`; `GET/PUT/DELETE /v1/workflows/:id`.
- `POST /v1/workflows/:id/execute|activate|deactivate`.
- `POST /v1/workflows/test-run {definition,input,workflowId?}`.
- `GET /v1/executions`, `GET /v1/executions/:id`,
  `POST /v1/executions/:id/cancel`.
- `GET/POST /v1/workflow-runners`; detail/update/delete/options/config/connection/
  heartbeat/command/instances.
- `POST /v1/runner/jobs/:id/claim|heartbeat|complete|release|credentials`.
- `GET/POST /v1/inference-jobs`, detail; inference runner claim/heartbeat/complete/release.
- `GET /v1/templates`, `GET /v1/templates/:name`.
- `ALL /webhook/:path`, `POST /mcp`.

Workflow tenant-scoped, definition ≤200KB, settings ≤8KB. Queue transport
at-least-once; runner claim guard trùng lặp. Code node production isolated.

## Linked Data — SynapseLDS

- Public: `GET /v1/lds/licenses`, entity export/detail.
- Management: datasource CRUD, attribute registry, records, stats/export.
Record `{_core,entity,attributes}`; `_core` không serialize. Attribute đăng ký
structural allowlist; visibility public/restricted/internal; cross-tenant 404.

## Base — SynapseBase

- Database/collection CRUD và stats.
- Document CRUD/query/vector-search/increment/batch/changes/outbox.
- Graph và GIS endpoint qua prefix `/v1/base`.
Write `data` hoặc `object`; mapping logical field; optimistic concurrency;
increment atomic; batch partial failure; Postgres pushdown/GIN/FTS/vector;
change feed dùng `since` + cursor; document/nesting/array/prototype có giới hạn.

## Faststore

String/hash/list/set/zset CRUD; TTL/expire/incr; scan/batch/stats;
lock acquire/release/extend. Tenant namespace; anonymous từ chối; production cần
Valkey.

## Queue

Queue CRUD/purge/stats; publish/batch; consume/wait; ack/nack/heartbeat; inspect/
dead/replay. At-least-once, visibility lease, retry/DLQ, dedupe/delay. Production
cần Valkey.

## Stream

Topic/group/message/consume/ack; retention và replay. Tenant-scoped; retention
gap trả `410 retention_gap` thay vì im lặng bỏ lịch sử.

## SynapseOCS / legacy storage

Bucket/object CRUD, multipart, presign, preview/import, stats. `/v1/ocs` và legacy
`/v1/storage`. Signed URL có expiry; quota byte/content-type; S3 hoặc filesystem.

## Notifications

Template/outbox/preference/delivery; enqueue inline hoặc template; retry và relay
email/SMS/push. Render snapshot theo template version.

## Warehouse

Dataset CRUD/search/page; job CRUD/run/pause/resume/delete; template; pipeline
status; ETL Path A/B/C; OCS preview/import. Tenant SQL external access tắt;
retention gap đưa job `error`, phải rebuild trước khi tạo job mới.

## Lakehouse

Namespace/table/snapshot/schema/append/materialize. Iceberg v2 + Parquet; catalog
Postgres production, S3 warehouse; data file giữ lại khi drop; cleanup là thao tác
operator.

## Usage analytics

- `POST /v1/usage/ingest` internal.
- `GET /v1/usage/summary`, `GET /v1/usage/events`.
- `GET /internal/usage/meter?orgId=` internal.
Meter token/day eventual-consistent; execution meter đếm accepted execute,
test-run và tạo inference-job, không đếm denial/read/status mutation.

## AI assistant và inference

- `POST /v1/ai/agent`, `POST /v1/ai/guide`.
- `POST /v1/inference/chat/completions`, `/embeddings`, `/decision`, `/route`.
Provider key server-side. AI assistant guidance-only, không thay thế authz.

## Platform Super Admin (`/v1/platform`)

Chỉ human platform token; tenant token chỉ dùng `/v1/platform/session` để đổi.
Mutation cần step-up.

| Method | Path | Mô tả |
|---|---|---|
| GET | `/v1/platform/me` | profile/admin role |
| GET | `/v1/platform/overview` | metadata toàn nền tảng |
| GET/POST | `/v1/platform/orgs` | list/create tenant + admin đầu tiên |
| GET | `/v1/platform/orgs/:orgId` | chi tiết org |
| GET | `/v1/platform/orgs/:orgId/resources` | accounts/users/roles/policies/API-key metadata/service accounts/quotas |
| GET | `/v1/platform/orgs/:orgId/audit` | audit theo org |
| POST | `/v1/platform/orgs/:orgId/accounts` | tạo account |
| POST | `/v1/platform/orgs/:orgId/suspend|reactivate` | vòng đời org |
| POST | `/v1/platform/orgs/:orgId/roles|policies` | tạo role/policy |
| POST | `/v1/platform/orgs/:orgId/keys` | tạo tenant API-key, secret một lần |
| POST | `/v1/platform/orgs/:orgId/keys/:keyId/rotate` | rotate, secret một lần |
| POST | `/v1/platform/orgs/:orgId/keys/:keyId/revoke` | revoke |
| GET | `/v1/platform/quotas/defaults` | mặc định toàn cục |
| GET | `/v1/platform/quotas?service&q&limit&offset` | override có phân trang |
| GET | `/v1/platform/orgs/:orgId/quotas` | effective/raw/default |
| PUT | `/v1/platform/orgs/:orgId/quotas` | override nullable |
| DELETE | `/v1/platform/orgs/:orgId/quotas/:service` | reset default |
| POST | `/v1/platform/orgs/:orgId/service-accounts/:id/revoke` | revoke SA |
| GET/POST/DELETE | `/v1/platform/admins...` | quản trị platform admin |
| GET | `/v1/platform/users...` | user cross-tenant và action routes |

### Hiển thị tổ chức và metadata API-key

Tenant chỉ đọc org/quota cùng tenant qua `canActForOrg`; tenant khác `403`.
Platform/internal endpoint không available cho tenant; gateway không có route
`/internal/*`.

API-key list/detail/resource chỉ có id, prefix, name, scopes, account, owner,
created/last-used/expiry/revocation và status. Hash/plaintext không trả về sau
response create/rotate. Rotation là đường khôi phục secret duy nhất. Tenant và
platform create/rotate đều `Cache-Control: noStore`; platform mutation cần step-up
và audit.

### Service quota (AI / Inference / Workflow)

`org_quotas` lưu override nullable cho `(org_id, service)`. NULL kế thừa default.
Effective response có `overridden` và map `overrides`. Request limit:

- `requestsPerMin` / `requests_per_min`;
- `requestsPer5h` / `requests_per_5h`;
- `requestsPerDay` / `requests_per_day`.

Các trường `tokensPerDay`, `executionsPerHour`, `concurrentExecutions` vẫn được
hỗ trợ. Token/day cho `ai`/`inference`; execution/concurrency cho `workflow`.

**Cửa sổ cố định, không sliding:**

- minute: bucket 60 giây theo epoch;
- five-hour: bucket 18.000 giây theo epoch;
- day: ngày UTC, reset `00:00:00Z`.

Khi `AI_QUOTA_REQUESTS_PER_5H` / `AI_QUOTA_REQUESTS_PER_DAY` (và tương ứng
`INFERENCE_*` / `WORKFLOW_*`) unset, default suy ra `requestsPerMin * 300` và
`requestsPerMin * 1440`. Tên minute chuẩn:
`AI_QUOTA_REQUESTS_PER_MIN`, `INFERENCE_QUOTA_REQUESTS_PER_MIN`,
`WORKFLOW_QUOTA_REQUESTS_PER_MIN`; fallback cũ là `AI_RATE_LIMIT` và
`INFERENCE_RATE_LIMIT_PER_MIN`.

Gateway lấy IAM effective quota (cache `QUOTA_CACHE_TTL_MS`, mặc định 30s), xác
định org sở hữu gồm service-account, rồi gọi internal:

```json
{
  "subject": "org:<uuid>",
  "service": "ai",
  "limits": { "minute": 30, "fiveHour": 9000, "day": 43200 }
}
```

`POST /internal/quota/check` cần internal secret và chạy Lua Valkey trên key
`quota:v1:<service>:<subject>:<window>:<bucket>`. Script kiểm tra cả ba counter
trước increment; rejection không tiêu thụ budget. Accepted request tăng cả ba và
đặt TTL nguyên tử. Response:

```json
{
  "allowed": false,
  "window": "fiveHour",
  "count": 9000,
  "limit": 9000,
  "retryAfterSeconds": 1234,
  "resetAt": "2026-11-26T18:00:00.000Z"
}
```

Gateway trả `429 quota_exceeded` với `service`, `window`, `limit`, `retryAfter`,
`retryAfterSeconds`, `resetAt` tùy chọn và header `Retry-After`. Central
authorization chạy trước shared quota nên request bị policy từ chối/authz-unavailable
không tiêu thụ budget. Route execute/test-run/tạo inference-job thường acquire
lease execution IAM trước request admission. `/mcp` được request-meter ở edge;
workflow-service admission từng `tools/call` thật trong JSON-RPC batch qua cùng
endpoint IAM execution-hour/concurrency trusted và cùng subject `org:<id>`, nên
hai đường dùng chung một hourly counter và một sorted-set lease concurrency.

Attribution org của service-account nằm ở `x-synapseone-quota-org`, không phải
`x-synapseone-org`; authorization vẫn account-bound. Rotation API-key dùng
compare-and-swap `rotated_at` nguyên tử, giới hạn grace của key cũ ở expiry gốc,
và giữ nguyên expiry gốc cho key kế nhiệm.

Nếu IAM effective lookup hoặc Valkey request admission lỗi, IAM trả 503 và
gateway fail open về minute limiter in-memory. Anonymous/IP luôn dùng limiter cục
bộ. Execution admission chung ngược lại fail closed: route thường trả 503 còn MCP
call đang được thực thi trả lỗi quota khi execution quota store không khả dụng.

Token/day vẫn dùng usage telemetry eventual-consistent. Provider thiếu usage có
thể undercount token. Lease execution workflow bao trùm proxy request thường và
lượt chạy MCP tool; queued backend completion không phải tín hiệu concurrency
chính xác. Patch không redesign token propagation.

## Health / Metrics

- `GET /health`, `GET /ready`, `GET /metrics` ở gateway.
- Node service health/ready; Rust service health; IAM ready phản ánh DB.
- Readiness aggregate upstream; degradation không che lỗi critical dependency.

## Tracing

Gateway echo `x-request-id`, sanitize input và forward. Log không được chứa
Authorization/API-key/secret.
