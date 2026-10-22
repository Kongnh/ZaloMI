# MCP đọc Zalo desktop để tổng hợp market intelligence

Oct 22, 2026 · @HUY CONG

## Tóm tắt

Làm được, nhưng phần khó không nằm ở MCP. Phần khó là lấy tin nhắn ra khỏi Zalo, vì Zalo không có API chính thức để đọc chat nhóm cá nhân. API Official Account chỉ dùng cho tài khoản doanh nghiệp OA.

MCP chỉ là lớp "cửa sổ" để Claude hỏi dữ liệu. Vì vậy nên tách làm hai phần: một bộ thu thập chạy riêng, và một MCP chỉ đọc.

## Kiến trúc ba lớp

Tách bộ thu thập khỏi MCP để có thể đổi cách lấy tin từ Zalo mà không viết lại MCP.

&#91;embedded content: kiến trúc ba lớp · từ Zalo đến bản tin\]

Lợi ích lớn nhất của mã tin và thời gian thật là xử lý tận gốc các lỗi export hiện tại: thứ tự ngày bị đảo, tin lặp với tên người gửi khác, ngày lệch 1 đến 2 ngày.

## Bốn cách lấy dữ liệu từ Zalo

Xếp từ an toàn đến rủi ro. Lớp MCP giữ nguyên dù chọn cách nào.

| Cách | Cách làm | Ưu | Nhược |
| --- | --- | --- | --- |
| A. Giữ exporter hiện tại | Extension Edge trên Zalo Web xuất `zalo_*.md`, một script nạp vào SQLite | Đã chạy được, không rủi ro tài khoản | Vẫn bấm tay, vẫn dính lỗi trùng tin và đảo ngày của giao diện |
| B. Đọc giao diện Zalo PC | Zalo PC là ứng dụng Electron; thử mở với `--remote-debugging-port=9222` rồi đọc giao diện như trên Web | Tự động hơn, chạy cùng Zalo PC | Chưa chắc Zalo cho phép cờ này; giao diện đổi là hỏng |
| C. Đọc dữ liệu cục bộ của Zalo PC | Đọc thư mục dữ liệu trong `%LOCALAPPDATA%` / `%APPDATA%` | Có mã tin thật, chỉ đọc, không gọi mạng | Chưa rõ dữ liệu có bị mã hóa không; phải dò cấu trúc; cập nhật Zalo có thể làm hỏng |
| D. API không chính thức (ví dụ zca-js) | Đăng nhập bằng cookie Zalo Web, lấy lịch sử nhóm qua API nội bộ | Dữ liệu sạch, đầy đủ nhất | Vi phạm điều khoản Zalo, có rủi ro khóa tài khoản; không khuyên dùng với tài khoản cá nhân |

## Lộ trình đề xuất

Bắt đầu từ dữ liệu đã có, rồi mới thay bộ thu thập.

1. **Giai đoạn 1 (vài giờ):** xây MCP đọc thẳng folder export hiện có, nạp vào SQLite, gộp tin trùng. Có ngay lợi ích tìm kiếm và tổng hợp theo kỳ mà không đụng vào Zalo.
2. **Giai đoạn 2 (kiểm tra khoảng 15 phút):** thử xem Zalo PC có nhận cờ `--remote-debugging-port` không, và thư mục dữ liệu của Zalo PC có file SQLite hoặc LevelDB đọc được không. Kết quả quyết định chọn cách B hay C để thay exporter; lớp MCP giữ nguyên.

## Lưu ý thực tế

- MCP local chạy qua Claude Desktop, không dùng được trên claude.ai bản web.
- Đây là tin nhắn của người khác trong nhóm. Giữ dữ liệu gốc trên máy, chỉ đưa phần đã lọc cho Claude, và tiếp tục quy tắc không lưu số điện thoại cá nhân như skill bản tin hiện tại.
