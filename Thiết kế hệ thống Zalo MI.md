# Thiết kế hệ thống Zalo MI

22/10/2026 · bản thiết kế cho bộ thu thập, database riêng và skill tổng hợp

Tài liệu liên quan trong cùng thư mục:
- `MCP đọc Zalo desktop để tổng hợp market intelligence.md`: ý tưởng ban đầu, bốn cách lấy dữ liệu.
- `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`: kết quả thử nghiệm ngày 22/10/2026, gồm cách đọc đã chạy được và cấu trúc dữ liệu thật.

Ký hiệu trong tài liệu:
- **[Cong quyết]**: Cong đã nói hoặc đã chọn.
- **[Claude quyết]**: Claude chọn để có mặc định hợp lý. Cong có thể đổi.
- **[Builder quyết]**: để người xây tự chọn.

## 1. Mục đích

Cong ở trong nhiều nhóm Zalo về năng lượng tái tạo nhưng không có thời gian đọc. Khi cần, Cong muốn nhờ Claude Desktop tổng hợp các nhóm đó thành một bản tin market intelligence bằng tiếng Việt: chính sách mới, dự án mới, người mới đáng chú ý cho BD, tin tức, file và tài liệu được chia sẻ, giá thiết bị, thông tin kỹ thuật, link tài liệu, sự kiện và hội thảo. **[Cong quyết]**

Hiện Cong đang dùng extension trên Zalo Web để export tay từng nhóm ra file `zalo_*.md`. Cách này tốn công, và file export hay bị lỗi: trùng tin, đảo thứ tự ngày, lệch ngày. Thiết kế này thay việc export tay bằng việc đọc thẳng từ Zalo PC, lưu vào một database riêng trên máy, rồi để Claude đọc database đó khi được yêu cầu. **[Cong quyết]**

Thành công nghĩa là: Cong mở tab Code của Claude Desktop, gõ "tổng hợp các nhóm năng lượng 2 tuần qua", và vài phút sau nhận được bản tin có dẫn nguồn (nhóm, ngày, người gửi), không phải tự mở Zalo đọc từng nhóm.

Bản tin chỉ để Cong đọc. Nếu cần chia sẻ, Cong sẽ tự chọn lọc. **[Cong quyết]**

## 2. Mục tiêu, ngoài phạm vi, điều không được xảy ra

**Mục tiêu**
1. Tự động lấy tin từ các nhóm Zalo được chọn theo dõi trên Zalo PC, không export tay. **[Cong quyết]**
2. Lưu vào một database riêng trên máy, không trùng tin, giờ gửi chính xác, chạy lại bao nhiêu lần cũng không hỏng.
3. Lưu lại file được chia sẻ (PDF, Word, Excel…) để mở xem sau. **[Cong quyết]**
4. Lưu mọi ảnh có chữ (ảnh chụp màn hình, poster sự kiện, ảnh chụp tài liệu, bảng giá, infographic) để Claude đọc được. Bỏ qua ảnh không có chữ (người, phong cảnh) và video. **[Cong quyết]**
5. Theo dõi link tài liệu và sự kiện, hội thảo. **[Cong quyết]**
6. Ghi lại sự kiện thành viên vào nhóm để tìm người mới cho BD.
7. Một skill trong Claude Desktop tạo bản tin MI khi được yêu cầu, gọn nhẹ, không cần dựng server. **[Cong quyết]**

**Ngoài phạm vi**
- Đọc hoặc gửi theo thời gian thực. **[Cong quyết]**
- Gửi tin nhắn hay làm bất cứ thao tác nào trên Zalo thay Cong. **[Cong quyết]**
- Lưu chat riêng 1-1 vào database. `sync` chỉ lấy các nhóm trong danh sách theo dõi. **[Claude quyết]** Ngoại lệ từ 09/11/2026: lệnh `zmi chat` đọc **một** chat (1-1 hoặc nhóm bất kỳ) khi Cong yêu cầu, chỉ in ra màn hình, không ghi vào database (mục 14). **[Cong quyết]**
- Giao diện web, dashboard, chạy trên cloud, chạy trên điện thoại.
- Lưu sticker, video, ảnh thường.
- Một database "thực thể" lâu dài (danh bạ dự án, danh bạ người). Bản tin trích xuất mỗi lần chạy; lưu thực thể có thể làm sau.

**Điều không được xảy ra**, kể cả khi mọi thứ khác đều chạy:
- Ghi bất cứ thứ gì vào Zalo: gửi tin, đánh dấu đã xem, xóa, sửa, hay gọi các hàm ghi của database Zalo (`insert`, `put`, `update`, `delete`…).
- Làm hỏng dữ liệu Zalo PC hoặc khiến Zalo phải đồng bộ lại.
- Đăng nhập Zalo bằng một kênh riêng hoặc gọi API máy chủ Zalo (kiểu zca-js), vì có thể bị khóa tài khoản.
- Ghi số điện thoại hay email cá nhân vào bản tin. Hotline hoặc email chung của sự kiện, tổ chức (ví dụ `info@…`, số tổng đài ban tổ chức) thì được ghi. Claude được xem ảnh và PDF gốc trên máy, không cần làm mờ. **[Cong quyết]**
- Cài đặt nặng nề: Docker, môi trường Python riêng, hàng trăm gói npm.

