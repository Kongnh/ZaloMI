# Zalo MI

Công cụ dòng lệnh `zmi` (Node 24) đọc tin nhắn nhóm Zalo từ ứng dụng Zalo PC đang chạy, qua Chrome DevTools Protocol, để đưa vào một database SQLite riêng phục vụ báo cáo market intelligence theo yêu cầu. Thiết kế đầy đủ: `Thiết kế hệ thống Zalo MI.md`. Kết quả thử nghiệm đọc dữ liệu: `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`.

Hiện có: kết nối CDP, cầu nối chỉ đọc, các lệnh `doctor`, `groups`, `sync` (lấy tin của các nhóm theo dõi vào database), `files` (lưu file đính kèm vào `data/files/`), `images` (quét chữ trong ảnh chụp màn hình, lưu ảnh có chữ vào `data/images/`), `export` (bản đã lọc, đã che cho Claude đọc), `search` (tìm toàn văn), và script mở Zalo ở chế độ thu thập.

## Yêu cầu

- Windows, Node 24 trở lên.
- Zalo PC đang mở **kèm cờ** `--remote-debugging-port=9222` (lối tắt "Zalo (MI)", xem bên dưới). Phải thoát hẳn Zalo trước khi mở lại, nếu không Zalo đang chạy sẽ bỏ qua cờ này. Cổng chỉ mở ở `127.0.0.1`. Chỉ `doctor`, `groups --refresh`, `sync` và `images` cần Zalo mở; `files`, `export`, `search` thì không.

## Mở Zalo ở chế độ thu thập

```
powershell -ExecutionPolicy Bypass -File scripts\zalo-mi-launch.ps1            # hoặc bấm lối tắt "Zalo (MI)" trên Desktop
powershell -ExecutionPolicy Bypass -File scripts\zalo-mi-launch.ps1 -DryRun    # chỉ in Zalo.exe, lệnh sẽ chạy và trạng thái
```

