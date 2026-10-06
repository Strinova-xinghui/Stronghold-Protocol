# 卫戍协议 —— 一键关服：只停本项目的游戏服务器（端口 24500 的 node），不动 frpc / 其他程序
# 用法：双击 stop-online.bat
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Port = 24500

# 用 curl 健康检查确认这是我们的游戏服务器（防误杀别的程序占用的端口）
function Test-GameAlive([int]$p) {
    try {
        $out = curl.exe -s -m 2 "http://127.0.0.1:$p/healthz" 2>$null
        return ($LASTEXITCODE -eq 0 -and "$out" -match '"app"')
    } catch { return $false }
}

if (-not (Test-GameAlive $Port)) {
    Write-Host "[i] 端口 $Port 上没有游戏服务器在跑（本来就关着）。" -ForegroundColor Yellow
    exit 0
}

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$pids = $conns.OwningProcess | Select-Object -Unique
foreach ($procId in $pids) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "[ok] 已停止游戏服务器进程 PID $procId" -ForegroundColor Green
    } catch {
        # SYSTEM 权限进程（曾经的计划任务残留）用 taskkill 兜底
        taskkill /F /PID $procId 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Host "[ok] 已通过 taskkill 停止 PID $procId" -ForegroundColor Green }
        else { Write-Host "[!] PID $procId 停止失败（Access denied）——它可能是 SYSTEM 服务，请看 AGENTS.md「幽灵服务」节" -ForegroundColor Red }
    }
}
Start-Sleep -Seconds 2
if (Test-GameAlive $Port) {
    Write-Host "[!] 关闭后健康检查仍通过——服务器可能被守护进程复活，请检查计划任务" -ForegroundColor Red
    exit 1
}
Write-Host "[ok] 游戏服务器已关闭。樱花 frp 隧道保持在线（地址不变，重新开服前朋友访问会提示连接失败，属正常）。" -ForegroundColor Green
Write-Host "[i] 想再开服：双击 start-online.bat"
exit 0
