---
name: zalo-chat-report
description: Summarise Cong's Zalo conversation with ONE client or partner (a 1-1 chat or a client group) into a markdown report saved in the matching Allotrope workstream folder, reading the chat on demand from the local Zalo PC app with `zmi chat` (nothing stored in the zmi database). Saves every shared file and every screenshot with text into the workstream's "Zalo files" folder and reads them (not ordinary photos, not scanned files). Use when Cong asks things like "tổng hợp chat Zalo với anh Nam bên GreenPower", "đọc tin Zalo với khách X để làm báo cáo", "tóm tắt trao đổi Zalo với Y từ tháng 9", "lấy file khách gửi qua Zalo về folder GAP". Code tab only (runs local commands). Not for the market-intel digest of tracked energy groups: that is zalo-mi.
---

# Zalo chat report

Cong wants to turn his Zalo exchanges with a client into a report that only he reads. The report's content follows his prompt each time; there is no fixed template. Output is a markdown file in the workstream folder.

- Project: `C:\Users\kongn\Pictures\CodeProject\Zalodatabase` (README.md, section "Đọc một chat theo yêu cầu")
- CLI: `node C:\Users\kongn\Pictures\CodeProject\Zalodatabase\zmi.mjs chat find|read …`
- Workstreams: `C:\Users\kongn\OneDrive\Máy tính\Allotrope\2026\NN. <name>\` (see the root CLAUDE.md map). Follow that workstream's own CLAUDE.md as well.

## Hard rules

1. **Only the chat Cong named, only when he asks.** Never read other chats "for context", never loop over chats.
2. **Never store the chat text.** Do not redirect `zmi chat read` output to a file, do not run `zmi sync`/`export` for it, do not paste the raw chat into any file. The report (a synthesis) is the only file written, plus the files and screenshots `--save-to` copies.
3. **Read only.** Use only `zmi chat find`, `zmi chat read`, the launch script and `scripts/read-pdf.py`. Never send anything on Zalo.
4. **No Zalo ids in the report** (the chat id is for commands only). Phone numbers and e-mails may appear (Cong's choice: the report is for him), but do not add them unless they matter.
5. **Cite** chat facts as `(dd/mm/yyyy, Người gửi, #m<mã>)`; mark Claude's own judgement "(Nhận định)". Follow the shared conventions: no em dashes, dates DD/MM/YYYY, times ICT, facts apart from views ([S] for what was said in the chat, [F] for a document opened from it, [H] for Claude).

## Steps

### 1. Understand the request

Get, from Cong's words or by asking once (all missing items in one question):
- **Who**: client/person/company name (what Cong calls them in Zalo).
- **Workstream folder** it belongs to. If unclear, propose the most likely `2026\NN. …` folder from the client name and ask.
- **Period**: default the whole history on the PC; turn "từ tháng 9" etc. into `--from/--to YYYY-MM-DD`.
- **What the report should cover**: his prompt. If he gave none, ask what he needs it for.

### 2. Make sure Zalo is open in collection mode

`zmi chat` needs it. If a command exits 1 with the message about opening "Zalo (MI)", run `powershell -ExecutionPolicy Bypass -File C:\Users\kongn\Pictures\CodeProject\Zalodatabase\scripts\zalo-mi-launch.ps1`. Exit 0: retry. Exit 2 (Zalo running without the debug port) or anything else: tell Cong to quit Zalo and open the "Zalo (MI)" shortcut, and wait.

### 3. Find the chat and get Cong's confirmation

`node …\zmi.mjs chat find "<name>"` prints `<id> | 1-1/nhóm | name (tên Zalo) | tin cuối …`, newest first. The first search covers contacts and group names; with no match it searches people not in the contact list (slower, says so).

Show Cong the candidates **without the ids** (type, name, last message date) and ask which one, even when there is a single match. Read nothing until he confirms. If nothing matches, try a shorter or unaccented name, then ask him for the name as it shows in his Zalo.

### 4. Read the chat page by page

```
node …\zmi.mjs chat read <id> [--from YYYY-MM-DD] [--to YYYY-MM-DD] --save-to "<workstream>\Zalo files\<client name>" [--page N]
```

- Always pass `--save-to` with an absolute path; the folder name is the client name as Cong says it (Vietnamese is fine, no `<>:"/\|?*`). The command creates it.
- Each page is about 20,000 characters. The last lines say `Trang i/n`; run every page (`--page 2`, `--page 3`, …) in order. Files and screenshots are copied only for the page being read, so every page must be run once with `--save-to`.
- Line format: `[HH:mm] Sender: (trả lời "…") content #m<id>` under `## YYYY-MM-DD (thứ)` headers. `[File] name (size) → <path>` or `→ chưa lưu được (reason)`; `[Ảnh có chữ] caption | OCR excerpt → <path>`; `[Ảnh chụp màn hình, không có chữ]`; `[Ảnh]` = ordinary photo (not read, by Cong's rule); `[Link] title — domain | description`.
- For a long chat (many pages), keep short running notes per page in your head/context rather than re-reading pages; if it exceeds ~10 pages, tell Cong the size and suggest narrowing the period before reading everything.

### 5. Read the files and screenshots

Open what bears on the report, usually all documents and screenshots with text:
- Screenshots: the Read tool on the saved `.jpg/.png`.
- PDFs: `python -E C:\Users\kongn\Pictures\CodeProject\Zalodatabase\scripts\read-pdf.py "<file.pdf>" --pages 1-5 --out <scratchpad>` from the project folder. If it reports a **scanned** page (it renders a PNG instead of text), do not read it: Cong's rule is no scanned files. List it as "file scan, chưa đọc".
- Word/Excel/PowerPoint: use the docx/xlsx/pptx skills' reading methods.
- Ordinary photos (`[Ảnh]`) and photos sent as image files (`.jpg/.png` in a `[File]` line that are camera photos): do not read.
- Files `chưa lưu được` (link expired, not on this PC): list them with the reason; suggest Cong open the chat on his phone if one matters.

### 6. Write the report

- Vietnamese by default (English if Cong asks or the client content is English), plain and short, bullets and tables.
- Structure follows Cong's prompt. When he gave little guidance, a sensible default is: tóm tắt; diễn biến theo mốc thời gian; các điểm đã thống nhất / còn mở; số liệu và tài liệu khách gửi; việc cần làm (ai, khi nào); nhận định.
- Header: client, chat type (1-1/nhóm), period actually covered (first and last message date), date written, "Người lập: Cong Nguyen (soạn với Claude)", and a scope line: number of messages, files read, screenshots read, files not saved or not read (scans, expired links).
- Section "Tài liệu từ chat": each file with date, sender and its path under `Zalo files\…`.
- Save to `<workstream>\Zalo_<client-short-name>_<YYYY-MM-DD from>_den_<YYYY-MM-DD to>.md`; if it exists, add `_v2`, `_v3`… Never overwrite.
- If the workstream keeps `session-log.md`, add the session entry its CLAUDE.md asks for (status only, English from 09/11/2026).

### 7. Reply to Cong

The report path, the `Zalo files\…` folder and how many files/screenshots were saved, 3 to 5 key points, and anything that limited the report (expired links, scans not read, pages skipped).
