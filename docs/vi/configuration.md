# Cấu hình (tra cứu biến môi trường)

[English](../configuration.md) · Tiếng Việt

Sao chép `.env.example` thành `.env` và thay mọi giá trị `*_change_me_*`. Bảng dưới
đây mô tả biến mà từng service đọc.

## Gateway (`apps/gateway`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` / `GATEWAY_PORT` | 8080 | cổng listen |
| `IAM_SERVICE_URL` | `http://iam:4001` | upstream IAM |
| `WORKFLOW_SERVICE_URL` | `http://workflow:4002` | upstream workflow |
| `AI_SERVICE_URL` | `http://ai:4003` | upstream AI assistant |
| `LDS_SERVICE_URL` | `http://lds:4004` | upstream SynapseLDS |
| `BASE_SERVICE_URL` | `http://base:4005` | upstream SynapseBase |
| `FASTSTORE_SERVICE_URL` | `http://faststore:4006` | upstream Faststore |
| `QUEUE_SERVICE_URL` | `http://queue:4007` | upstream Queue |
| `STREAM_SERVICE_URL` | `http://stream:4009` | upstream Stream |
| `INFERENCE_SERVICE_URL` | `http://inference:4008` | upstream Inference |
| `OCS_SERVICE_URL` | `http://ocs:4010` | upstream OCS |
| `NOTIFICATIONS_SERVICE_URL` | `http://notifications:4011` | upstream Notifications |
| `WAREHOUSE_SERVICE_URL` | `http://warehouse:4012` | upstream Warehouse |
| `LAKEHOUSE_SERVICE_URL` | `http://lakehouse:4013` | upstream Lakehouse |
| `AUTHZ_MODE` | `off` | `off` chỉ tenant isolation; `audit` ghi would-deny nhưng không chặn; `enforce` trả `403 access_denied`, IAM lỗi trả `503 authz_unavailable` |
| `AUTHZ_CACHE_TTL_MS` | 30000 | cache quyết định policy (0 tắt, tối đa 300000) |
| `AUTHZ_MODE_REQUIRED` | `false` | production từ chối boot khi `AUTHZ_MODE=off` |
| `AUTHZ_AUDIT_ACK` | unset | bắt buộc owner/expiry khi production chạy `audit` |
| `PLATFORM_ADMIN_ENABLED` | `true` dev / `false` prod | bật `/v1/platform/*` và `/admin` |
| `PLATFORM_ADMIN_REQUIRE_MFA` | `true` | phiên platform cần TOTP mới |
| `PLATFORM_ADMIN_REQUIRE_STEP_UP` | `true` | mutation nền tảng cần `x-platform-step-up` |
| `PLATFORM_ORG_SLUG` | `synapseone-platform` | org nhân sự nền tảng |
| `PLATFORM_BOOTSTRAP_SECRET` | — | bootstrap owner đầu tiên; trống tắt |
| `PLATFORM_RECOVERY_SECRET` | — | khôi phục khẩn cấp MFA |
| `IAM_SENSITIVE_MUTATION_MODE` | `audit` | `enforce` yêu cầu org admin cho mutation nhạy cảm |
| `IAM_ALLOW_DIRECT_ORG_CREATE` | `true` dev / `false` prod | cho phép `POST /v1/orgs` trực tiếp |
| `IAM_JWT_SECRET` | — | phải trùng IAM |
| `GATEWAY_ROUTES_PATH` | `./routes.yaml` | bảng route |
| `GATEWAY_VERIFY_APIKEY` | `true` | verify API-key qua IAM; `false` chỉ dev |
| `PROXY_TIMEOUT_MS` | 30000 | timeout upstream |
| `CORS_ORIGIN` | allow all | danh sách origin phân tách dấu phẩy |
| `SYNAPSEONE_INTERNAL_SECRET` | — | credential service-to-service, phải giống nhau ở production |
| `HSTS_ENABLED` | `false` | gửi `Strict-Transport-Security` sau TLS |
| `TRUST_PROXY` | `false` | `1` sau một hop edge; `true` bị từ chối |
| `AI_QUOTA_REQUESTS_PER_MIN` | 30 | mặc định request/minute AI; fallback cũ `AI_RATE_LIMIT` |
| `INFERENCE_QUOTA_REQUESTS_PER_MIN` | 60 | mặc định inference; fallback cũ `INFERENCE_RATE_LIMIT_PER_MIN` |
| `WORKFLOW_QUOTA_REQUESTS_PER_MIN` | 120 | mặc định workflow |
| `*_QUOTA_REQUESTS_PER_5H` | minute × 300 | cửa sổ epoch-five-hour cố định |
| `*_QUOTA_REQUESTS_PER_DAY` | minute × 1440 | cửa sổ UTC-day cố định |
| `AI_QUOTA_TOKENS_PER_DAY` / `INFERENCE_QUOTA_TOKENS_PER_DAY` | 1000000 | hạn mức token/day best-effort |
| `WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` | 1000 | execution/hour workflow |
| `WORKFLOW_QUOTA_CONCURRENT` | 10 | concurrency workflow |
| `QUOTA_CACHE_TTL_MS` | 30000 | cache quota/meter (0–300000ms) |
| `VALKEY_URL` / `REDIS_URL` | — | backend Redis protocol; edge limiter vẫn in-memory |
| `GATEWAY_SESSION_CACHE_MS` | 2000 | cache session/credential revalidation |
| `GATEWAY_HOST_PORT` | 8080 | cổng host Compose |

