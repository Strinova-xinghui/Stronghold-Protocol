# 卫戍协议：盟约 —— 一键公网开服脚本（Cloudflare 临时隧道）
# 用法：powershell -ExecutionPolicy Bypass -File start-online.ps1 [-Port 3000]
# 前提：已 npm install && node tools/setup.mjs --no-local；开服前退出 Clash/Mihomo（TUN 会掐断隧道）
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. 服务器：3000 没人监听才启动（避免重复起进程）
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "[ok] 服务器已在端口 $Port 运行，跳过启动" -ForegroundColor Yellow
} else {
    Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory $root -WindowStyle Minimized
    Start-Sleep -Seconds 4
    Write-Host "[ok] 服务器已启动（后台最小化窗口），本机地址 http://localhost:$Port" -ForegroundColor Green
}

# 2. 隧道：起 cloudflared，日志写 .cache\tunnel.log（地址在 stderr 里）
$cf = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
if (-not (Test-Path $cf)) { $cf = 'cloudflared' }
$cacheDir = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$tlog = Join-Path $cacheDir 'tunnel.log'
$olog = Join-Path $cacheDir 'tunnel-out.log'
Start-Process -FilePath $cf -ArgumentList 'tunnel', "--url", "http://localhost:$Port" `
    -WindowStyle Hidden -RedirectStandardError $tlog -RedirectStandardOutput $olog

# 3. 轮询等公网地址出现（最多 60 秒）
$url = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $tlog) {
        $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
        if ($m) { $url = $m.Matches[0].Value; break }
    }
    Write-Host ("    等待隧道建立… {0}s" -f (($i + 1) * 2)) -ForegroundColor DarkGray
}

if ($url) {
    Write-Host ''
    Write-Host '==================== 联机地址（发给朋友） ====================' -ForegroundColor Green
    Write-Host "  $url" -ForegroundColor Cyan
    Write-Host '=============================================================' -ForegroundColor Green
    Write-Host "本机游玩: http://localhost:$Port"
    Write-Host '注意: 地址每次运行本脚本都会变化；关服 = 任务管理器结束 node.exe 和 cloudflared.exe。'
    Start-Process $url
} else {
    Write-Host "隧道地址获取失败。排查: 1) 是否退出 Clash/Mihomo？2) 日志: $tlog" -ForegroundColor Red
    exit 1
}
