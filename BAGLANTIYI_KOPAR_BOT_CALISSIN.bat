@echo off
title LegendBots - RDP Oturumunu Guvenli Ayir
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RDP_OTURUMUNU_GUVENLI_AYIR.ps1"
if errorlevel 1 (
    echo.
    echo [HATA] Oturum aktarilamadi. Yukaridaki hatayi kontrol edin.
    pause
)