Script tìm thư mục `Zalo-<phiên bản>` mới nhất trong `%LOCALAPPDATA%\Programs\Zalo\`, rồi:

1. Zalo đang chạy và cổng debug trả lời: báo sẵn sàng (mã 0).
2. Zalo đang chạy **không** có cổng debug: in hướng dẫn thoát hẳn Zalo (khay hệ thống → Thoát) rồi chạy lại (mã 2). Script **không bao giờ** tự tắt Zalo.
3. Zalo chưa chạy: mở `Zalo.exe --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`, chờ cổng mở tối đa 60 giây (mã 0; hết giờ: 3).

Mã khác: 4 không tìm thấy `Zalo.exe`, 5 cổng mở nhưng chưa có cửa sổ "Zalo" (đợi Zalo đăng nhập xong rồi chạy lại), 1 lỗi bất ngờ. Lần chạy thật đầu tiên tạo lối tắt "Zalo (MI)" trên Desktop (không ghi đè lối tắt đã có; `-NoShortcut` để bỏ). Lối tắt gọi chính script này nên vẫn đúng khi Zalo cập nhật sang thư mục phiên bản mới. `-Port N` đổi cổng.

Kiểm tra tay sau khi sửa script: (a) thoát hẳn Zalo, chạy script → Zalo mở, cổng trả lời; (b) `node zmi.mjs doctor` ✓ mọi mục; (c) chạy lại script khi Zalo (MI) đang mở → báo sẵn sàng, không mở Zalo thứ hai; (d) mở Zalo bình thường rồi chạy script → hướng dẫn thoát, mã 2; (e) `-DryRun` không mở gì.

Lưu ý: khi cổng mở, mọi chương trình trên máy này đều đọc được Zalo qua `127.0.0.1:9222`. Thoát Zalo (MI) và mở Zalo bình thường khi không cần thu thập.

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
- Cuối mỗi lần `sync`: lưu file đính kèm mới (như `zmi files`), rồi quét ảnh chụp màn hình mới (như `zmi images`) bằng chính kết nối Zalo đó, in dòng `Đã quét X ảnh: …`. Bước ảnh lỗi hay dừng giữa chừng chỉ in cảnh báo `⚠ …`, không đổi mã thoát của `sync`; chạy `node zmi.mjs images` sau để làm tiếp.

```
node zmi.mjs files                  # lưu file đính kèm chưa xử lý (status trống)
node zmi.mjs files --retry          # thử lại cả file lỗi (failed) và file chỉ có link (remote_only)
node zmi.mjs files --limit 50       # chỉ 50 file (mới nhất trước)
```

`zmi sync` gọi bước này ở cuối mỗi lần chạy cho các file mới; `zmi files` xử lý phần tồn đọng. `files` không cần Zalo mở: khi Zalo đóng, lệnh nói một lần rằng bỏ qua bảng `Media.File` của Zalo rồi vẫn chép file từ đường dẫn đã lưu trong tin và tải theo link. Mỗi file được thử theo thứ tự:

1. **File đã có trên máy**: `localPath` trong tin (`raw_json`), rồi `localPath`/`folderPath` của dòng `Media.File` tương ứng (đọc qua cầu nối chỉ đọc; ghép theo `cliMsgId`, trùng thì chọn đúng người gửi rồi giờ gửi gần nhất). Đường dẫn cũ `...\ZaloPC\<uid>\ZaloDownloads\...` được đổi sang `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\...`. File được **chép**, không bao giờ di chuyển; thư mục (như `folderPath` của file zip đã giải nén) bị bỏ qua.
2. **Tải theo `href`** bằng một `GET` thường (không cookie) qua bộ tải an toàn `lib/net.mjs`: chỉ máy chủ công cộng `http(s)`, theo tối đa 3 lần chuyển hướng và kiểm tra lại từng lần (xem phần An toàn). `href` do người gửi tin đặt nên không bao giờ được trỏ vào máy này.
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

```
node zmi.mjs images                 # quét các ảnh chụp màn hình chưa quét (và ảnh lỗi lần trước)
node zmi.mjs images --limit 300     # chỉ 300 ảnh, theo thứ tự ưu tiên
node zmi.mjs images --rescan        # quét lại mọi ảnh chụp màn hình, kể cả ảnh đã quét
node zmi.mjs images --prune-photos  # không quét: xóa file đã lưu của ảnh không phải ảnh chụp màn hình, giữ chữ OCR
```

`images` **chỉ quét ảnh có dáng ảnh chụp màn hình** (`shape_class` là `phone_screenshot` hoặc `desktop_screenshot`) và giữ lại ảnh nào có chữ để Claude đọc sau. **[Cong quyết]** Ảnh chụp bằng máy ảnh, ảnh AI, quảng cáo không đáng thời gian quét, nên mọi ảnh dáng khác (`photo`) không bao giờ được tải hay đọc chữ, kể cả với `--rescan`; chấp nhận rằng poster, bảng giá và ảnh chụp màn hình đã cắt có dáng khác cũng bị bỏ qua. **Cần Zalo đang mở ở chế độ thu thập**, vì bộ đọc chữ (OCR) và bộ giải mã ảnh JXL là của chính Zalo; Zalo đóng thì lệnh in hướng dẫn mở "Zalo (MI)", thoát mã 1 và không ghi gì. `zmi sync` tự chạy bước này ở cuối; `zmi images` dùng để làm phần tồn đọng hoặc quét lại. Link ảnh của Zalo chỉ sống khoảng 2 tuần (xem phần thử nghiệm bên dưới), nên chạy `sync` **ít nhất mỗi tuần một lần**.

`--prune-photos` dọn kết quả của lần quét toàn bộ ảnh trước đây: với mỗi ảnh dáng `photo` đã có file trong `data/images/`, xóa file, đặt `stored_path` rỗng và `status = text_only`, giữ nguyên `ocr_text`, `has_text`, `text_score` (nên chữ trong ảnh vẫn tìm được). Chỉ xóa đường dẫn nằm trong `data/images/`, đường dẫn khác bị từ chối (thoát mã 1); file đã mất thì chỉ cập nhật database. Lệnh cũng dọn file tạm còn sót trong `data/images/.tmp/` của các lần chạy đã chết (mỗi lần quét cũng tự dọn khi bắt đầu). Không cần mở Zalo. Lần chạy thật: 2.189 file, giải phóng 724 MB.

Mỗi ảnh chụp màn hình được xử lý như sau:

1. **Lấy ảnh**: trước hết từ cache ảnh của Zalo trên máy (chỉ đọc): `picture\<convId bỏ chữ g>_group\z<msgId>_<mã>.<đuôi>`, `resource\<convId>\picture\<cliMsgId>_<fromUid>_<convId>_<mã>.<đuôi>` trong `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\`, và `localPath` của tin (đổi gốc cũ như với file). Có bản `.jpg`/`.png` thì dùng luôn, chỉ có `.jxl` thì nhờ bộ giải mã JXL của Zalo đổi sang JPEG. Không có trên máy thì tải theo link (`hdUrl`): với link JXL của Zalo, xin bản JPEG ở cùng đường dẫn (`/jxl/…/x.jxl` thành `/jpg/…/x.jpg`), không được mới tải link gốc. Chỉ tải `http(s)` từ máy chủ công cộng (từ chối localhost và địa chỉ nội bộ, kiểm tra lại ở mỗi lần chuyển hướng), tối đa 20 MB, chờ tối đa 30 giây.
2. **Đọc chữ** bằng OCR của Zalo trên một file tạm của zmi (`data/images/.tmp/`), không bao giờ trên file trong thư mục Zalo.
3. **Quyết định**: ảnh "có chữ" khi OCR đọc được từ 6 từ trở lên (từ = cụm có ít nhất 2 chữ cái hoặc chữ số, nên con số trong bảng giá cũng tính). Một logo, biển hiệu hay nhãn bản đồ (1 đến 5 từ) không đủ. Ngưỡng này được chọn trên mẫu ảnh thật (bên dưới).
4. **Lưu**: chỉ ảnh có chữ được ghi vào `data/images/<convId>/<msgId>.jpg` (ảnh gốc PNG thì giữ `.png`), qua file tạm rồi đổi tên. Ảnh không có chữ chỉ giữ dòng trong database.

| `status` | Nghĩa |
| --- | --- |
| `stored` | Có chữ, đã lưu ở `images.stored_path` (đường dẫn tính từ thư mục gốc repo, dấu `/`) |
| `no_text` | Đã đọc, không đủ chữ; không lưu file |
| `unavailable` | Không có trên máy và link đã hết hạn hoặc không tải được (lý do ở `images.error`, ví dụ `HTTP 404 (link đã hết hạn)`) |
| `failed` | Lỗi khi giải mã hoặc đọc chữ, hay mạng chập chờn với ảnh còn mới (lý do ở `error`); lần chạy sau tự thử lại, sau các ảnh chưa quét, tối đa 3 lần (`images.fail_count`), rồi chỉ `--rescan` mới thử lại |
| `text_only` | Ảnh dáng `photo` đã quét trong lần quét toàn bộ ảnh trước đây; file đã xóa bằng `--prune-photos`, chỉ còn giữ chữ OCR |
| (trống) | Chưa quét; với ảnh dáng `photo` là không bao giờ quét |

- Mỗi ảnh ghi `shape_class`, `status`, `has_text` (1/0), `text_score` (số từ), `ocr_text` (các dòng chữ OCR đọc được, cả khi không đủ để lưu ảnh), `stored_path`, `scanned_at`, `error`. `ocr_text` được đưa vào tìm kiếm toàn văn cùng tin nhắn, không phân biệt dấu.
- `shape_class` (`phone_screenshot`: ảnh dọc tỉ lệ ít nhất 1,9; `desktop_screenshot`: ảnh ngang gần 16:9 hoặc 16:10, rộng từ 1280; còn lại `photo`) được tính cho mọi ảnh ngay đầu lần chạy, từ kích thước đã lưu, và quyết định ảnh nào được quét.
- **Thứ tự**: ảnh còn link (16 ngày gần nhất) trước, ảnh cũ nhất trước (ảnh sắp hết hạn link được quét trước); sau đó ảnh cũ hơn có trên máy; cuối cùng là phần còn lại (phần lớn sẽ là `unavailable`).
- Chạy lại không làm lại gì: chỉ quét ảnh chụp màn hình chưa có `scanned_at` và ảnh `failed`. `--rescan` quét lại mọi ảnh chụp màn hình (ảnh đã lưu được đọc lại từ chính file đã lưu); `--rescan` không xóa file đã lưu.
- Đồng thời 3 ảnh. Bảo vệ ổ đĩa như `files`: ổ chứa `data/` còn dưới 5 GB thì dừng, ảnh còn lại giữ nguyên, thoát mã 1. Mất kết nối với Zalo giữa chừng, hoặc 10 ảnh chưa từng lỗi bị lỗi liên tiếp (dấu hiệu OCR hay bộ giải mã hỏng), thì dừng và báo; chạy lại là tiếp tục. Ảnh đã lỗi từ trước không tính vào ngưỡng này và luôn xếp sau, nên vài ảnh lỗi mãi không chặn được hàng đợi.
- In tiến độ mỗi 25 ảnh, rồi `Đã quét X ảnh: Y có chữ (đã lưu), Z không có chữ, W không còn tải được, V lỗi`, thời gian và tốc độ (ảnh/giây), các lý do lỗi phổ biến nhất, và dòng trạng thái của các ảnh chụp màn hình (kèm số ảnh dáng khác không quét theo thiết kế).

```
node zmi.mjs export                                        # 14 ngày gần nhất, mọi nhóm đang theo dõi
node zmi.mjs export --from 2026-10-01 --to 2026-10-15      # ngày giờ Việt Nam; --to tính hết ngày đó
node zmi.mjs export --groups g123,g456 --out D:\tam\xuat   # chỉ các nhóm này; --out phải chưa có hoặc đang trống
```

`export` đọc database (không cần Zalo) và ghi một thư mục `exports/<YYYYMMDD-HHmm>/` (trùng phút thì thêm `-2`, `-3`…). **Dòng cuối cùng in ra là đường dẫn thư mục**, để skill lấy. Nếu lần sync gần nhất cũ hơn 24 giờ, cảnh báo được in trước dòng đó và ghi ở đầu `index.md`. Mã thoát: 0 xong, 1 chưa có database / chưa có nhóm theo dõi / `config/groups.json` hỏng, 2 sai `--from`, `--to`, `--groups` hay `--out`.

| File | Nội dung |
| --- | --- |
| `index.md` | Kỳ, lần sync gần nhất, bảng nhóm (số tin, tin đầu, tin cuối, tên file), số người mới, file, ảnh có chữ, link, cách đọc và những gì đã lọc bỏ |
| `<tên-nhóm>.md` | Một file cho mỗi nhóm có tin, gom theo ngày: `[HH:mm] Người gửi: nội dung #m<mã tin>` |
| `members.md` | Người vào nhóm trong kỳ (tự tham gia hay được ai thêm), kèm tối đa 2 tin đầu của chính họ sau khi vào |
| `attachments.md` | Theo nhóm: file, ảnh chụp màn hình có chữ (có file trong `data/images/`) và link của kỳ |

