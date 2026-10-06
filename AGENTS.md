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

## 3.5 自研追加功能（2026-10-06 定稿，提交 b7e26b0 / 8d554a3）

以下均为本项目本地追加，上游无此代码；更新代码时注意 rebase 保护。

### /monitor 服务器监控面板

- 地址 `http://localhost:24500/monitor`（外网 `https://frp-end.com:15810/monitor`）；`/monitor?json` 为纯 JSON。
- 实现：`server/index.js` 内 MONITOR_HTML 模板 + monitorSnapshot(lobby) 快照函数，复用 Lobby/Match 内存状态，5 秒轮询，零依赖零进程。
- 显示：房间/对局/在线玩家/AI/观战统计；每房间卡片（房间码、模式难度、房主、座位玩家名+在线+准备、对局阶段/回合/LP/商店等级/淘汰）。
- 已验证：临时端口模拟真实玩家（WS hello→room.create→addBot），快照字段与服务器状态逐字段吻合（tools/test-monitor.mjs 保留可复跑）。

### 盟约定向加成（SP_BOND_BOOST）——已被下方「定向甄选」取代

- 需求：朋友反馈想要的牌刷不到 → 商店抽卡按「每个玩家场上已激活人数最多的 ACTIVE 盟约」定向加权。
- 实现（三处，共约 40 行）：
  1. `server/match/pool.js` `roll()` 新增 `opts.bondBoost`（Map<bondId, multiplier>）：含该盟约的干员权重 = 剩余份数 × mult；其余干员不变。
  2. `server/match/PlayerState.js` `_rollChessSlot()`：从 `this.bonds`（recompute 维护）取 count 最大的 active 盟约 → 构造 boost 传入。
  3. `server/match/Match.js` 构造器：`this.bondBoostMult = env SP_BOND_BOOST`（>1 才生效）。
- 特性：**只影响刷出分布，不影响池子份数/保底/精锐合成/SOLD_OUT/审计**；所有抽卡路径（商店/晋升奖励/机变/驰援）自动生效；多人各刷各的。
- 验证：`node tools/test-bond-boost-math.mjs`（mock 池 5 万次抽样：×2 → 38.3%→55.4%，理论 54.6% ✓）。**关键认知：权重×M ≠ 占比×M**（分母同涨），×2 实际相对提升约 1.45×，比直觉温和。
- ⚠️ **现状（2026-10-06 晚）**：朋友反馈「全格加成太高」→ 已由下方「定向甄选」取代。`SP_BOND_BOOST` 环境变量仍生效于**所有商店格**，若要只保留定向甄选，把 `start-online.ps1` 里那行 `$env:SP_BOND_BOOST='2'` 删掉或改为 `1`。

### 定向甄选（2026-10-06 定稿，热更配置驱动）

- **配置文件**：`config/custom-rules.json`（新建目录，**非 data/ 官方生成物**，build-data 与上游同步都不会碰它）。改完文件**立即生效**（mtime 缓存热更），无需重启进程；但规则逻辑本身在 server/ 代码里，改逻辑仍需重启。
- **配置模块**：`server/match/customRules.js`（自研）。读文件 + mtime 缓存 + 容错（非法 JSON/未知 kind/字段类型错 → 退回关闭并记一次警告，绝不断对局）。

**① 干员三选一定向（rewardOffer）**
- 作用点：`PlayerState.pushRewardOffer()`（三合一赠送/晋升奖励、以及所有走它的免费挑选）。**寻呼模块/信标未改**（本就是同盟约定向）。
- 位置映射：slot 0 = 第一张候选，slot 1 = 第二张…未列出的位置保持纯随机。
  - `kind: mainCount` = 激活人数最多的主盟约（`minCount` 默认 3 = 所有核心盟约的激活阈值）
  - `kind: maxLayers` = 层数最多的副盟约（默认排除 `soloShip` 独行 + `visiShip`/`miraShip`/`investShip` 经济类）
- `mode`: `filter`（默认，该位置必须是该盟约干员）| `weight`（只提高权重）。
- 抽不到时自动退回纯随机，保证候选张数不缩水。
- 验证：`node --test tools/directed-pick.test.mjs`（4/4，真实 Match 实例）。

