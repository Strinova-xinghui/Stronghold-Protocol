# 卫戍协议：盟约（Stronghold Protocol）— 项目协作规则

> 本文件即你所说的「agent.md」；DeepSeek Harness 会自动读取 `AGENTS.md` 这个标准名，
> 故用此命名以确保规则被自动加载生效。目标：与朋友一起联机游玩 + 协作开发这个外部复刻项目。

## 1. 项目是什么

- 明日方舟限时玩法「卫戍协议：盟约」的**非官方同人复刻**。
- 玩法：自走棋 + 塔防。休整期招募干员、摆阵、配装备；作战期干员自动部署，迎击敌人，漏怪扣目标生命。
- 支持单人或 **1–4 人联机合作**。
- 上游仓库：<https://github.com/sganggs/Stronghold-Protocol>

## 2. 技术栈与目录结构

- 服务器：Node.js —— HTTP 静态服务 + WebSocket（`/ws`）、大厅、对局引擎、战斗模拟。
- 客户端：浏览器**原生 ES 模块**（PixiJS + pixi-spine、three.js 3D 棋盘、Preact + htm UI）。
- 许可证：**GPL-3.0-or-later**（自写代码与文档）；非商业同人项目。

| 路径 | 内容 |
| --- | --- |
| `server/` | Node 服务、WebSocket、大厅、对局引擎（`match/`）、战斗模拟（`sim/`，前后端共用） |
| `shared/` | 前后端共用的常量与网络协议 |
| `public/` | 浏览器客户端 |
| `data/` | 由官方数据表生成的游戏数据与素材清单 `assets.json` |
| `tools/` | 数据生成等工具 |
| `scripts/` | 脚本 |

## 3. 环境与运行（2026-10-05 已实测跑通）

- 本机 Node v24.18.0（要求 ≥22，满足）；`npm install` 已完成；素材已由 `node tools/setup.mjs --no-local` 下载齐全（271 MB / 4023 文件，仅 `enemies.enemy_5601_entlec.icon` 缺失，客户端有占位图兜底）。
- 启动服务器：`npm start`（默认端口 3000）；健康检查 `GET /healthz` 实测 200（v0.1.3）。
- 常用命令：`npm run doctor` 诊断（Node/素材/端口/防火墙/局域网地址）；`npm run dev` 改服务器代码自动重启。
- `--no-local` 跳过明日方舟客户端素材提取（官方 3D 棋盘贴图等可选素材）；之后想要可跑 `node tools/setup.mjs --local`（需本机客户端 + Python 3.8+）。
- 客户端为原生 ES 模块（无打包器），一般改完刷新页面即可。

## 4. 和朋友一起玩（2026-10-05 实测：Cloudflare 临时隧道已打通）

### 公网联机（朋友零安装，当前采用）

1. 开服前检查 Clash：**TUN / DNS 覆写（fake-ip）开着会掐断隧道**（见踩坑记录）；已关闭 DNS 覆写则 Clash 可以常开。
2. 运行 `powershell -ExecutionPolicy Bypass -File start-online.ps1`：自动确保服务器在 3000 → 起 cloudflared 隧道 → 打印并打开公网地址。
3. 把打印的 `https://xxxx.trycloudflare.com` 发给朋友，浏览器直接打开即玩（https 页面自动走 wss，无需配置；HTTP 与 WebSocket 均已实测通过隧道）。
4. 进游戏：输入昵称 → 同盟模拟 → 创建房间 → 发 4 位同盟密钥或 `?room=密钥` 链接 → 全员准备后房主开始。

### 实测踩坑记录（重要）