## IAM (`apps/iam-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4001 | cổng listen |
| `DATABASE_URL` | — (memory) | backend Postgres |
| `IAM_QUOTA_VALKEY_URL` | `VALKEY_URL` → `REDIS_URL` | Valkey cho quota admission; lỗi/trống trả 503 |
| `AI_QUOTA_REQUESTS_PER_MIN` / `_PER_5H` / `_PER_DAY` | 30 / 9000 / 43200 | mặc định AI, 5h/day suy ra khi unset |
| `INFERENCE_QUOTA_REQUESTS_PER_MIN` / `_PER_5H` / `_PER_DAY` | 60 / 18000 / 86400 | mặc định inference |
| `WORKFLOW_QUOTA_REQUESTS_PER_MIN` / `_PER_5H` / `_PER_DAY` | 120 / 36000 / 172800 | mặc định workflow |
| `AI_QUOTA_TOKENS_PER_DAY` / `INFERENCE_QUOTA_TOKENS_PER_DAY` | 1000000 | mặc định token/day |
| `WORKFLOW_QUOTA_EXECUTIONS_PER_HOUR` / `WORKFLOW_QUOTA_CONCURRENT` | 1000 / 10 | mặc định execution/hour và lease in-flight workflow dùng chung cho route thường và MCP call |
| `IAM_JWT_SECRET` | — | HS256, production cần ≥32 ký tự ngẫu nhiên |
| `IAM_JWT_EXPIRES_IN` / `IAM_REFRESH_EXPIRES_IN` | 3600 / 2592000 | TTL token |
| `IAM_API_KEY_PEPPER` | — | HMAC pepper cho hash API-key/refresh token |
| `IAM_MFA_ENCRYPTION_KEY` | HKDF từ `IAM_JWT_SECRET` | khóa AES-256-GCM bảo vệ TOTP |
| `IAM_MFA_ISSUER` | `SynapseOne` | nhãn issuer `otpauth://` |
| `IAM_LOGIN_MAX_FAILURES` / `IAM_LOGIN_LOCKOUT_SECONDS` | 5 / 900 | khóa tạm sau sai credential |
| `IAM_LOGIN_RATE_LIMIT_PER_MIN` / `IAM_MFA_RATE_LIMIT_PER_MIN` | 60 / 60 | trần request theo IP |
| `AUDIT_RETENTION_DAYS` | 0 | số ngày giữ audit; 0 tắt |
| `AUDIT_TRAIL` | `true` | data-plane ghi audit mutation |
| `AUDIT_INGEST_URL` | `${IAM_SERVICE_URL}/v1/audit/ingest` | endpoint audit sink |
| `IAM_ALLOW_DEV_LOGIN` | `true` | đăng nhập passwordless dev |
| `IAM_ALLOW_OIDC_DEMO_CALLBACK` | `true` | callback demo; production phải `false` |
| `SYNAPSEONE_INTERNAL_SECRET` | — | chặn truy cập trực tiếp service |
| `HSTS_ENABLED` | `false` | HSTS sau TLS |
| `OIDC_PROVIDER` | `authentik` | nhãn IdP |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` | xem `.env.example` | OIDC Authentik/Keycloak |
| `IAM_REGISTRATION_ENABLED` | `true` | đăng ký first-party |
| `IAM_REGISTRATION_ALLOW_NEW_ORGS` | `true` | cho tạo org mới khi đăng ký |
| `IAM_EXPOSE_LIFECYCLE_TOKENS` | `false` | chỉ dev mới trả reset/verify token |
| `IAM_RESET_TOKEN_TTL_SECONDS` / `IAM_VERIFY_TOKEN_TTL_SECONDS` | 3600 / 86400 | TTL token dùng một lần |
| `OIDC_ALLOWED_ORGS` | — | slug org được phép OIDC |

## Thực thi quota và rollout

Đặt cùng giá trị `*_QUOTA_*` chuẩn trên IAM và gateway. Cửa sổ request cố định
epoch-minute, epoch-five-hour và UTC-day, không phải sliding. Lua Valkey của IAM
kiểm tra cả ba trước khi tăng và đặt TTL nguyên tử. Valkey lỗi trả
`503 quota_unavailable`; gateway fail open về minute limiter in-memory. Anonymous
luôn dùng limiter cục bộ. Production nên giữ `IAM_QUOTA_VALKEY_URL` (hoặc
`VALKEY_URL`) khả dụng và giám sát 503; fallback chỉ riêng từng replica, không
thay thế shared quota.

Rollback: khôi phục image/env cũ và giữ bảng `org_quotas` cùng journal. Code cũ
bỏ qua cột mới. Counter hết hạn theo TTL; không flush namespace Valkey không liên
quan.

## Workflow (`apps/workflow-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4002 | cổng listen |
| `DATABASE_URL` | — (memory) | Postgres workflow/execution, bắt buộc production |
| `WORKFLOW_CRON_TICK_MS` | 15000 | chu kỳ cron |
| `WORKFLOW_TIMEOUT_MS` | 60000 | timeout execution |
| `WORKFLOW_EXECUTION_MODE` | `queue` Compose / `auto` | queue/inline/auto |
| `QUEUE_SERVICE_URL` | `http://queue:4007` | SynapseQueue nội bộ |
| `WORKFLOW_WORKER_ENABLED` | true | worker platform tích hợp |
| `WORKFLOW_WORKER_CONCURRENCY` | 4 | job song song (1–32) |
| `WORKFLOW_WORKER_POLL_MS` | 500 | chu kỳ poll |
| `WORKFLOW_QUEUE_VISIBILITY_SECONDS` | 300 | lease job |
| `WORKFLOW_QUEUE_MAX_ATTEMPTS` | 5 | số lần trước DLQ |
| `WORKFLOW_QUEUE_PLATFORM` | `synapseone-wf-platform` | queue workflow platform |
| `WORKFLOW_QUEUE_CUSTOM` | `synapseone-wf-custom` | queue custom |
| `WORKFLOW_QUEUE_SHARED` | `synapseone-wf-shared` | queue hybrid |
| `WORKFLOW_QUEUE_INFERENCE` | `synapseone-inference` | queue inference/hybrid |
| `WORKFLOW_SYSTEM_QUEUE_TENANT_MAX` | 100 | trần queued+running system-runner mỗi tenant |
| `MCP_ALLOW_ANONYMOUS` | `false` | bật MCP anonymous chỉ tool read-only |
| `MCP_ANONYMOUS_RATE_LIMIT_PER_MIN` | 30 | trần anonymous MCP theo IP |
| `WORKFLOW_MCP_QUOTA_ENFORCEMENT` | true production / false dev | switch chỉ cho MCP dùng shared IAM execution-hour/concurrency admission trên từng `tools/call` thật, gồm batch; route execution thường ở gateway luôn thực thi và quota-store lỗi fail closed |
| `SYNAPSEONE_PUBLIC_URL` | `https://api.synapseone.space` | URL gateway trong lệnh runner |
| `WORKFLOW_RUNNER_IMAGE` | `ghcr.io/.../synapseone-workflow-runner:latest` | image runner |
| `WORKFLOW_RUNNER_HEARTBEAT_SECONDS` | 15 | chu kỳ heartbeat |
| `WORKFLOW_RUNNER_STALE_SECONDS` | 60 | thời gian đánh dấu offline |
| `WORKFLOW_RUNNER_MAX_CONCURRENCY` | 32 | trần concurrency connector |
| `INFERENCE_TIMEOUT_MS` | 120000 | timeout gọi inference |
| `IAM_SERVICE_URL` | `http://iam:4001` | IAM cho node `synapseone.api` |
| `SYNAPSEONE_IAM_API_KEY` | — | API-key service gọi IAM |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` | `false` | HSTS |

## AI agent (`apps/ai-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4003 | cổng listen |
| `AI_BASE_URL` | `https://openrouter.ai/api/v1` | provider OpenAI-compatible |
| `AI_API_KEY` | — | key server-side |
| `AI_DECISION_MODEL` / `AI_LLM_MODEL` | `inception/mercury-2.5` / `liquid/lfm-2.5-2.6b:free` | model chọn endpoint/tạo câu trả lời |
| `AI_TIMEOUT_MS` | 20000 | timeout LLM |
| `AI_RETRIES` | 2 | retry reply lỗi/rỗng |
| `AI_LLM_FALLBACK_MODEL` | decision model | fallback provider khác |
| `AI_RATE_LIMIT` | 30 | limiter cục bộ của ai-service, tách khỏi `AI_QUOTA_*` |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | HSTS/CORS |