Dạng dòng: `[File] tên (3,9 MB) → <đường dẫn tuyệt đối>` hoặc `→ chỉ có link: <href>`; `[Ảnh có chữ] chú thích | ~200 ký tự đầu của chữ OCR → <đường dẫn>` (ảnh đã xóa bằng `--prune-photos` ghi `(chỉ còn chữ, ảnh đã xoá)`); `[Ảnh] chú thích`; `[Link] tiêu đề — tên miền | mô tả`; `[Thành viên] X được Y thêm vào nhóm`. Một tin dài vẫn nằm trên một dòng (xuống dòng thành ` ⏎ `). Giờ luôn là giờ Việt Nam (UTC+7), bất kể múi giờ của máy.

- **Lọc bỏ**: tin thu hồi, tin đã xóa, sticker, video (database vẫn giữ), tin trống, và tin chào/cảm ơn ngắn (dưới 15 ký tự, không có số hay link, chỉ gồm lời chào/cảm ơn cộng tối đa một từ khác như tên người). Link, file và ảnh không bao giờ bị lọc.
- **Rút gọn tin đăng lại**: tin từ 40 ký tự trở lên giống hệt một tin trước đó **trong cùng nhóm và cùng kỳ** chỉ còn `(đăng lại tin #m<tin gốc>)`, vẫn giữ giờ, người gửi và mã của chính nó. Các nhóm bán hàng đăng lại cùng một tin mỗi ngày: lần xuất 14 ngày đầu tiên rút gọn 1.732 tin, file nhóm lớn nhất giảm từ 1,6 MB còn 1,0 MB. Tin giống nhau ở **hai nhóm khác nhau** được giữ nguyên để bản tin tự gộp.
- **Che dữ liệu cá nhân** (`lib/redact.mjs`, spec 6.7): chữ chat, tiêu đề/mô tả link, tên người gửi và link file đi qua `redact`: số điện thoại thành `[SĐT]`, email thành `[email]`. Chữ OCR trong ảnh và tên file thì không che (Cong quyết: ảnh, PDF không cần che; bản tin vẫn không được ghi số cá nhân). Số di động 10 số theo các cách nhóm thường gặp, số gõ thừa hoặc thiếu một chữ số (`098177774`, `0867 224 4149`), số bàn `02x`, số có `+84`/`0084`, và `zalo.me/<số>` đều bị che; mã văn bản, công suất, tiền, ngày giờ, hotline `1900`/`1800`, số căn cước 12 số thì không. Điểm mù đã biết: mã số thuế 10 số bắt đầu bằng 03/05/07/08/09 bị che như số di động.