- **Clash/Mihomo TUN 模式会让 cloudflared 彻底连不上**：TUN 把隧道到 Cloudflare 边缘（UDP/TCP 7844）的流量接管成 fake-ip（198.18.x），表现为 QUIC 超时、TLS 握手被切（EOF）。退出 Clash 后同样配置立即全部预检 PASS——元凶就是它。不想退出可在 Mihomo 规则里加 `PROCESS-NAME,cloudflared.exe,DIRECT`（判断隧道是否被 TUN 接管：`.cache\tunnel.log` 里 edge IP 是 `198.18.x` 即中招）。
- **`start-online.ps1` 必须保存为 UTF-8 带 BOM**：Windows 自带 `powershell.exe`（5.1）按 ANSI 解析无 BOM 的 UTF-8 脚本，中文注释会变成乱码并直接报 ParserError。文件已带 BOM，编辑时勿用「无 BOM」方式重存。
- Clash 退出后**系统代理可能残留**：本机浏览器若打不开网页，先关闭系统代理（Windows 设置或 Clash 开关）再试；`localhost:3000` 一般不受影响。
- **重启后端口 3000 可能被 Hyper-V/WSL 保留区抢走（`EACCES: permission denied 0.0.0.0:3000`）**：动态保留范围重启后漂移，本次实测 `2977–3076` 圈住 3000。查看：`netsh interface ipv4 show excludedportrange protocol=tcp`。`start-online.ps1` 已改为自动在 3000→3100→8080 里挑第一个可绑定的端口（3100 在两个保留区之间的空隙）。
- **Clash 的系统代理会劫持 `Invoke-WebRequest` 对 localhost 的请求**（ProxyServer 127.0.0.1:7897，代理瞬断即误判服务器已死），脚本健康检查因此改用 `curl.exe`（不走系统代理，从无误报）。
- **临时隧道地址刚生成时可能报 1033/530**：地址分配先于连接注册完成，脚本已在打印前多等 8 秒。
- 临时隧道**地址每次运行都会变**，重开后要重新发地址；要固定地址需 Cloudflare 账号 + 自有域名的命名隧道（DEPLOY.md §2.4）。
- 隧道日志在 `.cache\tunnel.log`；游戏数据/房间全在内存，**重启服务器即清空所有对局**。

### 局域网直连（备选）

同一 Wi-Fi 下访问 `http://192.168.3.20:3000`（本机 WLAN 地址，随路由器分配可能变化）；打不开先放行防火墙（`npm run doctor` 会给出具体命令）。

### 主力路线：樱花 frp 固定网址（2026-10-05 实测全通，延迟约为隧道 1/4）

- 隧道：TCP 类型，节点 #83 合肥电信PLUS2，本地 127.0.0.1:**24500**，自动 HTTPS「启用」；frpc 由官方启动器（`C:\tools\sakurafrp\SakuraLauncher.exe`，MD5 已校验）管理，登录账号后常驻。
- **固定地址 `https://frp-end.com:15810`**（朋友收藏一次即可；iOS Safari / 安卓浏览器 / PC / APK「填地址连接」通用）。
- 实测：HTTP 200、wss 握手 OK、TCP connect 54–73ms、暖请求 TTFB 230–262ms（对比 Cloudflare 785–1364ms）。WebSocket 长连接下实际操作 RTT ≈ 54–73ms。
- 游戏服务器默认端口已从 3000 迁到 **24500**（`start-online.ps1` 同步更新）：3000 易被 Hyper-V 保留区抢走，且 frp 隧道绑定需要固定端口。
- **踩坑 1**：内地节点的 TCP 隧道穿透明文 HTTP 会被合规拦截（HTTP 501，节点返回「必须启用 HTTPS」）——这不是故障。解法即官方推荐：国内节点 + 网页/API 流量**必须开自动 HTTPS**（官方速查表「网页（国内节点）✔️必须」；「游戏联机 ❌不要」那条指非 Web 的 P2P 游戏流量，不适用于本网页游戏）。
- **踩坑 2**：自动 HTTPS 用自签证书，浏览器首次访问需「高级 → 继续前往」（一次性）；**安卓 APK 的 WebView 可能无此按钮**——APK 用户进不去时改用浏览器，或另开海外节点隧道（明文 HTTP 不拦、无证书告警，广东→香港约 20–50ms）。
- 要换节点/加隧道都在 natfrp 后台操作；本地端口统一填 24500。

### 低延迟路线：Radmin VPN 组网（2026-10-05 实测本机侧已通，仅限 PC 朋友）

隧道方案延迟 350–700ms（国内→Cloudflare 洛杉矶→国内两次跨洋，实测暖请求 TTFB 785–1364ms），朋友反馈过高，改用 Radmin VPN：

1. 朋友安装 Radmin VPN（<https://www.radmin-vpn.com/zh/>，免费无实名），注册后加入房主的网络（房主在 Radmin 里把网络名和密码发给他们）。
2. 朋友浏览器（或 APK「填地址连接」）访问 `http://26.226.65.176:3100`（房主的 Radmin IP，固定不变，这是它比隧道强的地方）。
3. 房主侧防火墙已有 Node.js 入站放行规则（Public 档），Radmin 网卡默认公用网络即可；若连不上用 `npm run doctor` 查。
4. `start-online.ps1` 会自动探测 Radmin 网卡并打印该地址；服务器监听 0.0.0.0 天然覆盖 Radmin 网卡。