**② 装备甄选（itemOffer）**
- 作用点：`PlayerState._rollItemSlot()` → `SharedPool.rollItem(rng, maxTier, opts)`（**仅商店装备槽**，每回合 1 件）。
- 目标装备 = **能与变形同构体配合转职的阵营装备**（数据判定 `giveBondId === 目标盟约`，不硬编码清单）。
- 14 个阵营各有 1 件可出的转职装备：坚守盾牌T1、维式重锤T1、萨尔贡浓茶T2、不屈弹射器T2、炎国短刀T3、阿戈尔重刃T3、奥术法阵T3、精准狙击镜T3、叙拉古正装T3、迅捷作战粮T3、突袭手雷T3、卡西米尔竞技旗T4、拉特兰桥夹T4、谢拉格不融冰T5。
- ⚠️ **维式重锤的 4 个变体（战栗/坚固/加速/灼燃）被游戏本体 shopExcluded，商店只出 T1 基础版**——维多利亚阵营在商店里只有这一件转职装备。
- 无转职装备的 9 个盟约：灵巧、远见、奇迹、投资人、助力、调和、协防干员、独行、绝技（对它们甄选无效）。
- 配置：`minRound`（从第几回合起，默认 6）、`mult`（默认 2）、`mode`（`weight` 默认 / `filter` 必须命中）、`targetBond`（`mainCount` 默认 / 固定 id）、`onTierMiss`（`fallback` 默认退到含该装备的层保证命中 / `random` 保持层级退回随机）。
- 验证：`node --test tools/item-pick.test.mjs`（5/5）。实测：基线 0% → weight ×2 后 19.45%；filter 模式 200/200 全命中。

- **当前启用状态**：两者均已 `enabled: true`（2026-10-06 晚落实，服务器已重启加载）。

### ⚠️ 素材丢失事故与恢复（2026-10-06，必读）

- **症状**：本地+隧道访问全部图标/干员头像/技能图标炸裂（404），`public/assets/` 只剩 175MB（皮肤资源），原版 271MB 素材消失。
- **原因**：皮肤合并过程中 `public/assets/` 被覆盖/清空（该目录在 `.gitignore` 中，git 无法恢复）。
- **恢复**：`node tools/fetch-assets.mjs`（幂等续传，重下 5703 个文件，6897 文件 / 491.5MB）→ **再跑 `node tools/inject-skins-assets.mjs` 重新注入 174 套皮肤**。
- **关键陷阱（务必记住）**：`fetch-assets.mjs --allow-shrink` 会**抹掉 assets.json 里的 skins 字段**（它不认识该字段，重写 chars 时覆盖）。**任何 fetch-assets 重写清单后，都必须重跑 `inject-skins-assets.mjs`**。正常 fetch-assets 会因「20451 条缺失」拒绝写入（防缩水保护；那些是皮肤 spine 的元数据键被误判为文件条目）——不要用 --allow-shrink 绕过，或用了之后立刻重注入。
- **验证三件套**：`curl` 抽查真实资源路径（如 `/assets/char/avatar/char_1012_skadi2.png`）→ 无头浏览器抓失败清单（应 0）→ `node tools/sample-asset-paths.mjs` 采样 assets.json 真实路径批量对比。

### 皮肤子系统部署（2026-10-06 完成，fork 0.1.6-pre-skin 合并）

