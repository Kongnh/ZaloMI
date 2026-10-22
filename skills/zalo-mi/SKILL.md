---
name: zalo-mi
description: Build Cong's Vietnamese market-intelligence report (bản tin MI) from the LOCAL Zalo database on this machine (Zalodatabase project, `zmi` CLI reading Zalo PC), not from manual zalo_*.md exports. Use whenever Cong asks to summarise, update, catch up on or report what happened in his Zalo energy groups — e.g. "có gì mới trong các nhóm năng lượng tuần này", "tổng hợp Zalo 2 tuần qua", "bản tin Zalo", "ai mới vào nhóm đáng chú ý", "giá tấm pin trong nhóm Zalo dạo này" — even if he doesn't say "skill" or "MI". Code tab only (it runs local commands and reads local files). Replaces the older zalo-energy-mi-digest skill.
---

# Zalo MI report

Cong (Allotrope Partners Vietnam) is in many Zalo renewable-energy groups and has no time to follow them. The `zmi` tool keeps a private SQLite copy of the tracked groups. This skill turns a period of it into a Vietnamese MI report: policy, projects, prices, technical info, events, notable new members for BD, shared files and links.

- Project: `C:\Users\kongn\Pictures\CodeProject\Zalodatabase` (README.md documents every command)
- CLI: `node C:\Users\kongn\Pictures\CodeProject\Zalodatabase\zmi.mjs <command>`. Run it from any folder; it finds its own data.
- Style reference: `C:\Users\kongn\Downloads\PEWG_MI_Report_2026-06-06_den_2026-10-05.md`. Skim its first ~60 lines once per run for tone and layout.

## Hard rules

