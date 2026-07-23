param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('account', 'group', 'sign', 'reward')]
    [string]$Worker,
    [switch]$CheckOnly,
    [switch]$Preview,
    [ValidateRange(72, 160)][int]$Width = 0
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$definitions = @{
    account = @{ Number = 1; Name = 'HESAP' }
    group   = @{ Number = 2; Name = 'GRUPLA' }
    sign    = @{ Number = 3; Name = 'SIGN' }
    reward  = @{ Number = 4; Name = 'REWARD' }
}
$definition = $definitions[$Worker]
$logPath = Join-Path $PSScriptRoot "pipeline-runtime\logs\$Worker-console.log"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [Console]::OutputEncoding
    & chcp.com 65001 *> $null
}
catch {
    # UTF-8 ayarı desteklenmese de salt-okunur log takibi devam edebilir.
}

if ($CheckOnly) {
    Write-Output "Worker log görüntüleyicisi doğrulandı: BOT $($definition.Number) -> $logPath"
    exit 0
}

try {
    $Host.UI.RawUI.WindowTitle = "LegendBots - BOT $($definition.Number) - $($definition.Name) - CANLI LOG"
}
catch {
    # RawUI olmayan hostlarda başlık ayarlanamaz; log takibi etkilenmez.
}

Clear-Host
$uiWidth = if ($Width -gt 0) { $Width } else { 92 }
if ($Width -le 0) {
    try { $uiWidth = [Math]::Max(72, [Math]::Min(118, [Console]::WindowWidth - 2)) } catch {}
}
$title = " LEGEND BOTS / BOT $($definition.Number) / $($definition.Name) / CANLI LOG "
$fill = [Math]::Max(1, $uiWidth - $title.Length - 2)
$displayPath = "pipeline-runtime\logs\$Worker-console.log"
Write-Host ('┌' + $title + ('─' * $fill) + '┐') -ForegroundColor Cyan
Write-Host ('│ ' + 'SALT OKUNUR • Ctrl+C ile kapat'.PadRight($uiWidth - 4) + ' │') -ForegroundColor Green
Write-Host ('│ ' + "Kaynak: $displayPath".PadRight($uiWidth - 4) + ' │') -ForegroundColor DarkGray
Write-Host ('└' + ('─' * ($uiWidth - 2)) + '┘') -ForegroundColor Cyan
Write-Host ''

if ($Preview) { exit 0 }

while (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
    Write-Host '  BEKLİYOR  Log dosyası henüz oluşmadı; worker çıktısı bekleniyor...' -ForegroundColor Yellow
    Start-Sleep -Seconds 2
}

Get-Content -LiteralPath $logPath -Encoding utf8 -Tail 120 -Wait
