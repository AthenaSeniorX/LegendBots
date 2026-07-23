param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('account', 'group', 'sign', 'reward', 'manager')]
    [string]$Worker,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [Console]::OutputEncoding
    & chcp.com 65001 *> $null
}
catch {
    # Manager'ın detached başlattığı worker hostlarında gerçek konsol tanıtıcısı
    # olmayabilir. UTF-8 dosya günlüğü yine açıkça kodlandığı için bu durum
    # workerın Node sürecini başlatmasını engellememelidir.
}

$definitions = @{
    account = @{ Title = 'LegendBots - BOT 1 - HESAP'; Script = 'pipeline\account-worker.js' }
    group   = @{ Title = 'LegendBots - BOT 2 - GRUPLA'; Script = 'pipeline\group-worker.js' }
    sign    = @{ Title = 'LegendBots - BOT 3 - SIGN'; Script = 'pipeline\sign-worker.js' }
    reward  = @{ Title = 'LegendBots - BOT 4 - REWARD'; Script = 'pipeline\reward-worker.js' }
    manager = @{ Title = 'LegendBots - BOT 0 - MANAGER'; Script = 'pipeline\manager.js' }
}

if ([string]::IsNullOrWhiteSpace($Worker)) {
    throw 'Worker adı alınamadı. worker-host.ps1 -Worker account|group|sign|reward|manager biçiminde çağrılmalıdır.'
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
try {
    $Host.UI.RawUI.WindowTitle = $definition.Title
}
catch {
    # Redirect edilmiş/detached hostlarda RawUI bulunmayabilir.
}

if ($Worker -eq 'manager') {
    try {
        # Panel 23 satır ve en fazla 118 sütundur. Bir miktar giriş alanı bırakarak
        # tek kareyi ekrana sığdır; böylece satır kayması paneli aşağı itmez.
        $rawUi = $Host.UI.RawUI
        $maximum = $rawUi.MaxPhysicalWindowSize
        $targetWidth = [Math]::Min(120, $maximum.Width)
        $targetHeight = [Math]::Min(30, $maximum.Height)

        $buffer = $rawUi.BufferSize
        $buffer.Width = [Math]::Max($buffer.Width, $targetWidth)
        $buffer.Height = [Math]::Max($buffer.Height, $targetHeight)
        $rawUi.BufferSize = $buffer

        $window = $rawUi.WindowSize
        $window.Width = $targetWidth
        $window.Height = $targetHeight
        $rawUi.WindowSize = $window
    }
    catch {
        # Windows Terminal gibi boyutu uygulamanın yönettiği hostlarda alternatif
        # ekran tamponu yine sabit panel davranışını sağlar.
    }
}

$consoleLogDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\logs'
[IO.Directory]::CreateDirectory($consoleLogDirectory) | Out-Null
$consoleLogPath = Join-Path $consoleLogDirectory "$Worker-console.log"
$managerTranscriptPath = Join-Path $consoleLogDirectory 'manager-transcript.log'
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
    if ($Worker -eq 'manager') {
        # Pipe kullanılırsa Node stdout TTY niteliğini kaybeder ve Manager'ın
        # readline tabanlı canlı komut merkezi devre dışı kalır. Doğrudan konsol
        # bağlantısını koru; transcript ile aynı zamanda kalıcı log al.
        $transcriptStarted = $false
        try {
            Start-Transcript -LiteralPath $managerTranscriptPath -Append -ErrorAction Stop | Out-Null
            $transcriptStarted = $true
        }
        catch {
            Write-Host "[HOST] Manager transcript başlatılamadı: $($_.Exception.Message)"
        }
        & node $workerScript
        $exitCode = $LASTEXITCODE
        if ($transcriptStarted) {
            Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        }
    }
    else {
        & node $workerScript 2>&1 | ForEach-Object {
            Write-WorkerConsoleLine ([string]$_)
        }
        $exitCode = $LASTEXITCODE
    }
    if ($exitCode -eq 0) {
        break
    }
    if ($exitCode -eq 2) {
        Write-WorkerConsoleLine "[HOST] $Worker worker başka bir kopyası zaten çalıştığı için durdu (kod=2)."
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

