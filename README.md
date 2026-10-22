# Zalo MI

Công cụ dòng lệnh `zmi` (Node 24) đọc tin nhắn nhóm Zalo từ ứng dụng Zalo PC đang chạy, qua Chrome DevTools Protocol, để đưa vào một database SQLite riêng phục vụ báo cáo market intelligence theo yêu cầu. Thiết kế đầy đủ: `Thiết kế hệ thống Zalo MI.md`. Kết quả thử nghiệm đọc dữ liệu: `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`.

Hiện có: kết nối CDP, cầu nối chỉ đọc, các lệnh `doctor`, `groups`, `sync` (lấy tin của các nhóm theo dõi vào database) và `files` (lưu file đính kèm vào `data/files/`). Chưa có quét chữ trong ảnh, `export` và `search`.

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

```
node zmi.mjs files                  # lưu file đính kèm chưa xử lý (status trống)
node zmi.mjs files --retry          # thử lại cả file lỗi (failed) và file chỉ có link (remote_only)
node zmi.mjs files --limit 50       # chỉ 50 file (mới nhất trước)
```

`zmi sync` gọi bước này ở cuối mỗi lần chạy cho các file mới; `zmi files` xử lý phần tồn đọng. `files` không cần Zalo mở: khi Zalo đóng, lệnh nói một lần rằng bỏ qua bảng `Media.File` của Zalo rồi vẫn chép file từ đường dẫn đã lưu trong tin và tải theo link. Mỗi file được thử theo thứ tự:

1. **File đã có trên máy**: `localPath` trong tin (`raw_json`), rồi `localPath`/`folderPath` của dòng `Media.File` tương ứng (đọc qua cầu nối chỉ đọc; ghép theo `cliMsgId`, trùng thì chọn đúng người gửi rồi giờ gửi gần nhất). Đường dẫn cũ `...\ZaloPC\<uid>\ZaloDownloads\...` được đổi sang `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\...`. File được **chép**, không bao giờ di chuyển; thư mục (như `folderPath` của file zip đã giải nén) bị bỏ qua.
2. **Tải theo `href`** bằng một `GET` thường (Node `fetch`, theo chuyển hướng, không cookie).
3. Không được thì ghi `status` và lý do vào `files.error`.

| `status` | Nghĩa |
| --- | --- |
| `stored` | Đã lưu ở `files.stored_path` = `data/files/<convId>/<YYYY-MM-DD>_<tên gốc>` (đường dẫn tính từ thư mục gốc repo, dấu `/`; ngày theo UTC+7) |
| `remote_only` | Link còn nhưng không lấy được nội dung: HTTP 401/403 hoặc trả về trang HTML thay vì file |
| `failed` | Lỗi, có lý do trong `error`: `HTTP 404 (link đã hết hạn)`, `HTTP 502`, không phân giải được máy chủ, quá thời gian chờ, checksum không khớp... |
| `skipped` | Không lưu: đuôi file ngoài danh sách (`loại file không lưu`) hoặc lớn hơn 100 MB (`quá 100 MB`) |

- Chỉ lưu các đuôi `pdf, doc, docx, xls, xlsx, ppt, pptx, csv, txt, zip, rar, jpg, jpeg, png`, tối đa 100 MB; âm thanh, video và đuôi khác là `skipped`.
- Kiểm tra trước khi ghi: MD5 trùng `checksum` Zalo báo (nếu có; không có thì kích thước và dấu hiệu định dạng pdf/zip/office/rar/ảnh phải khớp); trang HTML lỗi không bao giờ được lưu thành file. Ghi ra file tạm rồi đổi tên; tên bị trùng nhưng nội dung khác thì thêm `_<msg_id>` trước đuôi, nội dung giống hệt thì dùng lại file cũ. Tên file được làm sạch cho Windows (bỏ `<>:"/\|?*` và ký tự điều khiển, cắt dấu chấm/khoảng trắng cuối, tối đa ~150 ký tự, giữ đuôi).
- Chạy lại không làm lại gì: file `stored` mà còn tồn tại thì được giữ nguyên; mặc định chỉ xử lý dòng chưa có `status`. Chỉ các cột `status`, `stored_path`, `error` bị ghi. `--retry` thử lại mọi file lỗi, kể cả link đã hết hạn, nên có thể lâu (lần chạy đầu: 835 file trong khoảng 14 phút, phần lớn là máy chủ cũ trả 502/504 sau tới 30 giây); dùng `--limit` nếu chỉ muốn thử vài file.
- Bảo vệ ổ đĩa: trước mỗi file, nếu ổ chứa `data/` còn dưới 5 GB (tính cả dung lượng file sắp lưu) thì dừng, in cảnh báo, các file còn lại giữ nguyên `status` trống và lệnh thoát mã 1. Giải phóng chỗ rồi chạy lại là tiếp tục.
- Mỗi lần chạy in tiến độ (mỗi 25 file) và dòng tóm tắt `Đã lưu X file (Y MB), Z chỉ có link, W lỗi, V bỏ qua`, kèm các lý do lỗi phổ biến nhất.

**Link file của Zalo chỉ sống vài tuần (thường 1-3 tuần)** (xem phần thử nghiệm bên dưới). Vì vậy file chỉ được lưu đầy đủ nếu `zmi sync` chạy đều đặn (ít nhất mỗi tuần một lần, tốt nhất mỗi ngày): file cũ hơn thế chỉ còn nếu đã có sẵn trên máy (đã tải bằng Zalo, hoặc do chính Cong gửi từ máy mình).

## Thử nghiệm tải file (bước 0 của Task 6)

