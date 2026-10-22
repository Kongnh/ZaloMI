# Zalo MI

Công cụ dòng lệnh `zmi` (Node 24) đọc tin nhắn nhóm Zalo từ ứng dụng Zalo PC đang chạy, qua Chrome DevTools Protocol, để đưa vào một database SQLite riêng phục vụ báo cáo market intelligence theo yêu cầu. Thiết kế đầy đủ: `Thiết kế hệ thống Zalo MI.md`. Kết quả thử nghiệm đọc dữ liệu: `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`.

Ở bước này mới có khung dự án, kết nối CDP, cầu nối chỉ đọc và lệnh `doctor`.

## Yêu cầu

- Windows, Node 24 trở lên.
- Zalo PC đang mở **kèm cờ** `--remote-debugging-port=9222` (lối tắt "Zalo (MI)"). Phải thoát hẳn Zalo trước khi mở lại, nếu không Zalo đang chạy sẽ bỏ qua cờ này. Cổng chỉ mở ở `127.0.0.1`.

## Lệnh

```
node zmi.mjs doctor [--port 9222]
```

`doctor` kiểm tra lần lượt: cổng debug mở, tìm được module database của Zalo (đường nhanh `fsN4` và tìm theo hình dạng), đọc thử 1 tin của một nhóm, ghi thử rồi xóa một file tạm trong `data/`. Mỗi mục in `✓` hoặc `✗` bằng tiếng Việt. Khi cổng đóng, `doctor` in hướng dẫn mở Zalo và thoát với mã khác 0. `doctor` không bao giờ tạo hay đụng `data/zalo-mi.db`.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `zmi.mjs` | Điểm vào CLI, lệnh `doctor` |
| `lib/cdp.mjs` | `connect(title = 'Zalo', { port })` trả về `{ evaluate, close }`; ném `CdpError` (`PORT_CLOSED`, `NO_TARGET`) |
| `lib/zalo-bridge.mjs` | `openBridge({ port })` trả về Bridge: `listGroups`, `getMessages`, `getMediaRows`, `locate`, `readOnlyGuard` |
| `test/` | Test chạy bằng `node --test`, không cần Zalo |

## An toàn: chỉ đọc

Mọi lời gọi vào database của Zalo đi qua `readOnlyGuard`, chỉ cho phép `getAll`, `get`, `getMulti`, `count`. Gọi tên hàm khác thì ném lỗi ngay, cả ở phía Node lẫn trong trang Zalo (hai phía dùng chung một danh sách và một đoạn mã). Không gọi `insert`, `put`, `update`, `delete`, không gửi tin, không thao tác giao diện Zalo.

Dữ liệu (`data/`), bản xuất (`exports/`) và dữ liệu thô dùng cho test (`test/fixtures/raw/`) chứa nội dung chat thật nên đã nằm trong `.gitignore`. Không commit chúng.

## Kiểm thử

```
node --no-warnings --test
```
