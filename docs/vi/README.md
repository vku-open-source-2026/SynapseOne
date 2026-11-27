# Tài liệu SynapseOne

[English](../README.md) · Tiếng Việt

| Hướng dẫn | Nội dung | English |
|---|---|---|
| quickstart.md | Ba lệnh chạy, luồng đầu tiên, cài đặt Authentik/S3/workflow | — |
| architecture.md | Kiến trúc PaaS Tầng 1 và các quyết định kỹ thuật | — |
| business-flows.md | Tác nhân, vòng đời, quy tắc nghiệp vụ BF-01..BF-22 và truy vết | — |
| iam-model.md | Mô hình Organization/Account/Role/Policy, token và OIDC | — |
| [api.md](api.md) | Tài liệu API đầy đủ qua gateway | [../api.md](../api.md) |
| synapsebase.md | Tài liệu, ánh xạ object↔data, truy vấn và thay đổi | — |
| faststore.md | Cache, key/value, hash, list, set và lock | — |
| queue.md | Publish, consume, lease, retry và dead letter | — |
| workflow-runners.md | Runner workflow/inference/hybrid và bảo mật mạng | — |
| [configuration.md](configuration.md) | Bảng biến môi trường của toàn hệ thống | [../configuration.md](../configuration.md) |
| object-storage.md | API bucket/object, SeaweedFS và sao lưu | — |
| notifications.md | Outbox, biến inline, preference, gửi và retry | — |
| capability-matrix.md | Phạm vi thao tác, giao diện và giới hạn | — |
| lakehouse.md | Apache Iceberg, snapshot, schema evolution và ETL | — |
| troubleshooting.md | Cổng bận, curl Windows, lỗi 404, backup/restore, OIDC | — |
| console.md | Giao diện quản trị: chạy, cấu hình, SSO, phát triển frontend | — |
| [platform-superadmin.md](platform-superadmin.md) | Bootstrap, MFA, quản trị viên nền tảng và rollback | [../platform-superadmin.md](../platform-superadmin.md) |
| platform-superadmin-login.md | Tài khoản Platform Owner: đăng nhập, MFA, module, khôi phục | — |
| ai-assistant.md | Trợ lý kiểm thử API: thiết kế, model, giới hạn, chatbot | — |
| [database-performance.md](database-performance.md) | PgBouncer, Postgres, audit read replica, quota meter và Base cache | [../database-performance.md](../database-performance.md) |
| monitoring.md | Prometheus: chạy, target, cảnh báo và truy vấn hữu ích | — |
| production.md | Checklist production: secret, TLS, backup, ghim image | — |
| authentication-sso.md | SSO/OIDC: kích hoạt, bảo mật, xác minh và lỗi | — |
| sdk-js.md | SDK JavaScript/TypeScript: cài đặt, auth, API | — |
| sdk-python.md | SDK Python: cài đặt, auth, API | — |
| sdk-go.md | SDK Go: cài đặt, auth, API | — |
| sdk-0.10.1.md | Gói SDK 0.10.1, tag phát hành và audit | — |
| cli.md | CLI: cài đặt, cấu hình và lệnh | — |
| adr/ | Quyết định kiến trúc: Lakehouse, search, runtime parity, bảo mật workflow | — |
| production-readiness.md | Ma trận xác minh, blocker phát hành và điều kiện vận hành | — |
| migration-0.9.0-hardening.md | Thứ tự triển khai, tương thích migration và rollback | — |
| migration-synapseone.md | Nâng cấp SynapseDX lên SynapseOne 0.9.0 | — |
| [agents/services.md](agents/services.md) | Endpoint, dữ liệu, quy tắc và môi trường theo service | [../agents/services.md](../agents/services.md) |
| [org-quota-api-key-ui.md](org-quota-api-key-ui.md) | Triển khai, xác minh, giới hạn và rollback quota/API-key | [../org-quota-api-key-ui.md](../org-quota-api-key-ui.md) |

Các tên không có liên kết là tài liệu hiện chỉ có bản tiếng Anh ở `docs/`.
Bắt đầu tại [../README.md](../README.md). Đóng góp:
[../../CONTRIBUTING.md](../../CONTRIBUTING.md). Vận hành K8s:
[../../infra/k8s/README.md](../../infra/k8s/README.md).
