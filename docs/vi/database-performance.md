# Hiệu năng database: PgBouncer, Postgres, audit read replica, quota meter và Base read cache

[English](../database-performance.md) · Tiếng Việt

Hướng dẫn này bao gồm công việc hiệu năng database giai đoạn 1/2:

1. **PgBouncer** ở chế độ transaction pooling giữa application service và Postgres.
2. **Tuning Postgres** cho host production.
3. **IAM audit read replica tùy chọn** cho list/count audit của tenant/nền tảng.
4. **Quota meter IAM nguyên tử** trong Valkey cho cửa sổ request cố định.
5. **L2 document-read cache** của SynapseBase dùng Synapse Faststore (Valkey).

Hướng dẫn áp dụng cho Compose single-node. Application service vẫn dùng cùng
`DATABASE_URL`; chỉ host đổi từ `postgres:5432` sang `pgbouncer:6432`.

## Topology kết nối

```text
iam / workflow / base
         │  DATABASE_URL (transaction pooling)
         ▼
     pgbouncer:6432  ──►  postgres:5432
         ▲
         │  DATABASE_DIRECT_URL (migrations, advisory locks)
         └─────────────── application bootstrap code
```

## PgBouncer

`docker-compose.yml` đặt application service dùng `pgbouncer:6432` cho
`DATABASE_URL`. IAM migration/advisory lock dùng `DATABASE_DIRECT_URL` trực tiếp
tới Postgres vì cần session ổn định. Không trỏ migration vào transaction pool.

Các giá trị chính:

- `max_client_conn=1000`, `default_pool_size=20`;
- `pool_mode=transaction`;
- `server_idle_timeout=60`;
- thời gian chờ và timeout được giới hạn để lỗi backend không giữ connection vô hạn.

Postgres giữ `max_connections = 100`, chừa chỗ cho Authentik, backup, exporter và
migration. Chỉ tăng `default_pool_size` sau khi kiểm tra `pg_stat_activity`, wait
event và `pgbouncer SHOW POOLS`.

## Tuning Postgres

Compose truyền các giá trị tuning production qua `postgres -c`:

| Tham số | Mặc định | Lý do |
|---|---|---|
| `shared_buffers` | `2GB` | cache dữ liệu/index host 15 GiB RAM |
| `effective_cache_size` | `6GB` | ước lượng cache OS + Postgres cho planner |
| `work_mem` | `16MB` | tránh bùng nổ bộ nhớ khi nhiều sort/hash đồng thời |
| `maintenance_work_mem` | `256MB` | vacuum/index build |
| `wal_buffers` | `16MB` | ghi WAL |
| `max_wal_size` | `4GB` | hạn chế checkpoint lớn |
| `min_wal_size` | `1GB` | giảm tái sử dụng WAL file |
| `checkpoint_completion_target` | `0.9` | trải checkpoint |
| `effective_io_concurrency` | `200` | SSD production |
| `random_page_cost` | `1.1` | planner cho SSD |
| `track_io_timing` | `on` | quan sát I/O |
| `shared_preload_libraries` | `pg_stat_statements` | ghi thống kê query |
| `jit` | `off` | tránh overhead JIT với query OLTP ngắn |

Giám sát cache hit ratio, checkpoint, WAL, lock wait, slow query và dung lượng
disk. Đây là điểm khởi đầu, không thay thế benchmark dữ liệu thật.

## IAM audit read replica tùy chọn

`DATABASE_READ_URL` là kết nối IAM-only tùy chọn cho SELECT cuối của
`GET /v1/audit` và `GET /v1/platform/audit`. Mặc định trống nên deployment hiện
tại vẫn dùng `DATABASE_URL`, không đổi hành vi. Ví dụ:

```dotenv
DATABASE_READ_URL=postgresql://synapse_readonly:REPLACE_ME@synapse-read-replica-proxy:6433/synapseone
```