- **合并方式**：`git merge fork/0.1.6-pre-skin`（fork remote 已配）——8 处冲突手工解决：index.js（双方路由都保留）、audio.js/gameLogic.js/game.css/audio.test.js（**语音相关全取上游侧**，fork 双语语音系统未移植，见下）、game.js（保留 fieldTile 地形/我方 import，仅取 fork 的 `voice=true`）、detailPanel.js（组合：fork 的 isOwnedOrDeployed 语音门禁 + 我方 voice=false 默认）、prep-bench.test.js（取上游版）。
- **资产管线**：`node tools/fetch-skin-spines.mjs`（jsDelivr/fexli 镜像，1023/1044 成功）→ `node tools/fetch-skin-avatars.mjs`（174/174）→ `node tools/inject-skins-assets.mjs`（assets.json 注入 115 干员 174 套，**172 套含战斗骨骼**）。磁盘 175MB（spine 164.9 + avatar 10.3）。
- **降级设计**：5 款皮肤镜像缺 Back 骨骼（阿戈尔/缪尔赛思等）+ 2 款全缺（char_1012_skadi2 两款）——渲染器自动回退原皮骨骼，头像照常。清单工具：`node tools/check-skin-files.mjs`。
- **换装入口**：干员调配面板「换装」Tab（loadout 分页 UI 随合并带入），皮肤选择经 room.skins 协议广播（队友可见），share code 导入导出随 loadoutModel 走。
- **未移植**：fork 的双语语音系统（用户明确不要语音）——audio.js 取上游版，settings.js 的 voiceLang 选择器为**死控件**（无副作用，介意可手动删）。fork 的 android/ 目录已从工作区删除（git 历史可找回）。
- **测试**：skins.test 5/5 ✓ + 皮肤/加成/监控全线复验通过。

### IPv6 直连（队友调研，报告 docs/ipv6-feasibility.md）

- 判定**高可行性**：本机已获移动全局 IPv6（2409:8a55::/64），出口 ping 10-15ms；服务器代码 `HOST='::'` 即双栈；Windows 防火墙已有放行。
- **唯一硬门槛**：移动光猫「IPv6 会话防火墙」默认拦入站，需用户超管登录光猫关闭 → 手机流量实测 `/healthz` 验证。延迟预估 10-80ms，优于 frp；frp 永久兜底无 v6 的朋友。

### 热更新结论 + 安全换装

- **Node ESM 进程内热更做不到**（代码加载后不可替换；`node --watch` 也是重启）。等效方案：`update-restart.bat`。
- `update-restart.ps1` 安全重启逻辑：查 `/healthz` → `matches > 0` 时**拒绝重启**（打印对局数，exit 1，绝不坑在线玩家）→ `matches == 0` 时杀旧进程拉新代码 → 健康检查通过才报成功。
- 使用：对局间隙双击 `update-restart.bat` 即可换代（监控器/盟约加成/未来一切服务器改动通用）。

### 上游同步方法论（2026-10-06 定稿，下次直接照做）

- **同步流程**：① `api.github.com` 查远程 HEAD（github.com 直连常被墙，codeload/api/jsDelivr 可用）→ ② `codeload.github.com/.../tar.gz/<sha>` 下载精确 commit 的 tarball → ③ 解压后 robocopy 覆盖（**绝不用 /MIR**！）→ ④ `git status` 审查 → 恢复被覆盖的自研文件 → ⑤ 跑关键测试 → 提交。
- **血的教训（robocopy /MIR 事故）**：`/MIR` 会把上游没有的本地文件全部删除（AGENTS.md、自有脚本、测试工具等 14 个文件被删）。**永远用 `/E`（只增改不删）代替 `/MIR`**；被删文件靠 `git checkout HEAD -- <paths>` 秒回，git 提交纪律再次救场。
- **自研文件清单（同步后必须逐个验证仍在）**：`AGENTS.md`、`start-online.bat/ps1`、`update-restart.bat/ps1`、`scripts/night-off.*`、`scripts/register-wake.*`、`scripts/uninstall-task.*`、`scripts/wake-start.ps1`、`tools/test-monitor.mjs`、`tools/test-bond-boost-math.mjs`；`server/index.js`（monitor）、`server/match/pool.js`+`PlayerState.js`+`Match.js`（bondBoost）中的自研代码。
- **冲突判断**：先从 API 查上游 commit 动了哪些文件；上游没动的文件，自研版本直接 `git show <commit>:<path> > <path>` 恢复即零冲突。本轮上游 4 个 commit（d582925/f6f5ed5/f6794a2/19a8908）均未触碰 server/，恢复无冲突。
- **验证三件套**：`node --check` 逐文件语法 → `node --test test/match/pool.test.js`（10/10）+ `node tools/test-bond-boost-math.mjs`（PASS）→ 临时端口起服打 `/monitor?json`。
- **合并/同步后必跑：`node tools/check-missing-imports.mjs`**（扫描「被调用但未导入且未定义」的符号）。**血案（2026-10-06 `voiceKey is not defined`）**：合并 fork 0.1.6 时，`game.js` 取了 fork 的代码（调用 `voiceKey` 3 处：选中/部署/卖人路径），但同一文件我改回了我方 import、`audio.js` 也退回我方版本（不导出该符号）→ 运行时 ReferenceError，表现为「卖不了人」等操作失败。**教训：解决冲突要按「符号依赖」判断，不能按「文件」判断**——取了一侧的代码，就必须补齐它依赖的导入/导出；合并后立刻跑扫描器 + 用无头浏览器走一遍真实操作路径。
- **目录变更注意**：上游同步曾把 `public/vendor/` 清空（不进 git，靠 postinstall 重建），症状 = 游戏页加载到一半报「游戏脚本加载失败」；修复 = `node tools/vendor.mjs`，无需回退代码。

