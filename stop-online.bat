@rem Stop the Stronghold Protocol game server (port 24500 only). ASCII only.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-online.ps1"
echo.
cmd /k
