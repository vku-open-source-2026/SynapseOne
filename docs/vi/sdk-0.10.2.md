<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 VKU.VIC -->
# SDK 0.10.2

Bốn SDK JavaScript/TypeScript, Python, Go và Rust dùng chung phiên bản `0.10.2`.
Phiên bản nền tảng/container vẫn độc lập với phiên bản SDK.

## Cài đặt

| Ngôn ngữ | Gói / module | Lệnh cài | Tag phát hành |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `@synapseone/sdk` | `npm install @synapseone/sdk@0.10.2` | `sdk-v0.10.2` |
| Python | `synapseone-sdk` | `pip install synapseone-sdk==0.10.2` | `sdk-v0.10.2` |
| Go | `github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go` | `go get github.com/vku-open-source-2026/SynapseOne/sdks/sdk-go@v0.10.2` | `sdks/sdk-go/v0.10.2` |
| Rust | `synapseone` | `cargo add synapseone@0.10.2` | `sdk-rust-v0.10.2` |

Go dùng tag multi-module `sdks/sdk-go/v<version>`; Go module proxy tự resolve,
không cần token registry hay repository riêng.

## Tài liệu

- Trang [Docs](https://synapseone.space/docs) có đầy đủ 16 dịch vụ/sản phẩm.
- Trong mỗi dịch vụ, tab SDK tách riêng JavaScript/TypeScript, Python, Go và
  Rust; công tắc ngôn ngữ của Console vẫn dịch phần giải thích sang tiếng Việt
  hoặc tiếng Anh.
- [Bản hướng dẫn theo dịch vụ](../services/README.md) có ví dụ bốn ngôn ngữ.
- [Ma trận parity](../sdk-parity.md) nêu rõ method nào chưa có wrapper tiện lợi và
  cách dùng generic request.

## CI/CD

- `sdk-v<version>`: build/test, tạo GitHub Release, publish npm/PyPI qua OIDC
  Trusted Publishing.
- `sdk-rust-v<version>`: kiểm tra version/tag, fmt, Clippy, test rồi publish
  crates.io.
- `sdks/sdk-go/v<version>`: kiểm tra version/tag, fmt, vet/test, module path và
  khả năng resolve trên Go proxy rồi tạo GitHub Release.
- `node tools/sdk-version-check.cjs` chặn version lệch giữa bốn SDK.

Chi tiết tiếng Anh: [sdk-0.10.2.md](../sdk-0.10.2.md).

## Thứ tự phát hành

Sau khi CI xanh và tài khoản GitHub Actions không còn bị chặn billing/spending:

```bash
git tag -a sdk-v0.10.2 -m "SDK 0.10.2"
git tag -a sdk-rust-v0.10.2 -m "Rust SDK 0.10.2"
git tag -a sdks/sdk-go/v0.10.2 -m "Go SDK 0.10.2"
git push origin sdk-v0.10.2 sdk-rust-v0.10.2 sdks/sdk-go/v0.10.2
```

Kiểm tra lại npm, PyPI, crates.io, Go proxy, GitHub Release và docs.rs. Không
di chuyển tag đã phát hành; lỗi sau release được sửa bằng `0.10.3`.
