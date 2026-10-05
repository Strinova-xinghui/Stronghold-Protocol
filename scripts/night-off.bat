@rem Night mode: turn off WLAN radio (PC stays on, offline). ASCII only.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0night-off.ps1"
