@rem Uninstall the StrongholdProtocol scheduled task (SYSTEM auto-start). ASCII only, self-elevates.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-task.bat.ps1"
