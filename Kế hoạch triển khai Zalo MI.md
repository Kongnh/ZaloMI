# Kế hoạch triển khai Zalo MI

> **Cho người triển khai (kể cả agent):** dùng kèm `superpowers:subagent-driven-development` hoặc `superpowers:executing-plans` để làm từng task một. Các bước dùng checkbox (`- [ ]`) để theo dõi.

**Mục tiêu:** Xây CLI `zmi` (Node 24) đọc tin nhắn các nhóm Zalo từ Zalo PC vào một SQLite riêng, kèm file và ảnh có chữ, rồi một skill trong tab Code của Claude Desktop tạo bản tin market intelligence tiếng Việt khi được yêu cầu.

**Kiến trúc:** `zmi` nối vào Zalo PC qua Chrome DevTools Protocol (CDP), gọi bộ quản lý database của chính Zalo (đã mở khóa sẵn) bằng các hàm chỉ đọc. Dữ liệu chuẩn hóa vào `data/zalo-mi.db`; file và ảnh có chữ lưu ra đĩa. `zmi export` xuất bản đã lọc nhiễu và che số cá nhân cho skill đọc.

**Công nghệ:** Node 24.12 (`node:sqlite` = SQLite 3.50.4 có FTS5; `fetch` và `WebSocket` sẵn có cho CDP), PowerShell cho script khởi động, Claude Code skill (`SKILL.md`). Không dùng gói npm trừ khi một task ghi rõ lý do.

**Spec:** `Thiết kế hệ thống Zalo MI.md` (cùng thư mục). Đọc kèm: `Kết quả thử nghiệm đọc dữ liệu Zalo PC.md`.

## Global Constraints

- Node 24, không cài gói npm trừ khi task ghi rõ lý do (hiện mới dự kiến: một bộ giải mã JXL, một engine OCR — Task 7).
- **Chỉ đọc Zalo.** Mọi lời gọi vào Zalo đi qua một lớp bọc chỉ cho phép `getAll`, `get`, `getMulti`, `count`. Mọi tên hàm khác ném lỗi. Không bao giờ gọi `insert`, `put`, `update`, `delete`, không ghi vào Zalo, không gửi tin, không đánh dấu đã xem.
- Không đăng nhập Zalo bằng kênh riêng, không gọi API máy chủ Zalo.
- Tìm module nội bộ của Zalo **theo hình dạng** (object có `getInstance().Core.Message.getAll`), không hard-code tên `fsN4`.
- Cổng debug chỉ nghe `127.0.0.1:9222`.
- Đường dẫn cố định trên máy: Zalo cài ở `%LOCALAPPDATA%\Programs\Zalo\Zalo-<phiên bản>\`, dữ liệu ở `%APPDATA%\ZaloData\`, mã người dùng `1498602681856850483`.
- Database để nguyên văn. Che số điện thoại và email **chỉ ở phần chữ chat khi export**. Ảnh và PDF không che.
- Bản tin không ghi số điện thoại/email cá nhân; hotline hoặc email chung của tổ chức, sự kiện thì được.
- Thời gian lưu dạng mili giây (như Zalo); khi xuất đổi sang giờ Việt Nam (UTC+7).
- Tất cả văn bản cho người dùng (lỗi, README, bản tin) bằng tiếng Việt.

## Review Focus

Năm loại đầu vào hoặc tình huống spec ngụ ý nhưng dễ làm hỏng, mỗi dòng đã được gắn test vào task sở hữu nó:

- **Zalo chưa mở kèm cổng debug** khi chạy `zmi` → báo lỗi tiếng Việt rõ ràng, không ghi gì vào DB (Task 1).
- **Zalo cập nhật đổi tên module** → bước tìm module theo hình dạng vẫn tìm ra, hoặc `doctor` báo lỗi có hướng xử lý (Task 1).
- **Chạy `sync` hai lần** trên cùng dữ liệu → không nhân đôi tin, không nhân đôi file/ảnh (Task 5, 6, 7).
- **Số/văn bản không phải liên hệ cá nhân** (mã văn bản `1-BC-BCT-2026-760`, công suất `3.088 MW`, năm `2026`) → không bị che nhầm khi redact (Task 8).
- **Tin thu hồi/đã xóa và sticker/video** → không lọt vào bản tin nhưng vẫn lưu dấu trong DB (Task 3, 9).

---

## Cấu trúc file

```
Zalodatabase/
  zmi.mjs                      điểm vào CLI: doctor, groups, sync, images, export, search
  lib/
    cdp.mjs                    nối CDP, evaluate trong target "Zalo"
    zalo-bridge.mjs            tìm DB manager theo hình dạng + lớp bọc chỉ đọc + các hàm đọc nhóm/tin/media
    db.mjs                     mở SQLite, schema, upsert
    normalize.mjs              msgType → kind, parse từng loại tin
    files.mjs                  pipeline lưu file
    images.mjs                 JXL→JPEG + quét chữ (OCR)
    redact.mjs                 che số điện thoại/email
    export.mjs                 sinh thư mục exports/<lần chạy>/
  config/groups.json           nhóm theo dõi
  scripts/zalo-mi-launch.ps1   mở Zalo kèm cổng debug + tạo shortcut
  data/zalo-mi.db              database riêng (tạo khi chạy)
  data/files/<convId>/...
  data/images/<convId>/...
  exports/<lần chạy>/...
  test/                        test chạy bằng `node --test`
  README.md
