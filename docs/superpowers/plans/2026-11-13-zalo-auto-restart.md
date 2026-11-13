# Skill tự khởi động lại Zalo kèm cổng debug — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `zalo-mi-launch.ps1 -Restart` buộc tắt Zalo đang chạy ở chế độ thường rồi mở lại kèm cổng debug, và hai skill `zalo-mi`, `zalo-chat-report` dùng cờ này thay vì bảo Cong tự thoát Zalo.

**Architecture:** Thêm một hàm dừng tiến trình và một nhánh `-Restart` vào luồng `Invoke-ZaloLaunch` có sẵn; mọi trạng thái khác giữ nguyên. Kiểm tra bằng Pester 3.4 (có sẵn trong Windows PowerShell 5.1), dot-source script và Mock các hàm đụng tới tiến trình/cổng. Skill chỉ đổi phần hướng dẫn xử lý khi chưa có cổng.

**Tech Stack:** Windows PowerShell 5.1, Pester 3.4.0, Markdown (SKILL.md, README).

**Spec:** `docs/superpowers/specs/2026-11-13-zalo-auto-restart-design.md`

## Global Constraints

- Không có `-Restart` thì hành vi y như cũ: Zalo chạy không cổng → in hướng dẫn, mã 2, không tắt gì (lối tắt "Zalo (MI)" dựa vào điều này).
- Buộc dừng = `Stop-Process -Force` mọi tiến trình tên `Zalo`; chờ tối đa 15 giây; quá hạn → mã thoát mới **6**, không mở Zalo mới.
- Không bao giờ trả Zalo về chế độ thường sau khi đọc; bản debug chạy tới khi tắt máy.
- Thông báo cho người dùng bằng tiếng Việt, cùng giọng với các thông báo hiện có.
- Skill chỉ đọc; không đăng xuất, không đụng dữ liệu Zalo.

## Review Focus

1. Zalo đang chạy nhưng không tìm thấy `Zalo.exe` mới nhất → phải trả mã 4 **trước khi** tắt gì, để không bỏ Cong lại không có Zalo. (Test ở Task 1.)
2. Tiến trình Zalo không chịu dừng (ví dụ chạy quyền admin) → mã 6, không gọi `Start-ZaloProcess`. (Test ở Task 1.)
3. `-Restart` khi cổng đã mở (lần chạy thứ hai trong cùng phiên) → báo sẵn sàng, không tắt gì. (Test ở Task 1.)
4. `-DryRun -Restart` → chỉ mô tả, không tắt, không mở. (Test ở Task 1.)
5. Không có `-Restart` khi Zalo chạy không cổng → vẫn mã 2, không tắt. (Test ở Task 1.)

---

### Task 1: Cờ `-Restart` trong launch script

**Files:**
- Modify: `scripts/zalo-mi-launch.ps1` (khối `param`, phần `.DESCRIPTION`/`.PARAMETER`, thêm hàm sau `Get-ZaloProcesses`, nhánh `'RunningNoPort'` và phần `-DryRun` trong `Invoke-ZaloLaunch`, dòng gọi ở cuối file)
- Create: `test/zalo-mi-launch.Tests.ps1`

**Interfaces:**
- Produces: `Stop-ZaloProcesses -TimeoutSeconds <int=15> -IntervalMilliseconds <int=500>` → `[bool]` ($true khi không còn tiến trình `Zalo`). `Invoke-ZaloLaunch ... -Restart` → mã thoát (0/2/3/4/5/6/1). Script nhận `-Restart` từ dòng lệnh: `powershell -ExecutionPolicy Bypass -File scripts\zalo-mi-launch.ps1 -Restart`.

- [ ] **Step 1: Viết test Pester (đỏ)**

`test/zalo-mi-launch.Tests.ps1`: dot-source `scripts/zalo-mi-launch.ps1` (đường dẫn theo `$PSScriptRoot\..`). Trong mỗi `It`, Mock `Find-NewestZalo` (trả `[pscustomobject]@{ Version=[version]'26.11.10'; Path='C:\fake\Zalo.exe' }` trừ test 1), `Get-LaunchState`, `Stop-ZaloProcesses`, `Start-ZaloProcess`, `Wait-ZaloDebugPort` (trả `'Ready'`), `Write-Host`; luôn gọi với `-NoShortcut`.

