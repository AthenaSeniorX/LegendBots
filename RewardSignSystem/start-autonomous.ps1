[CmdletBinding()]
param(
    [switch]$Preview,
    [ValidateRange(72, 160)][int]$Width = 0,
    [switch]$NoClear,
    [switch]$SkipRuntimeProbe
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
& chcp.com 65001 *> $null

function Read-YesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [bool]$DefaultYes = $true
    )
    $suffix = if ($DefaultYes) { '[E/h]' } else { '[e/H]' }
    while ($true) {
        Write-Host -NoNewline "  [?] " -ForegroundColor Cyan
        Write-Host -NoNewline "$Prompt " -ForegroundColor White
        Write-Host -NoNewline "$suffix " -ForegroundColor Gray
        $answer = (Read-Host).Trim().ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $DefaultYes
        }
        if ($answer -in @('e', 'evet', 'y', 'yes')) {
            return $true
        }
        if ($answer -in @('h', 'hayır', 'hayir', 'n', 'no')) {
            return $false
        }
        Write-Host "  [!] Lütfen 'E' veya 'H' girin." -ForegroundColor Yellow
    }
}

function Read-RequiredText {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    while ($true) {
        Write-Host -NoNewline "  ▶ " -ForegroundColor Cyan
        Write-Host -NoNewline "${Prompt}: " -ForegroundColor White
        $value = (Read-Host).Trim()
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return $value
        }
        Write-Host '  [!] Bu değer boş bırakılamaz.' -ForegroundColor Yellow
    }
}

function Read-PositiveInteger {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    while ($true) {
        Write-Host -NoNewline "  ▶ " -ForegroundColor Cyan
        Write-Host -NoNewline "${Prompt}: " -ForegroundColor White
        $raw = (Read-Host).Trim()
        $value = 0
        if ([int]::TryParse($raw, [ref]$value) -and $value -gt 0) {
            return $value
        }
        Write-Host '  [!] Pozitif bir tam sayı girin.' -ForegroundColor Yellow
    }
}

function Read-PlainTextSecret {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    Write-Host -NoNewline "  🔒 " -ForegroundColor Red
    Write-Host -NoNewline "${Prompt}: " -ForegroundColor White
    $secureValue = Read-Host -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ([string]::IsNullOrEmpty($plainValue)) {
            Write-Host '  [!] Şifre boş bırakılamaz.' -ForegroundColor Yellow
            return Read-PlainTextSecret $Prompt
        }
        return $plainValue
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Get-RequiredCredentialEmails {
    param(
        [Parameter(Mandatory = $true)][string]$Prefix,
        [Parameter(Mandatory = $true)][string]$Domain,
        [Parameter(Mandatory = $true)][int]$Start,
        [Parameter(Mandatory = $true)][int]$End
    )
    $emails = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for ($idx = $Start; $idx -le $End; $idx++) {
        $email = "$Prefix$idx@$Domain".ToLowerInvariant()
        if ($seen.Add($email)) { $emails.Add($email) }
    }
    foreach ($sourcePath in @(
        '.\pipeline-runtime\pipeline-state.json',
        '.\onaylanmis_gruplar.json'
    )) {
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        try {
            $payload = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourcePath | ConvertFrom-Json
            if ($sourcePath -like '*pipeline-state.json') {
                foreach ($groupProperty in $payload.groups.PSObject.Properties) {
                    foreach ($rawEmail in @($groupProperty.Value.account_emails)) {
                        $email = ([string]$rawEmail).Trim().ToLowerInvariant()
                        if ($email -and $seen.Add($email)) { $emails.Add($email) }
                    }
                }
            }
            else {
                foreach ($groupProperty in $payload.groups.PSObject.Properties) {
                    foreach ($account in @($groupProperty.Value.accounts)) {
                        $email = ([string]$account.email).Trim().ToLowerInvariant()
                        if ($email -and $seen.Add($email)) { $emails.Add($email) }
                    }
                }
            }
        }
        catch {
            throw "Credential hesap listesi okunamadı ($sourcePath): $($_.Exception.Message)"
        }
    }
    return $emails
}

function Get-UiWidth {
    if ($Width -gt 0) {
        return $Width
    }
    try {
        return [Math]::Max(72, [Math]::Min(118, [Console]::WindowWidth - 2))
    }
    catch {
        return 92
    }
}

function Limit-UiText {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][int]$MaxLength
    )
    $clean = ([string]$Text) -replace '[\r\n\t]+', ' '
    $clean = $clean.Trim()
    if ($MaxLength -le 0) { return '' }
    if ($clean.Length -le $MaxLength) { return $clean }
    if ($MaxLength -le 3) { return $clean.Substring(0, $MaxLength) }
    return $clean.Substring(0, $MaxLength - 3).TrimEnd() + '...'
}

function Write-PanelTop {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [string]$Meta = '',
        [ConsoleColor]$Color = [ConsoleColor]::Cyan
    )
    $inner = $script:UiWidth - 2
    $left = "─ $Title "
    $right = if ([string]::IsNullOrWhiteSpace($Meta)) { '─' } else { " $Meta ─" }
    $available = $inner - $left.Length - $right.Length
    if ($available -lt 1) {
        $left = "─ $(Limit-UiText $Title ([Math]::Max(8, $inner - $right.Length - 2))) "
        $available = [Math]::Max(1, $inner - $left.Length - $right.Length)
    }
    Write-Host ('┌' + $left + ('─' * $available) + $right + '┐') -ForegroundColor $Color
}

function Write-PanelBottom {
    param([ConsoleColor]$Color = [ConsoleColor]::DarkGray)
    Write-Host ('└' + ('─' * ($script:UiWidth - 2)) + '┘') -ForegroundColor $Color
}