C:\Users\kongn\.claude\skills\zalo-mi\SKILL.md
```

Test dùng runner có sẵn `node --test`. Test nào cần Zalo đang mở thì đánh dấu và bỏ qua được khi cổng đóng; test thuần (normalize, redact, db, export) chạy không cần Zalo, dùng dữ liệu mẫu đã che trong `test/fixtures/`.

---

### Task 1: Khung dự án, kết nối CDP, cầu nối chỉ đọc

**Files:**
- Create: `zmi.mjs`, `lib/cdp.mjs`, `lib/zalo-bridge.mjs`, `README.md`, `.gitignore`
- Test: `test/zalo-bridge.test.mjs`

**Interfaces:**
- Produces:
  - `lib/cdp.mjs`: `connect(title = 'Zalo') -> { evaluate(exprString) -> any, close() }` (ném lỗi nếu không có target hoặc cổng đóng).
  - `lib/zalo-bridge.mjs`: `openBridge() -> Bridge`; `Bridge.listGroups() -> [{convId, name, totalMember, isGroup}]`; `Bridge.getMessages(convId, {fromTs, limit}) -> rawMsg[]`; `Bridge.getMediaRows(convId, store) -> row[]` với `store ∈ {File, Link, Image}`; `Bridge.readOnlyGuard` chặn hàm ngoài danh sách. Bridge tự inject hàm bọc vào trang để mỗi lời gọi store chỉ chạy `getAll/get/getMulti/count`.

- [ ] **Step 1: `git init` và tạo `.gitignore`** (bỏ `data/`, `exports/`, `node_modules/`, `test/fixtures/raw/`).

- [ ] **Step 2: Viết test thất bại** `test/zalo-bridge.test.mjs`: test `readOnlyGuard rejects write methods` — gọi guard với `'insert'`, `'put'`, `'update'`, `'delete'` phải ném; với `'getAll'`, `'get'`, `'count'` không ném. (Test này thuần, không cần Zalo: tách hàm guard ra kiểm thử được.)

- [ ] **Step 3: Chạy test, xác nhận FAIL** — `node --test test/zalo-bridge.test.mjs`, lỗi "không tìm thấy module".

- [ ] **Step 4: Viết `lib/cdp.mjs`** — port lại `connect/evaluate/close` từ script thử nghiệm (`scratchpad/cdp.mjs`, `ev.mjs`): lấy `GET /json/list`, chọn `type=page` title `Zalo`, mở WebSocket, `Runtime.evaluate` với `awaitPromise`, `returnByValue`, `timeout 60000`.

- [ ] **Step 5: Viết `lib/zalo-bridge.mjs`** — `openBridge` dùng `cdp` để: (a) lấy webpack require qua `webpackJsonp.push([["x"],{x:(m,e,r)=>{window.__zmiReq=r}},[["x"]]])`; (b) tìm DB manager theo hình dạng (duyệt cache module tìm `exports.default.getInstance().Core.Message.getAll`, thử nhanh module quen trước); (c) định nghĩa trong trang một hàm đọc có `readOnlyGuard` (danh sách cho phép `getAll,get,getMulti,count`). `getMessages` dùng đúng truy vấn đã chạy trong thử nghiệm (range `[convId, fromTs||'', '']` → `[convId, '9999999999999999', '9223372036854775808']`, `index:'userId_sendDttm_msgId'`, `direction:'prev'`, `partition:convId`, `useLGKeyRange:true`), phân trang theo `limit` mặc định 2000.

- [ ] **Step 6: Chạy test, xác nhận PASS** — `node --test test/zalo-bridge.test.mjs`.

- [ ] **Step 7: Viết `zmi.mjs` với lệnh `doctor`** — kiểm tra: cổng mở, tìm được module, đọc thử 1 tin của nhóm bất kỳ, ghi thử rồi xóa một file tạm trong `data/`. In kết quả tiếng Việt từng mục ✓/✗. Khi cổng đóng, in hướng dẫn mở "Zalo (MI)" và thoát mã khác 0, không đụng DB.

- [ ] **Step 8: Chạy thật `node zmi.mjs doctor`** với Zalo đang mở kèm cổng debug — mọi mục ✓. Rồi tắt cổng (hoặc đổi port) chạy lại — in hướng dẫn, thoát ≠ 0.

- [ ] **Step 9: Commit** — `feat: CDP connect and read-only Zalo bridge with doctor`.

---

### Task 2: Schema và lớp upsert database

**Files:**
- Create: `lib/db.mjs`
- Test: `test/db.test.mjs`

**Interfaces:**
- Produces: `openDb(path) -> DB`; `DB.upsertGroup(g)`, `DB.upsertMessage(m)`, `DB.upsertLink(l)`, `DB.upsertFile(f)`, `DB.upsertImage(i)`, `DB.upsertMemberEvent(e)`, `DB.recordSyncRun(run)`, `DB.maxTs(convId) -> number`, `DB.search(q, {from,to,convIds}) -> row[]`, `DB.close()`. Upsert theo khóa chính (`msg_id`, `conv_id`), chạy lại không nhân đôi.

- [ ] **Step 1: Viết test thất bại** `test/db.test.mjs`:
  - `upsertMessage twice keeps one row` — upsert cùng `msg_id` hai lần, `count(*)` = 1, `updated_at` đổi.
  - `maxTs returns latest ts for a conv`.
  - `search is diacritic-insensitive` — chèn tin "Năng lượng tái tạo", `search('nang luong')` trả về nó.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/db.mjs`** — `openDb` bật `PRAGMA journal_mode=WAL`, tạo bảng theo mục 7 của spec (`groups, messages, links, files, images, member_events, sync_runs`) và FTS5 `messages_fts` với `tokenize='unicode61 remove_diacritics 2'` trên `text,title,description` cộng `ocr_text` của ảnh. Upsert bằng `INSERT ... ON CONFLICT(pk) DO UPDATE`. `search` join FTS, lọc `ts` và `conv_id`.

