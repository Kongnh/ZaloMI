<#
.SYNOPSIS
  Mở Zalo PC ở chế độ debug để công cụ Zalo MI (node zmi.mjs) đọc được dữ liệu.

.DESCRIPTION
  Công cụ đọc Zalo qua Chrome DevTools Protocol tại 127.0.0.1:<Port>. Cổng này chỉ có khi Zalo được mở với
  --remote-debugging-port=<Port> --remote-allow-origins=http://127.0.0.1:<Port>.

  Script xử lý ba trạng thái. Không có -Restart thì KHÔNG BAO GIỜ tự thoát, tắt hay khởi động lại một Zalo đang chạy:
    1. Zalo đang chạy và cổng debug trả lời (có cửa sổ "Zalo")  -> báo sẵn sàng, mã thoát 0.
    2. Zalo đang chạy nhưng cổng debug không trả lời            -> in hướng dẫn thoát hẳn Zalo, mã thoát 2.
                                                                   Với -Restart: buộc tắt Zalo rồi làm như trạng thái 3.
    3. Zalo chưa chạy                                           -> mở Zalo.exe mới nhất kèm cờ debug, chờ cổng mở
                                                                   (tối đa 60 giây), báo sẵn sàng, mã thoát 0.

  Mã thoát: 0 sẵn sàng | 1 lỗi bất ngờ | 2 Zalo đang chạy không có cổng debug | 3 hết giờ chờ cổng |
            4 không tìm thấy Zalo.exe | 5 cổng mở nhưng chưa thấy cửa sổ "Zalo" |
            6 (-Restart) không tắt được Zalo sau 15 giây.

  Lần chạy thật đầu tiên còn tạo lối tắt "Zalo (MI)" trên Desktop (không bao giờ ghi đè lối tắt đã có).

.PARAMETER Port
  Cổng debug (mặc định 9222).

.PARAMETER DryRun
  Chỉ in đường dẫn Zalo.exe, lệnh sẽ chạy và trạng thái hiện tại. Không mở gì, không tạo lối tắt.

.PARAMETER NoShortcut
  Không tạo lối tắt trên Desktop.

.PARAMETER Restart
  Dùng cho skill: nếu Zalo đang chạy không có cổng debug thì buộc tắt Zalo rồi mở lại kèm cổng (mất tin đang gõ dở,
  ngắt cuộc gọi đang diễn ra). Zalo ở chế độ này tới khi tắt máy. Không có cờ này thì script không bao giờ tắt Zalo.
#>
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 9222,
    [switch]$DryRun,
    [switch]$NoShortcut,
    [switch]$Restart
)

# Khi chỉ nạp bằng dot-source để thử hàm thì không đổi chế độ của phiên đang gọi.
$script:DotSourced = ($MyInvocation.InvocationName -eq '.')
if (-not $script:DotSourced) {
    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
}

$script:ShortcutFileName = 'Zalo (MI).lnk'
$script:ScriptPath = $PSCommandPath
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# ---------------------------------------------------------------------------------------------------------------
# Tìm Zalo.exe và đọc trạng thái (chỉ đọc, không đụng vào tiến trình nào)
# ---------------------------------------------------------------------------------------------------------------

function Get-ZaloInstallRoot {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Zalo'
}

# Thư mục Zalo-<phiên bản> mới nhất, so theo số phiên bản (26.10.11 mới hơn 26.9.10), không so theo tên.
# Trả về @{ Path; Version } hoặc $null.
function Find-NewestZalo {
    param([string]$Root = (Get-ZaloInstallRoot))

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $null }
    $found = foreach ($dir in Get-ChildItem -LiteralPath $Root -Directory) {
        if ($dir.Name -match '^Zalo-(\d+(\.\d+){1,3})$') {
            $exe = Join-Path $dir.FullName 'Zalo.exe'
            if (Test-Path -LiteralPath $exe -PathType Leaf) {
                [pscustomobject]@{ Version = [version]$Matches[1]; Path = $exe }
            }
        }
    }
    $found | Sort-Object -Property Version -Descending | Select-Object -First 1
}

function Get-ZaloLaunchArguments {
    param([int]$Port)
    @("--remote-debugging-port=$Port", "--remote-allow-origins=http://127.0.0.1:$Port")
}

function Get-ZaloProcesses {
    @(Get-Process -Name 'Zalo' -ErrorAction SilentlyContinue)
}

# Buộc dừng mọi tiến trình Zalo (chỉ dùng với -Restart) và chờ chúng thoát hết.
# Trả về $true khi không còn tiến trình Zalo nào, $false nếu hết $TimeoutSeconds mà vẫn còn.
function Stop-ZaloProcesses {
    param([int]$TimeoutSeconds = 15, [int]$IntervalMilliseconds = 500)

    # Dừng lại ở mỗi vòng: tiến trình con Zalo có thể vừa mới mọc ra sau lần dừng trước.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $left = @(Get-ZaloProcesses)
        if ($left.Count -eq 0) { return $true }
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
}