### 不打扰线上玩家的验证方法论（2026-10-06 定稿，必读）

> **概念澄清**：隔离验证**不是**「另开一个浏览器 profile 换端口」——那是同一份代码、同一个进程目录，只是换个入口，改代码照样影响线上服。真正的隔离是**另开一份代码副本**，端口只是第二道保险。

- **机制：git worktree（独立代码副本）+ 独立端口**，两层都要有：
  1. **代码层（关键）**：`git worktree add --detach E:\sp6p-verify HEAD` —— 在仓库外开一份**独立检出**，在副本里随便改、随便起服，主工作区与线上进程**完全不受影响**。验证完 `git worktree remove --force <path>` 一键清除，主仓库零残留。
  2. **进程/端口层**：副本里用 `PORT=24599`（避开线上的 24500），`SP_MAX_SEATS=6` 等环境变量只作用于这个进程。
- **省掉 86 MB 重装**：副本里用 **junction 复用主仓库依赖**（不要 `npm install`）：
  `New-Item -ItemType Junction -Path <副本>\node_modules -Target E:\卫戍协议\node_modules`；`public/vendor`（不进 git，靠 postinstall 重建）同理 junction 复用。
- **动手前的三条铁律**：
  1. 先查线上状态：`curl.exe -s http://127.0.0.1:24500/healthz` —— 看到 `matches > 0` 说明**有真实对局在进行**，绝不在主工作区改代码 / 重启服。
  2. 改代码前 `git status --porcelain` 必须为空（干净），否则先提交或 stash，避免把未完成改动混进验证。
  3. **日志目录先建再起进程**：`Start-Process -RedirectStandardOutput` 在目录不存在时会直接失败（本次踩坑）；先 `New-Item -ItemType Directory -Force`。
- **起副本服**（`Start-Process` 的日志重定向路径必须已存在）：
  `$env:SP_MAX_SEATS='6'; $env:PORT='24599'; $env:HOST='127.0.0.1'; Start-Process node -ArgumentList "server/index.js" -WorkingDirectory <副本> -PassThru -WindowStyle Hidden -RedirectStandardOutput <副本>\.cache\s6.out.log -RedirectStandardError <副本>\.cache\s6.err.log`
- **收尾必做**：① 按端口精确停服（`Get-NetTCPConnection -LocalPort 24599 -State Listen` → 只杀 `node`），**不要**用 `taskkill /IM node.exe`（会连线上服一起杀）；② 复查 `curl` 线上 24500 仍 200 且 `matches` 数未变；③ `git worktree remove --force`；④ 主工作区 `git status` 仍干净。
- **验证分层（性价比从高到低）**：`node --check` 语法 → `node --test` 单测 → 副本起服打 `/healthz` 看新字段（如 `maxSeats:6`）→ **真实 WebSocket 走一遍完整路径**（用仓库自带 `test/helpers/wsClient.js` 的 `TestClient`，别手写协议：回包类型是 `t:'ok'|'error'|'welcome'`，`room.state` 载荷是**顶层展开**（`m.seats`/`m.code`），不是 `m.room.*`）。
- 本次实战记录：6 人联机改动在副本里 **46/46 锚点全中**、`seats6.test.js` 10/10、核心回归 87/87、自研甄选 9/9、真实 WS 建房 6 座全通；线上 4 人局全程 `uptime` 未中断。
- **⚠️ 删除副本的致命细节**：副本里 `node_modules` / `public/vendor` 是指向主仓库的 **junction**，`Remove-Item -Recurse -Force` **会跟进删除主仓库的依赖**！`git worktree remove --force` 也会残留 junction 目录。正确做法：先 `Get-Item <副本>\node_modules -Force` 确认 Target，再用 **`cmd /c rmdir /s /q <副本>`**（rmdir 不跟进 junction），最后复查主仓库 `node_modules` 文件数正常。