function Write-PanelDivider {
    param([ConsoleColor]$Color = [ConsoleColor]::DarkGray)
    Write-Host ('├' + ('─' * ($script:UiWidth - 2)) + '┤') -ForegroundColor $Color
}

function Write-PanelLine {
    param(
        [AllowEmptyString()][string]$Text = '',
        [ConsoleColor]$Color = [ConsoleColor]::White
    )
    $available = $script:UiWidth - 4
    $line = Limit-UiText $Text $available
    Write-Host ('│ ' + $line.PadRight($available) + ' │') -ForegroundColor $Color
}

function Write-WrappedPanelLine {
    param(
        [AllowEmptyString()][string]$Text = '',
        [ConsoleColor]$Color = [ConsoleColor]::White,
        [string]$Prefix = ''
    )
    $available = $script:UiWidth - 4
    $remaining = (([string]$Text) -replace '[\r\n\t]+', ' ').Trim()
    $first = $true
    if ([string]::IsNullOrWhiteSpace($remaining)) {
        Write-PanelLine '' $Color
        return
    }
    while ($remaining.Length -gt 0) {
        $linePrefix = if ($first) { $Prefix } else { ' ' * $Prefix.Length }
        $lineWidth = [Math]::Max(8, $available - $linePrefix.Length)
        if ($remaining.Length -le $lineWidth) {
            $chunk = $remaining
            $remaining = ''
        }
        else {
            $cut = $remaining.LastIndexOf(' ', $lineWidth)
            if ($cut -lt [Math]::Floor($lineWidth * 0.55)) { $cut = $lineWidth }
            $chunk = $remaining.Substring(0, $cut).TrimEnd()
            $remaining = $remaining.Substring($cut).TrimStart()
        }
        Write-PanelLine ($linePrefix + $chunk) $Color
        $first = $false
    }
}

function Get-AgeLabel {
    param($Seconds)
    if ($null -eq $Seconds) { return 'bilinmiyor' }
    $value = [Math]::Max(0, [int]$Seconds)
    if ($value -lt 60) { return "$value sn önce" }
    if ($value -lt 3600) { return "$([Math]::Floor($value / 60)) dk önce" }
    if ($value -lt 86400) { return "$([Math]::Floor($value / 3600)) sa önce" }
    return "$([Math]::Floor($value / 86400)) gün önce"
}

function Get-ProgressBar {
    param(
        [int]$Percent,
        [int]$BarWidth = 24
    )
    $safePercent = [Math]::Max(0, [Math]::Min(100, $Percent))
    $safeWidth = [Math]::Max(8, $BarWidth)
    $filled = [Math]::Round(($safePercent / 100) * $safeWidth)
    return '[' + ('█' * $filled) + ('░' * ($safeWidth - $filled)) + ']'
}

function Get-LiveWorkerNames {
    $workerScripts = @{
        account = 'pipeline\account-worker.js'
        group   = 'pipeline\group-worker.js'
        sign    = 'pipeline\sign-worker.js'
        reward  = 'pipeline\reward-worker.js'
        manager = 'pipeline\manager.js'
    }
    $lockDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\worker-locks'
    if (-not (Test-Path -LiteralPath $lockDirectory -PathType Container)) { return @() }
    return @(
        Get-ChildItem -LiteralPath $lockDirectory -Filter '*.lock' -File | ForEach-Object {
            try {
                $lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName | ConvertFrom-Json
                $workerName = $_.BaseName
                $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$lock.pid)" -ErrorAction SilentlyContinue
                $expected = $workerScripts[$workerName]
                if ($process -and $expected -and
                    ([string]$process.CommandLine).Replace('/', '\').IndexOf(
                        $expected,
                        [StringComparison]::OrdinalIgnoreCase
                    ) -ge 0) {
                    $workerName
                }
            }
            catch {}
        }
    )
}

