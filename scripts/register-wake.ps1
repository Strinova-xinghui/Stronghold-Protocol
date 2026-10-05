# 注册计划任务 StrongholdWake：明早 08:00 唤醒电脑并按需拉起游戏服务器
# 需要 UAC 授权（脚本内部自动弹窗）；保存为 UTF-8 带 BOM
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$act = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "E:\卫戍协议\scripts\wake-start.ps1"' `
    -WorkingDirectory 'E:\卫戍协议'
$trg = New-ScheduledTaskTrigger -Once -At '2026-10-06 08:00'
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
$pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName 'StrongholdWake' -Action $act -Trigger $trg -Settings $set `
    -Principal $pri -Description 'Wake PC at 08:00 and start Stronghold server' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'StrongholdWake'
$info = Get-ScheduledTaskInfo -TaskName 'StrongholdWake'
Write-Host ''
Write-Host "注册成功: WakeToRun=$($t.Settings.WakeToRun)  下次运行=$($info.NextRunTime)" -ForegroundColor Green
Write-Host '验证: sleep 后到点应自动唤醒并启动服务器；结果看 E:\卫戍协议\logs\wake-start.log'
Write-Host ''
Read-Host '按回车键关闭'
