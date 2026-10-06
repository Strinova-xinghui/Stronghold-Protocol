# 卸载 StrongholdProtocol 计划任务（SYSTEM 自启服务）+ 防火墙规则，一次性自清理
# 双击运行：自动请求管理员权限 → 卸载 → 打印结果
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"" -Verb RunAs -Wait
    exit
}

Write-Host '=== 卸载 StrongholdProtocol 计划任务 ===' -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File 'E:\卫戍协议\scripts\install-service-windows.ps1' -Uninstall

Write-Host ''
Write-Host '=== 验证 ===' -ForegroundColor Cyan
$t = Get-ScheduledTask -TaskName 'StrongholdProtocol' -ErrorAction SilentlyContinue
if ($t) { Write-Host "[!] 任务仍存在: State=$($t.State)" -ForegroundColor Red } else { Write-Host '[ok] 计划任务已删除' -ForegroundColor Green }
Start-Sleep -Seconds 2
$c = Get-NetTCPConnection -LocalPort 24500 -State Listen -ErrorAction SilentlyContinue
if ($c) { Write-Host "[!] 端口 24500 仍被 PID $($c.OwningProcess) 占用（任务删除后 run-server.cmd 循环可能在 5 秒内复活，稍候再查一次）" -ForegroundColor Yellow } else { Write-Host '[ok] 端口 24500 已释放' -ForegroundColor Green }
Start-Sleep -Seconds 8
$c2 = Get-NetTCPConnection -LocalPort 24500 -State Listen -ErrorAction SilentlyContinue
if ($c2) { Write-Host "[!] 8 秒后仍被占用: PID $($c2.OwningProcess)（需手动杀）" -ForegroundColor Red } else { Write-Host '[ok] 确认释放，无复活' -ForegroundColor Green }
Write-Host ''
Read-Host '按回车键关闭'