# GET http://127.0.0.1:<Port><Path>; trả về nội dung văn bản hoặc $null nếu cổng không trả lời.
# Không dùng proxy hệ thống: đây là kết nối nội bộ.
function Invoke-DebugPortGet {
    param([int]$Port, [string]$Path, [int]$TimeoutMilliseconds = 2000)

    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port$Path")
        $request.Proxy = $null
        $request.Timeout = $TimeoutMilliseconds
        $request.ReadWriteTimeout = $TimeoutMilliseconds
        $response = $request.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
            try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally {
            $response.Close()
        }
    } catch {
        return $null
    }
}

# 'Ready'    : /json/version trả lời và /json/list có trang tên "Zalo"
# 'NoWindow' : /json/version trả lời nhưng chưa thấy trang "Zalo"
# 'Closed'   : cổng không trả lời
function Get-PortStatus {
    param([int]$Port)

    $versionText = Invoke-DebugPortGet -Port $Port -Path '/json/version'
    if ($null -eq $versionText) { return 'Closed' }
    try {
        $version = $versionText | ConvertFrom-Json
        if ($null -eq $version.PSObject.Properties['Browser']) { return 'Closed' }
    } catch {
        return 'Closed'
    }

    $listText = Invoke-DebugPortGet -Port $Port -Path '/json/list'
    if ($null -eq $listText) { return 'NoWindow' }
    try {
        $targets = @($listText | ConvertFrom-Json)
        foreach ($target in $targets) {
            if ($target.type -eq 'page' -and $target.title -eq 'Zalo') { return 'Ready' }
        }
    } catch {
        return 'NoWindow'
    }
    return 'NoWindow'
}

# 'Ready' | 'PortNoWindow' | 'RunningNoPort' | 'NotRunning'
function Get-LaunchState {
    param([int]$Port)

    switch (Get-PortStatus -Port $Port) {
        'Ready'    { return 'Ready' }
        'NoWindow' { return 'PortNoWindow' }
    }
    if (@(Get-ZaloProcesses).Count -gt 0) { return 'RunningNoPort' }
    return 'NotRunning'
}

# Mở Zalo.exe (tiến trình mới, không chờ nó thoát).
function Start-ZaloProcess {
    param([string]$ExePath, [string[]]$Arguments)
    Start-Process -FilePath $ExePath -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
}

# Chờ cổng debug mở và cửa sổ "Zalo" xuất hiện, hỏi mỗi $IntervalMilliseconds. 'Ready' | 'PortNoWindow' | 'Timeout'
function Wait-ZaloDebugPort {
    param([int]$Port, [int]$TimeoutSeconds = 60, [int]$IntervalMilliseconds = 1000)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $status = 'Closed'
    while ($true) {
        $status = Get-PortStatus -Port $Port
        if ($status -eq 'Ready' -or (Get-Date) -ge $deadline) { break }
        Write-Host -NoNewline '.'
        Start-Sleep -Milliseconds $IntervalMilliseconds
    }
    Write-Host ''
    switch ($status) {
        'Ready'    { return 'Ready' }
        'NoWindow' { return 'PortNoWindow' }
        default    { return 'Timeout' }
    }
}

# ---------------------------------------------------------------------------------------------------------------
# Lối tắt trên Desktop
# ---------------------------------------------------------------------------------------------------------------

function Get-ShortcutPath {
    param([string]$DesktopDir = [Environment]::GetFolderPath('Desktop'))
    Join-Path $DesktopDir $script:ShortcutFileName
}

