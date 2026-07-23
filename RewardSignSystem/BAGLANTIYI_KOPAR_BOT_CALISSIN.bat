@echo off
title RDP Oturumunu Konsola Aktarma - RewardSignSystem
:: Admin privilege check
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [Yonetici Izni Aliniyor...]
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ==================================================
echo   WINDOWS VPS MASAUSTU EKRAN OTURUMU KONSOLA AKTARILIYOR
echo   (Hesap Olusturucu & Otomasyon Botlari Icin)
echo ==================================================
echo.

:: Yontem 1: Aktif RDP Oturum ID'sini bulup konsola devretme
for /f "tokens=1-7 delims=.: " %%a in ('query session ^| findstr /i ">"') do (
    tscon %%b /dest:console >nul 2>&1
    tscon %%a /dest:console >nul 2>&1
)

:: Yontem 2: Ortam degiskeni uzerinden devretme
if defined SESSIONNAME (
    tscon %SESSIONNAME% /dest:console >nul 2>&1
)

:: Yontem 3: Sabit Oturum ID 1 ve 2 devretme
tscon 1 /dest:console >nul 2>&1
tscon 2 /dest:console >nul 2>&1

echo [BASARILI] Oturum konsola aktarildi! 
echo Ekran kilitlenmeyecek, Chrome/Puppeteer/PyAutoGUI botlari arka planda tiklamaya devam edecek.
timeout /t 3 >nul