- [ ] **Step 4: Chạy test, xác nhận PASS.**

- [ ] **Step 5: Commit** — `feat: SQLite schema and idempotent upsert layer`.

---

### Task 3: Chuẩn hóa tin nhắn

**Files:**
- Create: `lib/normalize.mjs`
- Test: `test/normalize.test.mjs`, `test/fixtures/messages/*.json`

**Interfaces:**
- Consumes: rawMsg từ `Bridge.getMessages` (Task 1).
- Produces: `normalizeMessage(raw) -> {message, links[], files[], images[], memberEvents[]}` — mỗi phần khớp tham số upsert của Task 2. `classifyMemberEvent(text) -> 'joined'|'added'|'removed'|'promoted'|'other'`.

- [ ] **Step 0: Chuẩn bị fixtures** — từ dữ liệu thô đã có (`scratchpad/fev-full.json`), lấy mỗi loại một vài tin mẫu, **che số/email**, lưu vào `test/fixtures/messages/`. Gồm: text, text có quote+mentions, photo (type 2), link (type 6), file (type 19), member join/added/removed (type -4), recalled (20), deleted (-27), sticker (4), video (18).

- [ ] **Step 1: Viết test thất bại** `test/normalize.test.mjs` — với mỗi fixture, assert `kind` đúng và các trường chính: file lấy `file_name/ext/size/checksum/remote_url`; link lấy `url/domain/title`; photo lấy `caption/width/height/remote_url`; member event lấy `event` đúng và `member_uids`; recalled/deleted có `kind` nhưng `text` rỗng khi xuất.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/normalize.mjs`** — bảng ánh xạ `msgType → kind` theo mục 6.4 spec; parse `message` khi là chuỗi JSON (title/href/params…); `classifyMemberEvent` theo mẫu tiếng Việt ("đã tham gia", "được … thêm", "xóa khỏi", "bổ nhiệm"). Luôn giữ `raw_json` đã bỏ trường rỗng.

- [ ] **Step 4: Chạy test, xác nhận PASS.**

- [ ] **Step 5: Commit** — `feat: message normalization per msgType`.

---

### Task 4: Liệt kê và chọn nhóm theo dõi

**Files:**
- Create: `config/groups.json` (sinh khi chạy), bổ sung lệnh vào `zmi.mjs`
- Test: `test/groups.test.mjs`

**Interfaces:**
- Consumes: `Bridge.listGroups` (Task 1), `DB.upsertGroup` (Task 2).
- Produces: `suggestTracked(groups) -> {convId: boolean}` (đoán theo từ khóa tên nhóm); lệnh `zmi groups [--refresh]`.

- [ ] **Step 1: Viết test thất bại** `test/groups.test.mjs` — `suggestTracked` bật cho tên chứa năng lượng/solar/điện/gió/BESS/energy/RE/ESG/carbon/NLTT, tắt cho "SĂN SALE SHOPEE", "Cần Giờ Adventure", "Cơ Điện K5 Khoá 2007".

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `suggestTracked` + lệnh `zmi groups`** — đọc nhóm từ Zalo, upsert vào DB, ghi/cập nhật `config/groups.json` (`convId, name, tracked, note`), giữ nguyên lựa chọn `tracked` Cong đã sửa tay. In bảng: tên, số thành viên, trạng thái theo dõi.

- [ ] **Step 4: Chạy test (PASS) và chạy thật `node zmi.mjs groups`** — xem danh sách, chỉnh `config/groups.json` nếu cần.

- [ ] **Step 5: Commit** — `feat: group listing and tracked-group suggestion`.

---

### Task 5: Điều phối `zmi sync`

**Files:**
- Modify: `zmi.mjs`
- Create: `lib/sync.mjs`
- Test: `test/sync.test.mjs`

**Interfaces:**
- Consumes: Bridge (1), DB (2), normalize (3), config (4).
- Produces: `syncGroup(bridge, db, convId, {overlapDays=3, full=false}) -> {new, updated}`; lệnh `zmi sync [--full] [--groups a,b]`.

- [ ] **Step 1: Viết test thất bại** `test/sync.test.mjs` với một Bridge giả (trả fixtures): `syncGroup incremental uses maxTs minus overlap` — lần 2 chỉ xin tin từ `maxTs - overlap`; `running twice yields no new rows` — chạy hai lần, tổng tin không đổi.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/sync.mjs`** — `full` thì backfill toàn bộ (phân trang `direction:prev` tới hết); ngược lại từ `DB.maxTs(conv) - overlapDays`. Với mỗi tin: normalize → upsert trong một transaction cho mỗi nhóm. Cập nhật `groups.last_synced_at/last_msg_ts`. Một nhóm lỗi thì ghi vào `errors` rồi sang nhóm khác. Ghi `sync_runs`. Lệnh `zmi sync` lặp các nhóm `tracked`.

