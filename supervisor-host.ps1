param(
    [switch]$Install,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
& chcp.com 65001 *> $null

$taskName = 'LegendBots Autonomous Supervisor'
$workerHost = Join-Path $PSScriptRoot 'worker-host.ps1'
$managerHeartbeat = Join-Path $PSScriptRoot 'pipeline-runtime\heartbeats\manager.json'
$logDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\logs'
$logPath = Join-Path $logDirectory 'supervisor-errors.jsonl'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $workerHost -PathType Leaf)) {
    throw "Worker host bulunamadı: $workerHost"
}

if ($CheckOnly) {
    Write-Output "Supervisor host doğrulandı: $workerHost"
    exit 0
}

function Write-SupervisorEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [hashtable]$Metadata = @{}
    )
    [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
    $entry = [ordered]@{
        at = [DateTimeOffset]::UtcNow.ToString('o')
        code = $Code
        message = $Message
    }
    foreach ($key in $Metadata.Keys) {
        $entry[$key] = $Metadata[$key]
    }
    $line = $entry | ConvertTo-Json -Compress
    [IO.File]::AppendAllText($logPath, "$line`r`n", $utf8NoBom)
}

if ($Install) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Supervisor görevi kuruldu ve başlatıldı: $taskName"
    exit 0
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) {
        return $false
    }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-ManagerHostAlive {
    $escapedPath = [Regex]::Escape($workerHost)
    return $null -ne (
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ProcessId -ne $PID -and
                $_.CommandLine -match $escapedPath -and
                $_.CommandLine -match '(?i)-Worker\s+manager(?:\s|$)'
            } |
            Select-Object -First 1
    )
}

$unhealthySince = $null
$lastRecoveryAt = [DateTimeOffset]::MinValue
$recoveryDelaySeconds = 75
$recoveryCooldownSeconds = 120
$hungSeconds = 300

while ($true) {
    try {
        $heartbeat = $null
        if (Test-Path -LiteralPath $managerHeartbeat -PathType Leaf) {
            $heartbeat = Get-Content -Raw -Encoding UTF8 -LiteralPath $managerHeartbeat | ConvertFrom-Json
        }
        $managerPid = if ($heartbeat) { [int]$heartbeat.pid } else { 0 }
        $alive = Test-ProcessAlive $managerPid
        $lastSeen = if ($heartbeat) { [DateTimeOffset]::Parse([string]$heartbeat.last_seen_at) } else { [DateTimeOffset]::MinValue }
        $ageSeconds = ([DateTimeOffset]::UtcNow - $lastSeen.ToUniversalTime()).TotalSeconds
        $healthy = $alive -and $ageSeconds -le 120 -and $heartbeat.status -notin @('stopped', 'stopping')

        if ($healthy) {
            $unhealthySince = $null
        }
        else {
            if ($null -eq $unhealthySince) {
                $unhealthySince = [DateTimeOffset]::UtcNow
            }
            $unhealthySeconds = ([DateTimeOffset]::UtcNow - $unhealthySince).TotalSeconds
            $sinceRecovery = ([DateTimeOffset]::UtcNow - $lastRecoveryAt).TotalSeconds

            if ($alive -and $ageSeconds -ge $hungSeconds -and $sinceRecovery -ge $recoveryCooldownSeconds) {
                Stop-Process -Id $managerPid -Force -ErrorAction Stop
                $lastRecoveryAt = [DateTimeOffset]::UtcNow
                $unhealthySince = [DateTimeOffset]::UtcNow
                Write-SupervisorEvent 'manager_hung_terminated' 'Manager heartbeat üretmediği için host tarafından yenilenecek.' @{
                    pid = $managerPid
                    heartbeat_age_seconds = [Math]::Round($ageSeconds, 1)
                }
            }
            elseif (-not $alive -and $unhealthySeconds -ge $recoveryDelaySeconds -and $sinceRecovery -ge $recoveryCooldownSeconds) {
                if (-not (Test-ManagerHostAlive)) {
                    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$workerHost`" -Worker manager"
                    $hostProcess = Start-Process -FilePath 'powershell.exe' `
                        -WorkingDirectory $PSScriptRoot `
                        -WindowStyle Normal `
                        -ArgumentList $arguments `
                        -PassThru
                    $lastRecoveryAt = [DateTimeOffset]::UtcNow
                    $unhealthySince = [DateTimeOffset]::UtcNow
                    Write-SupervisorEvent 'manager_host_restarted' 'Manager worker hostu bağımsız supervisor tarafından başlatıldı.' @{
                        host_pid = $hostProcess.Id
                    }
                }
            }
        }
    }
    catch {
        Write-SupervisorEvent 'supervisor_iteration_failed' $_.Exception.Message
    }
    Start-Sleep -Seconds 5
}
