# Pester 3.4 (có sẵn trong Windows PowerShell 5.1):
#   powershell -NoProfile -Command "Invoke-Pester -Script test\zalo-mi-launch.Tests.ps1"
# Chỉ thử luồng quyết định của Invoke-ZaloLaunch; mọi hàm đụng tới tiến trình, cổng hay Desktop đều bị Mock.

. (Join-Path $PSScriptRoot '..\scripts\zalo-mi-launch.ps1')

Describe 'Invoke-ZaloLaunch -Restart' {

    BeforeEach {
        Mock Write-Host {}
        Mock Find-NewestZalo { [pscustomobject]@{ Version = [version]'26.11.10'; Path = 'C:\fake\Zalo.exe' } }
        Mock Stop-ZaloProcesses { $true }
        Mock Start-ZaloProcess {}
        Mock Wait-ZaloDebugPort { 'Ready' }
        Mock Get-ZaloProcesses { @() }
    }

    It 'Zalo running without the port: stops it, relaunches with the debug flag, returns 0' {
        Mock Get-LaunchState { 'RunningNoPort' }
        Invoke-ZaloLaunch -Restart -NoShortcut | Select-Object -Last 1 | Should Be 0
        Assert-MockCalled Stop-ZaloProcesses -Exactly 1 -Scope It
        Assert-MockCalled Start-ZaloProcess -Exactly 1 -Scope It -ParameterFilter {
            $ExePath -eq 'C:\fake\Zalo.exe' -and $Arguments -contains '--remote-debugging-port=9222'
        }
    }

    It 'Zalo processes do not exit: returns 6 and launches nothing' {
        Mock Get-LaunchState { 'RunningNoPort' }
        Mock Stop-ZaloProcesses { $false }
        Invoke-ZaloLaunch -Restart -NoShortcut | Select-Object -Last 1 | Should Be 6
        Assert-MockCalled Start-ZaloProcess -Exactly 0 -Scope It
    }

    It 'Zalo.exe not found: returns 4 before stopping the running Zalo' {
        Mock Get-LaunchState { 'RunningNoPort' }
        Mock Find-NewestZalo { $null }
        Invoke-ZaloLaunch -Restart -NoShortcut | Select-Object -Last 1 | Should Be 4
        Assert-MockCalled Stop-ZaloProcesses -Exactly 0 -Scope It
    }

    It 'port already open (second run in the same session): returns 0, stops and launches nothing' {
        Mock Get-LaunchState { 'Ready' }
        Invoke-ZaloLaunch -Restart -NoShortcut | Select-Object -Last 1 | Should Be 0
        Assert-MockCalled Stop-ZaloProcesses -Exactly 0 -Scope It
        Assert-MockCalled Start-ZaloProcess -Exactly 0 -Scope It
    }

    It '-DryRun -Restart: describes the restart, stops and launches nothing' {
        Mock Get-LaunchState { 'RunningNoPort' }
        Invoke-ZaloLaunch -DryRun -Restart -NoShortcut | Out-Null
        Assert-MockCalled Stop-ZaloProcesses -Exactly 0 -Scope It
        Assert-MockCalled Start-ZaloProcess -Exactly 0 -Scope It
        Assert-MockCalled Write-Host -Scope It -ParameterFilter { "$Object" -like '*-Restart*' }
    }

    It 'without -Restart (the "Zalo (MI)" shortcut): still returns 2 and never stops Zalo' {
        Mock Get-LaunchState { 'RunningNoPort' }
        Invoke-ZaloLaunch -NoShortcut | Select-Object -Last 1 | Should Be 2
        Assert-MockCalled Stop-ZaloProcesses -Exactly 0 -Scope It
        Assert-MockCalled Start-ZaloProcess -Exactly 0 -Scope It
    }
}

Describe 'Stop-ZaloProcesses' {
    BeforeEach {
        Mock Stop-Process {}
        Mock Start-Sleep {}
    }

    It 'returns $true once no Zalo process is left' {
        $script:calls = 0
        Mock Get-ZaloProcesses { $script:calls++; if ($script:calls -le 2) { @([pscustomobject]@{ Id = 1 }) } else { @() } }
        Stop-ZaloProcesses -TimeoutSeconds 5 -IntervalMilliseconds 10 | Should Be $true
    }

    It 'returns $false when a Zalo process is still there after the timeout' {
        Mock Get-ZaloProcesses { @([pscustomobject]@{ Id = 1 }) }
        Stop-ZaloProcesses -TimeoutSeconds 0 -IntervalMilliseconds 10 | Should Be $false
    }
}
