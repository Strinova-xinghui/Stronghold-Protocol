@rem Safe update+restart: only restarts the server when no match is running. ASCII only.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-restart.ps1" %*
echo.
cmd /k