预期延迟 20–60ms（P2P 直连；Radmin 打洞失败走中继时会高一些，但一般仍远优于隧道）。**注意：Radmin VPN 只有 Windows 版，没有安卓端**——它只覆盖朋友用 PC 玩的场景；手机玩家见下。

### 手机（APK）玩家进虚拟局域网

Radmin 无安卓版，手机走 APK 时需用有安卓客户端的组网工具：**Tailscale / ZeroTier / EasyTier 均有官方 Android App**。以 Tailscale 为例：主机 `winget install Tailscale.Tailscale` 并登录，朋友手机装 Tailscale App 加入同一 tailnet（管理后台 Share 主机），APK「填地址连接」填 `http://<主机 100.x.y.z>:3100`。国内家宽之间 Tailscale 打洞通常成功（20–60ms），失败走海外中继会退化为接近隧道的延迟。

### 朋友用 APK（安卓端，调研结论 2026-10-05）

- 上游 fork <https://github.com/Paper-Yuan/Stronghold-Protocol> 提供 `*-android.apk`（约 285 MB，Android 7.0+ arm64，内嵌 Node.js 18 服务器 + WebView 壳，代码在 `feature/android-client` 分支）。
- **推荐版本 v0.1.4**（对应游戏数据 v0.1.2；v0.1.4.1 只给「打开黑屏」的老 WebView 设备用，Android 12 以下多见）。装前按 Release 说明核对 SHA-256（v0.1.4 前 8 位 `8000ae6e…`）。
- **remote 模式真相（源码 MainActivity.kt 证实）**：选「填地址连接」时 APK 只是 WebView 加载服务器下发的页面，游戏版本自动跟随服务器，与 APK 版本无对齐要求；内嵌 Node 服务器仅在「本机单人 / 同一 Wi-Fi」模式启动。
- 我方开 PC 服时：朋友装 APK → 选「填地址连接」→ 粘贴地址即可；**安卓端组网只能用 Tailscale/ZeroTier/EasyTier（Radmin 无安卓版）**；不开电脑时朋友们可互相用 APK「同一 Wi-Fi」模式 + 上述组网工具互联。

### 安卓手机开服（2026-10-05 调研结论，备用房）

- APK 内嵌 Node 服务器（`NodeServerService` 前台服务，绑 0.0.0.0:3000），启动页选「同一 Wi-Fi」即开服；本机单人离线可玩；「填地址连接」是做客户端，自己开服别选。
- 远程朋友进手机房的两条路：① **一行链接**：同一台手机再装「樱花frp启动器」安卓版（官方有 APK），TCP 隧道本地端口填 **3000**（APK 内嵌端口，不是 PC 的 24500）+ 自动 HTTPS，朋友用固定 frp 网址进，注意事项与 PC 服完全相同（501 拦明文 → 必须自动 HTTPS；自签证书浏览器可过）；② **组网**：Tailscale/UU 加速器（fork 文档明确支持）等虚拟局域网，朋友访问手机虚拟 IP:3000。
- 约束：APK 内嵌游戏数据 v0.1.2（旧 PC 服一档，房内一致）；开服手机建议插电、放行后台保活（小米/vivo 杀后台激进）；朋友首次进游戏从手机拉几十 MB 素材；服务器 CPU 负载极低（≈1ms/回合/房间），手机无压力。
- 分工：PC 服（https://frp-end.com:15810）为主力；手机开房用于不开电脑的场合。iOS 无法开服，只能当客人。

### 关服

任务管理器结束 `node.exe` 与 `cloudflared.exe`，或直接关机。

## 5. 协作规范

- 提交信息使用简体中文、一句话说清改动（遵循仓库既有风格）。
- 修改 `shared/` 协议时，同步检查 `server/` 与 `public/` 两端的一致性。
- 不提交第三方素材与可再生的生成数据（遵循仓库 `.gitignore`）。
- 尊重上游 **GPL-3.0-or-later**：二次分发须提供源码并保持同许可证。
- 游戏素材/数据版权归上海鹰角网络（Hypergryph）等权利人，仅限非商业同人用途（详见 `NOTICE.md`）。

## 6. 关键文件

- `README.md` —— 说明书（快速开始、联机、端口与配置）。
- `NOTICE.md` —— 版权与使用声明。
- `package.json` —— 依赖与脚本命令（`scripts`）。