@rem Register "StrongholdWake" scheduled task (wake at 08:00 + start server if dead).
@rem ASCII only. The ps1 prints all messages and self-elevates via UAC.
@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0register-wake.ps1' -Verb RunAs -Wait"
