# Kết quả thử nghiệm đọc dữ liệu Zalo PC

22/10/2026 · thử nghiệm trên máy của Cong, Zalo PC 26.10.11

## Tóm tắt

Đọc được. Một script chạy ngoài Zalo có thể lấy toàn bộ lịch sử tin nhắn của một nhóm từ Zalo PC, kèm mã tin, giờ gửi, người gửi, ảnh, file, link và sự kiện thành viên vào nhóm. Không cần bấm vào nhóm, không cần export tay, không gọi API mạng của Zalo.

Thử với nhóm **☀️ Future Energy Vietnam 🇻🇳**: lấy được **2.698 tin** từ 14/02/2025 đến 17/10/2026, của 195 người gửi, trong chưa tới 1 giây.

Có hai việc chưa xong: tải file PDF không có sẵn trên máy, và phân biệt ảnh chụp màn hình với ảnh thường. Chi tiết ở phần "Còn mở".

## Cách đọc

1. Mở Zalo PC kèm cờ `--remote-debugging-port=9222`. Phải thoát hẳn Zalo trước, nếu không Zalo đang chạy sẽ nuốt cờ này. Cổng chỉ mở ở `127.0.0.1`.
2. Script Node nối vào cửa sổ chính "Zalo" qua Chrome DevTools Protocol.
3. Trong cửa sổ đó, lấy bộ quản lý database của chính Zalo (`fsN4.default.getInstance()`). Bộ này đã tự mở khóa các database mã hóa, nên script không cần biết khóa.
4. Gọi hàm chỉ đọc `Core.Message.getAll(...)` theo từng nhóm:

```js
db.Core.Message.getAll(
  { from: [convId, '', ''], to: [convId, '9999999999999999', '9223372036854775808'] },
  { index: 'userId_sendDttm_msgId', direction: 'prev', limit: 20000, partition: convId, useLGKeyRange: true }
)
```

Chỉ dùng các hàm đọc (`getAll`, `get`, `count`). Không gọi `insert`, `put`, `update`, `delete`.

## Các hướng đã loại

| Hướng | Kết quả |
| --- | --- |
| Đọc thẳng file database trong `%APPDATA%\ZaloData` | Không được. Tất cả file tin nhắn (~1,4 GB, mỗi cuộc trò chuyện một file) mã hóa SQLCipher |
| Lớp `$zsqlite` trong cửa sổ shared-worker | Không đủ. Đây chỉ là chỉ mục tìm kiếm, các hàm trả về mã tin và thời gian, không trả nội dung |
| Đọc file ảnh, file trong thư mục cache mà không có tin nhắn | Không đủ. Ảnh xếp theo nhóm nhưng không biết ai gửi, lúc nào; file bị xáo trộn (XOR 0x93) và mất tên gốc |

## Dữ liệu có trong Zalo PC

**Danh sách database và bảng** (qua bộ quản lý của Zalo):

- `Core`: Message, Conversation (942), Group (94), GroupInfo, File, Link, Image, Mention, Poll, Friend…
- `Media`: File (3.287), Link (5.371), Image (10.000+), có trường `convId` và `localPath`
- `MsgInfo`: Quotes, ThreadMsg, UnreadInfo…

**94 nhóm**, trong đó khoảng 25 nhóm liên quan năng lượng, ví dụ: TỔNG KHO CỘNG ĐỒNG SOLAR MIỀN NAM (6.160 tin trên máy), DOANH NHÂN SOLAR VN, Solar Technology VN, Năng Lượng tái tạo Việt Nam/Điện gió ngoài khơi, BIZ Năng lượng tái tạo, VREN, Future Energy Vietnam, Hỏi đáp kỹ thuật Điện Mặt Trời, BESS Technology VN.

**Mỗi tin nhắn có**: `msgId` (mã tin thật), `cliMsgId`, `sendDttm` (giờ gửi, mili giây), `fromUid` và `dName` (người gửi), `message` (chữ hoặc object), `quote` (tin được trả lời), `mentions`, `localPath` (nếu đã tải về máy).

**Các loại tin gặp trong nhóm thử**:

| msgType | Loại | Số tin | Trường hữu ích |
| --- | --- | --- | --- |
| 1 | Chữ | 1.612 | nội dung, quote, mentions |
| 2 | Ảnh | 339 | `title` (chú thích), `hdUrl`/`oriUrl`, `params.width/height/fileSize` |
| 6 | Link | 319 | `title`, `description`, `href`, `thumb` |
| 19 | File | 145 | `title` (tên file), `href`, `params.fileSize/checksum/fileExt` |
| 18 | Video | 1 | bỏ qua |
| 4 | Sticker | 12 | bỏ qua |
| -4 | Sự kiện thành viên | 141 | nội dung + `updateMemberIds` |
| 20 / -27 | Thu hồi / đã xóa | 80 / 45 | bỏ qua |

## Đối chiếu với yêu cầu báo cáo

**Chính sách, dự án, tin tức, giá, kỹ thuật**: nằm trong tin chữ và link. Link chủ yếu từ vnexpress (50), tuoitre (36), nangluongvietnam.vn (26), vneconomy (15), theleader (12), linkedin, youtube, nikkei.

**Người mới có tiềm năng BD**: có thể lấy chắc chắn từ sự kiện -4 thay vì đoán từ chữ. Nhóm thử có 64 lượt "được … thêm vào cộng đồng", 49 lượt "đã tham gia cộng đồng", 25 lượt bị xóa. Chức danh và công ty vẫn phải lấy từ tin giới thiệu (ví dụ "xin giới thiệu: anh/chị …, Managing Director, …").

