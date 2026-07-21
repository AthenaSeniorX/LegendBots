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

try {
    Clear-Host
    Write-Host '   __   ___ ___ ___ _  _ ___    ___  ___ _____ ___ ' -ForegroundColor Cyan
    Write-Host '  / /  | __/ __| __| \| |   \  | _ )/ _ \_   _/ __|' -ForegroundColor Cyan
    Write-Host ' / /__ | _| (_ | _|| .` | |) | | _ \ (_) || | \__ \' -ForegroundColor Cyan
    Write-Host ' \____/|___\___|___|_|\_|___/  |___/\___/ |_| |___/' -ForegroundColor Cyan
    Write-Host ' ───────────────────────────────────────────────────' -ForegroundColor Gray
    Write-Host '  OAS Games Otomatik Hesap Yönetim ve Sign Sistemi  ' -ForegroundColor Yellow
    Write-Host ' ───────────────────────────────────────────────────' -ForegroundColor Gray
    Write-Host ''

    Write-Host ' [1] Sistem Gereksinimleri Kontrol Ediliyor...' -ForegroundColor Green

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host '  [X] HATA: Node.js PATH içinde bulunamadı!' -ForegroundColor Red
        throw 'Node.js PATH içinde bulunamadı.'
    } else {
        Write-Host '  ✔ Node.js Kurulumu: Tamam' -ForegroundColor Green
    }

    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Host '  [X] HATA: Python PATH içinde bulunamadı!' -ForegroundColor Red
        throw 'Python PATH içinde bulunamadı.'
    } else {
        Write-Host '  ✔ Python Kurulumu: Tamam' -ForegroundColor Green
    }

    $workerLockDirectory = Join-Path $PSScriptRoot 'pipeline-runtime\worker-locks'
    if (Test-Path -LiteralPath $workerLockDirectory) {
        $liveWorkers = @(
            Get-ChildItem -LiteralPath $workerLockDirectory -Filter '*.lock' -File | ForEach-Object {
                try {
                    $lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName | ConvertFrom-Json
                    if (Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue) {
                        $_.BaseName
                    }
                }
                catch {}
            }
        )
        if ($liveWorkers.Count -gt 0) {
            Write-Host "  [X] HATA: Zaten çalışan aktif worker(lar) bulundu: $($liveWorkers -join ', ')" -ForegroundColor Red
            throw "Zaten çalışan worker bulundu: $($liveWorkers -join ', '). İkinci sistem başlatılmadı."
        } else {
            Write-Host '  ✔ Çalışan Worker Çakışması: Yok (Güvenli)' -ForegroundColor Green
        }
    } else {
        Write-Host '  ✔ Çalışan Worker Çakışması: Yok (Güvenli)' -ForegroundColor Green
    }
    Write-Host ''

    Write-Host ' [2] Varsayılan Hesap Planı Yükleniyor...' -ForegroundColor Green
    $configuration = Get-Content -Raw -Encoding UTF8 -LiteralPath '.\pipeline.config.json' | ConvertFrom-Json
    $prefix = [string]$configuration.account.prefix
    $domain = [string]$configuration.account.domain
    $start = [int]$configuration.account.start
    $end = [int]$configuration.account.end

    Write-Host '  ┌─────────────────────────────────────────────────────────────────┐' -ForegroundColor Gray
    Write-Host ("  │ E-posta Biçimi : $prefix{NUMARA}@$domain".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │ İlk Hesap      : $prefix$start@$domain".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │ Son Hesap      : $prefix$end@$domain".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │ Toplam         : $($end - $start + 1) hesap".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │ Şifre Durumu   : Diskte tutulmaz (Güvenli Giriş)".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host '  └─────────────────────────────────────────────────────────────────┘' -ForegroundColor Gray
    Write-Host ''

    $useDefaults = Read-YesNo 'Bu varsayılan hesap bilgileriyle devam etmek istiyor musunuz?' $true
    if (-not $useDefaults) {
        Write-Host ''
        Write-Host ' [3] Yeni Hesap Planı Yapılandırması' -ForegroundColor Green
        $prefix = Read-RequiredText 'E-posta ön eki (örn: hadestxz)'
        $domain = Read-RequiredText 'E-posta alan adı (örn: outlook.com)'
        $start = Read-PositiveInteger 'Başlangıç hesap numarası'
        while ($true) {
            $end = Read-PositiveInteger 'Bitiş hesap numarası'
            if ($end -ge $start) {
                break
            }
            Write-Host '  [!] Bitiş numarası başlangıç numarasından küçük olamaz.' -ForegroundColor Yellow
        }
    }

    $env:LEGEND_EMAIL_PREFIX = $prefix
    $env:LEGEND_EMAIL_DOMAIN = $domain
    $env:LEGEND_ACCOUNT_START = [string]$start
    $env:LEGEND_ACCOUNT_END = [string]$end

    Write-Host ''
    Write-Host ' [3] Çalışma Planı Özeti' -ForegroundColor Green
    Write-Host '  ┌─────────────────────────────────────────────────────────────────┐' -ForegroundColor Gray
    Write-Host ("  │ Hesap Aralığı  : $prefix$start@$domain".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │                  $prefix$end@$domain".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host ("  │ Toplam Hesap   : $($end - $start + 1)".PadRight(66) + '│') -ForegroundColor Gray
    Write-Host '  └─────────────────────────────────────────────────────────────────┘' -ForegroundColor Gray
    Write-Host ''

    if (-not (Read-YesNo 'Bu dinamik hesap planını onaylıyor musunuz?' $true)) {
        throw 'Hesap planı kullanıcı tarafından iptal edildi.'
    }

    Write-Host ''
    Write-Host ' [3.5] Çalışma Modu Seçimi' -ForegroundColor Green
    Write-Host '  ┌─────────────────────────────────────────────────────────────────┐' -ForegroundColor Gray
    Write-Host '  │ [1] Test Modu      — Daha hızlı, 403 riski düşük ama sıfır    │' -ForegroundColor Yellow
    Write-Host '  │                      değil. Geliştirme/deneme için.           │' -ForegroundColor Yellow
    Write-Host '  │ [2] Çalışma Modu   — Yavaş ama 403 engellerine karşı kesin    │' -ForegroundColor Cyan
    Write-Host '  │                      güvenli. Üretim kullanımı için.          │' -ForegroundColor Cyan
    Write-Host '  └─────────────────────────────────────────────────────────────────┘' -ForegroundColor Gray
    while ($true) {
        Write-Host -NoNewline '  ▶ ' -ForegroundColor Cyan
        Write-Host -NoNewline 'Mod seçin (1 veya 2): ' -ForegroundColor White
        $modeChoice = (Read-Host).Trim()
        if ($modeChoice -eq '1') {
            $env:LEGEND_OPERATION_MODE = 'test'
            Write-Host '  ✔ Test Modu seçildi — hızlı zamanlama aktif.' -ForegroundColor Yellow
            break
        }
        if ($modeChoice -eq '2') {
            $env:LEGEND_OPERATION_MODE = 'production'
            Write-Host '  ✔ Çalışma Modu seçildi — güvenli zamanlama aktif.' -ForegroundColor Green
            break
        }
        Write-Host '  [!] Lütfen 1 veya 2 girin.' -ForegroundColor Yellow
    }
    Write-Host ''

    $emailList = [Collections.Generic.List[string]]::new()
    $seenEmails = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    for ($index = $start; $index -le $end; $index++) {
        $email = "$prefix$index@$domain".ToLowerInvariant()
        if ($seenEmails.Add($email)) {
            $emailList.Add($email)
        }
    }
    if (Test-Path -LiteralPath '.\onaylanmis_gruplar.json') {
        $legacyGroups = Get-Content -Raw -Encoding UTF8 -LiteralPath '.\onaylanmis_gruplar.json' | ConvertFrom-Json
        foreach ($groupProperty in $legacyGroups.groups.PSObject.Properties) {
            foreach ($account in $groupProperty.Value.accounts) {
                $email = ([string]$account.email).Trim().ToLowerInvariant()
                if (-not [string]::IsNullOrWhiteSpace($email) -and $seenEmails.Add($email)) {
                    $emailList.Add($email)
                }
            }
        }
    }

    Remove-Item Env:\LEGEND_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\LEGEND_ACCOUNT_PASSWORDS_B64 -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host ' [4] Güvenlik ve Şifre Girişi' -ForegroundColor Green
    $sharedPassword = Read-YesNo 'Bütün hesaplar aynı şifreyi mi kullanıyor?' $true
    if ($sharedPassword) {
        $env:LEGEND_PASSWORD = Read-PlainTextSecret 'Hesapların ortak şifresi'
    }
    else {
        Write-Host "  [!] $($emailList.Count) hesap için şifreler maskeli olarak tek tek alınacak." -ForegroundColor Yellow
        if ($emailList.Count -gt 50 -and -not (Read-YesNo 'Çok sayıda şifre girişi gerekecek. Devam etmek istiyor musunuz?' $false)) {
            throw 'Hesap bazlı şifre girişi kullanıcı tarafından iptal edildi.'
        }
        $passwordMap = [ordered]@{}
        foreach ($email in $emailList) {
            $passwordMap[$email] = Read-PlainTextSecret "$email şifresi"
        }
        $passwordJson = $passwordMap | ConvertTo-Json -Compress
        $passwordBytes = [Text.Encoding]::UTF8.GetBytes($passwordJson)
        $encodedPasswords = [Convert]::ToBase64String($passwordBytes)
        if ($encodedPasswords.Length -gt 30000) {
            throw 'Hesap bazlı şifre planı Windows ortam değişkeni sınırını aşıyor; daha küçük aralık veya ortak şifre kullanın.'
        }
        $env:LEGEND_ACCOUNT_PASSWORDS_B64 = $encodedPasswords
        $passwordMap.Clear()
        $passwordJson = $null
        $passwordBytes = $null
        $encodedPasswords = $null
    }

    & node .\automation.js --persist-session
    if ($LASTEXITCODE -ne 0) {
        throw 'Dinamik oturum planı ve korunan credential kaydı oluşturulamadı.'
    }

    Write-Host ''
    Write-Host ' [5] Ön Kontrol Yapılıyor...' -ForegroundColor Green
    Write-Host '  ▶ automation.js --check komutu çalıştırılıyor...' -ForegroundColor Gray
    & node .\automation.js --check
    if ($LASTEXITCODE -ne 0) {
        throw 'Ön kontrol başarısız; hiçbir worker başlatılmadı.'
    }
    Write-Host '  ✔ Ön Kontrol Başarılı' -ForegroundColor Green
    Write-Host ''

    & node .\automation.js --enable-all-workers
    if ($LASTEXITCODE -ne 0) {
        throw 'Worker çalışma durumları etkinleştirilemedi.'
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\supervisor-host.ps1 -Install
    if ($LASTEXITCODE -ne 0) {
        throw 'Bağımsız supervisor görevi kurulamadı; workerlar başlatılmadı.'
    }

    Write-Host ' [6] Worker Modülleri Başlatılıyor...' -ForegroundColor Green
    $workerHost = Join-Path $PSScriptRoot 'worker-host.ps1'
    foreach ($worker in @('account', 'group', 'sign', 'manager')) {
        $workerArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$workerHost`" -Worker $worker"
        Start-Process -FilePath 'powershell.exe' `
            -WorkingDirectory $PSScriptRoot `
            -WindowStyle Normal `
            -ArgumentList $workerArguments
        Write-Host "  [+] $worker worker terminali açıldı." -ForegroundColor Cyan
        Start-Sleep -Milliseconds 250
    }
    Write-Host ''
    Write-Host ' ─────────────────────────────────────────────────────────────────' -ForegroundColor Gray
    Write-Host '  [✔] Sistem Başarıyla Başlatıldı! Worker pencerelerini izleyin.' -ForegroundColor Green
    Write-Host ' ─────────────────────────────────────────────────────────────────' -ForegroundColor Gray
    Write-Host ''
}
catch {
    Write-Host ''
    Write-Host ' ┌─────────────────────────── HATA ───────────────────────────┐' -ForegroundColor Red
    $errStr = $_.Exception.Message
    if ($errStr.Length -gt 58) {
        $errStr = $errStr.Substring(0, 55) + "..."
    }
    Write-Host (" │ " + $errStr.PadRight(58) + " │") -ForegroundColor Red
    Write-Host ' └────────────────────────────────────────────────────────────┘' -ForegroundColor Red
    Write-Host ''
    exit 1
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