```powershell
It 'Restart: running without port -> stops, launches with debug args, returns 0' {
  # Get-LaunchState -> 'RunningNoPort'; Stop-ZaloProcesses -> $true
  Invoke-ZaloLaunch -Restart -NoShortcut | Select-Object -Last 1 | Should Be 0
  Assert-MockCalled Stop-ZaloProcesses -Exactly 1
  Assert-MockCalled Start-ZaloProcess -Exactly 1 -ParameterFilter { $Arguments -contains '--remote-debugging-port=9222' }
}
It 'Restart: processes do not exit -> 6, nothing launched' {
  # Stop-ZaloProcesses -> $false
  ... | Should Be 6
  Assert-MockCalled Start-ZaloProcess -Exactly 0
}
It 'Restart: Zalo.exe not found -> 4 before stopping anything' {
  # Find-NewestZalo -> $null; Get-LaunchState -> 'RunningNoPort'
  ... | Should Be 4
  Assert-MockCalled Stop-ZaloProcesses -Exactly 0
}
It 'Restart: port already open -> 0, nothing stopped or launched' {
  # Get-LaunchState -> 'Ready'
  ... | Should Be 0
  Assert-MockCalled Stop-ZaloProcesses -Exactly 0
  Assert-MockCalled Start-ZaloProcess -Exactly 0
}
It 'DryRun + Restart -> nothing stopped or launched' {
  # Get-LaunchState -> 'RunningNoPort'
  Invoke-ZaloLaunch -DryRun -Restart -NoShortcut | Out-Null
  Assert-MockCalled Stop-ZaloProcesses -Exactly 0
  Assert-MockCalled Start-ZaloProcess -Exactly 0
}
It 'No Restart: running without port -> 2, nothing stopped' {
  ... | Should Be 2
  Assert-MockCalled Stop-ZaloProcesses -Exactly 0
}
```

Ghi chú: Mock của Pester 3 chỉ áp dụng nếu `Stop-ZaloProcesses` đã tồn tại; trước khi có hàm, test chạy đỏ là đúng.

- [ ] **Step 2: Chạy test, thấy đỏ**

Run: `powershell -NoProfile -Command "Invoke-Pester -Script test\zalo-mi-launch.Tests.ps1"`
Expected: các test `Restart` FAIL (thiếu tham số `Restart` / hàm `Stop-ZaloProcesses`), test "No Restart" có thể PASS.

- [ ] **Step 3: Cài đặt**

- `param`: thêm `[switch]$Restart`; `.PARAMETER Restart`: "Dùng cho skill: nếu Zalo đang chạy không có cổng debug thì buộc tắt Zalo rồi mở lại kèm cổng (mất tin đang gõ dở, ngắt cuộc gọi đang diễn ra). Không có cờ này thì script không bao giờ tắt Zalo." Thêm mã 6 vào dòng "Mã thoát" và ý này vào `.DESCRIPTION`.
- `Stop-ZaloProcesses`: `Get-ZaloProcesses | Stop-Process -Force -ErrorAction SilentlyContinue`, rồi hỏi `Get-ZaloProcesses` mỗi `IntervalMilliseconds` tới khi rỗng hoặc hết `TimeoutSeconds`.
- `Invoke-ZaloLaunch`: thêm `[switch]$Restart`. Nhánh `'RunningNoPort'`: không `-Restart` → như cũ (mã 2). Có `-Restart`: nếu `$exe` rỗng → in lỗi không tìm thấy Zalo.exe như nhánh hiện có, mã 4; else in "Zalo đang mở ở chế độ thường. Đang tắt và mở lại kèm cổng debug $Port (Zalo sẽ ở chế độ này tới khi tắt máy)..."; `Stop-ZaloProcesses` trả `$false` → `Write-Fail` "Không tắt được Zalo sau 15 giây. Hãy thoát Zalo ở khay hệ thống rồi chạy lại.", mã 6; trả `$true` → rơi xuống đoạn mở Zalo hiện có (dùng chung code với trạng thái 3, không chép lại).
- `-DryRun` với `-Restart` và trạng thái `RunningNoPort`: in "(-Restart) sẽ buộc tắt N tiến trình Zalo rồi mở lại với lệnh trên." thay mô tả mã 2.
- Dòng gọi cuối file truyền `-Restart:$Restart`.

