@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo HATA: Node.js bulunamadi. Once Node.js kurulmali veya PATH'e eklenmeli.
    exit /b 1
)

echo LegendBots gruplama otomasyonu baslatiliyor...
echo Optimize varsayilanlar: gercek Chrome, 15 sn hesap ve 60 sn grup sogumasi.
node .\grupla.js %*
exit /b %errorlevel%