## Linked data — SynapseLDS (`apps/lds-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4004 | cổng listen |
| `DATABASE_URL` | — (memory) | Postgres, bắt buộc production |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | HSTS/CORS |

Record lưu `{_core, entity, attributes}`; projector chỉ đọc `entity` và
`attributes` đã đăng ký. `_core` không bao giờ được serialize. Attribute chưa đăng
ký default-deny; visibility `public|restricted|internal` được xét lúc đọc.

## Base — SynapseBase (`apps/base-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4005 | cổng listen |
| `DATABASE_URL` | — (memory) | Postgres, bắt buộc production |
| `BASE_MAX_DOCUMENT_BYTES` | 262144 | kích thước document tối đa |
| `BASE_QUERY_SCAN_LIMIT` | 200000 | trần scan chỉ fallback memory |
| `STREAM_SERVICE_URL` | — | bật outbox relay |
| `BASE_OUTBOX_STREAM_TOPIC` | `base-changes` | topic đích |
| `BASE_OUTBOX_RELAY_MS` | 1000 | chu kỳ relay |
| `BASE_OUTBOX_MAX_ATTEMPTS` | 20 | số lần trước quarantine |
| `BASE_OUTBOX_RETRY_BASE_MS` | 1000 | bước backoff đầu |
| `BASE_OUTBOX_RETRY_MAX_MS` | 300000 | trần backoff |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | HSTS/CORS |
| `BASE_SERVICE_HOST_PORT` | `127.0.0.1:4005` | bind host Compose |

