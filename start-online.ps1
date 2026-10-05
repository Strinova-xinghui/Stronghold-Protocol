# 卫戍协议：盟约 —— 一键公网开服脚本（Cloudflare 临时隧道）
# 用法：powershell -ExecutionPolicy Bypass -File start-online.ps1 [-Port 3000]
# 前提：已 npm install && node tools/setup.mjs --no-local；Clash 若开 TUN 需给 cloudflared.exe 加直连规则
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会解析失败（中文变乱码）
param([int]$Port = 0)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 测试端口能否绑定（Hyper-V 保留区会导致 EACCES，等价于 node 的 listen 失败）
function Test-PortFree([int]$p) {
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p)
        $l.Start(); $l.Stop(); return $true
    } catch { return $false }
}
# 测试该端口上是否已有我们的游戏服务器在跑
# 用 curl.exe 而不是 Invoke-WebRequest：后者会被 Clash 系统代理（如 127.0.0.1:7897）劫持，代理瞬断时误判
function Test-GameAlive([int]$p) {
    try {
        $out = curl.exe -s -m 2 "http://127.0.0.1:$p/healthz" 2>$null
        return ($LASTEXITCODE -eq 0 -and "$out" -match '"app"')
    } catch { return $false }
}

# 1. 选端口：指定了 -Port 就只用它；否则按 3000 → 3100 → 8080 顺序挑第一个可用的
if ($Port -gt 0) { $candidates = @($Port) } else { $candidates = @(3000, 3100, 8080) }
$chosen = $null; $alreadyRunning = $false
foreach ($p in $candidates) {
    if (Test-GameAlive $p) { $chosen = $p; $alreadyRunning = $true; break }
    if (Test-PortFree $p)  { $chosen = $p; break }
    Write-Host "[skip] 端口 $p 不可用（被占用或被 Hyper-V 保留区圈走）" -ForegroundColor Yellow
}
if (-not $chosen) {
    Write-Host '所有候选端口都不可用。排查: netsh interface ipv4 show excludedportrange protocol=tcp' -ForegroundColor Red
    exit 1
}

# 2. 服务器：没在跑才启动
if ($alreadyRunning) {
    Write-Host "[ok] 游戏服务器已在端口 $chosen 运行，跳过启动" -ForegroundColor Yellow
} else {
    $env:PORT = $chosen
    Start-Process -FilePath "node" -ArgumentList "server/index.js" -WorkingDirectory $root -WindowStyle Minimized
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if (Test-GameAlive $chosen) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host "服务器启动失败（端口 $chosen）。排查: 1) netsh interface ipv4 show excludedportrange protocol=tcp 2) 手动运行 npm start 看报错" -ForegroundColor Red
        exit 1
    }
    Write-Host "[ok] 服务器已启动（后台最小化窗口），本机地址 http://localhost:$chosen" -ForegroundColor Green
}

# 3. 隧道：清掉旧 cloudflared 再起，日志写 .cache\tunnel.log（地址在 stderr 里）
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
$cf = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
if (-not (Test-Path $cf)) { $cf = 'cloudflared' }
$cacheDir = Join-Path $root '.cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$tlog = Join-Path $cacheDir 'tunnel.log'
$olog = Join-Path $cacheDir 'tunnel-out.log'
Start-Process -FilePath $cf -ArgumentList 'tunnel', "--url", "http://localhost:$chosen" `
    -WindowStyle Hidden -RedirectStandardError $tlog -RedirectStandardOutput $olog

# 4. 轮询等公网地址出现（最多 60 秒）
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
    # 地址拿到后再等 8 秒让连接注册完成（避免 Cloudflare 1033）
    Start-Sleep -Seconds 8
    Write-Host ''
    Write-Host '==================== 联机地址（发给朋友） ====================' -ForegroundColor Green
    Write-Host "  $url" -ForegroundColor Cyan
    # Radmin VPN 网卡地址（26.x）：低延迟方案，朋友装 Radmin VPN 进同一网络后访问
    $rad = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -match 'Radmin' -and $_.IPAddress -like '26.*' } |
        Select-Object -First 1
    if ($rad) {
        Write-Host "  http://$($rad.IPAddress):$chosen   <- Radmin VPN 组网（低延迟，朋友装 Radmin 后用这个）" -ForegroundColor Cyan
    }
    Write-Host '=============================================================' -ForegroundColor Green
    Write-Host "本机游玩: http://localhost:$chosen"
    Write-Host '注意: 隧道地址每次运行都会变；关服 = 任务管理器结束 node.exe 和 cloudflared.exe。'
    Start-Process $url
} else {
    Write-Host "隧道地址获取失败。排查: 1) Clash TUN 是否接管了流量（日志 edge IP 为 198.18.x 即中招）？2) 日志: $tlog" -ForegroundColor Red
    exit 1
}