- [ ] **Step 4: Chạy test (PASS) và chạy thật `node zmi.mjs sync --full`** trên các nhóm theo dõi. Kiểm tra `sync_runs` và vài tin trong DB.

- [ ] **Step 5: Đối chiếu** — so nhóm Future Energy Vietnam giai đoạn 22/09–05/10/2026 trong DB với 31 tin của `zalo_Future-Energy-Vietnam_20261006-1454.md`: nội dung phải bao trùm. Ghi kết quả vào README.

- [ ] **Step 6: Commit** — `feat: zmi sync with backfill and incremental overlap`.

---

### Task 6: Lưu file đính kèm

**Files:**
- Create: `lib/files.mjs`
- Modify: `lib/sync.mjs` (gọi sau khi upsert tin file)
- Test: `test/files.test.mjs`

**Interfaces:**
- Produces: `resolveFile(fileRow, bridge) -> {status:'stored'|'remote_only'|'failed', stored_path?, error?}`; `remapLocalPath(p) -> p` (đổi `...\Local\ZaloPC\...\ZaloDownloads\` sang `%APPDATA%\ZaloData\media\<uid>\ZaloDownloads\`).

- [ ] **Step 0 (spike, ghi kết quả vào README):** thử tải một file `href` bằng `GET` thật; nếu lỗi, thử `$zdownload.sendDownloadRequest` qua bridge (đọc-ghi? — nếu nó kích hoạt tải về đĩa chứ không ghi DB thì chấp nhận; nếu không chắc, bỏ). Chốt cơ chế tải trước khi viết Step 3. Nếu không cơ chế nào chạy, phương án là `remote_only` + hướng dẫn Cong bật tự động tải file trong Zalo.

- [ ] **Step 1: Viết test thất bại** `test/files.test.mjs` — `remapLocalPath converts old ZaloPC root`; `resolveFile copies an existing local file and verifies md5` (dùng file tạm giả lập + checksum).

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/files.mjs`** — thứ tự: localPath của tin/Media.File (qua `remapLocalPath`) → cơ chế tải chốt ở Step 0 → `remote_only`. Chép vào `data/files/<convId>/<YYYY-MM-DD>_<tên gốc>`, so md5 nếu có `checksum`, bỏ qua file > 100 MB. Idempotent: file đã `stored` và còn tồn tại thì bỏ qua.

- [ ] **Step 4: Chạy test (PASS) và chạy thật** — sync lại, kiểm tra `data/files/` và cột `status` trong bảng `files`.

- [ ] **Step 5: Commit** — `feat: attachment file storage pipeline`.

---

### Task 7: Ảnh có chữ (`zmi images`)

**Files:**
- Create: `lib/images.mjs`
- Modify: `zmi.mjs`
- Test: `test/images.test.mjs`

**Interfaces:**
- Consumes: `remapLocalPath` (Task 6) để tìm ảnh trong cache Zalo.
- Produces: `shapeClass(w,h) -> 'phone_screenshot'|'desktop_screenshot'|'photo'`; `scanImages(db, {limit}) -> {scanned, withText}`; lệnh `zmi images [--limit N]`. `scanImages` đổi JXL→JPEG, chạy OCR, set `ocr_text/has_text/scanned_at/status`, chỉ chép file ảnh `has_text=1` vào `data/images/<convId>/<msgId>.jpg`.

- [ ] **Step 0 (spike, ghi kết quả vào README):** (a) đổi JXL→JPEG — thử `$znode.nativelibs.zjxl`/`libjxl.decodeToJpeg` qua bridge; nếu không được, một gói WASM JXL (ghi lý do khi thêm npm). (b) OCR tiếng Việt — thử `$znode.nativelibs.zocr`, rồi `Windows.Media.Ocr` (cần gói ngôn ngữ VI), rồi Tesseract. Chốt một đường cho mỗi phần trên khoảng 10 ảnh mẫu (có poster, bảng giá, ảnh người) trước khi viết Step 3.

- [ ] **Step 1: Viết test thất bại** `test/images.test.mjs` — `shapeClass`: ảnh 1080×2340 → `phone_screenshot`, 1920×1080 → `desktop_screenshot`, 1200×1000 → `photo`. `hasText threshold`: chuỗi OCR nhiều chữ → `has_text=1`, chuỗi rỗng/vài ký tự → `0`.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/images.mjs`** — `shapeClass` theo spec; `scanImages` chạy tăng dần (chỉ ảnh `scanned_at` null), có `--limit`, ưu tiên `shape_class` screenshot và ảnh mới; lấy ảnh nguồn từ cache (qua `remapLocalPath`) rồi `hdUrl`; đổi định dạng; OCR; ghi DB; ảnh không nguồn → `status='unavailable'`. Chỉ chép ảnh `has_text=1`.

- [ ] **Step 4: Chạy test (PASS) và chạy thật `node zmi.mjs images --limit 300`** — kiểm tra `data/images/` có poster/bảng giá, bỏ ảnh người.

- [ ] **Step 5: Kiểm thử mẫu** — chọn tay ~50 ảnh thật của nhóm thử, so `has_text` của hệ thống với nhãn tay: không bỏ sót poster sự kiện nào trong mẫu. Ghi kết quả vào README.

- [ ] **Step 6: Commit** — `feat: image text scan and JXL conversion`.

---

### Task 8: Che số điện thoại và email

**Files:**
- Create: `lib/redact.mjs`
- Test: `test/redact.test.mjs`

**Interfaces:**
- Produces: `redact(text) -> text` thay số điện thoại VN/quốc tế bằng `[SĐT]`, email bằng `[email]`.

- [ ] **Step 1: Viết test thất bại** `test/redact.test.mjs` — **che**: `0963046382`, `0963.046.382`, `0963 046 382`, `+84 963 046 382`, `thuduyen.vcci@gmail.com`. **không che**: `1-BC-BCT-2026-760`, `3.088 MW`, `2026`, `TT 05/2025/TT-BCT`, `10,7 GW`.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/redact.mjs`** — regex neo theo đầu số di động VN và tiền tố `+84`/`0`, yêu cầu đủ 9–10 chữ số liền (cho phép dấu cách/chấm giữa), tránh chuỗi có chữ cái hoặc dấu gạch kiểu mã văn bản; email theo mẫu chuẩn.

- [ ] **Step 4: Chạy test, xác nhận PASS.**

- [ ] **Step 5: Commit** — `feat: phone/email redaction for exports`.

---

### Task 9: `zmi export` và `zmi search`

**Files:**
- Create: `lib/export.mjs`
- Modify: `zmi.mjs`
- Test: `test/export.test.mjs`

**Interfaces:**
- Consumes: DB (2), redact (8).
- Produces: `exportRange(db, {from, to, convIds, out}) -> dir`; lệnh `zmi export [--from --to --groups --out]` và `zmi search "<kw>" [--from --to --groups]`.

- [ ] **Step 1: Viết test thất bại** `test/export.test.mjs` (dùng DB mẫu trong bộ nhớ): `export omits recalled/deleted/sticker`; `export redacts phone in chat text`; `index.md warns when latest sync > 24h old`; `per-group file lines carry #m<msgId>`.

- [ ] **Step 2: Chạy test, xác nhận FAIL.**

- [ ] **Step 3: Viết `lib/export.mjs`** — sinh `exports/<YYYYMMDD-HHmm>/`: `index.md`, `<tên-nhóm>.md` (gom theo ngày, dòng `[HH:mm] Người gửi: nội dung #m<id>`, các dòng `[File]/[Ảnh có chữ]/[Ảnh]/[Link]/[Thành viên]` theo spec mục 8), `members.md`, `attachments.md`. Lọc nhiễu (bỏ recalled/deleted/sticker/video và tin chào-cảm ơn < ~15 ký tự không có link/file), đổi giờ UTC+7, che chữ chat bằng `redact`. `zmi search` in kết quả `DB.search`.

- [ ] **Step 4: Chạy test (PASS) và chạy thật `node zmi.mjs export --from ... --to ...`** — mở `exports/<lần chạy>/` kiểm tra.

- [ ] **Step 5: Commit** — `feat: zmi export and search`.

---

### Task 10: Script khởi động Zalo

**Files:**
- Create: `scripts/zalo-mi-launch.ps1`
- Test: kiểm tra tay (ghi các bước vào README)

- [ ] **Step 1: Viết `scripts/zalo-mi-launch.ps1`** — tìm thư mục `Zalo-<phiên bản>` mới nhất; nếu Zalo đang chạy không có cổng debug thì in hướng dẫn thoát hẳn Zalo (không tự kill); mở `Zalo.exe` kèm `--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222`; chờ `GET /json/version` tới khi mở; tạo shortcut Desktop "Zalo (MI)" nếu chưa có. Thông báo tiếng Việt.

- [ ] **Step 2: Chạy thật** — thoát Zalo, chạy script, xác nhận cổng mở và `node zmi.mjs doctor` chạy được qua script này.

- [ ] **Step 3: Commit** — `feat: launch script for Zalo debug mode`.

---

### Task 11: Skill `zalo-mi`

**Files:**
- Create: `C:\Users\kongn\.claude\skills\zalo-mi\SKILL.md`
- Modify: `README.md` (hướng dẫn cài skill, nhắc tắt `zalo-energy-mi-digest` cũ)

- [ ] **Step 1: Viết `SKILL.md`** — frontmatter `name: zalo-mi`, `description` nêu rõ: tổng hợp market intelligence từ **database Zalo trên máy**, kích hoạt khi Cong nhờ tổng hợp/cập nhật/bản tin từ các nhóm Zalo (kể cả không nói "skill"); ghi rõ chỉ chạy trong tab Code. Thân skill theo mục 9.3 spec: hiểu yêu cầu (mặc định 14 ngày, nhóm theo dõi) → `zmi sync` rồi `zmi images` → `zmi export` → đọc theo nhóm (subagent cho nhóm lớn) → mở ảnh/PDF liên quan → tổng hợp gộp trùng → viết bản tin theo khung mục 9.4 → lưu `C:\Users\kongn\Downloads\Zalo_MI_Report_<từ>_den_<đến>.md` → trả đường dẫn + 5–7 ý chính. Dặn: không ghi số/email cá nhân; đánh dấu "(Nhận định)" cho ý của Claude; nếu Zalo chưa mở chế độ thu thập thì hỏi một lần dùng dữ liệu cũ (ghi ngày) hay chờ.

- [ ] **Step 2: Chạy thử đầu-cuối** — trong tab Code, nhờ "tổng hợp các nhóm năng lượng 14 ngày qua". Kiểm tra bản tin có dẫn nguồn, có mục người mới và sự kiện, không có số cá nhân.

- [ ] **Step 3: Cong đọc và xác nhận** bản tin dùng được. Ghi chú chỉnh sửa (nếu có) rồi sửa `SKILL.md`.

- [ ] **Step 4: Commit** — `feat: zalo-mi skill for on-demand MI report`.

---

## Thứ tự và phụ thuộc

1 → 2, 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Task 7 dùng `remapLocalPath` của Task 6 nên 6 trước 7. Task 10 độc lập, có thể làm sớm nếu tiện. Mỗi task kết thúc bằng một deliverable chạy và test được riêng.