## 3. Ràng buộc

- Windows 11, Zalo PC bản 26.10.11 (Electron 22, Chrome 108). Cài ở `%LOCALAPPDATA%\Programs\Zalo\Zalo-<phiên bản>\`, dữ liệu ở `%APPDATA%\ZaloData\`, mã người dùng `1498602681856850483`.
- Zalo không có API chính thức để đọc nhóm của tài khoản cá nhân.
- Database của Zalo PC bị mã hóa. Cách đọc duy nhất đã chạy được là mở Zalo PC kèm cổng debug và gọi bộ quản lý database của chính Zalo (xem file kết quả thử nghiệm).
- Zalo PC phải đang chạy, kèm cờ `--remote-debugging-port`, thì mới thu thập được.
- Tên module nội bộ (`fsN4`…) do webpack sinh ra và có thể đổi sau mỗi lần Zalo cập nhật.
- Máy đã có Node 24.12 (có sẵn `node:sqlite` với SQLite 3.50.4, FTS5 và bộ tách từ bỏ dấu tiếng Việt, đã kiểm tra) và Python 3.14.
- Có khoảng 94 nhóm, trong đó khoảng 25 nhóm liên quan năng lượng. Nhóm lớn nhất có hơn 6.000 tin trên máy.

## 4. Tổng quan

```
Zalo PC (mở kèm cổng debug)
   │  CDP, chỉ đọc
   ▼
