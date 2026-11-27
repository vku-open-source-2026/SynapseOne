# Hạn mức tổ chức và mặt quản lý API-key

[English](../org-quota-api-key-ui.md) · Tiếng Việt

Tính năng này bổ sung khả năng xem tổ chức an toàn theo tenant, quản lý API-key
chỉ bằng metadata dành cho operator nền tảng, và hạn mức request dùng chung cho
`ai`, `inference` cùng `workflow`. Các tài liệu tiếng Anh trong `docs/` là bản
chuẩn.

## Luồng người dùng

### Quản trị viên nền tảng

1. Mở **Rate Limits** (`/admin/quotas`) để xem mặc định toàn cục và danh sách
   override theo tổ chức có tìm kiếm/phân trang.
2. Mở một tổ chức và dùng tab **API Keys**:
   - xem account, prefix, scope, owner, thời điểm tạo/dùng cuối/expiry và trạng thái;
   - chọn **New key** hoặc **Rotate**, xác thực step-up rồi sao chép secret ngay;
   - dùng **Revoke** để thu hồi vĩnh viễn ngay lập tức.
3. Mở **Quotas** để sửa Requests/min, Requests/5h, Requests/day và các trường
   token/execution/concurrency riêng của service. Ô trống nghĩa là kế thừa mặc
   định toàn cục. **Reset to default** xóa override của service.

Plaintext key chỉ được trả về khi tạo/xoay vòng. Secret không bao giờ được lưu
hoặc trả về từ API list/detail/resource; database chỉ lưu hash. Rotation dùng
chuyển trạng thái có điều kiện `api_keys.rotated_at` (migration 0020) nên chỉ một
lượt thắng khi gọi đồng thời. Thời điểm retire grace bị giới hạn ở
`min(now + graceSeconds, originalExpiresAt)`, còn key kế nhiệm luôn giữ nguyên
expiry gốc (kể cả không có expiry). Response tạo và xoay vòng dùng
`Cache-Control: noStore`; mutation key và quota của nền tảng đều cần step-up dùng
một lần và được ghi audit.

### Người dùng tenant

Mở **Quotas** (`/quotas`) để xem chỉ-đọc tổ chức và hạn mức hiệu lực. Trang thể
hiện nguồn default/override theo từng trường và đánh dấu rõ trường không áp dụng
hoặc không giới hạn. Trang gọi:

- `GET /v1/orgs/:orgId`
- `GET /v1/orgs/:orgId/quotas`

IAM áp dụng `canActForOrg`; tenant khác nhận `403`. Endpoint nền tảng và nội bộ
không được cấp cho credential tenant. Phiên API-key cũng dùng được các đường
đọc này khi scope cho phép IAM read.

## Hợp đồng quota

`org_quotas` có một dòng cho mỗi `(org_id, service)` với các trường nullable:

- `requests_per_min`, `requests_per_5h`, `requests_per_day`;
- các trường hiện có `tokens_per_day`, `executions_per_hour`,
  `concurrent_executions`.

NULL kế thừa mặc định toàn cục. Response hiệu lực dùng camelCase và bổ sung
`overridden` cùng map `overrides` để xác định nguồn từng trường.

Cửa sổ request là **cố định**, không phải sliding:

| Window | Bucket | Reset |
|---|---|---|
| `minute` | `floor(epoch_seconds / 60) * 60` | epoch minute kế tiếp |
| `fiveHour` | `floor(epoch_seconds / 18000) * 18000` | ranh giới năm giờ epoch kế tiếp |
| `day` | ngày UTC `YYYY-MM-DD` (UTC-day) | `00:00:00Z` ngày kế tiếp |

Mặc định suy ra `requestsPer5h = requestsPerMin * 300` và
`requestsPerDay = requestsPerMin * 1440` khi biến môi trường tương ứng chưa đặt.
Tên chuẩn cho minute là `AI_QUOTA_REQUESTS_PER_MIN`,
`INFERENCE_QUOTA_REQUESTS_PER_MIN` và `WORKFLOW_QUOTA_REQUESTS_PER_MIN`.
`AI_RATE_LIMIT` cùng `INFERENCE_RATE_LIMIT_PER_MIN` vẫn là input tương thích cũ.
Concurrency workflow mặc định là 10.

## Admission và hành vi khi gián đoạn

Gateway xác định org sở hữu đã xác minh, gồm JWT service-account thông qua
`org_id` do IAM trả về khi verify principal. Giá trị này được giữ riêng trong
`attributionOrg`/`attribution_org`: authorization service-account vẫn gắn account
và không stamp `x-synapseone-org`. Chỉ header trusted `x-synapseone-quota-org`
mang attribution tới workflow-service. Gateway lấy hạn mức hiệu lực rồi gửi
`POST /internal/quota/check` với
`{subject, service, limits:{minute,fiveHour,day}}`. Endpoint được bảo vệ bởi
`SYNAPSEONE_INTERNAL_SECRET` và không có route công khai.

Central authorization chạy trước khi tính quota org dùng chung. Request bị policy
từ chối hoặc authz-unavailable không tiêu thụ budget request hay execution. Với
route execute/test-run/tạo inference-job thường, gateway gọi
`POST /internal/workflow/execution/check` trước request admission và giữ lease cho
tới khi proxy request hoàn tất. `/mcp` vẫn tham gia workflow request admission ở
edge. Vì một JSON-RPC batch có thể chứa tối đa 20 `tools/call` và gateway không
được buffer body, workflow-service gọi **cùng** endpoint execution IAM cho từng
tool call thật và giữ lease trong suốt lượt chạy.