## Warehouse — Synapse Warehouse (`apps/warehouse-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4012 | cổng listen |
| `WAREHOUSE_DATA_DIR` | `/data/warehouse` | thư mục DuckDB bền vững |
| `WAREHOUSE_OCS_MAX_FILE_BYTES` | 67108864 | kích thước file import tối đa |
| `OCS_SERVICE_URL` | `http://ocs:4010` | nguồn object OCS |
| `WAREHOUSE_THREADS` | 2 | thread DuckDB mỗi tenant |
| `WAREHOUSE_QUERY_TIMEOUT_MS` | 15000 | timeout query |
| `WAREHOUSE_MAX_BODY` | 8mb | trần request body |
| `STREAM_SERVICE_URL` | `http://stream:4009` | nguồn stream ETL |
| `BASE_SERVICE_URL` | `http://base:4005` | nguồn snapshot Base |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ, bắt buộc production |
| `CORS_ORIGIN` | — | origin cho phép |
| `WAREHOUSE_SERVICE_HOST_PORT` | `127.0.0.1:4012` | bind host |

Image Warehouse liên kết thư viện DuckDB 2.0.0 chính thức. Tenant SQL vẫn tắt
truy cập file/network bên ngoài.

## Lakehouse — Apache Iceberg (`apps/lakehouse-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4013 | cổng listen |
| `LAKEHOUSE_CATALOG_URI` | SQLite dev | catalog SQLAlchemy; production cần Postgres |
| `LAKEHOUSE_WAREHOUSE` | file dev | `s3://bucket/prefix`; production cần S3 |
| `LAKEHOUSE_S3_ENDPOINT` | — | endpoint S3-compatible |
| `LAKEHOUSE_S3_ACCESS_KEY` / `LAKEHOUSE_S3_SECRET_KEY` | — | credential service |
| `LAKEHOUSE_S3_REGION` | `us-east-1` | region ký S3 |
| `LAKEHOUSE_MAX_NAMESPACES` | 20 | quota namespace/tenant |
| `LAKEHOUSE_MAX_TABLES_PER_NAMESPACE` | 100 | quota bảng/namespace |
| `LAKEHOUSE_MAX_ROWS_PER_APPEND` | 5000 | trần dòng append |
| `LAKEHOUSE_MAX_BYTES` | 1073741824 | quota byte/tenant |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `LAKEHOUSE_SERVICE_HOST_PORT` | `127.0.0.1:4013` | bind host |

