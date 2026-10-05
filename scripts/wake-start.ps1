# 卫戍协议：盟约 —— 定时唤醒总控（计划任务 StrongholdWake 以 SYSTEM 身份调用）
# 链路: 1) WLAN 无线电若被睡前脚本关闭则打开  2) 等回连 WiFi  3) 确认出网  4) 按需拉起游戏服务器
# 日志: E:\卫戍协议\logs\wake-start.log
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root  = 'E:\卫戍协议'
$log   = Join-Path $root 'logs\wake-start.log'
$node  = 'C:\Program Files\nodejs\node.exe'
$ssid  = 'HUAWEI-10HMD6'
$stamp = { (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') }
function Log([string]$m) { Add-Content -Path $log -Value ("{0} {1}" -f (& $stamp), $m) }

Log '=== wake-start begin ==='

# 1. 打开 WLAN 无线电（睡前脚本 radio off 后此处恢复；已开则无副作用）
& netsh wlan set interface name='WLAN' admin=enabled 2>&1 | Out-Null
$state = (& netsh wlan show interfaces | Select-String 'State|状态' | Select-Object -First 1).ToString()
Log "wlan admin=enabled done; $state"

# 2. 等回连 WiFi（最多 60 秒）
$connected = $false
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $line = (& netsh wlan show interfaces | Select-String 'State|状态' | Select-Object -First 1).ToString()
    if ($line -match 'connected|已连接') {
        $cur = (& netsh wlan show interfaces | Select-String '^\s*SSID' | Select-Object -First 1).ToString()
        Log "wifi connected: $($cur.Trim()) (waited $($i*5+5)s)"
        $connected = $true; break
    }
}
if (-not $connected) {
    # 保险：显式连接已保存的配置文件再试一轮
    & netsh wlan connect name=$ssid 2>&1 | Out-Null
    for ($i = 0; $i -lt 6; $i++) {
        Start-Sleep -Seconds 5
        $line = (& netsh wlan show interfaces | Select-String 'State|状态' | Select-Object -First 1).ToString()
        if ($line -match 'connected|已连接') { Log "wifi connected after explicit connect ($($i*5+5)s)"; $connected = $true; break }
    }
}
if (-not $connected) { Log 'FATAL: wifi not connected after 90s, abort'; exit 1 }

# 3. 确认出网（frp 域名解析 + 本机源站之外的外网可达，最多 60 秒）
$online = $false
for ($i = 0; $i -lt 12; $i++) {
    & curl.exe -s -m 5 -o NUL https://www.natfrp.com 2>$null
    if ($LASTEXITCODE -eq 0) { Log "internet ok (waited $($i*5)s)"; $online = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $online) { Log 'WARN: internet check failed, still starting server (frpc service will retry on its own)' }

# 4. 按需拉起游戏服务器（24500 健康检查通过则跳过）
function Test-GameAlive {
    try {
        $out = & curl.exe -s -m 3 'http://127.0.0.1:24500/healthz' 2>$null
        return ($LASTEXITCODE -eq 0 -and "$out" -match '"app"')
    } catch { return $false }
}
if (Test-GameAlive) {
    Log 'server already alive on 24500, skip'
} else {
    Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Minimized
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 2
        if (Test-GameAlive) { Log "server started on 24500 (waited $($i*2+2)s)"; $ok = $true; break }
    }
    if (-not $ok) { Log 'FATAL: server failed to start'; exit 1 }
}
Log '=== wake-start end (all good) ==='
exit 0
