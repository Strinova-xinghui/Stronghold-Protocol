# 睡前一键：关闭 WLAN 无线电（彻底断联，电台级），其余网卡不动
# 明早 08:00 计划任务 StrongholdWake 会自动开 WiFi 并拉起服务器
# 保存为 UTF-8 带 BOM
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

& netsh wlan set interface name='WLAN' admin=disabled 2>&1 | Out-Null
$st = (& netsh wlan show interfaces) -join ' '
if ($st -notmatch 'WLAN') {
    Write-Host ''
    Write-Host '[ok] WLAN 无线电已关闭 —— 今晚不联网。' -ForegroundColor Green
    Write-Host '[ok] 明早 08:00 计划任务 StrongholdWake 将自动: 开WiFi -> 等联网 -> 拉起服务器' -ForegroundColor Green
    Write-Host '[ok] frp 固定网址届时自动恢复: https://frp-end.com:15810' -ForegroundColor Cyan
    if (-not (Get-ScheduledTask -TaskName 'StrongholdWake' -ErrorAction SilentlyContinue)) {
        Write-Host '[!] 提醒: StrongholdWake 任务尚未注册，请先双击 scripts\register-wake.bat' -ForegroundColor Yellow
    }
} else {
    Write-Host '[!] WLAN 关闭失败，请手动检查' -ForegroundColor Red
}
Write-Host ''
Read-Host '按回车键关闭'