Service tạo metadata Iceberg v2, Parquet, manifest và snapshot thật. Data file
được giữ khi drop bảng; expiration/orphan cleanup là thao tác operator tường minh.
Warehouse đọc qua materialization nội bộ, không cấp filesystem cho tenant SQL.

## Faststore — Synapse Faststore (`apps/faststore-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4006 | cổng listen |
| `FASTSTORE_VALKEY_URL` | `FASTSTORE_REDIS_URL` → `VALKEY_URL` → `REDIS_URL` | backend Valkey, bắt buộc production |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | HSTS/CORS |
| `FASTSTORE_SERVICE_HOST_PORT` | `127.0.0.1:4006` | bind host |

## Queue — SynapseQueue (`apps/queue-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4007 | cổng listen |
| `QUEUE_VALKEY_URL` | `QUEUE_REDIS_URL` → `VALKEY_URL` → `REDIS_URL` | backend Valkey, bắt buộc production |
| `QUEUE_MAX_PAYLOAD_BYTES` | 262144 | payload tối đa |
| `SYNAPSEONE_INTERNAL_SECRET` | — | auth nội bộ |
| `HSTS_ENABLED` / `CORS_ORIGIN` | `false` / — | HSTS/CORS |
| `QUEUE_SERVICE_HOST_PORT` | `127.0.0.1:4007` | bind host |

Ba service dữ liệu dùng tenant org/account/user; platform caller phải chọn tenant.
API-key principal mang org sở hữu do IAM resolve để usage và quota dùng chung
namespace `org:<id>`.

## Stream — SynapseStream (`apps/stream-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4009 | cổng listen |
| `STREAM_ENGINE` | suy ra URL | `valkey`/`redis`/`memory`; `memory` bị cấm production |
| `STREAM_VALKEY_URL` | `STREAM_REDIS_URL` → `VALKEY_URL` → `REDIS_URL` | URL engine bền vững |
| `STREAM_MAX_PAYLOAD_BYTES` | 262144 | payload tối đa |
| `SYNAPSEONE_INTERNAL_SECRET` | — | bắt buộc production |
| `CORS_ORIGIN` | — | bắt buộc production, không wildcard |

## Inference (`apps/inference-service`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 4008 | cổng listen |
| `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter defaults | provider/model LLM |
| `OPENROUTER_TIMEOUT_MS` / `OPENROUTER_RETRIES` | 30000 / 2 | timeout/retry upstream |
| `EMBEDDING_MODEL_NAME` / `DECISION_MODEL_NAME` | local models | model self-hosted |
| `DECISION_BACKEND` | `local` | `local` hoặc `openrouter` |
| `IAM_SERVICE_URL` | `http://iam:4001` | đích usage/token metering |
| `INFERENCE_USAGE_REPORTING` | `true` | báo prompt/completion token |
| `SYNAPSEONE_INTERNAL_SECRET` | — | bắt buộc production |
| `CORS_ORIGIN` | — | bắt buộc production |

## Object storage (`apps/ocs-service`)

Xem `../object-storage.md`. Biến chính: `STORAGE_BACKEND` (`fs|s3`, bắt buộc
production), `STORAGE_S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY/SECRET_KEY/PATH_STYLE`,
`STORAGE_FS_ROOT`, `STORAGE_MAX_OBJECT_BYTES` (25 MiB; production 128 MiB cho
signed release), `STORAGE_TENANT_QUOTA_BYTES` (5 GiB),
`STORAGE_ALLOWED_CONTENT_TYPES`.

## Backup (`pg-backup`, `s3-backup`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `BACKUP_INTERVAL_SECONDS` | 86400 | chu kỳ chạy |
| `BACKUP_RETENTION_DAYS` | 7 | số ngày giữ, luôn giữ snapshot mới nhất |
| `BACKUP_DATABASES` | `${POSTGRES_DB} authentik` | database được dump |

`pg-backup` dùng `POSTGRES_*`; `s3-backup` dùng `STORAGE_S3_*`. Volume
`pgbackups`, `s3backups`.

## Notifications (`apps/notifications-service`)

Xem `../notifications.md`. Biến chính: `DATABASE_URL`,
`NOTIFICATIONS_QUEUE_URL`/`_QUEUE_NAME`, các relay email/SMS/push,
`NOTIFICATIONS_MAX_ATTEMPTS` (5), `NOTIFICATIONS_RETRY_BASE_SECONDS` (5),
`NOTIFICATIONS_RATE_LIMIT_PER_MIN` (120).