**File chia sẻ**: 145 file (143 PDF, 2 DOCX), có tên gốc, dung lượng, checksum. Ví dụ: `TT 05_2025_TT-BCT.pdf`, `260716_MOIT_Important projects.pdf`, thư mời hội thảo. Chỉ 20 file đã tải về máy (18 file còn tồn tại), số còn lại chỉ có link.

**Ảnh chụp màn hình**: ảnh có kích thước, link HD và file cache. 46 ảnh có `localPath`, và cả 46 đều tìm thấy sau khi đổi đường dẫn cũ `AppData\Local\ZaloPC\…` sang `AppData\Roaming\ZaloData\media\<uid>\…`. Thư mục cache của nhóm có khoảng 350 ảnh. Link HD của ảnh mới vẫn tải được (HTTP 200, `image/jxl`); ảnh từ đầu 2025 thì link đã hỏng.

**Link tài liệu và sự kiện**: link có sẵn tiêu đề và mô tả. Sự kiện, hội thảo thường nằm trong file thư mời hoặc ảnh có chú thích (ví dụ ảnh có chú thích "mời các đồng nghiệp ở Đà Nẵng tham dự…"), nên phải để Claude đọc và trích ra.

**So với file export Zalo Web**: cùng giai đoạn 22/09 đến 05/10/2026, file export có 31 tin. Database có 36 tin, gồm 25 chữ, 4 ảnh, 3 link, 3 sự kiện thành viên, 1 tin thu hồi. Phần nội dung khớp, và database có thêm sự kiện thành viên cùng giờ chính xác. Lịch sử trên máy dài hơn nhiều (từ 02/2025).

## Còn mở

1. **Tải file chưa có trên máy.** Kiểm tra `HEAD` vào link file (`dlfl.vn` → `flchat.vn`) trả về 404, file cũ trả về 502. Chưa thử tải thật bằng `GET`. Có ba hướng: thử `GET`; dùng bộ tải của Zalo (`$zdownload.sendDownloadRequest`); hoặc bật "tự động tải file" trong cài đặt Zalo PC rồi lấy theo `localPath`.
2. **Phân biệt ảnh chụp màn hình.** Theo tỉ lệ khung hình, 49/339 ảnh có dáng ảnh chụp màn hình (38 dáng màn hình máy tính, 11 dáng điện thoại). Đây chỉ là đoán. Cách chắc hơn là để Claude xem ảnh, hoặc dùng OCR (Zalo PC có sẵn module `ocr`, chưa thử).
3. **Thông tin người gửi.** `dName` là tên hiển thị lúc gửi. Chưa kiểm tra bảng Friend/GroupInfo có thêm hồ sơ gì không.
4. **`numMsg` trong Conversation không phải tổng số tin.** Nhóm thử ghi 87 nhưng thực tế có 2.698. Muốn biết đủ hay chưa thì phải đếm qua `getAll`.

## Rủi ro và giới hạn

- **Phụ thuộc bên trong Zalo.** Tên module `fsN4`, `wH4e` là mã do webpack sinh ra và có thể đổi sau mỗi bản cập nhật. Script nên tìm module theo hình dạng (đối tượng có `getInstance().Core.Message.getAll`) thay vì theo tên cố định.
- **Zalo phải đang mở kèm cờ debug** mỗi lần thu thập. Zalo tự cập nhật sẽ tạo thư mục `Zalo-<phiên bản>` mới, nên shortcut cần trỏ vào bản mới nhất.
- **Cổng debug mở thì mọi chương trình trên máy đều điều khiển được Zalo.** Chấp nhận được trên máy cá nhân, nhưng nên chỉ bật khi cần.
- **Rủi ro tài khoản thấp hơn API không chính thức.** Script không đăng nhập riêng và không gọi máy chủ Zalo, chỉ đọc dữ liệu Zalo PC đã có trên máy. Dù vậy, đây vẫn không phải cách Zalo hỗ trợ chính thức.
- **Chỉ có những gì Zalo PC đã đồng bộ.** Tin của nhóm mới tham gia, hoặc tin trước khi cài Zalo PC, có thể không có.
- **Dữ liệu cá nhân.** Tin nhắn có số điện thoại, email của người khác. Database riêng nên lọc bớt trước khi đưa cho Claude, giữ quy tắc không lưu số điện thoại cá nhân.

## Kiến trúc gợi ý từ kết quả này

1. **Bộ thu thập (Node, chạy khi cần):** nối vào Zalo PC, với mỗi nhóm trong danh sách theo dõi thì lấy các tin mới hơn lần đồng bộ trước (dựa trên `sendDttm` lớn nhất), rồi ghi vào SQLite riêng. Các bảng: nhóm, tin, sự kiện thành viên, file, link, ảnh. Chép file và ảnh có `localPath` sang thư mục riêng.
2. **Database riêng (SQLite):** khóa theo `msgId`, nên chạy lại bao nhiêu lần cũng không bị trùng.
3. **Tổng hợp trong Claude Desktop:** một skill (hoặc MCP chỉ đọc) truy vấn database theo khoảng thời gian và nhóm, đọc ảnh chụp màn hình và file khi cần, rồi viết báo cáo market intelligence.

Script thử nghiệm và dữ liệu thô của lần này nằm trong thư mục tạm của phiên làm việc, không nằm trong dự án.
