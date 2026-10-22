# Zalo MI

Công cụ dòng lệnh `zmi` (Node 24) đọc tin nhắn nhóm Zalo từ ứng dụng Zalo PC đang chạy, qua Chrome DevTools Protocol, để đưa vào một database SQLite riêng phục vụ báo cáo market intelligence theo yêu cầu. Thiết kế đầy đủ: `Thiết kế hệ thống Zalo MI.md`. Kết quả thử nghiệm đọc dữ liệu: `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`.

Hiện có: kết nối CDP, cầu nối chỉ đọc, các lệnh `doctor`, `groups` và `sync` (lấy tin của các nhóm theo dõi vào database). Chưa có lưu file đính kèm, quét chữ trong ảnh, `export` và `search`.

## Yêu cầu

- Windows, Node 24 trở lên.
- Zalo PC đang mở **kèm cờ** `--remote-debugging-port=9222` (lối tắt "Zalo (MI)"). Phải thoát hẳn Zalo trước khi mở lại, nếu không Zalo đang chạy sẽ bỏ qua cờ này. Cổng chỉ mở ở `127.0.0.1`.

## Lệnh

```
node zmi.mjs doctor [--port 9222]
```

`doctor` kiểm tra lần lượt: cổng debug mở, tìm được module database của Zalo (đường nhanh `fsN4` và tìm theo hình dạng), đọc thử 1 tin của một nhóm, ghi thử rồi xóa một file tạm trong `data/`. Mỗi mục in `✓` hoặc `✗` bằng tiếng Việt. Khi cổng đóng, `doctor` in hướng dẫn mở Zalo và thoát với mã khác 0. `doctor` không bao giờ tạo hay đụng `data/zalo-mi.db`.

```
node zmi.mjs groups              # in danh sách nhóm từ config/groups.json, không cần mở Zalo
node zmi.mjs groups --refresh    # đọc lại danh sách nhóm từ Zalo (chỉ đọc), cập nhật database và config/groups.json
```

`groups` in bảng gồm tên nhóm, số thành viên, theo dõi (`✓`/`–`), ghi chú, và dòng "Đang theo dõi X/Y nhóm". `config/groups.json` là nơi quyết định nhóm nào được theo dõi (`tracked`): lần đầu zmi đề xuất theo từ khóa trong tên nhóm (năng lượng, solar, điện, gió, BESS, energy, RE, ESG, carbon, NLTT, tái tạo, pin, DPPA, JETP, NetZero, wind, VREN, phát thải, hydrogen, LNG; loại trừ mua sắm, du lịch, lớp học cũ), các lần sau giữ nguyên `tracked` và `note` bạn đã sửa tay, nhóm mới được thêm với ghi chú "đề xuất tự động", nhóm không còn trên Zalo được giữ lại với `"missing": true`. File này không được commit (nằm trong `.gitignore`).

```
node zmi.mjs sync                       # tin mới của mọi nhóm đang theo dõi
node zmi.mjs sync --full                # đọc lại toàn bộ lịch sử có trên máy của mỗi nhóm
node zmi.mjs sync --groups g123,g456    # chỉ các nhóm này (convId trong config/groups.json)
```

`sync` đọc tin của các nhóm `tracked: true` (và còn trên Zalo) từ Zalo, chỉ đọc, rồi ghi vào `data/zalo-mi.db`. Cần Zalo đang mở ở chế độ thu thập; nếu Zalo đóng thì in hướng dẫn mở "Zalo (MI)", thoát mã 1 và không mở hay ghi database. Chưa có `config/groups.json` thì bảo chạy `node zmi.mjs groups --refresh`.

- **Lần đầu (hoặc `--full`)**: lấy hết lịch sử. **Các lần sau**: chỉ lấy tin từ `tin mới nhất đã lưu - 3 ngày`; 3 ngày chồng lấn để bắt tin Zalo đồng bộ muộn, tin bị thu hồi hoặc xóa sau đó. Ghi theo `msgId` nên chạy lại không nhân đôi (chạy hai lần liền: lần hai +0 tin mới, 0 cập nhật).
- Mỗi nhóm được ghi trong một transaction. Nhóm lỗi thì rollback, ghi vào `sync_runs.errors_json` rồi sang nhóm tiếp (mã thoát 1 ở cuối). Một tin hỏng chỉ bị bỏ qua và ghi lỗi, các tin còn lại vẫn vào.
- Tin đã lưu mà sau đó bị thu hồi hoặc xóa: chỉ đổi `kind`/`msg_type`, giữ nguyên chữ, `raw_json` và mục tìm toàn văn (dữ liệu riêng trên máy, spec 6.4). Tin thu hồi gặp lần đầu thì lưu không có chữ.
- Mỗi lần chạy ghi một dòng vào bảng `sync_runs` (số nhóm, tin mới, tin cập nhật, lỗi). Mỗi nhóm in một dòng, ví dụ `☀️ Future Energy Vietnam 🇻🇳: +12 tin mới, 1 cập nhật (2.698 tin trên máy)`, rồi dòng `Tổng`.

## Đối chiếu với bản xuất Zalo Web cũ

Nhóm `☀️ Future Energy Vietnam 🇻🇳`, giai đoạn 22/09 đến 05/10/2026 (giờ UTC+7), so database với file xuất cũ `zalo_Future-Energy-Vietnam_20261006-1454.md` (31 tin, file này không được commit):

- **31/31 tin của bản xuất đều có trong database**, đúng người gửi. 28 tin có chữ khớp trọn nội dung (so sau khi gộp khoảng trắng, không phân biệt hoa thường). 3 dòng `[Ảnh]` khớp 3 tin ảnh cùng người gửi, cùng ngày, cùng phút. Một tin ảnh thứ tư có chú thích, khớp một dòng chữ trong bản xuất.
- 22 tin có giờ trong bản xuất, cả 22 khớp đúng ngày và phút; 9 tin còn lại bản xuất không ghi giờ.
- Database có 36 dòng trong cùng giai đoạn, nhiều hơn bản xuất 5 dòng: 3 sự kiện thành viên, 1 tin thu hồi (không có chữ), 1 thẻ link không kèm chữ. Bản xuất cũ chỉ liệt kê tin có chữ, không có các loại này nên không phải thiếu sót của `sync`.
- Không có tin nào của bản xuất bị thiếu.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `zmi.mjs` | Điểm vào CLI, lệnh `doctor`, `groups` và `sync` |
| `lib/sync.mjs` | `syncGroup` (một nhóm: đọc Zalo, chuẩn hóa, ghi trong một transaction), `syncAll` (mọi nhóm, ghi `sync_runs`), chọn nhóm và in kết quả |
| `lib/groups.mjs` | `suggestTracked`, gộp danh sách nhóm vào `config/groups.json`, in bảng nhóm |
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