```
node zmi.mjs search "DPPA"                                  # mới nhất trước, tối đa 50 kết quả
node zmi.mjs search "giá tấm pin" --from 2026-10-01 --limit 20
node zmi.mjs search "hội thảo" --groups g123
```

`search` tìm toàn văn trong chữ tin, tiêu đề/mô tả link, tên file và chữ OCR của ảnh, không phân biệt hoa thường và dấu (`dien` khớp `điện`). Mỗi kết quả một dòng `[YYYY-MM-DD HH:mm] <nhóm> | <người gửi>: <~200 ký tự quanh chỗ khớp, đã che> #m<mã tin>`; tin thu hồi, đã xóa, sticker, video không bao giờ được trả về. Mặc định: mọi ngày, các nhóm đang theo dõi. Không cần Zalo. Mã thoát 0 (cả khi không có kết quả), 1 chưa có database, 2 thiếu từ khóa hay sai tùy chọn. Từ khóa bắt đầu bằng `-` phải đặt sau `--`: `node zmi.mjs search -- "-abc"`.

## Thử nghiệm ảnh (bước 0 của Task 7)

**Đổi JXL sang JPEG.** Thử theo thứ tự của spec:

1. *Xin JPEG từ máy chủ ảnh của Zalo*: gửi `Accept: image/jpeg,image/png`, bỏ `?jxlstatus=1` hay đổi `jxlstatus=0` đều vẫn nhận `image/jxl`. Nhưng đổi đường dẫn `/jxl/…/x.jxl` thành `/jpg/…/x.jpg` thì máy chủ trả **JPEG thật** (`ffd8ff`, `image/jpg`), đúng kích thước Zalo lưu (11/12 ảnh thử khớp `width`/`height`; ảnh 4284×5712 nhận bản 1920×2560, Zalo giới hạn cạnh dài 2560). Dùng cách này cho mọi ảnh tải theo link: không cần giải mã.
2. *Bộ giải mã của Zalo* (`$zFeatures.libjxl.decodeToJpeg`, bản gói sẵn của `$znode.nativelibs.zjxl`): chạy được qua CDP, đưa byte vào, nhận JPEG ra, khoảng 130 ms cho ảnh 1254×1254 (khoảng 200 ms tính cả truyền base64). Hàm này chỉ tính toán: không đọc, không ghi gì của Zalo. Dùng cho ảnh trong cache máy chỉ có bản `.jxl`. Cần thiết: cache máy có ảnh của 2.435/10.010 dòng (2.324 ảnh đã hết hạn link), trong đó chỉ khoảng 630 có sẵn bản `.jpg`.
3. *Gói WASM npm*: không cần, không cài gói npm nào.

