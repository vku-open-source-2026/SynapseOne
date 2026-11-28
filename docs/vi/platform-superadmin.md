# Platform Super Admin

[English](../platform-superadmin.md) · Tiếng Việt

Platform Super Admin là **mặt điều khiển cross-tenant do con người vận hành**,
tách biệt với `users.is_org_admin` (phạm vi tenant) và caller nền tảng nội bộ
`SYNAPSEONE_INTERNAL_SECRET`.

> **Switch MFA:** deployment hiện đặt `SYNAPSEONE_MFA_ENABLED=false`, nên đăng
> nhập mật khẩu/SSO là đủ và các thao tác platform không hỏi TOTP/step-up. Đặt
> switch về `true` để khôi phục luồng bảo mật chặt chẽ bên dưới. Khi bật lại,
> thu hồi session đang hoạt động (hoặc tăng `auth_version`) để session chỉ mật
> khẩu cũ không giữ nguyên mức bảo đảm trước đó.

## Mô hình bảo mật

- Quản trị viên nền tảng là user trong tổ chức nền tảng dành riêng
  (`PLATFORM_ORG_SLUG`, mặc định `synapseone-platform`).
- Quyền được cấp bằng dòng `platform_admins` (`owner`, `operator`, `auditor`).
  Xóa/thu hồi dòng có hiệu lực ở request kế tiếp.
- Console đổi JWT user thường **cộng mã TOTP mới** lấy token nền tảng ngắn hạn:
  - `kind=platform-admin`;
  - `aud=synapseone-platform-admin`;
  - không có claim org/account tenant;
  - TTL 15 phút.
- Gateway chỉ chấp nhận token này trên `/v1/platform/*`; token nền tảng bị từ
  chối trên API tenant. JWT user thường chỉ được chấp nhận tại
  `/v1/platform/session` để đổi token.
- API-key và token service-account không thể trở thành phiên nền tảng.
- Hành động phá hủy cần token step-up ngắn hạn thứ hai (`x-platform-step-up`,
  TTL 5 phút). Proof **dùng một lần**, gắn với phiên nền tảng (`sid`) và đúng
  hành động như `org:create`, `org:suspend`, `org:role:create`, `org:key:create`,
  `org:key:rotate`, `org:quota:update`, `user:reset-mfa`, `user:enable` hoặc
  `admin:grant`.
- Slug nền tảng không thể bị tạo như tenant. `bootstrap` từ chối dùng lại tenant
  đã sở hữu slug này; `currentPlatformAdmin` xác minh user thuộc org
  `kind=platform`.
- Tài khoản được mời (admin tenant đầu tiên, quản trị viên nền tảng bổ sung,
  user tenant) được kích hoạt bằng mã dùng một lần; email+org không đủ để chiếm
  membership. Mã hết hạn sau 7 ngày mặc định.
- User có membership ở nhiều org chỉ liệt kê context sau khi chứng minh sở hữu
  email (`email_verified`). Context của chính caller luôn hiện. Đăng nhập mật
  khẩu không đồng nghĩa email đã xác minh, nên hàng tự đăng ký bằng email nạn
  nhân không thể liệt kê org, user id hoặc trạng thái platform-admin của nạn
  nhân. Chuyển tenant → tenant còn cần mật khẩu đúng của user đích (và MFA nếu
  bật). Tenant → platform không cấp phiên; phải đăng nhập org platform và MFA.
  Kể cả khi email trùng, phiên platform gắn với user của org platform: mật
  khẩu/TOTP tenant không bao giờ là bằng chứng platform. Không có đường đóng
  gói email-only hay impersonation.
- Org tenant có vòng đời `active`/`suspended`. Suspend cần lý do và step-up, thu
  hồi session/API-key, được IAM và gateway thực thi. Org platform được bảo vệ;
  reactivate cũng cần step-up và đăng nhập tenant mới.
- Mặt điều khiển ưu tiên metadata: không lộ nội dung document, object hoặc secret
  tenant qua các module dashboard.

## Module