Dùng role chỉ đọc với quyền `CONNECT`, `USAGE` và chỉ `SELECT` trên `audit_log`
(không có quyền migration, auth, quota, usage, session, export hay write). Kết
nối chính vẫn là `DATABASE_URL` / `DATABASE_DIRECT_URL`. Pool replica tối đa 4
connection, connect timeout 2s, statement/query timeout 5s, lock timeout 1s và
idle-in-transaction timeout 5s.

Mỗi thao tác replica chạy trong transaction `BEGIN READ ONLY` riêng với
`transaction_read_only=on`; client handle là private. Cùng transaction kiểm tra
`pg_is_in_recovery()`. Nếu endpoint không phải replica, không kết nối được, timeout
hoặc query audit lỗi, IAM ghi counter event có cấu trúc (không log connection
string hay error message) rồi fallback về query/count primary. Lỗi primary vẫn
được truyền ra bình thường.

Dữ liệu replica **eventual-consistent**. Audit row mới ghi có thể chưa xuất hiện;
list/count là snapshot riêng nên total phân trang có thể lệch. Không dùng đường
này cho read-after-write hoặc quyết định bảo mật. Authorization caller
org/platform-admin, gồm session và MFA, luôn hoàn tất trên primary trước SELECT
replica. Audit export, `logAudit`, auth, quota, usage summary/meter, platform
session và mutation vẫn ở primary.

Để tắt, unset `DATABASE_READ_URL` và recreate chỉ IAM. Không cần migration hay
rollback dữ liệu.

## Quota meter tổ chức nguyên tử

`org_quotas` nằm trong Postgres vì là cấu hình bền vững; request counter nằm
trong Valkey dưới `quota:v1:<service>:<subject>:<window>:<bucket>`. IAM dùng
client `ioredis` lazy riêng (`IAM_QUOTA_VALKEY_URL`, fallback `VALKEY_URL` rồi
`REDIS_URL`) với offline queue tắt, retry giới hạn, connect timeout 1s và command
timeout 1.5s. Nó không dùng audit read replica.

Một Lua call đọc counter minute, five-hour và UTC-day, kiểm tra cả ba, rồi mới
tăng request được chấp nhận và đặt TTL cửa sổ cố định. Nhờ vậy request bị từ chối
không tiêu thụ cửa sổ khác và admission nguyên tử qua nhiều replica IAM. Cửa sổ
bị từ chối có tỷ lệ dùng cao nhất (reset sớm nhất khi bằng) cung cấp `window`,
`count`, `limit`, `retryAfterSeconds` và `resetAt`.

Nếu Valkey không có hoặc không khả dụng, `/internal/quota/check` trả
`503 quota_unavailable`; gateway cố ý fail open về minute limiter in-memory hiện
có. Phải giám sát fallback: nó riêng từng replica và không thực thi 5h/day.
Không đưa quota counter lên audit replica hoặc flush toàn bộ Valkey khi rollback;
key hết hạn theo TTL.

Migration `0018` tạo `org_quotas`; timestamp lớn hơn hackathon `0017`.
Entry 0015 cũ trong live worktree chưa từng apply ở production. Migration `0019`
thêm nullable `requests_per_5h` và `requests_per_day`. Fresh install và nâng cấp
từ 0014 đều hỗ trợ. Khi rollback, giữ bảng/cột additive và khôi phục image
application thay vì rollback schema.

## L2 document-read cache

Base service có thể cache kết quả đọc document/query ở Valkey. Cache key mang
namespace tenant và phiên bản dữ liệu để tránh lộ dữ liệu giữa tenant. Mutation
xóa/đổi cache liên quan; lỗi Valkey fallback về đường đọc chính. Cache không phải
nguồn sự thật và không được dùng cho quyết định authorization.

## Vận hành

Theo dõi:

- `pg_stat_statements` và slow query;
- connection pool, lock wait và transaction duration;
- replica lag và counter `iam_audit_read` outcome;
- latency/error `/internal/quota/check`, số lần fallback minute;
- TTL/key quota và dung lượng Valkey;
- cache hit/miss của Base.

Chạy kiểm tra migration:

```bash
node tools/migration-check.mjs
node tools/catalog-check.mjs
npm run version-check
```