# Tạo lối tắt "Zalo (MI).lnk" nếu chưa có. Trả về 'created' hoặc 'exists'; ném lỗi nếu không tạo được.
function New-ZaloMiShortcut {
    param([string]$IconExe, [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'))

    $path = Get-ShortcutPath -DesktopDir $DesktopDir
    if (Test-Path -LiteralPath $path) { return 'exists' }

    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($path)
        $shortcut.TargetPath = 'powershell.exe'
        $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script:ScriptPath + '"'
        $shortcut.WorkingDirectory = $script:RepoRoot
        $shortcut.Description = 'Mở Zalo ở chế độ debug cho công cụ Zalo MI'
        if ($IconExe) { $shortcut.IconLocation = "$IconExe,0" }
        $shortcut.Save()
    } finally {
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
    }
    return 'created'
}

# ---------------------------------------------------------------------------------------------------------------
# Thông báo (tiếng Việt)
# ---------------------------------------------------------------------------------------------------------------

function Write-Ok   { param([string]$Text) Write-Host $Text -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host $Text -ForegroundColor Yellow }
function Write-Fail { param([string]$Text) Write-Host $Text -ForegroundColor Red }

function Write-ReadyMessage {
    param([int]$Port)
    Write-Ok "Sẵn sàng: Zalo đang chạy, cổng debug $Port đang mở và thấy cửa sổ `"Zalo`"."
    Write-Host '  Chạy tiếp: node zmi.mjs doctor'
}

function Write-RunningNoPortGuidance {
    param([int]$Port)
    Write-Warn "Zalo đang chạy nhưng KHÔNG mở cổng debug $Port (Zalo đã được mở theo cách thông thường)."
    Write-Host 'Script này không tự thoát hay tắt Zalo. Hãy làm như sau:'
    Write-Host '  1. Thoát hẳn Zalo: bấm chuột phải vào biểu tượng Zalo ở khay hệ thống (góc phải thanh tác vụ,'
    Write-Host '     có thể phải bấm mũi tên ^ để thấy) > Thoát. Chỉ đóng cửa sổ bằng nút X là chưa đủ.'
    Write-Host '  2. Bấm lại lối tắt "Zalo (MI)" trên Desktop (hoặc chạy lại script này).'
}

function Write-PortNoWindowMessage {
    param([int]$Port)
    Write-Warn "Cổng $Port đang mở nhưng chưa thấy cửa sổ `"Zalo`"."
    Write-Host '  - Nếu Zalo vừa mở hoặc đang ở màn hình đăng nhập: đăng nhập, đợi Zalo tải xong rồi chạy lại script này.'
    Write-Host "  - Nếu cổng $Port đang do chương trình khác dùng: thoát chương trình đó hoặc chạy lại với -Port <số khác>."
}

function Get-StateDescription {
    param([string]$State, [int]$Port)
    switch ($State) {
        'Ready'         { return "Zalo đang chạy và cổng $Port đã mở (trạng thái 1): script chỉ báo sẵn sàng, mã thoát 0." }
        'RunningNoPort' { return "Zalo đang chạy nhưng cổng $Port không trả lời (trạng thái 2): script chỉ in hướng dẫn thoát Zalo, mã thoát 2, không tắt gì." }
        'NotRunning'    { return "Zalo chưa chạy (trạng thái 3): script sẽ chạy lệnh trên rồi chờ cổng $Port mở tối đa 60 giây." }
        default         { return "Cổng $Port trả lời nhưng chưa thấy cửa sổ `"Zalo`": script in lời nhắc, mã thoát 5, không mở gì." }
    }
}

# Khi chạy từ lối tắt (cha là Explorer) cửa sổ sẽ đóng ngay khi script xong, nên giữ lại để đọc thông báo.
function Test-StartedFromExplorer {
    try {
        $parentId = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID").ParentProcessId
        return ((Get-Process -Id $parentId).ProcessName -eq 'explorer')
    } catch {
        return $false
    }
}

function Wait-BeforeClose {
    param([int]$ExitCode)
    if (-not (Test-StartedFromExplorer)) { return }
    try {
        if ($ExitCode -eq 0) {
            Write-Host 'Cửa sổ này tự đóng sau 8 giây.'
            Start-Sleep -Seconds 8
        } else {
            [void](Read-Host 'Nhấn Enter để đóng cửa sổ')
        }
    } catch {
        Start-Sleep -Seconds 8
    }
}

# ---------------------------------------------------------------------------------------------------------------
# Luồng chính. Trả về mã thoát.
# ---------------------------------------------------------------------------------------------------------------

function Invoke-ZaloLaunch {
    param(
        [int]$Port = 9222,
        [switch]$DryRun,
        [switch]$NoShortcut,
        [switch]$Restart,
        [int]$TimeoutSeconds = 60,
        [int]$IntervalMilliseconds = 1000
    )

    $zalo = Find-NewestZalo
    $exe = if ($zalo) { $zalo.Path } else { $null }
    $launchArguments = Get-ZaloLaunchArguments -Port $Port
    $state = Get-LaunchState -Port $Port
    $willRestart = $Restart -and $state -eq 'RunningNoPort'

    if ($DryRun) {
        Write-Host '[DryRun] Chỉ kiểm tra, không mở Zalo và không tạo lối tắt.'
        if ($exe) {
            Write-Host "Zalo.exe mới nhất : $exe (phiên bản $($zalo.Version))"
            Write-Host '(Chỉ khi Zalo chưa chạy) lệnh sẽ chạy:'
            Write-Host "  `"$exe`" $($launchArguments -join ' ')"
        } else {
            Write-Host "Zalo.exe mới nhất : không tìm thấy trong $(Get-ZaloInstallRoot)"
        }
        if ($willRestart) {
            $count = @(Get-ZaloProcesses).Count
            Write-Host "Trạng thái        : Zalo đang chạy không có cổng $Port. (-Restart) sẽ buộc tắt $count tiến trình Zalo rồi mở lại với lệnh trên."
        } else {
            Write-Host "Trạng thái        : $(Get-StateDescription -State $state -Port $Port)"
        }
        $shortcutPath = Get-ShortcutPath
        $shortcutNote = if (Test-Path -LiteralPath $shortcutPath) { 'đã có, sẽ không ghi đè' } else { 'chưa có, sẽ tạo khi chạy thật; dùng -NoShortcut để bỏ qua' }
        Write-Host "Lối tắt Desktop   : $shortcutPath ($shortcutNote)"
        if (($state -eq 'NotRunning' -or $willRestart) -and -not $exe) { return 4 }
        return 0
    }

    if (-not $NoShortcut) {
        try {
            $shortcutResult = New-ZaloMiShortcut -IconExe $exe
            if ($shortcutResult -eq 'created') {
                Write-Host "Đã tạo lối tắt `"Zalo (MI)`" trên Desktop: $(Get-ShortcutPath)"
            }
        } catch {
            Write-Warn "Không tạo được lối tắt trên Desktop: $($_.Exception.Message)"
        }
    }

    switch ($state) {
        'Ready' {
            Write-ReadyMessage -Port $Port
            return 0
        }
        'RunningNoPort' {
            if (-not $Restart) {
                Write-RunningNoPortGuidance -Port $Port
                return 2
            }
            # Kiểm tra Zalo.exe trước khi tắt, để không bỏ người dùng lại không có Zalo.
            if (-not $exe) {
                Write-Fail "Không tìm thấy Zalo.exe trong $(Get-ZaloInstallRoot) (cần thư mục dạng Zalo-<phiên bản>). Không tắt Zalo đang chạy."
                return 4
            }
            Write-Host "Zalo đang mở ở chế độ thường. Đang tắt và mở lại kèm cổng debug $Port (Zalo sẽ ở chế độ này tới khi tắt máy)..."
            if (-not (Stop-ZaloProcesses)) {
                Write-Fail 'Không tắt được Zalo sau 15 giây. Hãy thoát Zalo ở khay hệ thống (chuột phải > Thoát) rồi chạy lại.'
                return 6
            }
            break  # Zalo đã tắt: mở lại như trạng thái 3 ở dưới.
        }
        'PortNoWindow' {
            Write-PortNoWindowMessage -Port $Port
            return 5
        }
    }

    # Zalo chưa chạy: mở Zalo.exe mới nhất kèm cờ debug.
    if (-not $exe) {
        Write-Fail "Không tìm thấy Zalo.exe trong $(Get-ZaloInstallRoot) (cần thư mục dạng Zalo-<phiên bản>). Hãy cài Zalo PC rồi chạy lại."
        return 4
    }
    Write-Host "Đang mở Zalo $($zalo.Version) ở chế độ debug (cổng $Port)..."
    try {
        Start-ZaloProcess -ExePath $exe -Arguments $launchArguments
    } catch {
        Write-Fail "Không mở được Zalo: $($_.Exception.Message)"
        return 1
    }
    Write-Host "Chờ cổng debug mở (tối đa $TimeoutSeconds giây)" -NoNewline
    $result = Wait-ZaloDebugPort -Port $Port -TimeoutSeconds $TimeoutSeconds -IntervalMilliseconds $IntervalMilliseconds
    switch ($result) {
        'Ready' {
            Write-ReadyMessage -Port $Port
            return 0
        }
        'PortNoWindow' {
            Write-PortNoWindowMessage -Port $Port
            return 5
        }
        default {
            Write-Fail "Hết $TimeoutSeconds giây mà cổng debug $Port vẫn chưa mở."
            Write-Host '  - Kiểm tra Zalo có đang mở không (xem khay hệ thống). Nếu Zalo hiện lên nhưng cổng vẫn đóng,'
            Write-Host '    thoát hẳn Zalo (khay hệ thống > Thoát) rồi chạy lại script này.'
            Write-Host "  - Nếu cổng $Port bị chặn hoặc đang bận, chạy lại với -Port <số khác>."
            return 3
        }
    }
}

# Cho phép nạp script bằng dot-source (để thử từng hàm) mà không chạy luồng chính.
if ($script:DotSourced) { return }

$exitCode = 1
try {
    $exitCode = @(Invoke-ZaloLaunch -Port $Port -DryRun:$DryRun -NoShortcut:$NoShortcut -Restart:$Restart)[-1]
} catch {
    Write-Fail "Lỗi bất ngờ: $($_.Exception.Message)"
}
Wait-BeforeClose -ExitCode $exitCode
exit $exitCode
