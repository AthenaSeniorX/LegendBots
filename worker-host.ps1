param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('account', 'group', 'sign', 'manager')]
    [string]$Worker,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
& chcp.com 65001 *> $null

$definitions = @{
    account = @{ Title = 'LegendBots - BOT 1 - HESAP'; Script = 'pipeline\account-worker.js' }
    group   = @{ Title = 'LegendBots - BOT 2 - GRUPLA'; Script = 'pipeline\group-worker.js' }
    sign    = @{ Title = 'LegendBots - BOT 3 - SIGN'; Script = 'pipeline\sign-worker.js' }
    manager = @{ Title = 'LegendBots - BOT 4 - MANAGER'; Script = 'pipeline\manager.js' }
}

if ([string]::IsNullOrWhiteSpace($Worker)) {
    throw 'Worker adı alınamadı. worker-host.ps1 -Worker account|group|sign|manager biçiminde çağrılmalıdır.'
}
$definition = $definitions[$Worker]
if ($null -eq $definition) {
    throw "Geçersiz worker adı: $Worker"
}
$workerScript = Join-Path $PSScriptRoot $definition.Script
if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
    throw "Worker Node betiği bulunamadı: $workerScript"
}
if ($CheckOnly) {
    Write-Output "Worker host doğrulandı: $Worker -> $workerScript"
    exit 0
}
$Host.UI.RawUI.WindowTitle = $definition.Title

$consoleLogDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\logs'
[IO.Directory]::CreateDirectory($consoleLogDirectory) | Out-Null
$consoleLogPath = Join-Path $consoleLogDirectory "$Worker-console.log"
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Write-WorkerConsoleLine {
    param([AllowEmptyString()][string]$Line)
    Write-Host $Line
    $timestamp = [DateTimeOffset]::Now.ToString('o')
    [IO.File]::AppendAllText($consoleLogPath, "$timestamp`t$Line`r`n", $utf8NoBom)
}

# Node/Python worker stderr'i beklenen hata günlüğüdür; PowerShell'in bunu
# terminating error sayması hostu ve otomatik yeniden başlatma döngüsünü öldürmemelidir.
$ErrorActionPreference = 'Continue'
$restartDelaySeconds = 5
$maximumRestartDelaySeconds = 120
$stableRuntimeSeconds = 300

while ($true) {
    $workerStartedAt = [DateTimeOffset]::Now
    & node $workerScript 2>&1 | ForEach-Object {
        Write-WorkerConsoleLine ([string]$_)
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        break
    }
    if ($exitCode -ne 0) {
        $runtimeSeconds = ([DateTimeOffset]::Now - $workerStartedAt).TotalSeconds
        if ($runtimeSeconds -ge $stableRuntimeSeconds) {
            $restartDelaySeconds = 5
        }
        Write-WorkerConsoleLine (
            "[HOST] $Worker worker kodu=$exitCode ile kapandı; " +
            "$restartDelaySeconds saniye sonra yeniden başlatılacak."
        )
    }
    Start-Sleep -Seconds $restartDelaySeconds
    $restartDelaySeconds = [Math]::Min(
        $maximumRestartDelaySeconds,
        $restartDelaySeconds * 2
    )
}