### 第三方「6 人联机」包调研（2026-10-06 定稿，结论：可移植，待用户决定是否落实）

- **来源**：`D:\Download\Stronghold-Protocol-v0.1.2(gai (2).zip`（306 MB，13,312 条目）。基于**上游 v0.1.2** 的第三方改版，自带 `docs/6人版与原版的差别.md`。**无 `.git`**，是纯源码快照。
- **核心机制**：**不用改代码，只加一个启动开关 `SP_MAX_SEATS=6`**（默认不设 = 官方 4 人，逐字节等同原版）。`/healthz` 新增 `maxSeats` 字段自证。
- **改动集（相对 59e5ff0/111e918 基线，共 16 个既有文件 + 2 个新文件，全部是加性小改）**：
  - 新文件 `server/match/scaling.js`（67 行，三个纯函数 + 常量）、`test/match/seats6.test.js`（188 行，10 个测试）。
  - `shared/constants.js`：`MAX_SEATS_LIMIT = 6` + `setMaxSeats()`（模块级可变值，默认 4）。
  - `shared/protocol.js`：`RESULT_LIMITS` 由 `Object.freeze` 改为**可变对象** + `setSeatLimit()`；`room.removeBot` 的 seat 上界由 `MAX_SEATS-1` 改为 `RESULT_LIMITS.players-1`。
  - `server/index.js`：读 `SP_MAX_SEATS`（仅接受 2–6，非法直接 throw）→ `lobbyOptions.maxSeats`。
  - `server/lobby.js`：`LOBBY_DEFAULTS.maxSeats`、`Room` 座位数组按 `maxSeats` 分配、`room.state` 携带 `maxSeats`、`Lobby` 构造器 clamp + `setSeatLimit`、`stats()` 加 `maxSeats`。
  - `server/match/Match.js`：`this.seatCount = players.size`，传给 `drawDisabledBonds` / `SharedPool` / `bossPoolHp`。
  - `server/match/gamedata.js`：`poolCopies(id, players)`、`bans(difficulty, players)`、`bossPoolHp(id, alive, players)` 三个签名加可选参数（默认 0 ⇒ 原版值）。
  - `server/match/pool.js`：`drawDisabledBonds(gd, rng, {players})`、`SharedPool(gd, {banned, players})`。
  - `server/match/finalAssault.js` / `audit.js`：`bossPoolHp` 透传 `players` / `m.seatCount`。
  - 客户端 4 处：`screens/room.js` 新增 `seatCapacity()`（从 `room.state.maxSeats` 读容量，`normalizeSeats` 用它）、`net.js` 收到 `room.state` 时 `setSeatLimit`、`battle/runner.js` 两处 `slice(0,4)` 改 `RESULT_LIMITS.players`、`ui/gameComponents.js` 座位色 `[162,196,38,280]` → 6 色 `SEAT_HUES`、`css/screens/room.css` 座位网格 `repeat(4,…)` → `repeat(auto-fit,…)`。
- **两条数值规则（只在 >4 人时生效，≤4 时每个系数恒为 1）**：
  1. **共享干员池按人数放大**：`× 人数/4`（5 人 ×1.25、6 人 ×1.5）。按干员单独设定的份数（如缪尔赛思固定 4）属内容设定，**不放大**。
  2. **领袖血条按战场数放大**：6 人分 **3 个战场**（`b1/b2/b3`，每队 2 人一张图），`× 1.5`；**全队仍共用同一条血条与同一个 LP**。淘汰不会让血条缩水。
  3. 附带：**>4 人时主/副盟约各少 ban 一个**（绝境 4 人 `core3+addon4` → 6 人 `core2+addon3`）。