**OCR tiếng Việt.** Thử `$znode.nativelibs.zocr` trước, qua hàm gói sẵn của Zalo `$zFeatures.ocr.recognize(đường dẫn)` (động cơ của tính năng "sao chép chữ trong ảnh" của Zalo PC, chạy trong tiến trình riêng `zocr-host`). Trên 54 ảnh thật của nhóm thử nó đọc **tiếng Việt có dấu rất tốt** (ví dụ cả poster "BIẾN TẦN SOLIS 100KW … GIẢI PHÁP TỐI ƯU CHO NĂNG LƯỢNG MẶT TRỜI MÁI XƯỞNG", văn bản, bảng giá, biểu đồ), trả về từng dòng kèm điểm tin cậy. Tốc độ: khoảng 0,8 giây/ảnh khi chạy một luồng (lần đầu thêm khoảng 2 giây khởi động), 0,7 giây/ảnh với 3 luồng; chạy thật trên 300 ảnh mới nhất (gồm tải ảnh): **2,2 ảnh/giây**. Không cài thêm gì. Vì cách đầu tiên đạt cả ba tiêu chí của spec (đọc được tiếng Việt có dấu, đủ nhanh cho vài nghìn ảnh, không cài thêm), **không thử** `Windows.Media.Ocr` (máy này chỉ có gói tiếng Anh, không đọc dấu) và Tesseract (phải tải dữ liệu ngôn ngữ, chậm hơn). Đánh đổi: `zmi images` cần Zalo mở, như `sync`.

