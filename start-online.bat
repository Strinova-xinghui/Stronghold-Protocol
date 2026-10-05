@rem 卫戍协议：盟约 —— 双击一键开服（调用 start-online.ps1）
@rem 关服：关闭弹出的服务器窗口，或任务管理器结束 node.exe
@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" %*
echo.
pause