Cả hai đường dùng `{subject:"org:<id>",limits:{hour,concurrent}}`; IAM kiểm tra
nguyên tử cùng một counter epoch-hour và cùng một sorted-set lease concurrency.
Vì vậy execution thường được chấp nhận và MCP call thật dùng chung cả hai budget.
Mọi lease được giải phóng khi hoàn tất, lỗi hoặc cancellation. Production mặc
định bật `WORKFLOW_MCP_QUOTA_ENFORCEMENT` cho MCP; route execution thường luôn
dùng admission chung. Khi quota store execution lỗi, cả hai đường fail closed thay
vì bypass giới hạn đã cấu hình.

Client `ioredis` của IAM lấy timestamp đúng một lần cho key, TTL, reset metadata
và Lua ARGV. Nó chạy một Lua script trên ba key
`quota:v1:<service>:<subject>:<window>:<bucket>`. Script kiểm tra cả ba counter
trước khi tăng bất kỳ counter nào, sau đó tăng request được chấp nhận và đặt TTL
một cách nguyên tử. Request bị từ chối không tiêu thụ hạn mức ở cửa sổ nào.
Response gồm `{allowed,window,count,limit,retryAfterSeconds,resetAt}`. Backoff
reconnect tối đa hai giây và retry vô hạn; `/health` công bố trạng thái quota,
counter check/denial/unavailable và thời điểm lỗi cuối.

Response 429 của gateway có `service`, `window` bị ràng buộc, `limit`,
`retryAfter`, `retryAfterSeconds`, `resetAt` tùy chọn và header `Retry-After`.
Nhờ vậy caller phân biệt được từ chối `fiveHour`/`day` với minute.

Nếu lấy hạn mức hiệu lực hoặc Valkey **request** admission lỗi, IAM trả 503 và
gateway fail open về bộ giới hạn minute in-memory hiện có. Traffic anonymous/IP
luôn dùng bộ giới hạn cục bộ này. Đây là hành vi ưu tiên khả dụng, nhưng fallback
chỉ riêng từng replica gateway và không thực thi hạn mức 5h/day; cần giám sát/cảnh
báo. **Execution** admission chung hoạt động khác: route execution thường trả
503 còn MCP call đang được thực thi trả lỗi quota khi IAM/Valkey không thể admit
hoặc release budget execution.

## Chiều hiện có và giới hạn

- `tokensPerDay` vẫn đo từ usage telemetry eventual-consistent. Nhà cung cấp
  không trả usage có thể khiến token bị đếm thiếu; patch này không thiết kế lại
  cơ chế truyền token.
- `executionsPerHour` đếm request execute, test-run và tạo inference-job được chấp
  nhận cùng từng MCP `tools/call` được admit; request bị từ chối, read và cập nhật
  trạng thái không tiêu thụ hourly budget chung.
- `concurrentExecutions` là một budget lease sorted-set IAM dùng chung. Gateway
  giữ lease execution thường suốt proxy request; workflow-service giữ lease MCP
  suốt lượt chạy tool. Việc backend hoàn tất execution qua queue vẫn không phải
  tín hiệu concurrency thời gian thực chính xác.
- Cấu hình quota/meter được cache khoảng 30 giây mặc định.

## Migration và triển khai

1. Apply migration IAM trước khi chạy image IAM/gateway mới.
2. `0018_org_quotas.sql` tạo `org_quotas`. Timestamp 0015 cũ trong live worktree
   cũ hơn `0014` nên sẽ bị bỏ qua; production chưa apply và chưa có bảng. Quota
   migration bắt đầu từ 0018, cao hơn hackathon 0017 (đã merge vào main tại
   `9d744d0`), nên thứ tự runtime và tên file không xung đột.
3. `0019_org_quota_request_windows.sql` thêm nullable `requests_per_5h` và
   `requests_per_day`. Timestamp journal tăng đơn điệu và snapshot nối tiếp
   `0017 → 0018 → 0019 → 0020`; mọi snapshot quota đều chứa
   `hackathon_registrations`, nên lần generate schema sau không thể drop bảng này.
4. `0020_api_key_rotation_marker.sql` thêm nullable `api_keys.rotated_at` để
   rotation chỉ có một người thắng. Các SQL additive nhưng **không thể chạy lại
   hay idempotent**; input hỗ trợ là database mới hoặc database 0014 chưa có bảng
   `org_quotas` (đường nâng cấp sẽ apply hackathon 0017 trước quota). Không chạy
   lại thủ công.
5. Đặt biến quota chuẩn giống nhau trên IAM và gateway. Trỏ
   `IAM_QUOTA_VALKEY_URL` tới Valkey hoặc để fallback sang `VALKEY_URL` /
   `REDIS_URL`. Compose và K8s base đã có mặc định.
6. Xác minh đường fresh, nâng cấp từ 0014 và merged-tree hackathon-first, rồi
   chạy kiểm tra catalog, migration, snapshot no-change generation và version.
   Test Valkey chỉ xóa key có prefix ngẫu nhiên (không `FLUSHDB`). Test Postgres
   cần `DATABASE_URL` và `IAM_TEST_DATABASE_URL=1`.

## Rollback

Khôi phục image IAM/gateway/Console và biến môi trường cũ trước. Giữ
`org_quotas`, `api_keys.rotated_at`, index và migration journal; image cũ bỏ qua
cột mới. Không drop bảng khi đang xử lý sự cố. Key quota Valkey hết hạn theo TTL
cửa sổ cố định (lease execution sau năm phút); không flush dữ liệu không liên
quan. Để buộc fallback minute cho request, làm endpoint quota Valkey không khả
dụng với IAM; khi đó 5h/day request không còn được thực thi dùng chung và
execution admission thường/MCP fail closed.