function Get-RuntimeOverview {
    if ($SkipRuntimeProbe -or -not (Get-Command node -ErrorAction SilentlyContinue)) {
        return $null
    }
    try {
        $raw = @(& node .\automation.js --dashboard 2>$null)
        if ($LASTEXITCODE -ne 0 -or $raw.Count -eq 0) { return $null }
        return (($raw -join "`n") | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Get-LatestErrorSignal {
    $logDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\logs'
    if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) { return $null }
    $latest = Get-ChildItem -LiteralPath $logDirectory -Filter '*-errors.jsonl' -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $latest) { return $null }
    return [pscustomobject]@{
        Worker = $latest.BaseName.Replace('-errors', '')
        AgeSeconds = [Math]::Max(0, [int](((Get-Date) - $latest.LastWriteTime).TotalSeconds))
    }
}

$environmentNames = @(
    'LEGEND_EMAIL_PREFIX',
    'LEGEND_EMAIL_DOMAIN',
    'LEGEND_ACCOUNT_START',
    'LEGEND_ACCOUNT_END',
    'LEGEND_PASSWORD',
    'LEGEND_ACCOUNT_PASSWORDS_B64',
    'LEGEND_OPERATION_MODE'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$script:UiWidth = Get-UiWidth
$script:IsCompact = $script:UiWidth -lt 94

try {
    # 1. Varsayılan Yapılandırmayı Yükle
    $configPath = '.\pipeline.config.json'
    $prefix = 'hadestxz'
    $domain = 'outlook.com'
    $start = 1
    $end = 100
    if (Test-Path -LiteralPath $configPath) {
        $configuration = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
        if ($configuration.account) {
            $prefix = [string]$configuration.account.prefix
            $domain = [string]$configuration.account.domain
            $start = [int]$configuration.account.start
            $end = [int]$configuration.account.end
        }
    }

    # Worker varsayılan seçimlerini kalıcı operatör niyetinden yükle. Manager'ın
    # geçici odak beklemeleri yeni başlatma planını yanlışlıkla değiştirmemeli.
    $workers = [ordered]@{
        account = $true
        group   = $true
        sign    = $true
        reward  = $true
        manager = $true
    }
    $workerTitles = @{
        account = 'BOT 1 / HESAP'
        group   = 'BOT 2 / GRUPLA'
        sign    = 'BOT 3 / SIGN'
        reward  = 'BOT 4 / REWARD'
        manager = 'BOT 0 / MANAGER'
    }
    $workerRoles = @{
        account = 'Hesap oluşturma ve kontrol'
        group   = 'FIFO paketleme ve gruplama'
        sign    = 'İmza döngüsü'
        reward  = 'Ödül ve kod toplama'
        manager = 'Sağlık, denge ve recovery'
    }

    $workerControlPath = '.\pipeline-runtime\worker-control.json'
    if (Test-Path -LiteralPath $workerControlPath) {
        try {
            $ctrl = Get-Content -Raw -Encoding UTF8 -LiteralPath $workerControlPath | ConvertFrom-Json
            foreach ($w in @($workers.Keys)) {
                if ($null -ne $ctrl.workers.$w) {
                    if ($null -ne $ctrl.workers.$w.operator_enabled) {
                        $workers[$w] = [bool]$ctrl.workers.$w.operator_enabled
                    }
                    else {
                        $workers[$w] = [bool]$ctrl.workers.$w.enabled
                    }
                }
            }
        } catch {}
    }
    # Bot 0 sistemin tek kontrol sahibidir; dört çalışma botundan bağımsız olarak
    # her yeni otonom oturumda açık tutulur.
    $workers['manager'] = $true

    $operationMode = 'normal'
    try {
        $pipelineConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath '.\pipeline.config.json' | ConvertFrom-Json
        if ($pipelineConfig.operation_mode -in @('normal', 'safe', 'extreme')) {
            $operationMode = [string]$pipelineConfig.operation_mode
        }
    } catch {}

    $sessionConfigPath = '.\pipeline-runtime\session-config.json'
    if (Test-Path -LiteralPath $sessionConfigPath -PathType Leaf) {
        try {
            $sessionConfiguration = Get-Content -Raw -Encoding UTF8 -LiteralPath $sessionConfigPath | ConvertFrom-Json
            if ($sessionConfiguration.operation_mode -in @('production', 'test', 'normal', 'safe', 'extreme')) {
                $operationMode = [string]$sessionConfiguration.operation_mode
            }
        }
        catch {}
    }
    $sharedPassword = $true
    $passwordSet = $false

    function Show-Header {
        param($Overview)
        $healthyCount = 0
        $statusLabel = 'YENİ OTURUM'
        $statusColor = [ConsoleColor]::DarkGray
        $statusMeta = 'canlı veri yok'
        if ($Overview -and $Overview.workers) {
            $healthyCount = @(
                $Overview.workers.PSObject.Properties |
                    Where-Object { $_.Value.healthy }
            ).Count
            $managerHealthy = [bool]$Overview.workers.manager.healthy
            if ($managerHealthy) {
                $statusLabel = 'SİSTEM CANLI'
                $statusColor = [ConsoleColor]::Green
            }
            elseif ($healthyCount -gt 0) {
                $statusLabel = 'KISMİ ÇALIŞMA'
                $statusColor = [ConsoleColor]::Yellow
            }
            else {
                $statusLabel = 'SİSTEM HAZIR'
                $statusColor = [ConsoleColor]::DarkGray
            }
            $updatedAge = [Math]::Max(0, [int](((Get-Date) - ([DateTime]$Overview.updated_at).ToLocalTime()).TotalSeconds))
            $statusMeta = "$healthyCount/5 sağlıklı • $(Get-AgeLabel $updatedAge) güncellendi"
        }

        Write-PanelTop 'LEGEND BOTS' 'CONTROL CENTER v3.0' Cyan
        Write-PanelLine 'OTONOM OPERASYON, RECOVERY VE GÜVENLİ BAŞLATMA MERKEZİ' Cyan
        Write-PanelDivider DarkGray
        Write-PanelLine "● $statusLabel  |  $statusMeta" $statusColor
        Write-PanelBottom Cyan
    }

    function Render-Dashboard {
        if (-not $NoClear -and -not $Preview) { Clear-Host }
        $overview = Get-RuntimeOverview
        $script:CurrentOverview = $overview
        $script:DashboardHasLiveSystem = $false
        if ($overview -and $overview.workers) {
            $script:DashboardHasLiveSystem = @(
                $overview.workers.PSObject.Properties |
                    Where-Object { $_.Value.healthy }
            ).Count -gt 0
        }

        Show-Header $overview
        Write-Host ''

        $selectedCount = @($workers.Values | Where-Object { $_ }).Count
        Write-PanelTop 'WORKER FİLOSU' "SEÇİLİ $selectedCount/5" Cyan
        if (-not $script:IsCompact) {
            Write-PanelLine 'TUŞ  BOT / GÖREV          SEÇİM     CANLI DURUM       KUYRUK   HEARTBEAT' DarkGray
            Write-PanelDivider DarkGray
        }

        $workerNumbers = @{ account = '1'; group = '2'; sign = '3'; reward = '4'; manager = '5' }
        foreach ($w in $workers.Keys) {
            $selection = if ($workers[$w]) { 'AÇIK' } else { 'KAPALI' }
            $runtime = 'BAŞLATILMADI'
            $queue = '-'
            $age = '-'
            $rowColor = if ($workers[$w]) { [ConsoleColor]::White } else { [ConsoleColor]::DarkGray }
            if ($overview -and $overview.workers.$w) {
                $details = $overview.workers.$w
                $runtime = [string]$details.statusLabel
                if ($null -ne $details.queue) { $queue = [string]$details.queue }
                if ($null -ne $details.ageSeconds) { $age = Get-AgeLabel $details.ageSeconds }
                if ($details.healthy) {
                    $rowColor = [ConsoleColor]::Green
                }
                elseif ($runtime -match 'ÖLÜ|YANITSIZ') {
                    $rowColor = [ConsoleColor]::Red
                }
                elseif ($runtime -match 'GERİ|BEKLE|BAŞLAT|ODAK|KAPANIYOR') {
                    $rowColor = [ConsoleColor]::Yellow
                }
            }
            if ($script:IsCompact) {
                Write-PanelLine ("[{0}] {1,-17} {2,-6} • {3,-15} • Q:{4} • {5}" -f
                    $workerNumbers[$w], $workerTitles[$w], $selection, $runtime, $queue, $age) $rowColor
            }
            else {
                Write-PanelLine ("[{0}]  {1,-20} {2,-9} {3,-17} {4,-7} {5}" -f
                    $workerNumbers[$w], $workerTitles[$w], $selection, $runtime, $queue, $age) $rowColor
            }
        }
        Write-PanelDivider DarkGray
        Write-PanelLine 'Seçim = operatör niyeti  •  Canlı durum = gerçek süreç ve heartbeat' DarkGray
        Write-PanelBottom Cyan
        Write-Host ''

        $totalAccs = [Math]::Max(1, ($end - $start + 1))
        $completion = 0
        $pipelineMeta = 'RUNTIME BEKLİYOR'
        if ($overview -and $overview.pools) {
            $completion = [int]$overview.pools.completion_percent
            $pipelineMeta = "%$completion TAMAMLANDI"
        }
        Write-PanelTop 'PIPELINE NABZI' $pipelineMeta Green
        if ($overview -and $overview.pools) {
            $barWidth = [Math]::Min(30, [Math]::Max(14, $script:UiWidth - 40))
            Write-PanelLine ("$(Get-ProgressBar $completion $barWidth)  %$completion  •  $($overview.pools.account_signed)/$($overview.pools.target_total) hesap imzalandı") Green
            if ($script:IsCompact) {
                Write-PanelLine "Hazır hesap $($overview.pools.account_ready)  •  Gruplama $($overview.pools.grouping_retry)  •  İmza kuyruğu $($overview.pools.sign_ready)" White
                Write-PanelLine "İmzalı paket $($overview.pools.signed_packages)  •  Ödül kuyruğu $($overview.pools.reward_ready)" White
            }
            else {
                Write-PanelLine "Hazır hesap: $($overview.pools.account_ready)  |  Gruplama: $($overview.pools.grouping_retry)  |  İmza kuyruğu: $($overview.pools.sign_ready)  |  İmzalı paket: $($overview.pools.signed_packages)  |  Ödül: $($overview.pools.reward_ready)" White
            }

            $cooldownText = 'bekleme yok'
            if ($overview.network -and $overview.network.activeCooldowns) {
                $cooldowns = @(
                    $overview.network.activeCooldowns.PSObject.Properties |
                        ForEach-Object { "$($_.Name) $($_.Value) sn" }
                )
                if ($cooldowns.Count -gt 0) { $cooldownText = $cooldowns -join ', ' }
            }
            $recent403 = if ($overview.network) { [int]$overview.network.recent403Count } else { 0 }
            Write-PanelLine "Ağ kalkanı: $recent403 yakın 403  •  Aktif güvenli bekleme: $cooldownText" $(if ($recent403 -gt 0) { 'Yellow' } else { 'Green' })

            $latestEvent = @($overview.recentEvents | Select-Object -Last 1)
            if ($latestEvent.Count -gt 0) {
                Write-WrappedPanelLine $latestEvent[0].message DarkGray 'Son olay: '
            }
        }
        else {
            Write-PanelLine 'Henüz okunabilir runtime verisi yok; yeni oturum ayarları hazır.' DarkGray
        }
        $latestError = Get-LatestErrorSignal
        if ($latestError) {
            Write-PanelLine "Son hata sinyali: $($latestError.Worker) • $(Get-AgeLabel $latestError.AgeSeconds) • ayrıntı için [L]" Yellow
        }
        Write-PanelBottom Green
        Write-Host ''

        $modeText = if ($operationMode -eq 'extreme') { 'EXTREME / AGRESİF HIZ' } elseif ($operationMode -eq 'safe') { 'SAFE / YAVAŞ KORUMA' } else { 'NORMAL / DENGELİ HIZ' }
        $modeColor = if ($operationMode -eq 'safe') { 'Green' } elseif ($operationMode -eq 'extreme') { 'Red' } else { 'Yellow' }
        $passwordMode = if ($sharedPassword) { 'ortak parola' } else { 'hesap bazlı parola' }
        $passwordState = if ($passwordSet) { 'güvenli bellekte hazır' } else { 'başlatırken maskeli alınacak' }
        Write-PanelTop 'OTURUM PLANI' "$totalAccs HESAP" Yellow
        Write-PanelLine "Kimlik: $prefix{NUMARA}@$domain  •  Aralık: $start → $end" White
        if ($script:IsCompact) {
            Write-PanelLine "Çalışma: $modeText" $modeColor
            Write-PanelLine "Parola: $passwordMode / $passwordState" White
            Write-WrappedPanelLine 'Parolalar düz metin dosyaya yazılmaz; başlangıçta Windows DPAPI ile korunur.' DarkGray
        }
        else {
            Write-PanelLine "Çalışma: $modeText  •  Parola: $passwordMode / $passwordState" $modeColor
            Write-PanelLine 'Parolalar düz metin dosyaya yazılmaz; başlangıçta Windows DPAPI ile korunur.' DarkGray
        }
        Write-PanelBottom Yellow
        Write-Host ''

        Write-PanelTop 'KOMUT PALETİ' 'KLAVYE ODAKLI' Cyan
        Write-PanelLine '[1-4] Bot kontrolü [A/P] Hepsi   [H] Hesap planı   [M] Mod' White
        Write-PanelLine '[K] Parola         [D] Tanılama [O] Ayrıntılı özet [L] Canlı log' White
        Write-PanelLine '[R] Yenile         [?] Yardım   [Q] Güvenli çıkış' White
        Write-PanelDivider DarkGray
        if ($script:DashboardHasLiveSystem) {
            Write-PanelLine '[S] YENİ BAŞLATMA KİLİTLİ — çalışan oturum korunuyor' Yellow
        }
        else {
            Write-PanelLine '[S] SEÇİLEN PLANI GÜVENLİ BİÇİMDE BAŞLAT' Green
        }
        Write-PanelBottom Cyan
    }

    function Wait-ForMenu {
        Write-Host ''
        Write-Host -NoNewline '  Enter ile kontrol merkezine dönün...' -ForegroundColor DarkGray
        [void](Read-Host)
    }

    function Show-Diagnostics {
        if (-not $NoClear) { Clear-Host }
        Write-PanelTop 'SİSTEM TANILAMA' 'SALT OKUNUR' Cyan
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($nodeCommand) {
            $nodeVersion = (& node --version 2>$null | Select-Object -First 1)
            Write-PanelLine "PASS  Node.js $nodeVersion" Green
        }
        else { Write-PanelLine 'FAIL  Node.js PATH içinde bulunamadı' Red }
        if ($pythonCommand) {
            $pythonVersion = (& python --version 2>&1 | Select-Object -First 1)
            Write-PanelLine "PASS  $pythonVersion" Green
        }
        else { Write-PanelLine 'FAIL  Python PATH içinde bulunamadı' Red }

        try {
            [void](Get-Content -Raw -Encoding UTF8 -LiteralPath '.\pipeline.config.json' | ConvertFrom-Json)
            Write-PanelLine 'PASS  pipeline.config.json okunuyor' Green
        }
        catch { Write-PanelLine 'FAIL  pipeline.config.json geçersiz' Red }

        $credentialText = if (Test-Path -LiteralPath '.\pipeline-runtime\credentials.dpapi.json' -PathType Leaf) {
            'PASS  DPAPI credential kaydı mevcut'
        } else { 'INFO  DPAPI credential kaydı ilk başlatmada üretilecek' }
        Write-PanelLine $credentialText $(if ($credentialText -like 'PASS*') { 'Green' } else { 'Yellow' })

        if ($nodeCommand) {
            $preflight = @(& node .\automation.js --check --no-desktop 2>&1)
            if ($LASTEXITCODE -eq 0) {
                Write-PanelLine 'PASS  Node bağımlılıkları, state, hostlar ve supervisor' Green
            }
            else {
                Write-PanelLine 'FAIL  Otonom ön kontrol başarısız' Red
                Write-WrappedPanelLine ($preflight -join ' ') Red '      '
            }
        }

        $liveNames = @(Get-LiveWorkerNames)
        if ($liveNames.Count -gt 0) {
            Write-PanelLine "INFO  Çalışan süreçler: $($liveNames -join ', ')" Yellow
        }
        else { Write-PanelLine 'PASS  Yeni başlangıcı engelleyen çalışan süreç yok' Green }

        $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($PSScriptRoot).Substring(0, 1)) -ErrorAction SilentlyContinue
        if ($drive) {
            Write-PanelLine ("INFO  Boş disk alanı: {0:N1} GB" -f ($drive.Free / 1GB)) DarkGray
        }
        Write-PanelBottom Cyan
        Wait-ForMenu
    }

    function Show-DetailedOverview {
        if (-not $NoClear) { Clear-Host }
        $overview = Get-RuntimeOverview
        Write-PanelTop 'OPERASYON ÖZETİ' 'CANLI SNAPSHOT' Cyan
        if (-not $overview) {
            Write-PanelLine 'Runtime özeti alınamadı. Node.js ve state dosyalarını [D] ile kontrol edin.' Yellow
            Write-PanelBottom Cyan
            Wait-ForMenu
            return
        }
        foreach ($w in $workers.Keys) {
            $details = $overview.workers.$w
            $action = if ($details.action) { [string]$details.action } else { 'bekliyor' }
            $pidText = if ($details.pid) { "PID $($details.pid)" } else { 'PID -' }
            Write-PanelLine "$($workerTitles[$w]): $($details.statusLabel) • $pidText • Q:$($details.queue) • $action" $(if ($details.healthy) { 'Green' } else { 'Yellow' })
        }
        Write-PanelDivider DarkGray
        Write-PanelLine "Hesap: $($overview.pools.total_accounts)/$($overview.pools.target_total) • İmzalı: $($overview.pools.account_signed) • Paket: $($overview.pools.signed_packages) • Sandık: $($overview.pools.total_claimed_chests)" White
        Write-PanelLine "Ağ: $($overview.network.recent403Count) yakın 403 • Koruma ve jittered backoff aktif" $(if ([int]$overview.network.recent403Count -gt 0) { 'Yellow' } else { 'Green' })
        Write-PanelBottom Cyan
        Write-Host ''

        Write-PanelTop 'SON OLAYLAR' 'EN YENİ 5' DarkGray
        $events = @($overview.recentEvents | Select-Object -Last 5)
        if ($events.Count -eq 0) { Write-PanelLine 'Henüz olay kaydı yok.' DarkGray }
        foreach ($event in $events) {
            $eventTime = try { ([DateTime]$event.at).ToLocalTime().ToString('HH:mm:ss') } catch { '--:--:--' }
            Write-WrappedPanelLine $event.message DarkGray "$eventTime  "
        }
        Write-PanelBottom DarkGray
        Wait-ForMenu
    }

    function Show-Help {
        if (-not $NoClear) { Clear-Host }
        Write-PanelTop 'HIZLI YARDIM' 'GÜVENLİ OPERASYON' Cyan
        Write-WrappedPanelLine '1-4 sistem kapalıyken sonraki başlatma planını, sistem canlıyken kalıcı operatör niyetini değiştirir. Worker aktif işini yarıda kesmeden güvenli sınırda durur. Bot 0 / Manager kapatılamaz.' White
        Write-WrappedPanelLine 'O ayrıntılı canlı özeti açar. L seçilen worker logunu salt okunur ayrı bir PowerShell penceresinde takip eder.' White
        Write-WrappedPanelLine 'D bağımlılıkları, state, DPAPI kaydı, PowerShell host zinciri ve supervisor yapılandırmasını değiştirmeden denetler.' White
        Write-WrappedPanelLine 'S başlamadan önce çalışan süreç kilidini tekrar doğrular ve son plan için açık onay ister. Mevcut oturum varken ikinci başlangıç engellenir.' Yellow
        Write-PanelBottom Cyan
        Wait-ForMenu
    }

    function Open-WorkerLog {
        Write-Host ''
        Write-Host -NoNewline '  Log seçin [1=Hesap, 2=Grupla, 3=Sign, 4=Reward, Q=İptal]: ' -ForegroundColor Cyan
        $logChoice = (Read-Host).Trim().ToUpperInvariant()
        $logMap = @{ '1' = 'account'; '2' = 'group'; '3' = 'sign'; '4' = 'reward' }
        if ($logChoice -eq 'Q') { return }
        if (-not $logMap.ContainsKey($logChoice)) {
            Write-Host '  Geçersiz log seçimi.' -ForegroundColor Yellow
            Start-Sleep -Seconds 1
            return
        }
        $viewerPath = Join-Path $PSScriptRoot 'view-worker-log.ps1'
        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$viewerPath`" -Worker $($logMap[$logChoice])"
        Start-Process -FilePath 'powershell.exe' -WorkingDirectory $PSScriptRoot -WindowStyle Normal -ArgumentList $arguments
    }

    function Set-WorkerIntent {
        param(
            [Parameter(Mandatory = $true)][ValidateSet('account', 'group', 'sign', 'reward')][string]$Worker,
            [Parameter(Mandatory = $true)][bool]$Enabled
        )
        if ($script:DashboardHasLiveSystem) {
            $flag = if ($Enabled) { '--enable-worker' } else { '--disable-worker' }
            & node .\automation.js $flag $Worker *> $null
            if ($LASTEXITCODE -ne 0) {
                throw "$($workerTitles[$Worker]) canlı operatör niyeti güncellenemedi."
            }
        }
        $workers[$Worker] = $Enabled
    }

    function Confirm-LaunchPlan {
        $liveNames = @(Get-LiveWorkerNames)
        if ($liveNames.Count -gt 0) {
            Write-Host ''
            Write-Host "  [KİLİT] Zaten çalışan oturum bulundu: $($liveNames -join ', ')." -ForegroundColor Yellow
            $killAnswer = Read-YesNo 'Eski oturumu ve çalışan tüm arka plan botlarını hemen durdurup temizlemek istiyor musunuz?' $true
            if ($killAnswer) {
                Write-Host '  [!] Eski botlar kapatılıyor ve kilitler temizleniyor...' -ForegroundColor Cyan
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\durdur-hepsini.ps1
                Start-Sleep -Seconds 1
            } else {
                return $false
            }
        }
        $selectedTitles = @(
            foreach ($w in $workers.Keys) {
                if ($workers[$w]) { $workerTitles[$w] }
            }
        )
        Write-Host ''
        Write-PanelTop 'BAŞLATMA ONAYI' 'SON GÜVENLİK KAPISI' Yellow
        Write-WrappedPanelLine ("Workerlar: " + ($selectedTitles -join ', ')) White
        Write-PanelLine "Hesap planı: $prefix$start@$domain → $prefix$end@$domain ($([Math]::Max(1, $end - $start + 1)) hesap)" White
        Write-PanelLine "Çalışma modu: $operationMode • Supervisor ve recovery: aktif" Green
        Write-PanelBottom Yellow
        return (Read-YesNo 'Bu planla otonom sistemi başlatmak istiyor musunuz?' $false)
    }

    # İnteraktif Menü Döngüsü
    $systemStarted = $false
    while (-not $systemStarted) {
        Render-Dashboard
        if ($Preview) { return }

        Write-Host ''
        Write-Host -NoNewline '  KOMUT  [1-5, A, P, H, M, K, D, O, L, R, ?, S, Q] › ' -ForegroundColor Cyan
        $choice = (Read-Host).Trim().ToUpperInvariant()

        switch ($choice) {
            '1' { Set-WorkerIntent 'account' (-not $workers['account']) }
            '2' { Set-WorkerIntent 'group'   (-not $workers['group']) }
            '3' { Set-WorkerIntent 'sign'    (-not $workers['sign']) }
            '4' { Set-WorkerIntent 'reward'  (-not $workers['reward']) }
            '5' {
                Write-Host '  [!] Bot 0 / Manager bu mimaride zorunludur ve kapatılamaz.' -ForegroundColor Yellow
                Start-Sleep -Seconds 1
            }
            'A' {
                foreach ($w in @('account', 'group', 'sign', 'reward')) {
                    Set-WorkerIntent $w $true
                }
                $workers['manager'] = $true
            }
            'P' {
                $applyDisable = $true
                if ($script:DashboardHasLiveSystem) {
                    $applyDisable = Read-YesNo 'Dört çalışma botu güvenli duruşa alınsın mı?' $false
                }
                if ($applyDisable) {
                    foreach ($w in @('account', 'group', 'sign', 'reward')) {
                        Set-WorkerIntent $w $false
                    }
                    $workers['manager'] = $true
                }
            }
            'H' {
                Write-Host ''
                Write-Host ' ─── HESAP PLANI DÜZENLEME ───' -ForegroundColor Yellow
                $prefix = Read-RequiredText 'E-posta ön eki (örn: hadestxz)'
                $domain = Read-RequiredText 'E-posta alan adı (örn: outlook.com)'
                $start = Read-PositiveInteger 'Başlangıç hesap numarası'
                while ($true) {
                    $end = Read-PositiveInteger 'Bitiş hesap numarası'
                    if ($end -ge $start) { break }
                    Write-Host '  [!] Bitiş numarası başlangıç numarasından küçük olamaz.' -ForegroundColor Yellow
                }
            }
            'M' {
                if ($operationMode -eq 'normal') {
                    $operationMode = 'safe'
                } elseif ($operationMode -eq 'safe') {
                    $operationMode = 'extreme'
                } else {
                    $operationMode = 'normal'
                }
            }
            'K' {
                Write-Host ''
                Write-Host ' ─── GÜVENLİK VE ŞİFRE YÖNETİMİ ───' -ForegroundColor Yellow
                $sharedPassword = Read-YesNo 'Bütün hesaplar aynı şifreyi mi kullanıyor?' $true
                if ($sharedPassword) {
                    $env:LEGEND_PASSWORD = Read-PlainTextSecret 'Hesapların ortak şifresi'
                    Remove-Item Env:\LEGEND_ACCOUNT_PASSWORDS_B64 -ErrorAction SilentlyContinue
                } else {
                    $emailList = @(Get-RequiredCredentialEmails $prefix $domain $start $end)
                    Write-Host "  $($emailList.Count) hesap için parola maskeli olarak alınacak." -ForegroundColor Yellow
                    if ($emailList.Count -gt 50 -and -not (Read-YesNo 'Çok sayıda parola girişi gerekecek. Devam edilsin mi?' $false)) {
                        break
                    }
                    $passwordMap = [ordered]@{}
                    foreach ($email in $emailList) {
                        $passwordMap[$email] = Read-PlainTextSecret "$email şifresi"
                    }
                    $passwordJson = $passwordMap | ConvertTo-Json -Compress
                    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($passwordJson)
                    $encodedPasswords = [Convert]::ToBase64String($passwordBytes)
                    if ($encodedPasswords.Length -gt 30000) {
                        throw 'Hesap bazlı parola planı Windows ortam sınırını aşıyor; aralığı küçültün veya ortak parola kullanın.'
                    }
                    $env:LEGEND_ACCOUNT_PASSWORDS_B64 = $encodedPasswords
                    Remove-Item Env:\LEGEND_PASSWORD -ErrorAction SilentlyContinue
                    $passwordMap.Clear()
                    $passwordJson = $null
                    $passwordBytes = $null
                    $encodedPasswords = $null
                }
                $passwordSet = $true
                Write-Host '  PASS  Parola bilgileri güvenli belleğe alındı.' -ForegroundColor Green
                Start-Sleep -Seconds 1
            }
            'D' { Show-Diagnostics }
            'O' { Show-DetailedOverview }
            'L' { Open-WorkerLog }
            'R' { }
            '?' { Show-Help }
            'S' {
                if (Confirm-LaunchPlan) {
                    $systemStarted = $true
                }
            }
            'Q' {
                Write-Host ''
                $liveNames = @(Get-LiveWorkerNames)
                if ($liveNames.Count -gt 0) {
                    Write-Host "  [!] Şu an arka planda çalışan botlar var: $($liveNames -join ', ')." -ForegroundColor Yellow
                    $killOnQuit = Read-YesNo 'Çıkış yaparken çalışan tüm bot süreçlerini durdurmak istiyor musunuz?' $true
                    if ($killOnQuit) {
                        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\durdur-hepsini.ps1
                    }
                }
                Write-Host '  [!] Kontrol merkezinden çıkıldı.' -ForegroundColor Yellow
                exit 0
            }
            default {
                Write-Host '  Geçersiz komut. [?] ile hızlı yardımı açabilirsiniz.' -ForegroundColor Yellow
                Start-Sleep -Seconds 1
            }
        }
    }

    # İkinci başlatıcının çalışan süreçlerin oturum planını değiştirmesine izin
    # verme. PID yeniden kullanımında yalnız beklenen worker komut satırı eşleşir.
    $workerScripts = @{
        account = 'pipeline\account-worker.js'
        group   = 'pipeline\group-worker.js'
        sign    = 'pipeline\sign-worker.js'
        reward  = 'pipeline\reward-worker.js'
        manager = 'pipeline\manager.js'
    }
    $liveWorkers = @()
    $workerLockDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\worker-locks'
    if (Test-Path -LiteralPath $workerLockDirectory -PathType Container) {
        $liveWorkers = @(
            Get-ChildItem -LiteralPath $workerLockDirectory -Filter '*.lock' -File | ForEach-Object {
                try {
                    $lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName | ConvertFrom-Json
                    $workerName = $_.BaseName
                    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$lock.pid)" -ErrorAction SilentlyContinue
                    $expected = $workerScripts[$workerName]
                    if ($process -and $expected -and
                        ([string]$process.CommandLine).Replace('/', '\').IndexOf(
                            $expected,
                            [StringComparison]::OrdinalIgnoreCase
                        ) -ge 0) {
                        $workerName
                    }
                }
                catch {}
            }
        )
    }
    if ($liveWorkers.Count -gt 0) {
        throw (
            "Zaten çalışan pipeline süreci var: $($liveWorkers -join ', '). " +
            'İkinci oturum açılmadı; mevcut sistemi Bot 0 üzerinden yönetin.'
        )
    }

    # 2. SEÇİLEN AYARLARI SİSTEME VE ORTAMA UYGULA
    if (-not $NoClear) { Clear-Host }
    Show-Header $null
    Write-Host ''
    Write-PanelTop 'GÜVENLİ BAŞLATMA AKIŞI' 'ADIM 1/5' Cyan
    Write-PanelLine 'Çalışma ortamı ve oturum planı hazırlanıyor...' Green
    Write-PanelBottom Cyan
    $env:LEGEND_EMAIL_PREFIX = $prefix
    $env:LEGEND_EMAIL_DOMAIN = $domain
    $env:LEGEND_ACCOUNT_START = [string]$start
    $env:LEGEND_ACCOUNT_END = [string]$end
    $env:LEGEND_OPERATION_MODE = $operationMode

    if (-not $passwordSet) {
        Write-Host ''
        Write-Host ' [2/5] Güvenlik ve Şifre Girişi' -ForegroundColor Green
        $sharedPassword = Read-YesNo 'Bütün hesaplar aynı şifreyi mi kullanıyor?' $true
        if ($sharedPassword) {
            $env:LEGEND_PASSWORD = Read-PlainTextSecret 'Hesapların ortak şifresi'
            Remove-Item Env:\LEGEND_ACCOUNT_PASSWORDS_B64 -ErrorAction SilentlyContinue
        } else {
            $emailList = @(Get-RequiredCredentialEmails $prefix $domain $start $end)
            $passwordMap = [ordered]@{}
            foreach ($email in $emailList) {
                $passwordMap[$email] = Read-PlainTextSecret "$email şifresi"
            }
            $passwordJson = $passwordMap | ConvertTo-Json -Compress
            $passwordBytes = [Text.Encoding]::UTF8.GetBytes($passwordJson)
            $encodedPasswords = [Convert]::ToBase64String($passwordBytes)
            if ($encodedPasswords.Length -gt 30000) {
                throw 'Hesap bazlı parola planı Windows ortam sınırını aşıyor; aralığı küçültün veya ortak parola kullanın.'
            }
            $env:LEGEND_ACCOUNT_PASSWORDS_B64 = $encodedPasswords
            Remove-Item Env:\LEGEND_PASSWORD -ErrorAction SilentlyContinue
            $passwordMap.Clear()
            $passwordJson = $null
            $passwordBytes = $null
            $encodedPasswords = $null
        }
    }

    Write-Host ''
    Write-Host ' [3/5] Oturum ve Credential Kaydı Oluşturuluyor...' -ForegroundColor Green
    & node .\automation.js --persist-session
    if ($LASTEXITCODE -ne 0) {
        throw 'Dinamik oturum planı ve korunan credential kaydı oluşturulamadı.'
    }

    Write-Host ''
    Write-Host ' [4/5] Sistem Ön Kontrolü Yapılıyor...' -ForegroundColor Green
    & node .\automation.js --check
    if ($LASTEXITCODE -ne 0) {
        throw 'Ön kontrol başarısız; hiçbir worker başlatılmadı.'
    }
    Write-Host '  PASS  Ön kontrol başarılı' -ForegroundColor Green

    Write-Host ''
    Write-Host ' [5/5] Worker Durumları Uygulanıyor ve Sistem Başlatılıyor...' -ForegroundColor Green
    foreach ($w in $workers.Keys) {
        $isEnabled = $workers[$w]
        if ($isEnabled) {
            & node .\automation.js --enable-worker $w *> $null
            if ($LASTEXITCODE -ne 0) { throw "$w worker etkinleştirilemedi." }
            Write-Host "  PASS  $($workerTitles[$w]) seçildi" -ForegroundColor Green
        } else {
            & node .\automation.js --disable-worker $w *> $null
            if ($LASTEXITCODE -ne 0) { throw "$w worker devre dışı bırakılamadı." }
            Write-Host "  SKIP  $($workerTitles[$w]) kapalı bırakıldı" -ForegroundColor DarkGray
        }
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\supervisor-host.ps1 -Install
    if ($LASTEXITCODE -ne 0) {
        throw 'Bağımsız supervisor görevi kurulamadı.'
    }

    # Tek süreç sahibi zinciri: başlangıç betiği yalnız Bot 0 hostunu açar;
    # Bot 0 kalıcı kontrol dosyasına göre dört çalışma botunun hostlarını açar.
    # Böylece başlangıç ile manager aynı workerı eşzamanlı başlatmaya yarışmaz.
    $workerHost = Join-Path $PSScriptRoot 'worker-host.ps1'
    $managerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$workerHost`" -Worker manager"
    Start-Process -FilePath 'powershell.exe' `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Normal `
        -ArgumentList $managerArguments
    $activeWorkerCount = @(
        @('account', 'group', 'sign', 'reward') |
            Where-Object { $workers[$_] }
    ).Count
    $launchedCount = 1 + $activeWorkerCount
    Write-Host ''
    Write-PanelTop 'OTOMASYON BAŞLATILDI' "$launchedCount BOT" Green
    Write-PanelLine 'BOT 0 / MANAGER canlı komut merkezi ön planda açıldı.' Green
    Write-PanelLine "Manager $activeWorkerCount etkin çalışma botunu tek sahip olarak başlatacak." Cyan
    Write-PanelLine 'Kapalı workerlar supervisor tarafından otomatik olarak diriltilmeyecek.' Yellow
    Write-PanelBottom Green
    Write-Host ''
}
catch {
    Write-Host ''
    Write-PanelTop 'BAŞLATMA BAŞARISIZ' 'GÜVENLİ DURUŞ' Red
    Write-WrappedPanelLine $_.Exception.Message Red 'Hata: '
    Write-PanelLine 'Hiçbir yeni worker başlatılmadıysa [D] tanılama ile ayrıntıları kontrol edin.' Yellow
    Write-PanelBottom Red
    Write-Host ''
    Read-Host '  Ana menüye dönmek için Enter tuşuna basın...'
}
finally {
    foreach ($name in $environmentNames) {
        $previousValue = $previousEnvironment[$name]
        if ($null -eq $previousValue) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $previousValue, 'Process')
        }
    }
}
