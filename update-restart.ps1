# 卫戍协议 —— 安全换装重启：只在没有进行中对局时才重启服务器（matches == 0）
# 用法: 双击 update-restart.bat，或 powershell -File update-restart.ps1 [-Port 24500]
# 对局进行中(matches>0)时什么都不做，绝不坑到在线玩家；大厅/挂机状态会被断开(可重连)。
param([int]$Port = 24500)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = 'E:\卫戍协议'

function Test-GameAlive([int]$p) {
    try {
        $out = curl.exe -s -m 2 "http://127.0.0.1:$p/healthz" 2>$null
        return ($LASTEXITCODE -eq 0 -and "$out" -match '"app"')
    } catch { return $false }
}

# 1. 没有服务器在跑 → 直接起新的
if (-not (Test-GameAlive $Port)) {
    Write-Host '[i] 当前没有服务器在运行，直接启动。' -ForegroundColor Yellow
    Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "`$env:PORT=$Port; node server/index.js" -WorkingDirectory $root -WindowStyle Minimized
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if (Test-GameAlive $Port) { Write-Host "[ok] 服务器已启动: http://localhost:$Port（监控: /monitor）" -ForegroundColor Green; exit 0 }
    }
    Write-Host '[!] 启动失败，请手动运行 start-online.bat 查看报错。' -ForegroundColor Red
    exit 1
}

# 2. 有服务器 → 查对局状态
$health = curl.exe -s -m 5 "http://127.0.0.1:$Port/healthz" | ConvertFrom-Json
Write-Host ("当前: 房间 {0} · 进行中对局 {1} · 在线玩家 {2} · WS连接 {3}" -f $health.rooms, $health.matches, $health.humans, $health.sockets)

if ($health.matches -gt 0) {
    Write-Host ('[!] 有 {0} 场对局正在进行（{1} 位玩家）——本次换装取消。' -f $health.matches, $health.humans) -ForegroundColor Red
    Write-Host '    等对局结束后（大厅/结算界面也行）再双击本脚本即可，正在连接的玩家只会刷新页面重连。' -ForegroundColor Yellow
    exit 1
}

# 3. matches == 0 → 安全重启（大厅玩家会断线，但同盟 10 分钟内重连回原座位）
Write-Host '[ok] 无进行中对局，安全重启以加载新代码…' -ForegroundColor Green
$c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($c) {
    $pids = $c.OwningProcess | Select-Object -Unique
    foreach ($procId in $pids) {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host "  已停止旧进程 PID $procId" -ForegroundColor DarkGray }
        catch { Write-Host "  停止 PID $procId 失败（权限不足?）: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
    }
    Start-Sleep -Seconds 2
}
Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "`$env:PORT=$Port; node server/index.js" -WorkingDirectory $root -WindowStyle Minimized
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if (Test-GameAlive $Port) {
        Write-Host "[ok] 新代码已上线: http://localhost:$Port  ·  监控: http://localhost:$Port/monitor" -ForegroundColor Green
        exit 0
    }
}
Write-Host '[!] 重启后健康检查失败，请运行 start-online.bat 查看报错。' -ForegroundColor Red
exit 1
