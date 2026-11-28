# Nhật ký thay đổi

[English](../../CHANGELOG.md) · Tiếng Việt

Bản tiếng Việt này theo dõi các thay đổi quan trọng của dự án. Bản chuẩn đầy đủ
của từng bản phát hành nằm trong `CHANGELOG.md` tiếng Anh.

## [Chưa phát hành]

### Thêm

- **Kênh phát hành CLI 0.11.1:** tag `cli-v<version>` kiểm thử và publish CLI cài
  một lần độc lập với bản phát hành toàn bộ image nền tảng.
- **SynapseDNS và Synapse Tunnel:** dịch vụ edge Tầng 1 chạy độc lập với DNS
  authoritative UDP/TCP, API quản lý zone/record, connector tunnel HTTP chỉ kết
  nối outbound, ingress routing theo host/path, JSON persistence nguyên tử,
  Docker/Compose, tài liệu vận hành song ngữ và hướng dẫn bốn ngôn ngữ. Quản lý
  giờ có qua trang Platform Admin và route gateway hẹp; MFA là tùy chọn và đang
  tắt trên deployment hiện tại. Tích hợp Tầng 2/3 vẫn để sau.
- **Tên dịch vụ Console:** ẩn Gateway & Ops khỏi service tray nhưng vẫn giữ trong
  Docs, và đổi tên dịch vụ tìm kiếm tenant thành **SynapseSearch**.
- **Quản lý edge theo tổ chức:** zone SynapseDNS và connector Synapse Tunnel có
  ownership org. Route Console tenant `/dns` và `/tunnel` dùng API gateway có
  scope, truy cập khác org trả 404, và bản ghi version-1 được chuyển thành thuộc
  platform. Platform Admin giữ route vận hành global riêng thay vì sở hữu mọi
  tunnel của tổ chức.
- **Quy trình Tunnel kiểu Cloudflare:** Console tạo connector, route hostname và
  bản ghi SynapseDNS tùy chọn trong một luồng hướng dẫn, hiển thị token connector
  một lần và tạo lệnh `synapseone tunnel run` an toàn. CLI chạy connector
  HTTP/SSE chỉ outbound trên máy cục bộ với reconnect và streaming; Console làm
  mới trạng thái kết nối trực tiếp.
- **Quota tổ chức và mặt quản lý API-key.** Quản trị viên nền tảng xem metadata
  API-key tenant, tạo/xoay vòng key với secret chỉ hiện một lần, và quản lý
  override nullable cho `ai`/`inference`/`workflow`. Tenant đọc được tổ chức và
  quota hiệu lực của chính mình. Admission request dùng kiểm tra Valkey nguyên tử
  của IAM trên cửa sổ epoch-minute, epoch-five-hour và UTC-day cố định; response
  429 xác định `window` và `Retry-After`. Route workflow thường và MCP tool call
  dùng chung một budget IAM execution-hour/concurrency nguyên tử, gồm JSON-RPC
  batch. IAM/Valkey request-admission lỗi thì gateway fallback về minute limiter
  cục bộ; execution-admission lỗi thì fail closed. Bao gồm migration
  0018/0019/0020, Console `/admin/quotas`, tab API Keys/Quotas của tổ chức và
  trang tenant `/quotas`. Rotation key nguyên tử, giới hạn grace key cũ ở expiry
  gốc và giữ nguyên expiry đó cho key kế nhiệm. Cơ chế truyền token usage hiện
  tại vẫn là best-effort.
- **IAM audit read replica:** `DATABASE_READ_URL` tùy chọn chỉ định tuyến SELECT
  list/count audit tenant/nền tảng tới PostgreSQL hot standby read-only sau khi
  authorization trên primary. Read có timeout ngắn và tự fallback primary;
  auth, quota, write, export và mutation vẫn ở primary.
- **Kênh phát hành SDK 0.10.2:** bốn SDK dùng chung version gate; Go publish
  từ module path monorepo thật qua tag `sdks/sdk-go/v*`. Tài liệu dịch vụ có ví dụ
  tách riêng JavaScript/TypeScript, Python, Go và Rust.
- **Kênh phát hành SDK 0.10.1:** tag `sdk-v*` publish asset/gói JS và Python mà
  không build container platform; `sdk-rust-v*` tiếp tục publish Rust crate.