| Module | API chính |
|---|---|
| Tổng quan | `GET /v1/platform/overview`, `/v1/platform/usage/summary` |
| Tổ chức | `GET/POST /v1/platform/orgs`, `GET /v1/platform/orgs/:id`, `/resources`, `/audit`, suspend/reactivate |
| API-key | `POST /v1/platform/orgs/:id/keys` (tạo), `POST .../keys/:keyId/rotate`, `POST .../keys/:keyId/revoke`; danh sách chỉ metadata |
| Rate Limits | `/admin/quotas` và tab Quotas của tổ chức; `GET/PUT/DELETE /v1/platform/orgs/:id/quotas[/:service]`, `GET /v1/platform/quotas[/defaults]` |
| Account | `GET /v1/platform/accounts` |
| User & quyền | `GET /v1/platform/users`, `GET /v1/platform/users/:id`, các route hành động user |
| Chi tiết tổ chức | Các tab Overview, Accounts, Members, Administrators, Roles, Policies, API Keys, Quotas, Service Accounts, Audit tại `/admin/orgs/:id` |
| Tình trạng service | gateway `GET /ready` |
| Usage | `GET /v1/platform/usage/summary`, `/v1/platform/usage/events` |
| Audit & bảo mật | `GET /v1/platform/audit` |
| Quản trị viên nền tảng | `GET/POST /v1/platform/admins`, `DELETE /v1/platform/admins/:id` |

## Cấu hình