## SynapseDNS (`apps/dns-service`, chạy độc lập)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SYNAPSEDNS_DNS_HOST` / `SYNAPSEDNS_DNS_PORT` | `0.0.0.0` / `53` | bind DNS authoritative UDP/TCP |
| `SYNAPSEDNS_API_HOST` / `SYNAPSEDNS_API_PORT` | `0.0.0.0` / `4014` | bind API quản trị |
| `SYNAPSEDNS_DATA_FILE` | `./data/synapsedns.json` | JSON store bền vững; một writer |
| `SYNAPSEDNS_ADMIN_TOKEN` | bắt buộc production | bearer token quản trị |
| `SYNAPSEDNS_ALLOW_INSECURE` | `false` | bỏ auth chỉ cho test local; cấm production |
| `SYNAPSEDNS_LOG_LEVEL` | `info` | mức log structured |
| `SYNAPSEDNS_SHUTDOWN_TIMEOUT_MS` | `15000` | thời gian shutdown graceful |

Compose độc lập: `docker-compose.dns.yml`. Giữ API private và chưa delegate NS
production cho tới khi migrate/verify toàn bộ record.

## Synapse Tunnel (`apps/tunnel-service`, chạy độc lập)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SYNAPSETUNNEL_HOST` | `0.0.0.0` | bind API/ingress |
| `SYNAPSETUNNEL_API_PORT` | `4015` | API quản trị |
| `SYNAPSETUNNEL_INGRESS_PORT` | `4016` | ingress HTTP/WebSocket public |
| `SYNAPSETUNNEL_DATA_FILE` | `./data/synapse-tunnel.json` | JSON store bền vững; một writer |
| `SYNAPSETUNNEL_ADMIN_TOKEN` | bắt buộc production | bearer token quản trị |
| `SYNAPSETUNNEL_PUBLIC_SCHEME` | `http` | scheme forwarded; đặt `https` sau TLS |
| `SYNAPSETUNNEL_WS_PATH` | `/_synapse/tunnel/connect` | đường dẫn WebSocket connector |
| `SYNAPSETUNNEL_MAX_REQUEST_BYTES` | `10485760` | giới hạn request body buffer |
| `SYNAPSETUNNEL_MAX_RESPONSE_BYTES` | `16777216` | giới hạn response tích lũy |
| `SYNAPSETUNNEL_REQUEST_TIMEOUT_MS` | `30000` | timeout tới response header upstream |
| `SYNAPSETUNNEL_CONNECTOR_TOKEN` | bắt buộc cho connector | credential connector dùng một lần |
| `SYNAPSETUNNEL_SERVER_URL` | `http://127.0.0.1:4016` | đích connector kết nối outbound |

Compose độc lập: `docker-compose.tunnel.yml`. TLS termination, routing qua API
Gateway hiện tại và tích hợp Tầng 2/3 vẫn để sau.

## Console (`apps/console`, runtime qua `config.js`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SYNAPSEONE_PUBLIC_BASE_URL` | `http://localhost:8080` | URL gateway mà browser gọi |
| `CONSOLE_APP_URL` | `http://localhost:3000` | host app chuẩn |

## Dữ liệu lõi / engine ngoài

> **Dùng Valkey, không phải Redis.** Valkey 8 (BSD-3, Linux Foundation) tương
> thích giao thức Redis 7: client, Lua, Streams và pub/sub hoạt động không đổi,
> đọc được AOF/RDB Redis cũ. Redis 7.4+ đổi sang giấy phép non-OSI nên nền tảng
> không ship Redis. Tên ưu tiên: `VALKEY_URL`, `FASTSTORE_VALKEY_URL`,
> `QUEUE_VALKEY_URL`, `STREAM_VALKEY_URL`; alias `*_REDIS_URL` vẫn hỗ trợ. Compose
> giữ tên service `valkey` và volume `redisdata` để nâng cấp tại chỗ.

Postgres dùng `POSTGRES_*`; Valkey dùng `VALKEY_URL` (`REDIS_URL` là alias cũ,
URL vẫn `redis://`); Authentik dùng `AUTHENTIK_*`, cổng
`AUTHENTIK_HTTP_PORT=19000`; object storage là SeaweedFS với
`STORAGE_S3_ACCESS_KEY`/`STORAGE_S3_SECRET_KEY`, cổng `S3_HOST_PORT=9090`, volume
`seaweeddata`.
