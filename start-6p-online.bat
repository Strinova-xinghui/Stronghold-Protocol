@echo off
rem ===========================================================================================
rem  One-click launcher: 6-player co-op (SP_MAX_SEATS=6).
rem
rem  ASCII only on purpose: a .bat is parsed in the console's own code page, so non-ASCII text
rem  here can break the script. All Chinese messages come from start-online.ps1 / node.
rem
rem  Double-click this file. For the official 4-player game use start-online.bat instead.
rem  Docs: README.md section "6 ren tong meng mo ni", docs/DESIGN.md section 25.
rem ===========================================================================================
setlocal EnableExtensions
title Stronghold Protocol 6P
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" -MaxSeats 6 %*

echo.
echo   Server window is running in the background (minimized).
echo   To stop: double-click stop-online.bat
echo.
pause
