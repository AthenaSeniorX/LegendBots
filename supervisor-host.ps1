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
$heartbeatDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\heartbeats'
$workerControlPath = Join-Path $PSScriptRoot 'pipeline-runtime\worker-control.json'
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

function Test-WorkerHostAlive {
    param([Parameter(Mandatory = $true)][string]$Worker)
    $escapedPath = [Regex]::Escape($workerHost)
    $workerPattern = '(?i)-Worker\s+' + [Regex]::Escape($Worker) + '(?:\s|$)'
    return $null -ne (
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ProcessId -ne $PID -and
                $_.CommandLine -match $escapedPath -and
                $_.CommandLine -match $workerPattern
            } |
            Select-Object -First 1
    )
}

$unhealthySince = @{}
$lastRecoveryAt = @{}
$recoveryDelaySeconds = 75
$recoveryCooldownSeconds = 120
$hungSeconds = 300

while ($true) {
    try {
        $desired = @{ account = $true; group = $true; sign = $true; manager = $true }
        if (Test-Path -LiteralPath $workerControlPath -PathType Leaf) {
            $control = Get-Content -Raw -Encoding UTF8 -LiteralPath $workerControlPath | ConvertFrom-Json
            foreach ($worker in @('account', 'group', 'sign')) {
                $entry = $control.workers.$worker
                if ($null -ne $entry) {
                    $desired[$worker] = [bool]$entry.enabled
                }
            }
        }

        foreach ($worker in @('manager', 'account', 'group', 'sign')) {
            if (-not $desired[$worker]) {
                $unhealthySince.Remove($worker)
                continue
            }

            $heartbeatPath = Join-Path $heartbeatDirectory "$worker.json"
            $heartbeat = $null
            if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
                $heartbeat = Get-Content -Raw -Encoding UTF8 -LiteralPath $heartbeatPath | ConvertFrom-Json
            }

            $workerPid = if ($heartbeat) { [int]$heartbeat.pid } else { 0 }
            $alive = Test-ProcessAlive $workerPid
            $lastSeen = if ($heartbeat) {
                [DateTimeOffset]::Parse([string]$heartbeat.last_seen_at)
            }
            else {
                [DateTimeOffset]::MinValue
            }
            $ageSeconds = ([DateTimeOffset]::UtcNow - $lastSeen.ToUniversalTime()).TotalSeconds
            $healthy = $alive -and $ageSeconds -le 120 -and $heartbeat.status -notin @('stopped', 'stopping')

            if ($healthy) {
                $unhealthySince.Remove($worker)
                continue
            }
            if (-not $unhealthySince.ContainsKey($worker)) {
                $unhealthySince[$worker] = [DateTimeOffset]::UtcNow
            }
            if (-not $lastRecoveryAt.ContainsKey($worker)) {
                $lastRecoveryAt[$worker] = [DateTimeOffset]::MinValue
            }
            $unhealthySeconds = ([DateTimeOffset]::UtcNow - $unhealthySince[$worker]).TotalSeconds
            $sinceRecovery = ([DateTimeOffset]::UtcNow - $lastRecoveryAt[$worker]).TotalSeconds

            if ($alive -and $ageSeconds -ge $hungSeconds -and $sinceRecovery -ge $recoveryCooldownSeconds) {
                Stop-Process -Id $workerPid -Force -ErrorAction Stop
                $lastRecoveryAt[$worker] = [DateTimeOffset]::UtcNow
                $unhealthySince[$worker] = [DateTimeOffset]::UtcNow
                Write-SupervisorEvent "${worker}_hung_terminated" "$worker heartbeat üretmediği için host tarafından yenilenecek." @{
                    worker = $worker
                    pid = $workerPid
                    heartbeat_age_seconds = [Math]::Round($ageSeconds, 1)
                }
            }
            elseif (-not $alive -and $unhealthySeconds -ge $recoveryDelaySeconds -and $sinceRecovery -ge $recoveryCooldownSeconds) {
                if (-not (Test-WorkerHostAlive $worker)) {
                    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$workerHost`" -Worker $worker"
                    $hostProcess = Start-Process -FilePath 'powershell.exe' `
                        -WorkingDirectory $PSScriptRoot `
                        -WindowStyle Normal `
                        -ArgumentList $arguments `
                        -PassThru
                    $lastRecoveryAt[$worker] = [DateTimeOffset]::UtcNow
                    $unhealthySince[$worker] = [DateTimeOffset]::UtcNow
                    Write-SupervisorEvent "${worker}_host_restarted" "$worker worker hostu bağımsız supervisor tarafından başlatıldı." @{
                        worker = $worker
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