**Link ảnh hết hạn sau khoảng 15 ngày** (22 link thử theo tuổi): 200 ở 3 đến 15,0 ngày; 404 từ 15,2 ngày trở đi (cả bản JPEG lẫn bản JXL); máy chủ cũ `f57/f61-zpg-r.zdn.vn` (khoảng 400 ngày) trả 502 hoặc không còn tên miền. Vì vậy ảnh không có trong cache máy phải được quét trong vòng 2 tuần sau khi gửi.

**Cache ảnh trên máy.** Tên file trong `picture\<convId bỏ g>_group\` có dạng `z<msgId>_<mã băm>.jxl|.jpg`, trong `resource\<convId>\picture\` có dạng `<cliMsgId>_<fromUid>_<convId>_<mã băm>.jxl|.jpg` (cùng mã băm cho cùng một ảnh), nên ghép được với tin theo `msgId`, hoặc theo `cliMsgId` + người gửi. Nhóm thử có 337/339 ảnh trong cache; toàn bộ 28 nhóm có 2.435/10.010. Ảnh trong cache có kích thước như ảnh Zalo lưu (9/11 ảnh thử khớp `width`/`height`; 2 ảnh 4032×3024 được Zalo thu nhỏ còn 2568×1926).

## Kiểm thử mẫu ảnh (bước 5 của Task 7)

*Phép đo dưới đây làm khi `images` còn quét mọi ảnh. Từ sau quyết định chỉ quét ảnh chụp màn hình, nó vẫn đúng cho cách quyết định "có chữ" trên ảnh được quét, nhưng phần lớn ảnh trong mẫu (ảnh dáng `photo`) nay không còn được quét.*

54 ảnh thật của nhóm thử `g8318398124727869839` (chọn ngẫu nhiên trong 337 ảnh có trên máy), xem từng ảnh và gán nhãn tay: 42 ảnh có chữ (slide, biểu đồ, văn bản, bảng giá, ảnh chụp màn hình, thiệp có chữ, 6 ảnh poster, thư mời hoặc băng rôn sự kiện), 12 ảnh không có chữ (ảnh flycam, ảnh người, ảnh sản phẩm, ảnh bản đồ vệ tinh). So với quyết định của hệ thống (cùng OCR của Zalo, cùng cách ghép dòng, cùng ngưỡng; chạy trong bước thử nghiệm vì lần chạy thật bị dừng trước khi tới các ảnh cũ này):

| | Nhãn: có chữ | Nhãn: không có chữ |
| --- | --- | --- |
| Hệ thống: có chữ | 42 | 1 (ảnh người trước bảng trưng bày có chữ đọc được) |
| Hệ thống: không có chữ | 0 | 11 |

Độ chính xác 42/43 = 97,7 %, độ phủ 42/42 = 100 %, **không bỏ sót poster sự kiện nào** (6/6). Điểm `text_score` của ảnh có chữ thấp nhất là 9 (sơ đồ "polysilicon → wafer → solar cell → solar module"), của ảnh không có chữ (trừ ca biên ở trên) cao nhất là 2 ("gogoro network", "Google Maps"); ngưỡng 6 nằm giữa khoảng trống này. Mọi ngưỡng từ 3 đến 9 cho cùng kết quả, ngưỡng 10 làm sót sơ đồ trên.

Trên 300 ảnh mới nhất (chạy thật), ảnh 1 đến 5 từ là ảnh sản phẩm, ảnh người có biển hiệu nhỏ: đúng là `no_text`. Khoảng 6 đến 9 từ phần lớn là ảnh sản phẩm có nhãn bao bì (một nhóm bán hàng đăng lại nhiều lần) và được lưu: chấp nhận vài ảnh thừa để không bỏ sót ảnh có ít chữ.

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
| `zmi.mjs` | Điểm vào CLI, lệnh `doctor`, `groups`, `sync`, `files`, `images`, `export` và `search` |
| `lib/export.mjs` | `runExport`/`exportRange` (thư mục xuất: lọc nhiễu, rút gọn tin đăng lại, giờ Việt Nam, đường dẫn tuyệt đối), `searchMessages`, `selectGroupIds`, `isNoiseMessage`, `slugify`, đọc ngày `--from`/`--to` |
| `lib/redact.mjs` | `redact(text)`: che số điện thoại và email trong chữ chat |
| `lib/db.mjs` | Database riêng: lược đồ, upsert idempotent, tìm toàn văn FTS5 bỏ dấu |
| `lib/normalize.mjs` | Chuẩn hóa tin thô của Zalo theo `msgType` thành tin, link, file, ảnh, sự kiện thành viên |
| `scripts/zalo-mi-launch.ps1` | Mở Zalo kèm cổng debug, tạo lối tắt "Zalo (MI)" |
| `lib/net.mjs` | `guardedFetch` (tải chỉ từ máy chủ công cộng, kiểm địa chỉ lúc kết nối và ở mỗi lần chuyển hướng), `checkRemoteUrl`, `isPrivateAddress`; dùng chung cho `files` và `images` |
| `lib/images.mjs` | `shapeClass`, `textScore`/`hasText` (quyết định có chữ), `jpegVariantUrl`, `fetchImage` (tải ảnh qua `guardedFetch`, giới hạn thời gian và dung lượng), `scanImages` (phần tồn đọng của ảnh chụp màn hình: cache máy, link, giải mã, OCR, lưu; đồng thời 3 ảnh, bảo vệ ổ đĩa), `prunePhotoImages` (xóa file ảnh dáng `photo`, giữ chữ OCR), in kết quả |
| `lib/files.mjs` | `resolveFile` (một file: chép từ máy, tải theo link, kiểm tra), `resolveFiles` (phần tồn đọng, đồng thời 3 file, bảo vệ ổ đĩa), `remapLocalPath`, đặt tên file, in kết quả |
| `lib/sync.mjs` | `syncGroup` (một nhóm: đọc Zalo, chuẩn hóa, ghi trong một transaction), `syncAll` (mọi nhóm, ghi `sync_runs`), chọn nhóm và in kết quả |
| `lib/groups.mjs` | `suggestTracked`, gộp danh sách nhóm vào `config/groups.json`, in bảng nhóm |
| `lib/cdp.mjs` | `connect(title = 'Zalo', { port })` trả về `{ evaluate, close }`; ném `CdpError` (`PORT_CLOSED`, `NO_TARGET`) |
| `lib/zalo-bridge.mjs` | `openBridge({ port })` trả về Bridge: `listGroups`, `getMessages`, `getMediaRows`, `locate`, `readOnlyGuard`, và hai hàm tính toán `decodeJxl`, `recognizeText` (danh sách riêng `COMPUTE_ALLOWLIST`) |
| `test/` | Test chạy bằng `node --test`, không cần Zalo |

## An toàn: chỉ đọc

Mọi lời gọi vào database của Zalo đi qua `readOnlyGuard`, chỉ cho phép `getAll`, `get`, `getMulti`, `count`. Gọi tên hàm khác thì ném lỗi ngay, cả ở phía Node lẫn trong trang Zalo (hai phía dùng chung một danh sách và một đoạn mã). Không gọi `insert`, `put`, `update`, `delete`, không gửi tin, không thao tác giao diện Zalo. `zmi files` đọc `Media.File` qua đúng cầu nối này và tải file bằng một `GET` thường từ Node; không gọi bộ tải của Zalo (`$zdownload`) và không ghi gì vào thư mục dữ liệu của Zalo (chỉ chép từ đó ra `data/files/`).

`zmi images` dùng thêm một danh sách **riêng**, `COMPUTE_ALLOWLIST`, gồm đúng ba hàm chỉ tính toán của Zalo: `libjxl.decodeToJpeg` (byte JXL vào, byte JPEG ra), `ocr.recognize` (đọc chữ trong một file ảnh) và `ocr.isSupported`. Danh sách này cũng được kiểm ở cả hai phía như danh sách đọc kho; danh sách đọc kho không đổi (`getAll`, `get`, `getMulti`, `count`). OCR chỉ được đưa file tạm của zmi trong `data/images/.tmp/`: đường dẫn tương đối, có `..`, hay nằm trong `ZaloData`/`ZaloPC` bị từ chối ở cả hai phía. Ảnh trong cache Zalo do Node đọc rồi chép ra, không bao giờ đưa thẳng cho Zalo.

**Tải từ mạng chỉ tới máy chủ công cộng** (`lib/net.mjs`, dùng cho cả link file lẫn link ảnh). Link nằm trong tin nhắn nên người gửi có thể trỏ nó vào chính máy này, ví dụ cổng debug của Zalo `127.0.0.1:9222`. Vì vậy chỉ tải `http(s)`; từ chối `localhost`, địa chỉ loopback, mạng riêng, link-local, CGNAT, dải thử nghiệm (198.18.0.0/15, 192.0.0.0/24), multicast và các dạng IPv6 tương ứng (kể cả `::ffff:127.0.0.1`, `::127.0.0.1`). Việc kiểm tra diễn ra **ngay lúc kết nối**: bộ tải tự phân giải tên máy chủ và chỉ kết nối tới địa chỉ đã kiểm, nên một tên miền đổi sang `127.0.0.1` sau lần kiểm đầu (DNS rebinding) cũng không lọt. Chuyển hướng được theo bằng tay, tối đa 3 lần, mỗi lần kiểm lại; `Location` hỏng thì coi như link chết.

Dữ liệu (`data/`), bản xuất (`exports/`) và dữ liệu thô dùng cho test (`test/fixtures/raw/`) chứa nội dung chat thật nên đã nằm trong `.gitignore`. Không commit chúng.

## Kiểm thử

```
node --no-warnings --test
```
