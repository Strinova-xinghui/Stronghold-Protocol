@rem Stronghold Protocol one-click launcher (ASCII only: cmd parses this file in ANSI codepage,
@rem any non-ASCII byte here corrupts line parsing. All friendly messages are printed by the ps1.)
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" %*
echo.
echo [Invite links copied to clipboard. Server runs independently, this window can be closed.]
cmd /k