- **移植可行性（已实证，非推测）**：在 git worktree 副本里把整套改动打到我们 **v0.1.6-pre-skin** 上 → **46/46 锚点全中**（唯一需调整的是 `shared/constants.js`，因为上游 0.1.3+ 在 `MAX_SEATS` 与 `ROOM_CODE_LEN` 之间插入了 `MAX_SPECTATORS`）；`seats6.test.js` **10/10**、核心回归 **87/87**、自研甄选 **9/9**、真实 WS 建房 6 座全通（`maxSeats:6`、第 7 个被 `ROOM_FULL`、`removeBot seat:5` 通过而 `seat:6` 被 `BAD_MSG` 拒、`room.start` 成功）。**与我们自研的 monitor / 定向甄选改动零重叠**。
- **结论**：**值得移植**（小、加性、默认关闭、自带测试、4 人行为逐字节不变）。**移植时机必须在无对局时**（改 server/ 代码要重启进程）。**待用户拍板是否落实**。
- **无需移植的部分**：字体（我们已有）、`cheats` 作弊层（作者已在包内自行删除，只剩占位文件）、Docker/CI 改动（与 6 人无关）。

### 一键开服/关服（2026-10-06 定稿，完全脱离 DSH）

- **开服**：双击 `start-online.bat`（脚本内已固化 `$env:SP_BOND_BOOST='2'`，盟约加成默认开）。所有打印地址以 frp-way.com:17913 为主力。
- **关服**：双击 `stop-online.bat` —— 只停 24500 上的游戏服务器（先 curl 验身份防误杀），不动 frpc/其他程序；有 SYSTEM 残留时自动 taskkill 兜底并提示。
- **主力地址已切换**：`https://frp-way.com:17913`（#218 新节点，自动 HTTPS）——因合肥 #83 节点故障退役；APK 明文线 `http://frp-cup.com:30756`（日本 #74）不变；剪贴板文案与脚本打印已同步。
- 关服脚本若提示「被守护进程复活」，说明还有别的自启机制在拉 node，按提示排查计划任务。

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

### 最终形态（2026-10-05 深夜定稿，不依赖 DSH）

- **frpc**：官方守护进程已装为系统服务 + 樱花启动器开机自启 → 两条固定网址 24 小时有效，无需任何操作。
- **游戏服务器**：按需一键启动——**双击 `start-online.bat`**（调 start-online.ps1）：钉死端口 24500（与樱花隧道绑定一致，**绝不静默换端口**，被 Hyper-V 保留区圈走时明确报错）、curl 健康检查、复用已运行的源站、打印全部联机地址；关服 = 关闭弹出的服务器窗口。
- Cloudflare 临时隧道降级为可选兜底（`-Tunnel` 参数才启动），平时不跑。
- 已放弃计划任务开机自启方案（用户选择按需启动）；`scripts/install-service-windows.ps1` 仍在仓库里，未来想改回自启可直接用：`-Port 24500 -AllowPublicNetwork`。
- 手动起服备用：`$env:PORT=24500; npm start`。

### 主力路线：樱花 frp 固定网址（2026-10-05 实测全通，延迟约为隧道 1/4）

