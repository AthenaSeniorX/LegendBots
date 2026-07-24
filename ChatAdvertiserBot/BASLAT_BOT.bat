@echo off
title Legend Online Chat Bot - Yonetici Modu
:: Admin privilege check
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [Yonetici Izni Aliniyor...]
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo ==================================================
echo   LEGEND ONLINE CHAT BOT v2.0
echo   Yonetici modunda baslatiliyor...
echo   (RDP kesilirse otomatik konsola aktarilir)
echo ==================================================
echo.

cd /d "%~dp0"
python main.py

pause
