# 卫戍协议：盟约 —— 一键公网开服脚本（Cloudflare 临时隧道）
# 用法：powershell -ExecutionPolicy Bypass -File start-online.ps1 [-Port 3000]
# 前提：已 npm install && node tools/setup.mjs --no-local；Clash 若开 TUN 需给 cloudflared.exe 加直连规则
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会解析失败（中文变乱码）
param([int]$Port = 24500, [switch]$Tunnel)
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

# 1. 端口语义：樱花隧道按端口绑定到 24500，所以**钉死 24500，绝不静默换端口**——
#    换了端口服务器照样能跑，但朋友的固定网址会 502。24500 被占（Hyper-V 保留区漂移）时明确报错让人处理。
if ($Port -le 0) { $Port = 24500 }
$candidates = @($Port)
$chosen = $null; $alreadyRunning = $false
foreach ($p in $candidates) {
    if (Test-GameAlive $p) { $chosen = $p; $alreadyRunning = $true; break }
    if (Test-PortFree $p)  { $chosen = $p; break }
    Write-Host "[skip] 端口 $p 不可用（被占用或被 Hyper-V 保留区圈走）" -ForegroundColor Yellow
}
if (-not $chosen) {
    Write-Host "端口 $Port 不可用。樱花隧道固定绑定此端口，不能换。排查: netsh interface ipv4 show excludedportrange protocol=tcp" -ForegroundColor Red
    Write-Host '临时解法: 管理员 PowerShell 运行重启后重试，或 natfrp 后台把隧道本地端口改成脚本 -Port 指定的值。' -ForegroundColor Red
    exit 1
}

# 2. 服务器：没在跑才启动
if ($alreadyRunning) {
    Write-Host "[ok] 游戏服务器已在端口 $chosen 运行，跳过启动" -ForegroundColor Yellow
} else {
    $env:PORT = $chosen
    # 盟约定向加成（唯一游戏规则改动）：×2 = 主盟约干员抽卡权重翻倍；改这里或删掉此行 = 原版
    $env:SP_BOND_BOOST = '2'
    # 双栈监听：'::' 同时接受 IPv4 映射连接（127.0.0.1/局域网/frp 全部照常），并额外开放 IPv6 直连
    $env:HOST = '::'
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
    Write-Host "[ok] 服务器已启动（后台最小化窗口），本机地址 http://localhost:$chosen（盟约加成 ×2 开启，监控 /monitor）" -ForegroundColor Green
}

# 3. Cloudflare 隧道：默认跳过（樱花 frp 已提供两条固定网址）。需要兜底隧道时加 -Tunnel 参数
if (-not $Tunnel) {
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host ''
    Write-Host '==================== 联机地址（发给朋友） ====================' -ForegroundColor Green
    Write-Host '  [樱花frp 在线] 固定网址（浏览器: https://frp-way.com:17913 · APK: http://frp-cup.com:30756）' -ForegroundColor Cyan
    $rad = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -match 'Radmin' -and $_.IPAddress -like '26.*' } |
        Select-Object -First 1
    if ($rad) {
        Write-Host "  http://$($rad.IPAddress):$chosen   <- Radmin VPN 组网（低延迟，朋友装 Radmin 后用这个）" -ForegroundColor Cyan
    }
    # IPv6 直连（队友调研 docs/ipv6-feasibility.md）：只取稳定地址，排除 Random（隐私/临时地址会轮换）
    $v6 = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(fe80|::1)' -and $_.SuffixOrigin -ne 'Random' -and $_.AddressState -eq 'Preferred' } |
        Select-Object -First 1
    $v6Url = $null
    if ($v6) {
        $v6Url = "http://[$($v6.IPAddress)]:$chosen"
        Write-Host "  $v6Url   <- IPv6 直连（低延迟；需光猫已关闭 IPv6 防火墙，见 docs/ipv6-feasibility.md）" -ForegroundColor Cyan
    }
    Write-Host '=============================================================' -ForegroundColor Green
    Write-Host "本机游玩: http://localhost:$chosen"
    Write-Host '关服: 关闭弹出的服务器窗口（可最小化，别关）。'
    # 固定网址自动进剪贴板：Ctrl+V 直接发朋友，不用手动选中复制
    $invite = '浏览器(电脑/iOS/安卓): https://frp-way.com:17913' + "`r`n" +
              '安卓APK: http://frp-cup.com:30756（延迟较高）' + "`r`n" +
              '下载APK: https://github.com/Paper-Yuan/Stronghold-Protocol/releases （v0.1.4）'
    if ($v6Url) { $invite += "`r`n" + "IPv6直连(手机流量): $v6Url" }
    Set-Clipboard -Value $invite
    Write-Host '[固定网址已自动复制到剪贴板，Ctrl+V 直接发给朋友]' -ForegroundColor Green
    Start-Process "http://localhost:$chosen"
    exit 0
}

# 3b.（可选兜底）起 cloudflared 临时隧道，日志写 .cache\tunnel.log（地址在 stderr 里）
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
    # 樱花 frp 固定网址（frpc 由官方守护进程服务管理，开机自启，地址不变）
    $frpc = Get-Process frpc -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($frpc) {
        Write-Host "  [樱花frp 在线] 固定网址发给朋友（浏览器: https://frp-way.com:17913 · APK: http://frp-cup.com:30756）" -ForegroundColor Cyan
    } else {
        Write-Host "  [樱花frp 未运行] 固定网址暂不可用——请检查 natfrp 守护进程服务是否在跑" -ForegroundColor Yellow
    }
    # IPv6 直连（只取稳定地址，排除隐私/临时地址）
    $v6b = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(fe80|::1)' -and $_.SuffixOrigin -ne 'Random' -and $_.AddressState -eq 'Preferred' } |
        Select-Object -First 1
    if ($v6b) { Write-Host "  http://[$($v6b.IPAddress)]:$chosen   <- IPv6 直连（手机流量，需光猫放行）" -ForegroundColor Cyan }
    # Radmin VPN 网卡地址（26.x）：低延迟方案，朋友装 Radmin VPN 进同一网络后访问
    $rad = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -match 'Radmin' -and $_.IPAddress -like '26.*' } |
        Select-Object -First 1
    if ($rad) {
        Write-Host "  http://$($rad.IPAddress):$chosen   <- Radmin VPN 组网（低延迟，朋友装 Radmin 后用这个）" -ForegroundColor Cyan
    }
    Write-Host '=============================================================' -ForegroundColor Green
    Write-Host "本机游玩: http://localhost:$chosen"
    Write-Host '关服: 关闭弹出的服务器窗口，或任务管理器结束 node.exe。服务器窗口可最小化，别关。'
    Start-Process $url
} else {
    Write-Host "隧道地址获取失败。排查: 1) Clash TUN 是否接管了流量（日志 edge IP 为 198.18.x 即中招）？2) 日志: $tlog" -ForegroundColor Red
    exit 1
}