- [ ] **Step 4: Chạy test, thấy xanh**

Run: `powershell -NoProfile -Command "Invoke-Pester -Script test\zalo-mi-launch.Tests.ps1"`
Expected: 6 passed, 0 failed. Cùng lúc `node --test test/*.test.mjs` vẫn 342 pass (không đụng Node).

- [ ] **Step 5: Kiểm tra thật trên máy (Zalo của Cong sẽ khởi động lại một lần — Cong đã đồng ý)**

1. Zalo đang chạy thường. `powershell -ExecutionPolicy Bypass -File scripts\zalo-mi-launch.ps1 -DryRun -Restart` → mô tả, Zalo không bị tắt.
2. `... -NoShortcut` (không `-Restart`) → mã 2, Zalo không bị tắt.
3. `... -Restart -NoShortcut` → Zalo tắt rồi mở lại, mã 0; `node zmi.mjs doctor` ✓ mọi mục.
4. Chạy lại `... -Restart -NoShortcut` → báo sẵn sàng ngay, Zalo không khởi động lại.

- [ ] **Step 6: Commit**

```bash
git add scripts/zalo-mi-launch.ps1 test/zalo-mi-launch.Tests.ps1
git commit -m "feat: zalo-mi-launch -Restart stops a normal Zalo and reopens it with the debug port"
```

### Task 2: Skill và README dùng `-Restart`

**Files:**
- Modify: `skills/zalo-mi/SKILL.md:41-43`, `skills/zalo-chat-report/SKILL.md:34` (và dòng quy tắc "Read only" nếu nhắc tới launch script không kèm cờ), `README.md:10,27-41`
- Copy: hai SKILL.md sang `%USERPROFILE%\.claude\skills\zalo-mi\SKILL.md` và `...\zalo-chat-report\SKILL.md`

**Interfaces:**
- Consumes: lệnh `powershell -ExecutionPolicy Bypass -File C:\Users\kongn\Pictures\CodeProject\Zalodatabase\scripts\zalo-mi-launch.ps1 -Restart -NoShortcut` và mã thoát 0/6 từ Task 1.

- [ ] **Step 1: Sửa `skills/zalo-mi/SKILL.md`**

Thay khối "Zalo not open in collection mode": chạy launch script với `-Restart -NoShortcut`; trước khi chạy báo Cong một dòng "Đang khởi động lại Zalo ở chế độ thu thập (~20 giây); Zalo sẽ ở chế độ này tới khi tắt máy." Exit 0 → chạy lại sync. Mã khác (3, 4, 5, 6, 1) → báo Cong kèm thông báo của script và hỏi **một lần**: dùng dữ liệu lần sync trước hay chờ Cong xử lý. Bỏ câu "It never closes a running Zalo".

- [ ] **Step 2: Sửa `skills/zalo-chat-report/SKILL.md`**

Cùng thay đổi: `-Restart -NoShortcut`, báo một dòng như trên, exit 0 → chạy lại; mã khác → báo Cong thông báo của script và chờ.

- [ ] **Step 3: Sửa README**

Dòng 10: thêm "skill tự khởi động lại Zalo bằng `-Restart` khi cần". Phần script khởi động: thêm cờ `-Restart` (chỉ skill dùng; trạng thái 2 thành buộc tắt rồi mở lại), mã 6, lệnh chạy Pester, và các mục kiểm tra tay (f) `-DryRun -Restart` không tắt gì, (g) `-Restart` khi Zalo chạy thường → khởi động lại, `doctor` ✓, (h) chạy lại `-Restart` → không khởi động lại. Câu lưu ý cuối: cổng mở tới khi tắt máy hoặc thoát Zalo.

- [ ] **Step 4: Chép bản đã cài và kiểm tra**

Run: `Copy-Item skills\zalo-mi\SKILL.md "$env:USERPROFILE\.claude\skills\zalo-mi\SKILL.md" -Force` và tương tự cho `zalo-chat-report`; rồi `Compare-Object` từng cặp.
Expected: không có khác biệt.

- [ ] **Step 5: Commit**

```bash
git add skills/zalo-mi/SKILL.md skills/zalo-chat-report/SKILL.md README.md docs/superpowers
git commit -m "docs: zalo skills restart Zalo with -Restart instead of asking Cong to quit it"
```
