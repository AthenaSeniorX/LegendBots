[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$adminRole = [Security.Principal.WindowsBuiltInRole]::Administrator

if (-not $principal.IsInRole($adminRole)) {
    Write-Host '[BILGI] Yonetici izni isteniyor...' -ForegroundColor Yellow
    $arguments = @(
        '-NoProfile'
        '-ExecutionPolicy'
        'Bypass'
        '-File'
        "`"$PSCommandPath`""
    )
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
    exit 0
}

$queryExe = Join-Path $env:SystemRoot 'System32\query.exe'
$tsconExe = Join-Path $env:SystemRoot 'System32\tscon.exe'

if (-not (Test-Path -LiteralPath $queryExe) -or -not (Test-Path -LiteralPath $tsconExe)) {
    throw 'query.exe veya tscon.exe bulunamadi. Bu arac Windows Server/RDS bilesenlerini gerektirir.'
}

$sessionLines = @(& $queryExe session 2>&1)
$currentLine = $sessionLines |
    Where-Object { "$_" -match '^\s*>' } |
    Select-Object -First 1

if (-not $currentLine) {
    Write-Host 'Aktif oturum bulunamadi. query session ciktisi:' -ForegroundColor Red
    $sessionLines | ForEach-Object { Write-Host "$_" }
    throw 'Mevcut RDP oturum kimligi belirlenemedi.'
}

$pattern = '^\s*>\s*(?<session>\S+)\s+(?<username>\S+)\s+(?<id>\d+)\s+'
if ("$currentLine" -notmatch $pattern) {
    Write-Host "Cozumlenemeyen oturum satiri: $currentLine" -ForegroundColor Red
    throw 'RDP oturum satiri guvenli bicimde cozumlenemedi; tscon calistirilmadi.'
}

$sessionName = $Matches.session
$sessionId = [int]$Matches.id
$username = $Matches.username

Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' LegendBots - RDP Oturumunu Konsola Aktarma' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host " Kullanici : $username"
Write-Host " Oturum    : $sessionName"
Write-Host " Oturum ID : $sessionId"
Write-Host ''

if ($sessionName -ieq 'console') {
    Write-Host '[BILGI] Oturum zaten console oturumunda; islem gerekmiyor.' -ForegroundColor Green
    exit 0
}

Write-Host '[BILGI] Oturum console masaustune aktariliyor.' -ForegroundColor Yellow
Write-Host 'Baglanti simdi kesilebilir; bu normaldir. Windows oturumunu kapatmayin (Sign out yapmayin).' -ForegroundColor Yellow

& $tsconExe $sessionId /dest:console /v
$tsconExitCode = $LASTEXITCODE
if ($tsconExitCode -ne 0) {
    throw "tscon basarisiz oldu (cikis kodu: $tsconExitCode). Oturum degistirilmedi."
}

Write-Host '[BASARILI] RDP oturumu console masaustune aktarildi.' -ForegroundColor Green