### Bảo mật

- **Chế độ chỉ mật khẩu/SSO:** `SYNAPSEONE_MFA_ENABLED=false` là mặc định của
  Compose/K8s. Switch này bỏ challenge TOTP, MFA khi mở platform và step-up nhưng
  vẫn giữ lockout mật khẩu, thu hồi session và audit. Đặt `true` để bật lại MFA.
- Approval checkpoint workflow lưu đúng `pause_task_id`/`pause_node`; task tạo
  qua API/legacy không thể giả mạo checkpoint.
- Runner audience mặc định `account`; runner org-wide cần grant admin tường minh.
- Warehouse SQL sandbox tắt external file access và khóa cấu hình DuckDB.
- IAM policy condition fail-closed và validate khi ghi; refresh token đã rotate
  bị replay thì thu hồi cả token family.
- Các đường quota/API-key không làm lộ plaintext secret cũ; metadata chỉ đọc và
  rotation là đường cấp secret mới duy nhất.

### Sửa

- **Flow Console edge tenant:** giữ đúng prefix `/v1` của service trên route
  gateway DNS/Tunnel, bỏ qua deep-link zone cũ ngoài org và thêm test connector
  hướng dẫn 60 giây với phản hồi thành công/timeout/lỗi trực tiếp.
- **Lỗi phát hành SDK 0.10.2:** khôi phục package export JS
  `ocs/search/warehouse/lakehouse`, đồng bộ type/runtime của flat alias, sửa
  Python Search, ghi rõ workflow credential không hỗ trợ expiry thay vì gửi
  trường backend bỏ qua, thêm đủ bộ wrapper Lakehouse của Go và sửa request MFA
  recovery-code của Rust.
- **Ba blocker re-review quota:** execution workflow thường và MCP call dùng
  chung hourly counter/lease concurrency IAM nguyên tử; rotation grace PostgreSQL
  giữ expiry gốc của key kế nhiệm; snapshot quota rebase lên snapshot hackathon
  0017 đã merge và giữ `hackathon_registrations` tới 0020.
- Timestamp journal migration `0018` đã lớn hơn hackathon `0017`; `0019` thêm
  `requests_per_5h`/`requests_per_day` nullable cho fresh install và nâng cấp.
- Service-account được xác định org sở hữu từ IAM verify response để quota và
  usage attribution đúng tenant.
- Workflow test-run được đếm vào execution meter; request bị từ chối/read/status
  mutation không tiêu thụ hourly budget.
- Quota search áp dụng trước count/limit; tạo key tenant có `Cache-Control:noStore`.
- Execution lease guard của gateway Rust giải phóng lease IAM dùng chung ở mọi
  early return/error/cancellation.

## Các bản phát hành trước

| Phiên bản | Ngày | Nội dung chính |
|---|---|---|
| 0.9.0 | 2026-11-10 | Kiến trúc PaaS Tầng 1, workflow/runner, data plane, audit, SDK |
| 0.7.1 | 2026-11-04 | Sửa lỗi runtime và bảo mật |
| 0.7.0 | 2026-10-31 | Mở rộng workflow, notification và quản lý dữ liệu |
| 0.6.2 | 2026-10-27 | Ổn định queue/stream và runner |
| 0.6.1 | 2026-10-27 | Sửa lỗi phát hành |
| 0.6.0 | 2026-10-21 | Warehouse, Lakehouse, OCS và notification |
| 0.5.2 | 2026-10-21 | Sửa lỗi tenancy và usage |
| 0.5.1 | 2026-10-21 | Sửa lỗi runtime |
| 0.5.0 | 2026-10-21 | Mở rộng API, SDK và Console |
| 0.4.0 | 2026-10-20 | Bảo mật production, migration và quan sát |
| 0.3.1 | 2026-10-12 | Sửa lỗi workflow/OIDC |
| 0.3.0 | 2026-10-07 | Bổ sung workflow engine và data service |
| 0.2.0 | 2026-10-06 | Mở rộng API gateway và IAM |
| 0.1.0 | 2026-10-06 | Bản đầu tiên |

Xem `CHANGELOG.md` tiếng Anh để có danh sách thay đổi chi tiết của từng phiên bản.