zmi sync  ──►  data/zalo-mi.db (SQLite)  +  data/files/  +  data/images/
                       │
                       ▼
               zmi export (lọc nhiễu, che SĐT/email)  ──►  exports/<lần chạy>/*.md
                       │
                       ▼
         Skill "zalo-mi" trong Claude Desktop  ──►  bản tin MI (.md)
```

Có bốn phần:
1. **Khởi động Zalo ở chế độ thu thập** (mục 5).
2. **Bộ thu thập `zmi sync`** và bước quét chữ trong ảnh `zmi images` (mục 6).
3. **Database riêng** (mục 7).
4. **Xuất dữ liệu cho Claude `zmi export`** và **skill tổng hợp** (mục 8, 9).

`zmi` là một CLI viết bằng Node 24, chạy bằng `node zmi.mjs <lệnh>`, không cần gói npm nào: dùng `fetch` và `WebSocket` có sẵn cho CDP, `node:sqlite` cho database. **[Claude quyết]** Nếu builder thấy cần một gói (ví dụ để giải mã ảnh JXL), chỉ thêm khi thật cần và ghi rõ lý do.

## 5. Khởi động Zalo ở chế độ thu thập

- Một script `zalo-mi-launch.ps1` cùng shortcut trên Desktop "Zalo (MI)":
  1. Tìm thư mục `Zalo-<phiên bản>` mới nhất.
  2. Nếu Zalo đang chạy mà không có cổng debug, báo cho Cong và hướng dẫn thoát hẳn Zalo. Không tự kill Zalo để tránh mất tin đang soạn. **[Claude quyết]**
  3. Mở `Zalo.exe` kèm `--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`.
  4. Chờ cổng mở rồi báo thành công.
- Cổng chỉ nghe ở `127.0.0.1`. Tài liệu hướng dẫn ghi rõ: khi cổng mở, chương trình khác trên máy có thể điều khiển Zalo; muốn đóng cổng thì mở Zalo lại theo cách bình thường.
- Có nên để Zalo luôn chạy chế độ này (ví dụ thay shortcut Zalo mặc định) hay không: **[Builder quyết]**, mặc định là không.

## 6. Bộ thu thập (`zmi sync`)

### 6.1 Kết nối và tìm bộ quản lý database

1. Gọi `GET http://127.0.0.1:9222/json/list`, chọn target có `type=page` và `title="Zalo"`. Nếu không có, dừng và báo "Zalo chưa mở ở chế độ thu thập".
2. Qua `Runtime.evaluate`, lấy hàm `require` của webpack bằng `webpackJsonp.push(...)` (xem file kết quả thử nghiệm).
3. **Tìm module theo hình dạng, không theo tên cố định.** Duyệt cache module, lấy module có `exports.default.getInstance` mà kết quả có `.Core.Message.getAll`. Có thể thử `fsN4` trước cho nhanh, nhưng phải có bước tìm lại khi tên đổi.
4. Mọi lời gọi vào Zalo đi qua một lớp bọc **chỉ cho phép** `getAll`, `get`, `getMulti`, `count`. Gọi bất kỳ tên hàm nào khác thì ném lỗi ngay. Đây là chốt an toàn cho mục "điều không được xảy ra".
5. Kết quả trả về qua `returnByValue`. Với nhóm lớn, phân trang (ví dụ 2.000 tin một lần) để không trả về một khối JSON quá lớn.

### 6.2 Chọn nhóm

- File `config/groups.json` liệt kê các nhóm theo dõi: `convId`, tên, `tracked: true/false`, ghi chú.
- `zmi groups` liệt kê toàn bộ nhóm trên Zalo PC (`Core.Group.getAll`), có số thành viên, và đánh dấu nhóm nào đang theo dõi.
- Lần đầu chạy, đề xuất sẵn danh sách theo từ khóa trong tên nhóm (năng lượng, solar, điện, gió, BESS, energy, RE, ESG, carbon…), sau đó để Cong duyệt. Các nhóm rõ ràng không liên quan (mua sắm, du lịch, lớp học cũ) để `tracked: false`. **[Claude quyết]** Danh sách cụ thể Cong chỉnh sau trong file config, không ảnh hưởng thiết kế.

### 6.3 Lấy tin

- **Lần đầu (backfill):** lấy toàn bộ lịch sử có trên máy của mỗi nhóm theo dõi, phân trang theo `sendDttm` giảm dần.
- **Các lần sau (tăng dần):** lấy tin có `sendDttm` lớn hơn `max(sendDttm)` đã lưu, trừ đi một khoảng chồng lấn (mặc định 3 ngày). Khoảng chồng lấn để bắt tin Zalo đồng bộ muộn và tin bị thu hồi hoặc xóa sau đó. Upsert theo `msgId` nên lấy trùng không sao.
- Truy vấn mẫu, đã chạy được trong thử nghiệm:

```js
db.Core.Message.getAll(
  { from: [convId, fromTs, ''], to: [convId, '9999999999999999', '9223372036854775808'] },
  { index: 'userId_sendDttm_msgId', direction: 'prev', limit: 2000, partition: convId, useLGKeyRange: true }
)
```

- Lấy thêm dữ liệu kèm theo: `Core.Group`/`GroupInfo` (tên, mô tả, số thành viên), `Media.File` (theo `convId` + `cliMsgId`) để bổ sung đường dẫn file đã tải.
- Mỗi lần chạy ghi một dòng vào bảng `sync_runs`: thời điểm, số nhóm, số tin mới, lỗi.
- Chạy khi nào: khi skill được gọi (mục 9), hoặc Cong chạy tay `zmi sync`. Lịch chạy tự động bằng Task Scheduler là tùy chọn, chỉ có tác dụng khi Zalo đang mở kèm cổng debug. **[Claude quyết]**

### 6.4 Chuẩn hóa từng loại tin

Đã thấy trong thử nghiệm:

| msgType | `kind` lưu | Xử lý |
| --- | --- | --- |
| 1 | `text` | lưu nội dung, `quote`, `mentions` |
| 2 | `photo` | lưu chú thích (`title`), kích thước, `hdUrl`/`oriUrl`, đường dẫn cache. Xem 6.6 |
| 6 | `link` | lưu `href`, tên miền, `title`, `description` |
| 19 | `file` | lưu tên file (`title`), đuôi file, dung lượng, checksum, `href`. Xem 6.5 |
| -4 | `member_event` | phân loại: `joined` ("đã tham gia"), `added` ("được X thêm vào"), `removed` ("bị/được X xóa khỏi"), `promoted`, `other`. Lưu `updateMemberIds`, tên người, người thêm |
| 20 | `recalled` | đánh dấu, không đưa vào bản tin |
| -27 | `deleted` | đánh dấu, không đưa vào bản tin |
| 4, 18 | `sticker`, `video` | lưu một dòng tối thiểu, không lưu nội dung |
| khác | `other` | lưu nguyên `raw_json` để xem sau |

- Luôn lưu `raw_json` của tin (đã bỏ các trường rỗng) để có thể xử lý lại sau mà không phải lấy lại từ Zalo.
- Nếu một tin đã lưu sau đó thành thu hồi hoặc xóa: cập nhật `kind` và giữ nội dung cũ trong `raw_json`. Có giữ hay không giữ nội dung cũ là **[Builder quyết]**, mặc định là giữ vì đây là dữ liệu riêng trên máy.

### 6.5 File

- Với mỗi tin file, ghi một dòng vào bảng `files` với `status`:
  - `stored`: đã chép vào `data/files/<convId>/<YYYY-MM-DD>_<tên gốc>`.
  - `remote_only`: chỉ có link.
  - `failed`: thử tải nhưng lỗi, có ghi lý do.
- Thứ tự thử:
  1. `localPath` của tin, hoặc của dòng `Media.File` tương ứng, nếu file còn trên máy. Đổi đường dẫn gốc cũ `AppData\Local\ZaloPC\…\ZaloDownloads\` sang `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\` nếu cần.
  2. Tải theo `href`. **Chưa chắc chạy được**: thử `HEAD` trả về 404. Builder phải thử `GET` thật trước.
  3. Nhờ bộ tải của Zalo (`$zdownload.sendDownloadRequest`) tải về thư mục của Zalo, rồi chép sang. **Chưa thử.**
  4. Nếu cả hai cách trên đều không được: hướng dẫn Cong bật "tự động tải file" trong cài đặt Zalo PC, khi đó cách 1 sẽ đủ.
- So checksum (`params.checksum`, MD5) sau khi chép nếu có.
- Không giới hạn đuôi file, nhưng bỏ qua file lớn hơn một ngưỡng (mặc định 100 MB). **[Claude quyết]**

### 6.6 Ảnh có chữ

~~Cong muốn giữ mọi ảnh có chữ.~~ **Sửa ngày 2026-10-22: chỉ quét chữ ảnh có khung hình ảnh chụp màn hình** (`phone_screenshot`, `desktop_screenshot`). Ảnh chụp, ảnh AI, ảnh quảng cáo không có giá trị. Cong chấp nhận mất cả poster, bảng giá, screenshot đã cắt có dáng `photo`, vì quét toàn bộ (~1 ảnh/giây, hàng giờ tồn đọng) không đáng công. 2.189 ảnh `photo` đã quét trước đó bị xoá file nhưng giữ `ocr_text` (`status = text_only`), qua `zmi images --prune-photos`. **[Cong quyết]**

- Với mỗi tin ảnh, ghi một dòng vào bảng `images`: kích thước, chú thích, link, đường dẫn cache, `shape_class`, `text_score`, `ocr_text`, `has_text`, `status`.
- **Quét chữ chỉ trên ảnh có dáng ảnh chụp màn hình** của các nhóm theo dõi. Phần này là lệnh `zmi images`, và `zmi sync` gọi nó ở cuối để screenshot mới được quét trước khi link hết hạn (~15 ngày):
  - Chạy tăng dần: chỉ quét ảnh chưa quét. Có giới hạn số ảnh mỗi lần chạy để lần đồng bộ đầu không treo máy.
  - Ảnh có đủ chữ thì `has_text = 1`. Lưu `ocr_text` để tìm toàn văn được (đưa vào FTS) và để skill biết nên mở ảnh nào.
  - Ảnh nguồn lấy theo thứ tự: file cache của Zalo, rồi `hdUrl`. Ảnh cũ không còn trong cache và link đã hỏng thì `status = unavailable`.
- **Công cụ quét chữ** là **[Builder quyết]**, sau khi thử. Các ứng viên: OCR có sẵn trong Zalo PC (`$znode.nativelibs.zocr`), OCR có sẵn của Windows (`Windows.Media.Ocr`, cần gói tiếng Việt), hoặc Tesseract (cài nặng hơn, chỉ dùng khi hai cách kia không được). Không dùng Claude xem từng ảnh trong bước này, vì số lượng lên đến hàng nghìn ảnh. Tiêu chí chọn: đọc được tiếng Việt có dấu, xử lý vài nghìn ảnh trong thời gian chấp nhận được, không cài thêm nhiều thứ.
- `shape_class` (tỉ lệ khung hình) vẫn tính trong `sync` để ưu tiên quét trước: `phone_screenshot` (ảnh dọc, tỉ lệ ≥ 1,9), `desktop_screenshot` (ảnh ngang gần 16:9 hoặc 16:10, rộng ≥ 1280), còn lại là `photo`. Thử nghiệm: 49/339 ảnh có dáng ảnh chụp màn hình.
- **Chỉ chép file của ảnh có chữ** vào `data/images/`. Ảnh không có chữ chỉ giữ dòng metadata.
- Ảnh trong cache Zalo thường ở định dạng **JXL**, Claude không đọc được. Phải đổi sang JPEG/PNG khi lưu vào `data/images/<convId>/<msgId>.jpg`. Các cách, theo thứ tự nên thử:
  1. `normalUrl`/`oriUrl` nếu trả về JPEG.
  2. Bộ giải mã JXL của Zalo (`$znode.nativelibs.zjxl`, hoặc `libjxl.decodeToJpeg` trong preload) gọi qua CDP.
  3. Một gói giải mã JXL bằng WASM, như trường hợp ngoại lệ ở mục 4.
  - Lấy ảnh nguồn từ đường dẫn cache trước. Nếu không có thì tải `hdUrl`: ảnh mới vẫn tải được (HTTP 200), ảnh cũ từ đầu 2025 thì link đã hỏng.

### 6.7 Che dữ liệu cá nhân

- **Database giữ nguyên văn**, vì đây là dữ liệu riêng của Cong trên máy Cong.
- **Phần chữ chat khi export** (mục 8) che số điện thoại và email, vì trong chat những thông tin này hầu hết là của cá nhân. Mã người dùng Zalo (`fromUid`) chỉ dùng nội bộ, không đưa vào bản tin. **[Claude quyết, trong khuôn khổ quy tắc Cong đã chọn]**
- **Ảnh và PDF không cần che.** Claude được xem bản gốc trên máy. Hotline hoặc email chung của sự kiện, tổ chức đọc được từ poster, thư mời hay link thì được ghi vào bản tin. Số và email cá nhân thì không. **[Cong quyết]**
- Skill chỉ đọc dữ liệu qua `zmi export` và `zmi search`, không đọc thẳng `data/zalo-mi.db`.
- Phải kiểm thử quy tắc che với các mẫu số điện thoại thường gặp: `09xx xxx xxx`, `+84 9xx…`, `0963.046.382`, số có dấu cách hoặc dấu chấm. Quy tắc không được che nhầm mã văn bản, số tiền, công suất (ví dụ `1-BC-BCT-2026-760`, `3.088 MW`).

### 6.8 Lỗi và độ bền

- Không mở được cổng hoặc không tìm được module: dừng, báo lỗi rõ bằng tiếng Việt, không ghi gì vào database.
- Một nhóm bị lỗi thì ghi lại rồi chuyển sang nhóm khác.
- Ghi database trong transaction cho từng nhóm.
- Có lệnh `zmi doctor` kiểm tra: cổng mở, tìm được module, đọc thử 1 tin của 1 nhóm, quyền ghi thư mục `data/`.

## 7. Database riêng

- Một file SQLite `data/zalo-mi.db` trong thư mục dự án (`C:\Users\kongn\Pictures\CodeProject\Zalodatabase\`, không nằm trong OneDrive, đã kiểm tra). **[Claude quyết]**
- Bật WAL. Có thể chạy `zmi export` trong lúc `sync` đang chạy.
- Lược đồ tối thiểu (builder có thể thêm cột):

```sql
groups(conv_id PK, name, description, total_member, tracked, first_seen_at, last_synced_at, last_msg_ts)

messages(msg_id PK, conv_id, cli_msg_id, ts, from_uid, sender_name, msg_type, kind,
         text, title, description, url, quote_msg_id, quote_text, mentions_json,
         raw_json, ingested_at, updated_at)
  -- index (conv_id, ts)

messages_fts  -- FTS5 trên text, title, description; tokenize='unicode61 remove_diacritics 2'

links(msg_id PK, conv_id, ts, url, domain, title, description)

files(msg_id PK, conv_id, ts, sender_name, file_name, ext, size, checksum,
      remote_url, stored_path, status, error)

images(msg_id PK, conv_id, ts, sender_name, caption, width, height, remote_url,
       cache_path, stored_path, shape_class, text_score, ocr_text, has_text, scanned_at, status)
  -- ocr_text cũng đưa vào FTS để tìm được chữ trong ảnh

member_events(msg_id PK, conv_id, ts, event, member_uids_json, member_name, actor_name, text)

sync_runs(id PK, started_at, finished_at, groups, new_messages, updated_messages, errors_json)
```

- Thời gian lưu dạng mili giây (như Zalo). Khi xuất ra thì đổi sang giờ Việt Nam (UTC+7).
- Không có chính sách xóa dữ liệu cũ. Dung lượng dự kiến nhỏ: vài chục nghìn tin, cộng với file và ảnh chụp màn hình.

## 8. Xuất dữ liệu cho Claude (`zmi export`)

Mục đích là đưa cho Claude một bản đã lọc và đã che, đủ gọn để đọc.

- Tham số: `--from`, `--to` (mặc định 14 ngày gần nhất **[Claude quyết]**), `--groups` (mặc định tất cả nhóm đang theo dõi), `--out`.
- Đầu ra là một thư mục `exports/<YYYYMMDD-HHmm>/` gồm:
  - `index.md`: danh sách nhóm, số tin của từng nhóm trong kỳ, khoảng thời gian, thời điểm sync gần nhất. Nếu dữ liệu cũ hơn 24 giờ thì ghi cảnh báo.
  - Một file `<tên-nhóm>.md` cho mỗi nhóm có tin trong kỳ. Định dạng gần giống file `zalo_*.md` cũ (tiêu đề nhóm, gom theo ngày, dòng `[HH:mm] Người gửi: nội dung`). Giữ được tương thích với skill `zalo-energy-mi-digest` cũ thì tốt, nhưng không bắt buộc: skill mới `zalo-mi` thay thế skill cũ cho việc tổng hợp Zalo. **[Claude quyết]** Thêm vào:
    - mã tin ngắn ở cuối dòng, ví dụ `#m8372420766850`, để bản tin dẫn nguồn;
    - với file: `[File] tên.pdf (3,9 MB) → data/files/...` hoặc `→ chỉ có link`;
    - với ảnh có chữ: `[Ảnh có chữ] chú thích | vài dòng đầu của ocr_text → data/images/...`; ảnh không có chữ chỉ ghi `[Ảnh]`, kèm chú thích nếu có;
    - với link: `[Link] tiêu đề — tên miền`;
    - sự kiện thành viên: `[Thành viên] X được Y thêm vào nhóm`.
  - `members.md`: người mới vào các nhóm trong kỳ, kèm tin giới thiệu (nếu có) của họ hoặc về họ.
  - `attachments.md`: toàn bộ file, ảnh chụp màn hình và link trong kỳ, gom theo nhóm.
- Lọc nhiễu: bỏ sticker, tin thu hồi hoặc xóa, các tin chỉ có lời chào hay cảm ơn ngắn (dưới khoảng 15 ký tự, không có link hay file). Builder tinh chỉnh danh sách.
- Che số điện thoại và email (mục 6.7).
- `zmi search "<từ khóa>" [--from --to --groups]`: tìm toàn văn, có bỏ dấu, để skill tra cứu thêm khi cần.

## 9. Skill tổng hợp

### 9.1 Chạy ở đâu

Skill chạy trong **tab Code của Claude Desktop**, vì chỉ ở đó Claude mới chạy được lệnh trên máy và đọc được file của Cong. Không làm MCP cho tab Chat. **[Cong quyết]**

Skill đặt ở mức người dùng, `C:\Users\kongn\.claude\skills\zalo-mi\SKILL.md`, gọi `zmi` theo đường dẫn tuyệt đối, để dùng được ở bất kỳ phiên nào. **[Claude quyết]**

Skill cũ `zalo-energy-mi-digest` (skill của tài khoản claude.ai, đọc file `zalo_*.md`) có thể kích hoạt cùng các câu hỏi. Phần mô tả của skill mới phải ghi rõ là nó đọc từ database Zalo trên máy. Nên khuyên Cong tắt skill cũ trong cài đặt claude.ai khi skill mới đã chạy ổn. **[Claude quyết]**

### 9.2 Khi nào kích hoạt

Khi Cong nhờ tổng hợp, cập nhật hay làm bản tin market intelligence từ các nhóm Zalo, kể cả khi không nói chữ "skill". Ví dụ: "có gì mới trong các nhóm năng lượng tuần này", "tổng hợp Zalo 2 tuần qua", "ai mới vào nhóm đáng chú ý".

### 9.3 Các bước

1. **Hiểu yêu cầu:** kỳ báo cáo (mặc định 14 ngày), nhóm (mặc định tất cả nhóm theo dõi), chủ đề cần nhấn mạnh nếu Cong nêu.
2. **Đồng bộ:** chạy `zmi sync` rồi `zmi images` (chạy nền nếu lâu). Nếu Zalo chưa mở ở chế độ thu thập, nói cho Cong biết, rồi hỏi một lần: dùng dữ liệu của lần sync gần nhất (ghi rõ ngày), hay chờ Cong mở Zalo (MI).
3. **Xuất:** chạy `zmi export` cho kỳ báo cáo, đọc `index.md`.
4. **Đọc theo nhóm:** với mỗi file nhóm, trích các mục theo chủ đề (mục 9.4), mỗi mục kèm nguồn: nhóm, ngày, người gửi, mã tin. Nhóm lớn có thể giao cho subagent chạy song song. Nhóm nhỏ thì tự đọc. Ngưỡng chia là **[Builder quyết]**.
5. **Xem tài liệu đính kèm có chọn lọc:** dựa vào chú thích và `ocr_text`, mở ảnh có chữ và file PDF (vài trang đầu) khi chúng liên quan đến chính sách, giá, dự án hay sự kiện. Không mở hết.
6. **Tổng hợp:** gộp trùng giữa các nhóm (cùng một tin được đăng ở nhiều nhóm), sắp theo mức quan trọng, rồi viết bản tin theo mục 9.4.
7. **Lưu và báo:** lưu file bản tin và file tín hiệu (mục 9.5), trả cho Cong đường dẫn file cùng 5 đến 7 ý chính.

### 9.4 Bản tin

Theo văn phong của các bản tin MI hiện có của Cong (ví dụ `PEWG_MI_Report_2026-06-06_den_2026-10-05.md`): tiếng Việt, rõ ràng, mỗi ý có dẫn nguồn. Khung đề xuất **[Claude quyết]**:

1. Tóm tắt điều hành (5 đến 10 ý)
2. Chính sách và quy định: văn bản mới, dự thảo, hạn góp ý
3. Dự án và giao dịch: dự án mới, tiến độ, chủ đầu tư, nhà thầu
4. Giá thiết bị và số liệu thị trường: tấm pin, inverter, BESS, giá điện…, kèm ngày và nguồn, ghi rõ đây là tin trong nhóm, chưa kiểm chứng
5. Thông tin kỹ thuật đáng chú ý
6. Sự kiện và hội thảo: tên, ngày, nơi, đơn vị tổ chức, cách đăng ký (link, hotline hoặc email chung của ban tổ chức, không ghi số cá nhân)
7. Người mới đáng chú ý cho BD: tên, chức danh, công ty theo tin giới thiệu công khai, nhóm nào, ai giới thiệu, vì sao đáng chú ý với Allotrope. Không có số điện thoại hay email cá nhân.
8. Tài liệu và file được chia sẻ: tên file, nhóm, ngày, đường dẫn trên máy hoặc "chỉ có link"
9. Link bài viết đáng đọc
10. Hàm ý cho Allotrope và việc nên làm (ngắn)
11. Phụ lục: các nhóm đã đọc, số tin mỗi nhóm, thời điểm sync

- Lưu vào `C:\Users\kongn\Downloads\Zalo_MI_Report_<từ ngày>_den_<đến ngày>.md`, giống chỗ lưu của bản tin PEWG. **[Claude quyết]**
- Câu nào là nhận định của Claude thì ghi rõ "(Nhận định)", như bản tin PEWG.

### 9.5 File tín hiệu cho hub (thêm 03/11/2026)

Theo thiết kế đồng bộ hub và cẩm nang (`Allotrope/2026/19. Clean Energy Handbook/Handbook_2026/HANDBOOK_HUB_SYNC_DESIGN.md` mục 5.6, pha 4; Cong duyệt S-05 ngày 03/11/2026). Mỗi bản tin có thêm một file `Zalo_MI_Report_<từ>_den_<đến>.signals.csv` cạnh nó, cùng hậu tố `_vN`. **[Cong quyết]**

- **Vì sao:** job hub sáng thứ Hai ghi mỗi tin chính sách thành một sự kiện dưới chủ đề T-01 đến T-09; folder cẩm nang khớp sự kiện đó với văn bản gốc và sổ sự thật pháp lý. Đọc bảng mục 2 của bản tin bằng chữ thì tốn và dễ sót văn bản đã mở ở mục 8.
- **Gồm:** tin chính sách và quy định (mục 2 của bản tin) và văn bản pháp luật, công văn đã mở (mục 8). Không gồm giấy mời, nghiên cứu, giá.
- **Cột:** `ngay,nhom,ma_tin,chu_de,loai_su_kien,van_ban_nhac,key_hint,da_mo_goc,tom_tat,muc_bao_cao`. Tên cột trùng với trường của fact `event` trong hub (`date`, `source`, `source_ref`, theme, `event_type`, `van_ban_nhac`, `key_hint`, `original_opened`, `text`), để hub chép thẳng sang op `add_fact`. Định nghĩa từng cột ở bước 8b của skill.
- **Định dạng:** UTF-8 có BOM, ngày ISO, nhiều giá trị trong một ô phân cách bằng `|`. Ví dụ:

```
2026-10-31,DNSolar|VREN|NLTT-ĐGNK,#m8438161842955|#m8438394246240,T-03,ky,QĐ 2892/QĐ-BCT,QD_2892_BCT_2026,1,"Giá bán lẻ bình quân 2.159,9037 đ/kWh chưa VAT từ 01/11/2026",2|8
```

- **Bảo mật:** không số điện thoại, email, mã người dùng Zalo hay tên người gửi; skill kiểm rò rỉ trên file này như trên bản tin. Tin Zalo vẫn là tín hiệu [S] với hub, kể cả khi `da_mo_goc=1`.
- **Không đổi:** `zmi` và database không đổi; chỉ skill ghi thêm file này.

## 10. Cấu trúc thư mục

```
Zalodatabase/
  zmi.mjs                    CLI: sync, images, groups, export, search, doctor, chat
  lib/                       cdp, zalo-bridge (chỉ đọc), db (schema, upsert), normalize, export, redact
  config/groups.json         nhóm theo dõi
  scripts/zalo-mi-launch.ps1 mở Zalo kèm cổng debug + tạo shortcut
  data/zalo-mi.db            database riêng
  data/files/<convId>/...    file đã lưu
  data/images/<convId>/...   ảnh có chữ, đã đổi sang JPG
  exports/<lần chạy>/        dữ liệu đã lọc cho Claude
  README.md                  cách cài, cách chạy, cảnh báo về cổng debug
C:\Users\kongn\.claude\skills\zalo-mi\SKILL.md
```

Tách file trong `lib/` thế nào là **[Builder quyết]**.

## 11. Kiểm thử và tiêu chí hoàn thành

- **Chỉ đọc:** có test cho thấy lớp bọc chặn mọi hàm ngoài danh sách cho phép.
- **Chuẩn hóa:** test bằng mẫu tin thật đã lưu từ thử nghiệm (đã che dữ liệu cá nhân) cho từng loại tin trong mục 6.4, gồm cả các câu sự kiện thành viên.
- **Che dữ liệu:** test các mẫu số điện thoại và email ở mục 6.7, cùng các mẫu không được che.
- **Ảnh có chữ:** trên một mẫu khoảng 50 ảnh thật của nhóm thử, được chọn bằng tay (có poster, bảng giá, ảnh chụp màn hình, ảnh người), `has_text` phải đúng với phần lớn ảnh, và không bỏ sót poster sự kiện nào trong mẫu.
- **Không trùng:** chạy `sync` hai lần liền, số tin không đổi.
- **Đối chiếu:** với nhóm Future Energy Vietnam giai đoạn 22/09 đến 05/10/2026, phần nội dung trong database phải bao trùm 31 tin của file export Zalo Web cũ.
- **Chạy đầy đủ:** backfill toàn bộ nhóm theo dõi, rồi tạo một bản tin 14 ngày bằng skill. Cong đọc và xác nhận bản tin dùng được.
- **Tài liệu:** README có hướng dẫn cài, chạy, xử lý khi Zalo cập nhật làm hỏng bước tìm module.

## 12. Còn mở cho builder

1. **Tải file chưa có trên máy** (mục 6.5): thử `GET` và bộ tải của Zalo trước khi xây phần file. Nếu không cách nào chạy, phương án là nhờ Cong bật tự động tải file.
2. **Đổi ảnh JXL sang JPEG** (mục 6.6): thử theo thứ tự đã nêu.
3. **Chọn công cụ quét chữ** (mục 6.6): OCR của Zalo, OCR của Windows hay Tesseract, theo tiêu chí đã nêu.
4. **Đặt tên `kind` cho các `msgType` chưa gặp** (ví dụ -1909, bình chọn, ghi chú nhóm): lưu `other` kèm `raw_json`, rồi bổ sung dần.

## 13. Rủi ro

| Rủi ro | Cách giảm |
| --- | --- |
| Zalo cập nhật làm đổi tên module hoặc cấu trúc bên trong | Tìm module theo hình dạng; `zmi doctor` báo lỗi rõ; README có cách sửa |
| Quên mở Zalo kèm cổng debug | Skill nhắc Cong, cho phép dùng dữ liệu cũ, ghi rõ ngày sync |
| Lỡ gọi hàm ghi vào database Zalo | Lớp bọc chỉ cho phép hàm đọc, có test |

## 14. Đọc một chat theo yêu cầu (`zmi chat`, thêm 09/11/2026)

**Mục đích [Cong quyết]:** tổng hợp trao đổi với khách hàng qua Zalo để làm báo cáo cho riêng Cong. Nội dung báo cáo theo yêu cầu từng lần, dạng markdown.

**Cách chạy**
- `zmi chat find "<tên>"`: tìm chat theo tên trong danh bạ (tên gợi nhớ và tên Zalo), tên nhóm (kể cả nhóm không theo dõi), và nếu không khớp thì theo tên người chưa kết bạn hiển thị trong tin. In mã chat, loại (1-1/nhóm), tên, giờ tin cuối.
- `zmi chat read <mã> [--from] [--to] [--page N] [--save-to THƯ_MỤC]`: đọc thẳng từ Zalo qua cầu nối chỉ đọc, in ra màn hình theo trang khoảng 20.000 ký tự, cũ trước.

**Quy tắc [Cong quyết]**
- Chỉ đọc chat Cong chỉ định, khi Cong yêu cầu. Không ghi gì vào `data/zalo-mi.db`, không tạo file chứa nội dung chat; `lib/chat.mjs` không import `lib/db.mjs` (có test).
- Mọi file trong chat (mọi loại, tối đa 100 MB) được chép vào thư mục `--save-to`, thường là `<folder workstream>\Zalo files\<tên chat>\`. File đã có (cùng tên, cùng nội dung) không chép lại.
- Ảnh chụp màn hình được OCR; ảnh có chữ được chép vào cùng thư mục để Claude mở. Ảnh thường không chép, không đọc. File scan được chép nhưng Claude không đọc.
- Không che số điện thoại, email trong nội dung chat (báo cáo chỉ Cong đọc). Mã chat (Zalo id) không đưa vào báo cáo.

**[Claude quyết]**
- Giữ cả tin ngắn ("ok anh") vì trong chat với khách đó thường là xác nhận; vẫn bỏ sticker, video, tin thu hồi, tin đã xóa.
- Tin trả lời ghi kèm `(trả lời "…")` để giữ mạch trao đổi.
- `--save-to` phải là đường dẫn đầy đủ, không nằm trong thư mục Zalo hay `data/` của zmi. OCR luôn chạy trên bản tạm trong `%TEMP%`, không bao giờ trên file trong thư mục của Cong hay của Zalo.
- Skill `zalo-chat-report` điều phối: tìm chat, Cong xác nhận, đọc từng trang, mở file và ảnh, viết báo cáo vào folder workstream.
| Cổng debug bị chương trình khác trên máy lợi dụng | Chỉ nghe ở 127.0.0.1, chỉ bật khi cần, có cảnh báo trong README |
| Số điện thoại cá nhân lọt vào bản tin | Che trong chữ chat khi export, có test; skill được dặn chỉ ghi liên hệ chung của tổ chức |
| Quét chữ hàng nghìn ảnh làm lần đồng bộ đầu quá lâu | `zmi images` chạy riêng, tăng dần, có giới hạn mỗi lần; ưu tiên ảnh có dáng ảnh chụp màn hình và ảnh mới |
| Ngữ cảnh quá dài khi kỳ báo cáo dài hoặc nhóm quá sôi nổi | Lọc nhiễu, đọc theo nhóm, dùng subagent, chỉ mở đính kèm khi liên quan |
| Zalo PC chưa đồng bộ đủ lịch sử | Phụ lục bản tin ghi số tin và khoảng thời gian thực có của từng nhóm |
