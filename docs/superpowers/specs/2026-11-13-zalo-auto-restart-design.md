# Skill tự mở cổng debug của Zalo (tự khởi động lại Zalo)

13/11/2026 · bản thiết kế ngắn

## Mục đích

Cong không muốn mỗi lần nhờ làm bản tin (`zalo-mi`) hay báo cáo chat (`zalo-chat-report`) lại phải tự thoát Zalo rồi bấm "Zalo (MI)". Skill phải tự lo phần đó.

Hiện tại `scripts/zalo-mi-launch.ps1` đã tự mở Zalo kèm cổng khi Zalo đang tắt. Nhưng Zalo tự khởi động cùng Windows (mục Run `Zalo` → `%LOCALAPPDATA%\Programs\Zalo\Zalo.exe`), nên gần như lúc nào Zalo cũng đang chạy ở chế độ thường. Khi đó script dừng ở mã 2 và chờ Cong.

## Mục tiêu, không làm, không được xảy ra

- **Mục tiêu:** một lần chạy skill, không có bước tay nào. Zalo đang mở thường thì skill tự khởi động lại Zalo kèm cổng. Zalo bản debug cứ chạy tiếp tới khi Cong tắt máy; lần chạy skill sau trong cùng phiên thấy cổng đã mở nên không khởi động lại nữa.
- **Không làm:** trả Zalo về chế độ thường sau khi đọc (Cong thấy tốn thời gian, không cần); đổi cách Zalo khởi động cùng Windows (bật máy lại thì Zalo về chế độ thường, cổng đóng); phát hiện cuộc gọi đang diễn ra (Cong đã chấp nhận rủi ro bị ngắt).
- **Không được xảy ra:** sau khi chạy skill mà Zalo bị tắt hẳn; đăng xuất Zalo; đụng vào dữ liệu Zalo.

## Ràng buộc

- Khi chưa có cổng debug, không có cách thoát Zalo êm từ script (nút X chỉ thu xuống khay). Phải buộc dừng (`Stop-Process -Force` mọi tiến trình `Zalo`). SQLCipher/SQLite chịu được dừng đột ngột; tin trong khoảng gián đoạn được Zalo đồng bộ lại, và `sync` đã đọc lùi 3 ngày (`overlapDays`) nên không sót.
- Lối tắt "Zalo (MI)" và cách chạy script bằng tay giữ nguyên hành vi cũ (không tự tắt Zalo).
- Cổng debug mở suốt phần còn lại của phiên làm việc (tới khi tắt máy hoặc thoát Zalo). Cong đã chấp nhận.

## Các hướng đã cân nhắc

| Hướng | Đánh đổi | Chọn? |
| --- | --- | --- |
| Tự khởi động lại, không hỏi, để bản debug chạy tới hết phiên | Không bước tay nào, chỉ khởi động lại một lần mỗi phiên; có thể ngắt cuộc gọi, tin đang gõ, file đang gửi; cổng mở tới khi tắt máy | **Có, Cong chọn** |
| Như trên nhưng đọc xong thì trả Zalo về chế độ thường | Cổng chỉ mở lúc đọc; mỗi lần chạy khởi động lại Zalo hai lần | Không, Cong thấy tốn thời gian |
| Hỏi một câu trong chat trước khi khởi động lại | An toàn hơn, thêm một cú bấm | Không |
| Để Zalo luôn mở kèm cổng từ lúc bật máy | Không phải khởi động lại lần nào; cổng mở cả những ngày không dùng | Không |

## Thiết kế

1. **`zalo-mi-launch.ps1 -Restart`** (chỉ skill dùng). Như cũ, cộng thêm: ở trạng thái "Zalo đang chạy không có cổng" (trước đây mã 2), buộc dừng mọi tiến trình `Zalo`, chờ hết (tối đa 15 giây; quá thì mã thoát mới 6), rồi mở Zalo kèm cổng như trạng thái 3 và chờ cửa sổ "Zalo". In một dòng cho biết đã khởi động lại. Các trạng thái khác giữ nguyên (đã có cổng: báo sẵn sàng, không đụng gì).
2. **Hai skill** (`skills/zalo-mi/SKILL.md`, `skills/zalo-chat-report/SKILL.md`, rồi chép sang bản đã cài trong `~/.claude/skills/`): khi lệnh cần Zalo báo chưa có cổng, chạy launch script với `-Restart`, báo Cong một dòng "đang khởi động lại Zalo ở chế độ thu thập (~20 giây), Zalo sẽ ở chế độ này tới khi tắt máy", rồi chạy lại lệnh. Bỏ đoạn "hỏi Cong / bảo Cong thoát Zalo". Mã khác 0 vẫn báo Cong như hiện nay.
3. **README:** cập nhật phần script khởi động (cờ `-Restart`, mã thoát 6) và danh sách kiểm tra tay.

## Để người làm tự quyết

- Cách chờ tiến trình thoát; có in số tiến trình đã dừng hay không.
- Kiểm tra: phần PowerShell kiểm tra tay như các script hiện có (thêm mục cho `-Restart`), cộng `-DryRun -Restart` mô tả việc sẽ làm mà không tắt gì.