- 隧道：TCP 类型，节点 #83 合肥电信PLUS2，本地 127.0.0.1:**24500**，自动 HTTPS「启用」；frpc 由官方启动器（`C:\tools\sakurafrp\SakuraLauncher.exe`，MD5 已校验）管理，登录账号后常驻。
- **固定地址 `https://frp-end.com:15810`**（朋友收藏一次即可；iOS Safari / 安卓浏览器 / PC / APK「填地址连接」通用）。
- 实测：HTTP 200、wss 握手 OK、TCP connect 54–73ms、暖请求 TTFB 230–262ms（对比 Cloudflare 785–1364ms）。WebSocket 长连接下实际操作 RTT ≈ 54–73ms。
- 游戏服务器默认端口已从 3000 迁到 **24500**（`start-online.ps1` 同步更新）：3000 易被 Hyper-V 保留区抢走，且 frp 隧道绑定需要固定端口。
- **踩坑 1**：内地节点的 TCP 隧道穿透明文 HTTP 会被合规拦截（HTTP 501，节点返回「必须启用 HTTPS」）——这不是故障。解法即官方推荐：国内节点 + 网页/API 流量**必须开自动 HTTPS**（官方速查表「网页（国内节点）✔️必须」；「游戏联机 ❌不要」那条指非 Web 的 P2P 游戏流量，不适用于本网页游戏）。
- **踩坑 2**：自动 HTTPS 用自签证书，浏览器首次访问需「高级 → 继续前往」（一次性）；**安卓 APK 的 WebView 可能无此按钮**——APK 用户进不去时改用浏览器，或另开海外节点隧道（明文 HTTP 不拦、无证书告警，广东→香港约 20–50ms）。
- 要换节点/加隧道都在 natfrp 后台操作；本地端口统一填 24500。
- **双隧道并存**（2026-10-05 深夜定稿）：同一服务器挂多条隧道，朋友从任一地址进的都是同一个房。
  - **合肥 #83 `https://frp-end.com:15810`**（TCP+自动 HTTPS）：浏览器用户主力，你侧 connect 54–73ms，加密。
  - **日本2 #74 `http://frp-cup.com:30756`**（TCP，自动 HTTPS 禁用，**明文**）：**APK 专用**——安卓 APK 的 WebView 对 wss 自签证书大概率直接拒连（不走 onReceivedSslError 回调），明文 http→ws 全程不碰证书，零构建兼容官方 APK；你侧 connect ~98–121ms（偶发抖动），海外节点允许明文 HTTP。**也是 iOS 的兜底线**：Safari 页面能开但卡在连接（自签未继承给 wss）时换这条，无证书参与，同一个房。
  - 日本2 建站类型补充：日本等海外节点比内地节点多出「HTTP/HTTPS 建站隧道」类型（需绑自有域名），TCP 明文仍是 APK 兼容的最简解；HTTPS 建站 + Let's Encrypt 证书是理论完美方案，有域名再说。
  - 已否决路线：自建魔改 APK（改 WebView 信任自签证书）——需要 JDK17+Android SDK+Gradle 环境，且 wss 自签在 Chromium 内核内部拒连、壳层豁免无效，性价比远低于明文隧道；本机仅 Java 8，环境全缺。

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
- **版本一致性机制（关键认知）**：APK remote 模式 = WebView 加载服务器页面，游戏逻辑 100% 跟服务器版本走（源码 connectToHost 直接 loadUrl 服务器地址）。PC 服 0.1.3 + 朋友任意版 APK 完全兼容，无需对齐版本；APK 自带的旧数据只在「本机单人/同一 Wi-Fi」开服时启用。真正的坑：① APK 断线重连必须回同一个 APK（WebView 存储隔离，换浏览器丢座位）；② 不要把 APK 自开房与 PC 服的房间/密钥混用（两套独立服务器）。
- **版本澄清（2026-10-06 git compare 实测）**：release 页 v0.1.4 写的「上游 0.1.2」是当时旧状态；v0.1.5-pre 起 fork 已同步上游 0.1.3 + bd892a4（联防 BGM），视频说法属实。当前 0.1.6-pre-skin 分支 vs 上游 master 19a8908：**领先 49 commits**（安卓壳/语音/皮肤自研），**落后 16 commits**（漏怪警报、地形说明、WebP 贴图、战斗语音、盟约条折叠等——我们的 PC 服全有）。推论：APK remote 连 PC 服用不到 APK 内置代码；**手机自开房**才会缺这 16 个新特性。
- **0.1.6 替换上游的方案已否决（2026-10-06 裁定）**：fork 领先的 49 commits 大部分是安卓壳专属，唯一玩法修复（灰毫/号角不攻空 + 莫斯提马减速，f9e2bd5 fix #16/#35）经查是重复劳动——上游 sganggs 已在 10/3 的 `052e906`（含状态图标显示，更完整）修复并包含在我们的 master 历史里（compare status=ahead, behind=0）。**替换 = 净倒退 16 个上游特性，无独家收益。判定：维持上游 master + 自研功能，等 fork 未来真正同步上游后再评估。**

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