Quản trị viên vừa hoàn tất đăng nhập password + TOTP có thể mở console mà không
nhập lại factor: claim `amr`/`auth_time` được dùng lại trong
`PLATFORM_FRESH_MFA_SECONDS`. Session cũ, refresh không có factor mới và
credential không MFA vẫn phải đổi mã mới. Hành động nhạy cảm luôn cần proof
step-up riêng.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PLATFORM_ADMIN_ENABLED` | `true` dev, `false` prod nếu chưa đặt | bật `/v1/platform/*` và console `/admin` |
| `PLATFORM_ADMIN_REQUIRE_MFA` | `true` | yêu cầu TOTP đã đăng ký và mã mới khi đổi phiên |
| `PLATFORM_ADMIN_REQUIRE_STEP_UP` | `true` | yêu cầu step-up cho hành động phá hủy |
| `PLATFORM_ORG_SLUG` | `synapseone-platform` | org dành riêng cho nhân sự nền tảng |
| `PLATFORM_SESSION_TTL_SECONDS` | `900` | TTL phiên console (60s–30 ngày); session dài vẫn thu hồi được qua `auth_version` |
| `PLATFORM_FRESH_MFA_SECONDS` | `900` | dùng lại MFA đăng nhập thành công trong cửa sổ này (60–3600s) |
| `PLATFORM_STEP_UP_TTL_SECONDS` | `300` | TTL proof step-up (60–900s) |
| `IAM_INVITE_TOKEN_TTL_SECONDS` | `604800` | TTL mã kích hoạt (5 phút–30 ngày) |
| `PLATFORM_BOOTSTRAP_SECRET` | trống | bootstrap owner đầu tiên dùng một lần; trống là tắt; prod cần 32+ ký tự |
| `PLATFORM_RECOVERY_SECRET` | trống | khôi phục khẩn cấp khi mất MFA; prod cần 32+ ký tự |
| `IAM_SENSITIVE_MUTATION_MODE` | `audit` | `enforce` yêu cầu org admin cho mutation IAM đặc quyền |
| `IAM_ALLOW_DIRECT_ORG_CREATE` | `true` dev / `false` prod | `POST /v1/orgs` trực tiếp |
| `AUTHZ_MODE_REQUIRED` | `false` dev / `true` prod | gateway từ chối boot nếu `AUTHZ_MODE=off` |

Khuyến nghị production:

```dotenv
AUTHZ_MODE=enforce
AUTHZ_MODE_REQUIRED=true
IAM_SENSITIVE_MUTATION_MODE=enforce
IAM_ALLOW_DIRECT_ORG_CREATE=false
PLATFORM_ADMIN_ENABLED=true
PLATFORM_ADMIN_REQUIRE_MFA=true
PLATFORM_ADMIN_REQUIRE_STEP_UP=true
# Phiên console 7 ngày; tăng/giảm tùy nhu cầu (tối đa 30 ngày).
PLATFORM_SESSION_TTL_SECONDS=604800
PLATFORM_STEP_UP_TTL_SECONDS=300
PLATFORM_BOOTSTRAP_SECRET=<random 32+ chars>
PLATFORM_RECOVERY_SECRET=<random 32+ chars>
```

Nếu console phục vụ trên host khác, thêm đúng origin vào `CORS_ORIGIN` và edge
allowlist. Không expose endpoint bootstrap/recovery nội bộ qua gateway; chúng
không có mục `routes.yaml`.

## Platform Owner đầu tiên

Endpoint bootstrap chỉ nội bộ (không có route gateway) và chỉ hoạt động khi
`platform_admins` trống. Nó cần cả `PLATFORM_BOOTSTRAP_SECRET` và header internal
khi cấu hình. Nó từ chối tenant đã sở hữu slug dành riêng.

### Docker Compose

```bash
# 1. Khởi động stack và apply migration IAM khi boot
docker compose up -d --build

# 2. Tạo platform owner đầu tiên (chạy trong container IAM)
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_BOOTSTRAP_SECRET;
fetch("http://localhost:4001/internal/platform/bootstrap", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-synapseone-internal": process.env.SYNAPSEONE_INTERNAL_SECRET,
    "x-platform-bootstrap-secret": secret
  },
  body: JSON.stringify({ email: "platform-owner@example.com", displayName: "Platform Owner" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

Endpoint trả `201` một lần và `409 bootstrap_completed` về sau. Response có
`inviteToken` dùng một lần (trừ khi account đã có mật khẩu).

### Kích hoạt tài khoản

Bootstrap tạo user chưa có mật khẩu và trả `inviteToken`. Kích hoạt bằng mã đó
hoặc mở `/register` trong Console:

```bash
curl -sX POST http://localhost:8080/v1/auth/invite/accept \
  -H 'Content-Type: application/json' \
  -d '{"token":"<inviteToken>","password":"<strong-password>"}'
```

Mã dùng một lần, hết hạn sau 7 ngày mặc định và không cần cặp email+org. OIDC
cũng hoạt động nếu danh tính IdP được ánh xạ vào cùng email của org platform.

### Mở dashboard

1. Đăng nhập tại `/login` bằng slug org, email và mật khẩu. Console hỗ trợ đăng
   nhập mật khẩu first-party; OIDC dùng được khi cấu hình.
2. Mở `/security` và bật TOTP MFA (10 recovery code chỉ hiện một lần).
3. Sau đăng nhập, quản trị viên nền tảng được chuyển tới `/admin/overview`, kể cả
   user hai vai trò nhập slug tenant. Nếu hiện là user tenant, guard yêu cầu đăng
   nhập org platform thay vì nâng cấp danh tính tenant. Hoàn tất MFA của org
   platform rồi nhập mã xác thực mới cho phiên nền tảng riêng.
4. Trang Tổng quan tải metadata toàn nền tảng. Account chỉ platform không thấy
   điều hướng tenant; account hai vai trò có thể chuyển sang tenant thực sự thuộc
   mình.

Tài khoản local đã cấp sẵn password/TOTP ngoài Git được mô tả trong
`platform-superadmin-login.md` (bản tiếng Anh).

### Khôi phục khi owner duy nhất mất MFA

`PLATFORM_RECOVERY_SECRET` bật endpoint nội bộ khẩn cấp:

```bash
docker compose exec -T iam node -e '
const secret = process.env.PLATFORM_RECOVERY_SECRET;
fetch("http://localhost:4001/internal/platform/recovery", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-synapseone-internal": process.env.SYNAPSEONE_INTERNAL_SECRET,
    "x-platform-recovery-secret": secret
  },
  body: JSON.stringify({ userId: "<platform-user-id>", action: "reset-mfa" })
}).then(async r => { console.log(r.status, await r.text()); });
'
```

Dùng `action: "revoke-sessions"` để xóa refresh session. `reset-mfa` cũng thu hồi
refresh session và API-key. Mọi sự kiện bootstrap/recovery đều ghi `audit_log`.

## Thêm quản trị viên thứ hai

Dùng `/admin/access` (chỉ owner), hoặc:

```bash
# Cần platform token của owner. Tạo proof dùng một lần:
# POST /v1/platform/step-up {"code":"123456","action":"admin:grant"}
curl -sX POST http://localhost:8080/v1/platform/admins \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "x-platform-step-up: $STEP_UP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops@example.com","role":"operator","reason":"on-call rotation"}'
```

Response có `inviteToken` cho account mới. Gửi ngoài kênh; người nhận kích hoạt
tại `/register` và đăng ký TOTP trước phiên platform đầu tiên. Owner duy nhất
không thể bị hạ cấp/thu hồi (`409 last_owner`).

## Tổ chức, API-key và quota

1. Mở **Organizations**, chọn tenant rồi dùng **API Keys** để xem account,
   prefix, scope, owner, thời điểm tạo/dùng cuối/expiry và trạng thái. Secret và
   hash không bao giờ được liệt kê. Dùng **New key** hoặc **Rotate** với mã
   step-up mới rồi sao chép secret ngay. Rotate có thể thu hồi key cũ ngay
   (`graceSeconds: 0`) hoặc cho thời gian chồng lấn có giới hạn.
2. Mở tab **Quotas** để so sánh hạn mức hiệu lực với mặc định toàn cục. Nhập số
   nguyên dương cho Requests/min, Requests/5h, Requests/day và các trường
   token/execution/concurrency riêng. Ô trống kế thừa mặc định; **Reset to
   default** xóa override. Mọi mutation đều có step-up và audit.
3. Dùng **Rate Limits** ở sidebar admin để tìm kiếm/phân trang override. Cửa sổ
   request cố định theo epoch-minute, epoch-five-hour và UTC-day. IAM/Valkey
   admission nguyên tử ba cửa sổ; khi gián đoạn, gateway dùng minute limiter cục
   bộ và endpoint check nội bộ trả `503 quota_unavailable`.
4. Tenant có trang **Quotas** chỉ-đọc tại `/quotas`, gọi
   `GET /v1/orgs/:orgId` và `GET /v1/orgs/:orgId/quotas`. Đọc cross-tenant bị từ
   chối. Endpoint platform/internal không expose cho tenant.

Console phân biệt default/override theo trường và hiển thị trường không áp dụng
hoặc không giới hạn thay vì số 0 gây hiểu nhầm. Bảng cuộn ngang trên màn hình
hẹp và tab có ngữ nghĩa ARIA.

## Database

IAM migrations thêm:

- `0007_fluffy_scarecrow.sql`: `platform_admins`, `organizations.kind`,
  `audit_log.org_id` + index, `idx_users_email_lower`, `idx_users_created_at`.
- `0008_shocking_grandmaster.sql`: `platform_step_ups` với `jti`, liên kết
  user/session/action, expiry, used_at.
- `0010_wonderful_alex_wilder.sql`: trạng thái suspend org và
  `service_accounts.revoked_at`; additive/tương thích ngược.
- `0018_org_quotas.sql`: `org_quotas` với hạn mức nullable theo service.
  Timestamp journal được sửa để mới hơn `0014` vì production chưa apply entry sai
  thứ tự và chưa có bảng.
- `0019_org_quota_request_windows.sql`: thêm nullable `requests_per_5h` và
  `requests_per_day`. Fresh install và nâng cấp từ 0014 đều tới cùng schema;
  timestamp journal tăng đơn điệu.
- `0020_api_key_rotation_marker.sql`: thêm nullable `api_keys.rotated_at` để chỉ
  một rotation thắng khi gọi đồng thời, trong khi key grace vẫn dùng được. Yêu
  cầu 0019; không chạy lại thủ công.

Migration có tính additive nhưng **không thể chạy lại/idempotent**. Điều kiện hỗ
trợ là database mới hoặc database đã migrate tới 0014 và chưa có bảng
`org_quotas`; 0020 yêu cầu schema 0019. Không chạy lại SQL thủ công—Drizzle ghi
hash đã apply trong journal. Backfill audit:

```bash
node tools/backfill-audit-org.mjs
```

Script chạy theo batch và an toàn khi chạy lại.

## Rollback

1. Đặt `PLATFORM_ADMIN_ENABLED=false` (route platform trả 404; UI không truy cập
   được).
2. Thu hồi phiên platform bằng `platform_admins.revoked_at` hoặc `revokeAllRefresh`
   cho user platform.
3. Khôi phục image gateway/console/IAM nếu cần.
4. Giữ migration additive. Code cũ bỏ qua `platform_admins`, `platform_step_ups`,
   `organizations.kind`, `audit_log.org_id`; không drop khi rollback sự cố.
5. Nếu phải nới lỏng rollout bảo mật, đặt `IAM_SENSITIVE_MUTATION_MODE=audit` và
   giám sát; không để `off`.
6. Rollback quota: khôi phục image IAM/gateway/Console và env cũ trước. Giữ
   `org_quotas` cùng migration; code cũ bỏ qua cột mới. Không drop bảng. Để ngắt
   shared enforcement không cần rollback schema, làm Valkey quota không khả dụng:
   `/internal/quota/check` trả 503 và gateway dùng fallback minute cục bộ. Counter
   cũ hết hạn theo TTL cửa sổ cố định.

Xem `../iam-model.md` và `../api.md` để biết hành vi IAM.
