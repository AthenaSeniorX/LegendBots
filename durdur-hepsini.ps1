[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding
& chcp.com 65001 *> $null

Write-Host ''
Write-Host " 🛑 LEGEND BOTS - TÜM SÜREÇLERİ VE SUPERVISOR'U DURDURMA " -ForegroundColor Red -BackgroundColor Black
Write-Host ''

# 1. Devre dışı bırakma komutunu gönder
Write-Host ' [1/4] Operatör niyeti kapalı olarak güncelleniyor...' -ForegroundColor Yellow
try { & node .\automation.js --disable-all-workers *> $null } catch {}

# 2. Windows Supervisor Görevini Kaldır
Write-Host ' [2/4] Windows Zamanlanmış Görev (Supervisor) kaldırılıyor...' -ForegroundColor Yellow
try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\supervisor-host.ps1 -Uninstall *> $null } catch {}

# 3. Arka plandaki Node ve PowerShell Worker süreçlerini sonlandır
Write-Host ' [3/4] Arka plandaki Node.js ve PowerShell bot süreçleri kapatılıyor...' -ForegroundColor Yellow
$workerScripts = @(
    'pipeline\account-worker.js',
    'pipeline\group-worker.js',
    'pipeline\sign-worker.js',
    'pipeline\reward-worker.js',
    'pipeline\manager.js',
    'worker-host.ps1'
)
try {
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $processes) {
        $cmd = [string]$proc.CommandLine
        if ($cmd) {
            $normalizedCmd = $cmd.Replace('/', '\')
            foreach ($script in $workerScripts) {
                if ($normalizedCmd.IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    Write-Host "  -> Süreç kapatılıyor: PID=$($proc.ProcessId) ($script)" -ForegroundColor DarkGray
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
                    break
                }
            }
        }
    }
} catch {}

# 4. Kilit dosyalarını temizle
Write-Host ' [4/4] Çalışma kilit dosyaları temizleniyor...' -ForegroundColor Yellow
$possibleLockDirs = @(
    (Join-Path $PSScriptRoot 'pipeline-runtime\worker-locks'),
    'c:\Users\huigf\LegendBots\pipeline-runtime\worker-locks',
    'C:\Users\huigf\Desktop\LegendBots\pipeline-runtime\worker-locks',
    'C:\Users\huigf\Desktop\LegendBots_Test\pipeline-runtime\worker-locks'
)
foreach ($dir in $possibleLockDirs) {
    if (Test-Path -LiteralPath $dir) {
        Remove-Item (Join-Path $dir '*.lock') -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '  ✅ TÜM BOTLAR VE ARKA PLAN SÜREÇLERİ BAŞARIYLA DURDURULDU.' -ForegroundColor Green
Write-Host ''
