@rem 卫戍协议：盟约 —— 双击一键开服（调用 start-online.ps1）
@rem 关服：关闭弹出的服务器窗口，或任务管理器结束 node.exe
@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1" %*
echo.
echo [固定网址已自动复制到剪贴板，Ctrl+V 直接发给朋友]
echo [服务器在后台独立运行，本窗口随手点 X 关闭都不影响联机]
cmd /k