1. **Read only.** Use only `zmi groups --refresh`, `zmi sync`, `zmi export`, `zmi search`, the launch script and `scripts/read-pdf.py` (below). Never read `data/zalo-mi.db` directly, never edit `config/groups.json`, never run `--full`, `--retry`, `--rescan` or `--prune-photos` (the last one deletes files). Never send anything on Zalo.
2. **No personal phone numbers or e-mails in the report**, in the chat reply, or in anything a subagent returns. Chat text in the export is already masked (`[SĐT]`, `[email]`), but **OCR text from images and file contents are not**. Organisation or event hotlines (1900/1800, an organiser's switchboard) and generic addresses (info@, contact@, ban tổ chức) are fine. When unsure whether a number is personal, leave it out and write "liên hệ người đăng trong nhóm".
3. **No Zalo user ids** anywhere.
4. **Cite every item**: `(Nhóm, dd/mm, Người gửi, #m<mã tin>)`. Group names may be shortened to something recognisable.
5. **Mark Claude's own judgement** with "(Nhận định)", like the PEWG report. Facts from the groups are not verified: prices and market figures always carry "tin trong nhóm, chưa kiểm chứng".

## Steps

### 1. Understand the request

- Period: default the last 14 days ending now. "Tuần này" = since Monday; "tháng 10" = 2026-10-01 to 2026-10-31; any explicit dates win. Turn it into `--from YYYY-MM-DD --to YYYY-MM-DD` (Vietnam dates, `--to` inclusive); no flags = last 14 days.
- Groups: default all tracked groups. If Cong names groups, run `node …\zmi.mjs groups` to find their convIds and pass `--groups id1,id2`.
- Topics to stress: note any Cong mentions (e.g. "tập trung BESS", "giá inverter").
- A narrow question ("ai nói gì về DPPA tuần này?") does not need the whole report: answer it with `zmi search` (step 3b) and offer the full report.

### 2. Sync

First run `node …\zmi.mjs groups --refresh` (needs Zalo in collection mode, like sync; it reads only). It picks up groups Cong joined since the last run.
- A new group whose name matches the energy keywords (năng lượng, solar, điện, gió, BESS, DPPA, ESG, carbon…) is set to tracked automatically. The next sync reads its whole history.
- A new group that does not match stays untracked. Groups Cong set by hand are never changed.
- The first output line says how many groups are new and how many were suggested. In the reply to Cong, name the new tracked groups and the new untracked ones whose name still looks business-related, so he can switch them on or off in `config/groups.json`. Never edit that file yourself.

Then run `node …\zmi.mjs sync` (in the background; it can take several minutes because it also saves new attachments and scans new screenshots at the end). Print nothing to Cong but a one-line status while it runs.

- **Exit 0**: continue.
- **Zalo not open in collection mode** (exit 1 with the message about opening "Zalo (MI)"): run `powershell -ExecutionPolicy Bypass -File C:\Users\kongn\Pictures\CodeProject\Zalodatabase\scripts\zalo-mi-launch.ps1`. It never closes a running Zalo.
  - Exit 0: Zalo is ready; run sync again.
  - Exit 2 (Zalo running without the debug port) or any other failure: tell Cong, and ask **once**: use the data from the last sync (give its date, from `index.md` after a quick export) or wait while he quits Zalo and opens "Zalo (MI)". Do what he picks.
- Group errors at the end of sync (exit 1 with per-group errors): continue, and list the failed groups in the report's scope box.
- If the last successful sync before today was more than 7 days ago, tell Cong that shared files and images older than ~2 weeks may be lost for good (Zalo's download links expire), and suggest syncing at least weekly.

### 3. Export

Run `node …\zmi.mjs export [--from … --to …] [--groups …]`. **The last line of stdout is the export folder.** Read `index.md` there first: period, last sync (and any staleness warning), one row per group with message count and file name, the line format, and what was filtered out.

Line format in group files: `[HH:mm] Người gửi: nội dung #m<mã tin>` under `## YYYY-MM-DD (thứ)` day headers. `[File] … → <path>` or `→ chỉ có link`; `[Ảnh có chữ] caption | OCR excerpt → <path>`; `[Ảnh]`; `[Link] title — domain | description`; `[Thành viên] …`; `(đăng lại tin #m…)` = word-for-word repost of an earlier message in the same group.

### 3b. Search when you need more

`node …\zmi.mjs search "từ khóa" [--from … --to …] [--groups …] [--limit N]` — accent-insensitive full text (message text, link titles, file names, OCR text), newest first. Use it to follow a thread across groups, find earlier context for a policy or project, or check whether something was discussed before the period (drop `--from`).

### 4. Read the groups

**Triage by cost before reading.** Reading costs about 130k tokens per 100 KB of export, through subagents. A large group that is mostly product ads is not worth that: in the first run, the 965 KB TỔNG KHO group cost about 1.2M tokens and yielded only prices that other groups also had. For every group file, measure its size and its *signal density*: the share of message lines that mention policy, projects or events. In Git Bash, from the export folder:

```bash
for f in *.md; do case $f in index.md|members.md|attachments.md) continue;; esac; t=$(grep -c "^\[" "$f"); s=$(grep -ciE "nghị định|thông tư|công văn|quyết định|dự thảo|nghị quyết|DPPA|dự án|[0-9] ?MW\b|hội thảo|diễn đàn|khung giá|quy hoạch|EVN|Bộ Công Thương|luật" "$f"); echo "$(( $(wc -c <"$f")/1024 )) KB | $t dòng | tín hiệu $(( t>0 ? 100*s/t : 0 ))% | $f"; done
```

(First run, for reference: news and policy groups had 20–26% signal, DOANH NHÂN SOLAR 3%, TỔNG KHO 1%.)

- **Over 150 KB and signal under 5%**: do not read the group in full. Take the cheap path:
  - Pull only the lines that matter: the signal pattern above plus lines that carry an actual price number. A bare "giá" matches every ad ("giá tốt"), so it is not in the pattern.

    ```bash
    P='nghị định|thông tư|công văn|quyết định|dự thảo|nghị quyết|DPPA|dự án|[0-9] ?MW\b|hội thảo|diễn đàn|khung giá|quy hoạch|EVN|Bộ Công Thương|luật|[0-9][.,]?[0-9x]{2,3} ?(đ|đồng|vnđ|k)? ?/ ?w|đ/kwh|[0-9]+([.,][0-9x]+)? ?(triệu|tr)\b'
    grep -iE "$P" "<file>" | grep -v "đăng lại tin" > "<scratchpad>/<group>-signal.txt"
    ```

  - On TỔNG KHO this kept 92 KB of 965 KB.
  - Read the result yourself if it is under ~60 KB. Otherwise give it to one `model: "sonnet"` subagent with the normal extraction prompt.
  - Say in the report's scope box that the group was only scanned by keyword, and why (size, signal %).
  - If even the keyword lines are just ads with no price or news, skip the group and say so in the same place.
- Cong may override this in his request, e.g. "đọc kỹ cả nhóm TỔNG KHO". His words win.
- Everything else goes to the normal path below.

- **Files up to ~60 KB**: read them yourself.
- **Bigger files**: hand them to subagents (Agent tool, general-purpose), all in parallel in one message. Use `model: "sonnet"` for the sales-heavy chunks: they only yield prices and product lists. The first run spent about 130k tokens per 100 KB chunk, and TỔNG KHO alone took 9 chunks. Split files over ~120 KB into chunks of about 100 KB at day headers (`grep -n "^## " <file>` gives the line numbers) and give each subagent a line range. Sales-heavy groups (TỔNG KHO, ĐỘI THI CÔNG, DOANH NHÂN SOLAR…) are mostly product ads: tell the subagent to keep only price points, new products/brands, projects and real news.

Subagent prompt (fill in the brackets; the subagent starts cold, so include the rules):

> Read `[path]` lines [a]–[b] with the Read tool (offset/limit). It is a Zalo group export, group "[name]", one message per line: `[HH:mm] Sender: content #m<id>` under `## YYYY-MM-DD` day headers. Extract only items useful for a Vietnamese renewable-energy market-intelligence report for Allotrope Partners: policy and regulation (new documents, drafts, comment deadlines), projects and deals (developer, EPC, size, location, status), equipment prices and market figures (panel, inverter, BESS, cable, electricity price: give the number, unit, date and seller type), notable technical info, events and trainings (name, date, place, organiser, how to register), shared files and links worth reading, and people introducing themselves with a company/role. Skip greetings, chit-chat and repetitive product ads (but keep each distinct price point once). For each item return one line: `category | Vietnamese summary (1-2 sentences, keep numbers exact) | YYYY-MM-DD | sender | #m ids | attachment path or URL if any | importance 1-3`. Then list up to 5 `[Ảnh có chữ]`/`[File]` paths that look worth opening (policy documents, price tables, event posters), with one line on why. NEVER output a personal phone number or e-mail address, even from OCR text; organisation hotlines and generic addresses are fine. Do not invent anything not in the lines.

### 5. Look at attachments selectively

From the group files, `attachments.md` and the subagents' picks, open only what bears on policy, prices, projects or events. Usually 5–15 items, not everything. A file marked `chỉ có link` is not on the machine: just list it.

- Screenshots: the Read tool (it shows images).
- PDFs: run `python -E C:\Users\kongn\Pictures\CodeProject\Zalodatabase\scripts\read-pdf.py "<file.pdf>" --pages 1-3 --out <scratchpad>` from the project folder.
  - It prints the text layer with correct Vietnamese diacritics (PyMuPDF).
  - For a scanned page it renders a PNG and prints its path instead; open that PNG with Read.
  - Do not use Read's `pages` on PDFs (no `pdftoppm` on this machine), and avoid `pdftotext`: it garbles the diacritics of many government PDFs.
  - Use `-E`, not `-I`: `-I` hides the user-site PyMuPDF.
- Write down in the report's scope box which documents were opened in full and which were not.

### 6. New members

Read `members.md`. Someone is notable for BD when their intro or messages show a role or company relevant to Allotrope (developers, EPCs, IPPs, industrial-park operators, large C&I energy users, banks/DFIs, BESS suppliers, consultancies, government/associations). Record name, role and company as stated publicly in the group, which group, who added them, and why it matters (Nhận định). Use `zmi search` with their name to find later messages. No phone numbers or e-mails.

### 7. Synthesise

- Merge duplicates: the same news is often posted in several groups — one item, all sources cited.
- Rank by importance to Allotrope (DPPA/CEBA, rooftop solar and BESS for C&I, industrial parks/VIDA, carbon/ESG, JETP/finance, offshore wind are the usual priorities).
- Where an item looks like a rumour or ad, say so.

### 8. Write the report

Vietnamese, clear and plain, short sentences, bullets and tables like the PEWG report. Structure:

```
# Bản tin Market Intelligence từ các nhóm Zalo năng lượng

**Nguồn:** <N> nhóm Zalo đang theo dõi (database Zalo trên máy, sync lúc <dd/mm/yyyy HH:mm>)
**Kỳ báo cáo:** dd/mm/yyyy đến dd/mm/yyyy
**Ngày lập:** dd/mm/yyyy
**Người lập:** Cong Nguyen (soạn với Claude)

> **Phạm vi và giới hạn**
> - Tin trong nhóm Zalo, chưa kiểm chứng; phần "(Nhận định)" là ý kiến của người lập.
> - <stale-data warning, failed groups, files only as links, anything not read>

## 1. Tóm tắt điều hành          (5–10 numbered points, most important first)
## 2. Chính sách và quy định     (văn bản mới, dự thảo, hạn góp ý; table if many)
## 3. Dự án và giao dịch         (table: Ngày | Dự án / Giao dịch | Bên liên quan | Quy mô | Ghi chú | Nguồn)
## 4. Giá thiết bị và số liệu thị trường  (table: Hạng mục | Giá / Số liệu | Ngày | Nguồn; "tin trong nhóm, chưa kiểm chứng")
## 5. Thông tin kỹ thuật đáng chú ý
## 6. Sự kiện và hội thảo        (table: Ngày | Sự kiện | Nơi | Đơn vị tổ chức | Đăng ký (link/hotline chung) | Nguồn)
## 7. Người mới đáng chú ý cho BD (table: Tên | Chức danh, công ty | Nhóm | Ai giới thiệu | Vì sao đáng chú ý (Nhận định))
## 8. Tài liệu và file được chia sẻ (tên file, nhóm, ngày, đường dẫn trên máy hoặc "chỉ có link")
## 9. Link bài viết đáng đọc
## 10. Hàm ý cho Allotrope và việc nên làm (ngắn, (Nhận định))
## 11. Phụ lục: các nhóm đã đọc  (table: Nhóm | Số tin trong kỳ | Ghi chú; then sync time and export folder)

*Hết bản tin.*
```

Drop a section that has nothing and say "Không có tin đáng chú ý trong kỳ." instead of padding. File paths in section 8 are absolute Windows paths from the export.

Always save to `C:\Users\kongn\OneDrive\Máy tính\New Topic\00. Market intel\Zalo_MI_Report_<YYYY-MM-DD from>_den_<YYYY-MM-DD to>.md` (Cong's choice; the folder syncs through OneDrive). If that file exists, add `_v2`, `_v3`… rather than overwriting. If the folder is missing, create it (only it, not other parts of OneDrive).

**Before saving, check for leaks**: search the draft for phone-like digit runs (`0` + 8–10 digits with optional spaces/dots, `+84…`) and `@`. Remove any that are personal.

### 9. Reply to Cong

The saved file path, then 5–7 key points in Vietnamese (one line each), then anything that limited the report (stale data, failed groups, attachments that could not be opened). Keep it short; the report holds the detail.
