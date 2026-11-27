# VIC Hackathon #1

**Ngôn ngữ / Language:** [Tiếng Việt](hackathon.md) | [English](../hackathon.md)

Trang công khai: **https://cloud.synapseone.space/hackathon**

## Tổng quan

VIC Hackathon #1 là sự kiện xây dựng sản phẩm dành cho thành viên CLB Lập trình
VIC. Mỗi đội **2–3 thành viên** phát triển sản phẩm từ SynapseOne và pitching trước
ban giám khảo. Đăng ký không cần tài khoản SynapseOne.

## Lịch trình — giờ Việt Nam (UTC+7)

| Mốc sự kiện | Thời gian |
|---|---|
| Đóng đơn đăng ký | **17:00 ngày 28/11/2026** |
| BTC phát API key qua email | **12:00 ngày 29/11/2026** |
| Vòng pitching | **19:00 ngày 03/12/2026** |

Trang công khai có đồng hồ đếm ngược đến hạn đăng ký. Backend cũng kiểm tra hạn
chót nên gọi API trực tiếp không thể vượt qua thời hạn.

## Thể lệ

1. Mỗi đội có 2–3 thành viên và một đội trưởng làm đầu mối liên hệ.
2. Sản phẩm phải được phát triển từ SynapseOne, sử dụng API, workflow, dữ liệu
   hoặc các năng lực khác của nền tảng.
3. Tôn trọng bản quyền, không phá hoại hệ thống và không chia sẻ API key công khai.
4. BTC tạo và gửi thủ công API key đến email đội trưởng sau khi duyệt đơn.
5. Mọi thay đổi lịch trình được thông báo qua email đội trưởng đã đăng ký.

## Giải thưởng

- **Giải nhất:** 500.000 VND
- **Giải nhì:** 300.000 VND
- **Giải ba:** 200.000 VND

Tổng giá trị giải thưởng: **1.000.000 VND**.

## Ban giám khảo

Ban giám khảo là đội ngũ xây dựng và duy trì SynapseOne tại VKU.VIC:

- Hồ Sỹ Bảo Nhân
- Võ Thành Nam
- Trần Thị Thùy Dương

Giới thiệu đội ngũ: <https://cloud.synapseone.space/about>

## API đăng ký

`POST /v1/hackathon/registrations` là API công khai, không cần tài khoản, JWT hay
API key. Các trường bắt buộc:

- `teamName`
- `captainName`
- `captainEmail`
- `captainPhone`
- `captainStudentId`
- `members`: 1–2 thành viên còn lại, tổng đội 2–3 người
- `acceptedRules: true`

Tùy chọn: `projectIdea`. Trường honeypot `website` bị từ chối nếu bot điền. Tên đội
và email đội trưởng là duy nhất, không phân biệt hoa/thường. API công khai có
giới hạn tần suất theo IP và `HACKATHON_MAX_REGISTRATIONS` (mặc định 500 đội).

API trả về ID đăng ký và trạng thái `pending`, không bao giờ trả về API key.

## Quy trình Superadmin

Platform operator/owner mở **Admin → VIC Hackathon** để:

1. Tìm/lọc đơn theo đội, đội trưởng, email, MSV hoặc trạng thái.
2. Xem danh sách thành viên và ý tưởng sản phẩm.
3. Duyệt/từ chối bằng step-up `hackathon:review`.
4. Tạo API key theo quy trình vận hành tin cậy hiện có và tự gửi email cho đội
   trưởng.
5. Đánh dấu đã gửi bằng step-up `hackathon:api-key-sent`.

Auditor chỉ được xem. Hành động duyệt và gửi key đều được audit. Hệ thống chỉ lưu
trạng thái/thời điểm gửi, không lưu API key plaintext.

## Cấu hình

| Biến | Mặc định | Mục đích |
|---|---|---|
| `HACKATHON_REGISTRATION_CLOSE_AT` | `2026-11-28T10:00:00.000Z` | Hạn đóng đơn phía server; ISO timestamp. |
| `HACKATHON_MAX_REGISTRATIONS` | `500` | Số đội tối đa. |
| `HACKATHON_REGISTRATION_RATE_LIMIT` | `5` | Số đơn công khai mỗi IP/window. |
| `HACKATHON_REGISTRATION_RATE_WINDOW_MS` | `900000` | Cửa sổ giới hạn (15 phút). |

Hạn mặc định tương ứng 17:00 giờ Việt Nam. Khi đổi ngày sự kiện, phải đồng bộ lịch
trên trang công khai và biến server.

## Quyền riêng tư và bảo mật

- Đăng ký công khai có chủ ý không gắn danh tính tenant.
- Thông tin liên hệ chỉ Platform Admin được phép xem.
- Mutation cần operator/owner, step-up khi bật và được audit.
- Không dán API key vào ghi chú duyệt hoặc bản ghi đăng ký.
- Backup bảng `hackathon_registrations` trước khi bảo trì schema/dữ liệu.
