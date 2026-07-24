@echo off
setlocal
title Legend Chat Reklam Botu v4.0 - HWND

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [Yonetici Izni Aliniyor...]
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ==================================================
echo   LEGEND CHAT REKLAM BOTU v4.0 - HWND
echo   Yonetici modunda baslatiliyor...
echo   Arka plan modu fiziksel fareyi ve odagi kullanmaz.
echo ==================================================
echo.

cd /d "%~dp0"

where py.exe >nul 2>&1
if not errorlevel 1 (
    py -3 -c "import tkinter" >nul 2>&1
    if not errorlevel 1 (
        py -3 main.py
        goto :finished
    )
)

where python.exe >nul 2>&1
if not errorlevel 1 (
    python -c "import tkinter" >nul 2>&1
    if not errorlevel 1 (
        python main.py
        goto :finished
    )
)

echo [HATA] Python 3 ve tkinter bulunamadi.
echo Windows Server'a Python 3 kurarken "tcl/tk and IDLE" bilesenini etkinlestirin.

:finished
echo.
echo Bot kapandi.
pause
endlocal