Thử `GET` thật lên `href` của các file đã lưu trong database, bằng hai cách: (2) Node `fetch` và (3) `fetch` chạy trong cửa sổ Zalo qua CDP (cùng phiên đăng nhập, `credentials: 'include'`; chỉ là một `GET` mạng, không gọi hàm nào của Zalo, không đụng kho dữ liệu của Zalo). Không gọi `$zdownload` (quy tắc R1).

| Tuổi link | Máy chủ | (2) Node GET | (3) GET trong trang Zalo |
| --- | --- | --- | --- |
| 1 đến 8 ngày (8 file thử: pdf, xlsx) | `file-stal-*.dlfl.vn`, `fg41.dlfl.vn` | chuyển hướng 301/302 sang `*.flchat.vn`, rồi 200 với đúng content-type (`application/pdf`, `...spreadsheetml.sheet`), đủ byte, **MD5 khớp** | y hệt (200, cùng số byte) |
| 16 đến 182 ngày (5 file) | `file-stal-*`, `fg40/41.dlfl.vn` | 404, thân rỗng | 404 |
| nhóm thử `g8318398124727869839`: 3 file mới nhất (05/08 đến 11/09/2026) | `file-stal-11/16/17.dlfl.vn` | 301, 302, rồi 404 rỗng | 404 |
| nhóm thử, file cũ nhất (17/02/2025) | `fg42.dlfl.me` | 502, `text/html`, 150 byte | 502, y hệt |
| link tháng 12/2025 | `fg63.dlfl.vn` | `ENOTFOUND` (máy chủ không còn) | `Failed to fetch` |

Kết luận: link sống vài tuần rồi hết hạn (còn tải được ở 8 ngày, đa số đã hết hạn ở 16 ngày; lần chạy thật có một file 22 ngày vẫn tải được); sau đó link trả 404 hoặc 502, hoặc máy chủ không còn. Cách (3) cho **đúng kết quả** như (2) ở mọi link đã thử, không cứu thêm được file nào, nên **không xây**. Chỉ giữ cách (2) cùng việc chép file đã có trên máy. Zalo cũng cất một số file trong `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\file\group\` dưới tên băm, không theo `checksum`; đối chiếu nội dung cho thấy chỉ khoảng 12 trong 845 dòng khớp, nên chưa dùng.

## Đối chiếu với bản xuất Zalo Web cũ

Nhóm `☀️ Future Energy Vietnam 🇻🇳`, giai đoạn 22/09 đến 05/10/2026 (giờ UTC+7), so database với file xuất cũ `zalo_Future-Energy-Vietnam_20261006-1454.md` (31 tin, file này không được commit):

- **31/31 tin của bản xuất đều có trong database**, đúng người gửi. 28 tin có chữ khớp trọn nội dung (so sau khi gộp khoảng trắng, không phân biệt hoa thường). 3 dòng `[Ảnh]` khớp 3 tin ảnh cùng người gửi, cùng ngày, cùng phút. Một tin ảnh thứ tư có chú thích, khớp một dòng chữ trong bản xuất.
- 22 tin có giờ trong bản xuất, cả 22 khớp đúng ngày và phút; 9 tin còn lại bản xuất không ghi giờ.
- Database có 36 dòng trong cùng giai đoạn, nhiều hơn bản xuất 5 dòng: 3 sự kiện thành viên, 1 tin thu hồi (không có chữ), 1 thẻ link không kèm chữ. Bản xuất cũ chỉ liệt kê tin có chữ, không có các loại này nên không phải thiếu sót của `sync`.
- Không có tin nào của bản xuất bị thiếu.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `zmi.mjs` | Điểm vào CLI, lệnh `doctor`, `groups`, `sync` và `files` |
| `lib/files.mjs` | `resolveFile` (một file: chép từ máy, tải theo link, kiểm tra), `resolveFiles` (phần tồn đọng, đồng thời 3 file, bảo vệ ổ đĩa), `remapLocalPath`, đặt tên file, in kết quả |
| `lib/sync.mjs` | `syncGroup` (một nhóm: đọc Zalo, chuẩn hóa, ghi trong một transaction), `syncAll` (mọi nhóm, ghi `sync_runs`), chọn nhóm và in kết quả |
| `lib/groups.mjs` | `suggestTracked`, gộp danh sách nhóm vào `config/groups.json`, in bảng nhóm |
| `lib/cdp.mjs` | `connect(title = 'Zalo', { port })` trả về `{ evaluate, close }`; ném `CdpError` (`PORT_CLOSED`, `NO_TARGET`) |
| `lib/zalo-bridge.mjs` | `openBridge({ port })` trả về Bridge: `listGroups`, `getMessages`, `getMediaRows`, `locate`, `readOnlyGuard` |
| `test/` | Test chạy bằng `node --test`, không cần Zalo |

## An toàn: chỉ đọc

Mọi lời gọi vào database của Zalo đi qua `readOnlyGuard`, chỉ cho phép `getAll`, `get`, `getMulti`, `count`. Gọi tên hàm khác thì ném lỗi ngay, cả ở phía Node lẫn trong trang Zalo (hai phía dùng chung một danh sách và một đoạn mã). Không gọi `insert`, `put`, `update`, `delete`, không gửi tin, không thao tác giao diện Zalo. `zmi files` đọc `Media.File` qua đúng cầu nối này và tải file bằng một `GET` thường từ Node; không gọi bộ tải của Zalo (`$zdownload`) và không ghi gì vào thư mục dữ liệu của Zalo (chỉ chép từ đó ra `data/files/`).

Dữ liệu (`data/`), bản xuất (`exports/`) và dữ liệu thô dùng cho test (`test/fixtures/raw/`) chứa nội dung chat thật nên đã nằm trong `.gitignore`. Không commit chúng.

## Kiểm thử

```
node --no-warnings --test
```
