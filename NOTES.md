# 卫戍协议 · 自研功能记录（NOTES）

> 本文件收录我们在**官方上游基础上追加**的全部功能：设计意图、实现要点、踩坑与验证清单。
> 从 `AGENTS.md` 外置而来（AGENTS.md 有 64KB 预算，超出会被截断）。
> **改玩法参数先看** `config/custom-rules.json`（热更，无需重启；也可用 `/console` 网页表单改）。
> 冲突裁定：**玩法逻辑一律取官方上游**；下列自研与上游无逻辑冲突，全部保留。
> 操作纪律（闪断授权、验证方法论、上游同步、开服/关服）留在 `AGENTS.md`。

## 目录

- [自研规则总览（热更配置）](#自研规则总览热更配置)
- 各功能详见下文（monitor 监看 / 影子观战 / 定向甄选 / 皮肤 / 配音 / 等待 / 负债 / 抽奖 / 回合编排 / 对局节奏 / 控制台 / 6 人联机 / 一键开服 …）

## 自研规则总览（热更配置）

| 规则 | 配置文件键 | 现状 | 热改 |
| --- | --- | --- | --- |
| 干员三选一定向 | `rewardOffer` | 开启，slot 0 主盟约 weight ×2.6 | ✅ |
| 装备甄选 | `itemOffer` | 开启，weight ×2.6、第 6 回合起 | ✅ |
| 休整期负债 | `prepDebt` | 开启，cap 1.05 | ✅ |
| 回合抽奖 | `roundLottery` | 开启，第 3/6/10 回合各 2 轮 5 选 1 | ✅ |
| 回合编排（加时赛） | `extraRounds` | 开启，第 13 回合后插 4 个发育回合，BOSS 18/隐藏 19 | ✅（BOSS 时间可热改） |
| 对局节奏 | `pacing` | 策略轮选 + 机变 ×1.5；战斗加速**未启用** | ✅（combatSpeed 需重开一局） |

全部规则可用 `http://<主机>:24500/console` 可视化编辑（仅限内网来源）。

## 3.5 自研追加功能（2026-10-06 定稿，提交 b7e26b0 / 8d554a3）

### monitor 实时监看（2026-10-06，提交 00ff41d）

- **能力**：在 `/monitor` 面板点玩家行上的「监看」按钮，即可**无席位限制**地看到该玩家的**完整 m.private**——装备、整备区手牌、临时区、商店 5 格与刷新、资金/生命/盟约层数。原生观战（`room.spectate`）看不到这些，且只有 2 个席位；本功能两者都突破。
- **协议**：`m.monitor { code, targetPlayerId? }`（targetPlayerId 缺省/null = 取消）。监看者只需一个普通 WS 连接 + hello，**不必入房、不占座位、不进 spectators、不计入 humans/观战统计、不改 session.roomCode**。
- **实现（4 处，约 60 行）**：
  1. `shared/protocol.js`：新增 `'m.monitor'` 消息定义。
  2. `server/lobby.js`：`monitor(session, msg)` 处理（校验房间/目标）+ `sendToPlayer` 放行带 `session.monitorRoom` 标记的会话（**顺序关键：必须先打标记再调 addMonitorWatcher**，否则立即补发会被拦）。
  3. `server/match/Match.js`：`this.monitorWatchers: Map<watcherId, targetPlayerId>` + `addMonitorWatcher/removeMonitorWatcher/monitorWatcherCount`；`_sendPrivate` 末尾把同一份 view 追加发给监看者（带 `_monitor: true`）；`sendTo` 放行 monitorWatchers 中的 id（它们没有 PlayerState）。
  4. `server/index.js`：monitorSnapshot 的 players 补 `playerId` 字段（**否则按钮渲染不出**）+ MONITOR_HTML 加监看面板（WS 连接、privateView 渲染器、事件委托）。
- **语义（重要）**：监看是「同一份数据的独立视图」，**不是屏幕镜像**——被看者的 UI 状态（打开哪个干员详情、滚动位置、相机）从不经过服务器，双方零干扰、互不可见。
- **验证**：`node tools/verify-monitor-watch.mjs <port>`（14/14：订阅、_monitor 标记、playerId 一致、shop/hand/board 字段、不占席位、不计 humans、取消、非法目标 BAD_TARGET、不存在房间 ROOM_NOT_FOUND）+ `node tools/verify-monitor-ui.mjs <port>`（7/7：无头浏览器点按钮→面板渲染→WS 已连接→无 JS 错误）。⚠️ 「不计 humans」断言数的是**全局** humans——在同一服务器上连跑多轮验证会因残留房间（每轮留 1 个宽限期内的离线房主）而超数报 13/14，**属测试残留非缺陷**（等 60s 宽限期自然衰减；干净服上 14/14）。
- **安全提醒**：无鉴权，拿到房间码的人即可窥看所有人手牌/商店。纯合作 PVE 影响有限；若将来开 PVP 或公开房间，需加 monitor 口令或限本机来源。
- **已知边界**：监看者视角是「数据面板」；要看**实时战场画面**用卡片上的「客户端」链接（`/?room=CODE`，走原生观战，会占 1 个观战席）。

### monitor 全功能影子观战（2026-10-06，提交 649e726）

- **能力（三合一，正是用户要的）**：`/monitor` 玩家行点「观战」→ 新标签打开 `/?shadow=CODE&as=PLAYERID` → **以被看者视角渲染完整游戏界面**（棋盘、商店、整备区、装备、盟约、HUD、战场画面），同时**不占观战席位**（原生观战仅 2 席且看不到手牌/商店）且**零干扰**（只读）。
- **实现原理**：客户端渲染 100% 由 `store.me.playerId`（myId）驱动 → 影子模式把 `me.playerId` 指向被看者，再接收服务端转发的被看者帧序列，整个 UI 自动以他的视角渲染（**无需改任何渲染代码**）。
- **服务端（Match.js 约 25 行）**：`sendTo()` 内**统一镜像**——发给被看玩家的每一帧（m.private / 战场 b.start / m.public / m.result / m.ticker）都原样转发给监看他的人（带 `_monitor: true`）。这比逐路径打补丁完整；`monitorWatchers` 里的人不在 `players` 中，天然不递归。
- **客户端（新增 `public/js/ui/shadow.js`，约 90 行）**：`parseShadowParam` 解析入口 → `installShadow({store,net})`：① 身份改写（me.playerId → 被看者 + `shadow:true`）；② **只读屏蔽**（`net.send`/`net.request` 拦截 `g.*` / `room.*`，影子发操作也无效）；③ welcome 后自动订阅、beforeunload 退订。
- **接线**：`main.js` 引入并调用 `installShadow`（命中则 `net.setName('观战·影')` **触发 hello** —— 不 setName 就不会握手，这是踩过的坑）；`store.js` 的 `selectRoute` 在 `s.me.shadow` 时直返 `'game'`（影子无 session.entered，否则卡在标题页）。
- **验证**：`node tools/verify-shadow.mjs <port>`（7/7：订阅成功、_monitor private、shop/hand/board 字段、m.public 到达、**无头浏览器渲染出真实对局界面**（如「选择策略/决策顺序/玩家A 决策中」）、无 JS 错误）+ 核心回归 pool 10/10、bonds 7/7、seats6 10/10。
- **两个入口并存**（monitor 玩家行两个按钮）：「观战」= 影子客户端（全功能画面）；「数据」= 侧栏数据面板（轻量文字，不加载客户端）。
- **AI 座位也可看（2026-10-07，提交 0023cef）**：任何座位（含 bot）都有观战/数据按钮——用户反馈"永远只能看一号位"，根因是按钮过滤 `!p.isBot` + 服务端 bot 不走 _sendPrivate/被 sendTo 拒发。实现：① 镜像移到 `sendTo` **入口**（bot 的 _resync public 等帧也走这里；镜像用 sendFn 直发不经 sendTo，天然不递归）；② `flush` 里 bot 被监看时（`_isWatched`）也持续推 private（否则画面静止）；③ 放开 `!p.isBot` 过滤。验证：真实 WS 监看 AI（订阅 OK、hand=10、切换第二个 AI OK）+ 无头浏览器以 AI 视角渲染完整对局界面（0 JS 错误）。
- **固定战场（2026-10-07，用户反馈「队友观战别的队友时监视器会一起过去」）**：根因 = `sendTo` 统一镜像把发给被看者的**每一帧**都转给影子——包括被看者「前往查看」队友时服务器发给他的**别人战场帧**（休整期侦察的 `m.field n:<other>`、战后观战的 `b.start{watch:true}` + b.ev/b.snap）。修复（2 处，全在 Match.js，**服务端改动必须重启才生效**）：① 镜像循环加 `_monitorPinnedSkip(msg, targetId)`——帧带 fieldId 且不是被看者自己的战场（fields 里没列他为玩家；休整期无 fields 时任何 m.field 都是侦察别人的板，`n:<targetId>` 本身从不发给他本人）→ 不镜像；被淘汰者（无自己的战场）照常跟随；② `addMonitorWatcher` 的初始战场帧改为**优先取被看者自己的战场**（原来先读 `watchers`，被看者正在看别人时初始帧就是别人的战场）。另证：战斗中前往查看本就被服务端 `_watchClient` 拒绝（WRONG_PHASE）——该场景无跟帧。验证：`node tools/verify-shadow-pin.mjs <port>`（15/15：休整期侦察不跟随/初始连接 pinned/开战后自己战场 b.start 镜像/战斗 spec 完整/不占席位）+ verify-monitor-watch 14/14 + verify-shadow 7/7（干净服复验）。**已闪断上线（2026-10-07）：matches=0 时 update-restart 换代，线上 24500 复跑 15/15。**
- **monitor 面板 WS 连接数**：monitorSnapshot 需带 `network.connectionCount`（早期只传 lobby.stats() 导致面板显示 undefined）。
- **安全**：同样无鉴权，且能力更强（可看战场细节）。纯合作 PVE 可接受；开 PVP 前必须加口令或限本机。

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

### 中日配音局内热切换（2026-10-07 完成，接手死会话的调查落地）

- **能力**：设置弹窗「语音语言」单选（中文 (默认)/日语）**局内热切换**——点一下立即生效，无需重启/刷新；正在播的那句保持原语言播完，之后每句按新语言解析。上游四国配音资产本地只落地了 cn（本功能补下 jp：**1680 文件 / ~51MB，12/12 战斗槽位全覆盖，0 失败**），原 fork 双语语音系统未移植的死控件就此激活。
- **关键认知（实现原理）**：官方四国配音**共享同一套文件名**（zh_CN 表的 `CN_*` 编号，jp 文件也叫 `cn_019.mp3`），只有 dump 目录不同 → 切换 = URL 前缀改写 `/voice/cn/` → `/voice/jp/`，**assets.json 清单零改动**（不碰 data/ 官方生成物，build-data 与上游同步都安全）。jp 缺某行时 404，`_playVoice` 在同 token 窗口内回退 cn 行（`_buffer` 缓存住 404，回退零成本）。
- **实现（3 处客户端 + 2 工具）**：
  1. `public/js/audio.js`：导出纯函数 `voiceLangUrl(line, lang)`（`/voice/cn/` 前缀改写，无需改写返回 null）；`setVoiceLang(lang)`（幂等 + 切换时 `voiceGate.reset()` 让新配音立即响应）；`voice()` 改写后交 `_playVoice(dub || url, token, volume, fallbackUrl)`；`_playVoice` 改 async，buffer 为 null 且有 fallback 时同 token 窗口内重试清单原行。
  2. `public/js/ui/gameLogic.js`：`DEFAULT_SETTINGS` + `sanitizeSettings` 加 `voiceLang`（'cn'|'jp'，默认 'cn'）——死控件的另一半根因就是 sanitize 之前会剥掉该字段，选了也不落盘。
  3. `public/js/ui/settings.js`：`settingsStore.subscribe` 加 `audio.setVoiceLang(s.voiceLang)`（每次设置变化自动生效，这是热切换的通道）+ 模块加载处初始化；VOICE_LANG 标签改 `[['cn','中文 (默认)'],['jp','日语']]`——**默认 cn 与现状行为一致**，老玩家不会被悄悄切日语（要 fork 的日语默认改 DEFAULT_SETTINGS 一处即可）。
  4. `tools/fetch-bilingual-voices.mjs`（fork 皮肤合并 53d9e35 带入，原直连 raw.githubusercontent 本机不通）：加 `SP_GITHUB_PROXY` 前缀代理支持（默认 gh-proxy.com，与皮肤管线 `sources.mjs` 同一传输；`SP_GITHUB_PROXY=''` 恢复直连）。
  5. `tools/verify-voice-lang.mjs`（新，12 断言，无头浏览器）。
- **验证**：`node tools/verify-voice-lang.mjs <port>` **12/12**（setVoiceLang 存在、voiceLangUrl 改写/不改写/null、默认 cn、updateSettings→store→localStorage 三同步、幂等、真实播放 jp/cn 各自请求 `/voice/jp|cn/`、404 回退 cn、0 JS 错误）+ 弹窗**真实点击**「日语」→ store=jp/按钮高亮/localStorage 落盘（.cache/modal-check.mjs 临时件）+ audio/mix/media 回归 31/31 + UI 回归 51/52（唯一失败 HUD_REM 与干净 HEAD 基线逐条相同 = fork 存量）+ 符号审计 ✓。服务器零改动。
- **踩坑（测试侧，复用价值）**：① resource timing 默认 250 条 buffer 在游戏页必然溢出——先 `performance.setResourceTimingBufferSize(10000)` + `clearResourceTimings()`，否则语音请求根本不进 entries；② audio 走 `mediaUrl` 的**去扩展名**形式（`/assets/audio/X` → `/media/X`，`assets/audio` 整段剥掉），断言实际请求要看 `/media/voice/...`；③ `JSON.stringify(localStorage)` 对 Storage 对象返回 `{}`（属性不可枚举），要 `localStorage.getItem('sp.pref.settings')`；④ 测试切语言必须走真实 UI 路径 `updateSettings`——直接调 `audio.setVoiceLang` 绕过 store，store 不会同步（store→audio 单向，与 setVolumes 同构）。
- **已知边界**：en/kr 语音未下载（四国只落地中日）；将来补齐 = 下载素材 + settings 单选加一项 + `setVoiceLang` 放行一项，机制已通用。切换不重播当前句（gentle 切换）。

### 休整期等待投票（prepWait，2026-10-07 自研追加；**v2 同日重构：与准备完全独立**）

- **需求（用户 v2 定稿）**：等待**独立于准备**——不就绪也能等待、等待**不锁任何操作**（不算准备状态）；**所有活人都在等待**时暂停本回合倒计时（deadline 0），所有人仍可同时操作（两个人一起电表倒转）；任一人取消等待即恢复剩余时间。v1（就绪后才可按、活人−1 票等最后一人）已被取代。
- **协议**：`g.prepWait { on }`（shared/protocol.js）。服务端 `Match.prepWait(ps, on)`：仅 PREP、solo 拒（**无就绪门禁**；重复加入/未加入取消 → ALREADY）。
- **hold 条件（v2）**：`prepWaitHeld` = `_prepWaiters` 非空 **且 所有活人都在 waiters**（`alivePlayers().every`）——等待人数就是全体，两两倒转天然成立。等待者断线/离开：`onLeave` 里 `_prepWaiters.delete`，活人集合变化后 hold 自动重估（释放是安全默认）。
- **倒计时暂停/恢复（`_prepWaitRefresh`）**：hold ⇒ 记剩余秒（`_prepWaitRemainSecs`）+ cancel `_phaseTimer` + `deadline=0`；释放 ⇒ `setDeadline(剩余秒)` + 清空投票。`enterPrep` 重置全部状态；`onReadyChanged` 联动刷新。
- **m.public.prepWait**：`{ held, waiters[], all }`（v2 去掉了 v1 的 target 字段）。hold 时 deadline 已是 0，客户端倒计时自然消失——Countdown 组件零改动（deadline=0 =「无倒计时」的既有 solo 语义）。
- **客户端**：`actions.prepWait(on)`；`ReadyToggle`（hud.js）**始终渲染等待按钮**（`const waitBtn = html` 不再受 ready 门禁），与准备按钮并排（`readywrap__pair`，amber 色调，hold 时 mint 脉冲）；提示条改「倒计时已暂停 · 全员等待中 · N/total 人仍可操作」。
- **验证**：`node tools/verify-prep-wait.mjs <port>`（**v2 20/20**：未就绪可等待/单人等待不 hold/全员等待 deadline=0/hold 期间 g.refresh 成功/取消恢复/ALREADY/B 就绪后 hold 仍成立/全员就绪 endPrep）+ `verify-prep-wait-ui.mjs`（10/10：未就绪也渲染等待按钮/三态/提示条）+ pool/seats6 20/20 + shadow-pin 15/15（monitor-watch 13/14 = 多轮验证的已知房间残留）。
- **已知边界**：hold 无上限（需求本身）；全员卡死 = 任何一人取消等待即恢复；`_waitTargetId` 已无调用方（保留备用，如需恢复 v1「等最后一人」语义改回 hold 条件即可）。`update-restart` 后线上生效。


### 休整期负债规则（prepDebt，2026-10-07 自研追加，朋友需求）

- **需求**：lp ≤ 0 不淘汰进入**负债**（负血继续作战），全队血量总和 < 0 才回到原逻辑让负债者死；同时敌人为负债提供倍率加成（**只作用于普通/联防波次敌人 HP，不作用于领袖/Boss**）。动机：电表倒转等长操作玩法 + 高血量策略（歌利亚 45）有价值。
- **量化设计（v3 用户定稿）**：Ā = 全策略平均初始血量排除歌利亚(45)向上取整 = 26（Match 构造自动算）。只有**真正负血**才算负债：debt = Σmax(0,−lp)；savings = Σmax(0, lp−Ā)（歌利亚 45 满血 = +19 存款）；net = debt − savings。net>0 ⇒ 敌人 HP ×(1+k·net/Ā)，k=0.3，cap=1.05；net<0 ⇒ ×(1+k₂·net/Ā)，k₂=0.15，floor=0.85；net=0 ⇒ ×1（三人 1/3/3 残血但未负 ⇒ 不惩罚）。全部热参数走 custom-rules.json。
- **淘汰/清算（Match.settle 内，原 lp≤0 即淘汰处改造）**：负债规则开启时跳过原判定；结算后 Σ(活人 LP) < 0 ⇒ **从最深负债者逐个淘汰**（每淘汰一人移除其负 LP 总和回升）直至总和 ≥ 0；全灭 → afterSettle finish(eliminated)。淘汰文案「全队生命值总和告负，你的负债被清算」。**踩坑**：原代码 `ps.lp = 0` 在淘汰时归零——负债者存活期间 lp 保留负值，LpTower 客户端改为负数红字显示（`lp__val--debt`，gameComponents.js 原 `Math.max(0,...)` clamp 移除）。
- **倍率注入点（关键选择）**：`Match._sanitizeSpawns(list, ownerPlayerId, applyDebtMul)`——普通波次（_normalOpts）与联防波次传 true（**联防敌人更强 = 「增加队友压力一起负重前行」原话的直接实现**），领袖/Boss 战（L3249）不传。注入方式 = spawns[].mods.hpMul ×倍率（spawnEnemy 原生支持 mods 乘数，与波次自带 hpMul（如 0.8）正确叠乘）。**不动 sim 内核 → golden 语料安全**。
- **m.public.debt**：`{ lpSum, mul, avgHp, debt, savings, net }`（规则开启时任何阶段广播）；HUD 顶栏 `debtpill` 三态：mul>1 红「敌方 ×N（负债）」/ mul<1「（存款）」/ ≈1 中性。
- **golden 解耦（重要）**：prepDebt.enabled 会改变 golden 语料的对局结果（AI 淘汰行为偏离官方）→ `customRules.js getCustomRules` 加 **`SP_OFFICIAL_RULES=1` 强制全关**，`golden.mjs` 入口设置该 env（worker 继承）——golden 语料与用户配置永久解耦。已验证 golden 全绿（46+22+16）。
- **验证**：`node --test tools/prep-debt.test.mjs`（**v3 15/15**：倍率曲线 8 含三人 1/3/3 回归 + 清算逻辑 3 + 波次注入同 seed 基线对比 1 + settle 结算接线 3）；E2E 的「真实漏怪扣血」路径不可行（client combat 由 authority 浏览器模拟，TestClient 不模拟 → 服务器 takeover 的替身战斗不产生漏怪扣血）——settle 接线单测替代。回归：甄选 4/4、物品 5/5（**必须单跑**——三个测试文件并发会互写 custom-rules.json）、prep-wait v2 20/20、shadow-pin 15/15。
- **已知边界**：负债无个人上限（总和 < 0 才清算，高血队友兜底 = 设计）；hold 倒计时 + 负债叠加 = 无限时长的整活局（设计意图）；最终攻势个人 LP 冻结（只扣 teamLp），血池倍率按进入时负债锁定；普通波次倍率在每场战斗 spec 生成时锁定（回合内不变）。
- **三处 clamp 修复（2026-10-07 提交 c97e39e，用户反馈「看不到负债」）**：① `Match.publicView` 的 `lp: Math.max(0, ps.lp)` → `ps.lp`（**根因**：服务端广播就截断，队友面板永远看不到负血）；② `gameLogic.normalizeResult` 的 `Math.max(0, teamLp)` → `teamLp`（结算画面显示真实负债）；③ `teamPanel.rowLp` 的 `pending = Math.min(lp, …)` 在 lp<0 时算出负数预告 → `lp < 0 ? 0 : …`。验证：`node tools/verify-debt-ui.mjs <port>`（5/5）+ 单测新增「负血广播」断言（publicView lp=-17 不被 clamp、debt.net>0）**16/16**。

### 规则控制台（/console，2026-10-08 自研追加）

- **能力**：浏览器打开 `http://<主机>:24500/console` 即可**用表单改全部外置规则**——干员三选一（rewardOffer）、装备甄选（itemOffer）、休整期负债（prepDebt）、回合抽奖（roundLottery）。改完点「保存并热更生效」立即生效（写 `config/custom-rules.json` + 清 mtime 缓存，**无需重启**，对局中玩家也生效）。
- **页面**（`public/console.html`，零依赖原生 JS）：6 个标签页 = 五组规则表单（三选一/装备甄选/负债/抽奖/回合编排）+「原始 JSON」；候选位、抽奖回合表可动态增删行；顶部状态胶囊实时显示生效清单。
- **服务端**（`server/index.js` + `customRules.js` 的 `saveCustomRules`）：`GET /console` 出页面、`GET/POST /console/api` 读写。**全站唯一 POST**（`handleRequest` 顶部加例外）。
- **安全**：① 仅内网来源（复用 `isPrivateAddress`，外网 404）；② 写盘前 `normalize` 校验（非对象/数组/null 拒绝）；③ 原子写（`.tmp` + `renameSync`）。非法内容一律 400 且**磁盘保持上一次的好配置**。
- **踩坑**：`log` 在 `createServer` 闭包内而函数在模块顶层 → 初版 `log.info` 导致写盘成功但响应 400（"log is not defined"）；改为传参。
- **验证**：`verify-console-api.mjs`（**13/13**：读写往返/独立读盘确认/关规则/非法拒绝/拒绝后未写坏/恢复）+ `verify-console-ui.mjs`（**14/14**：6 标签/表单渲染/真实改值保存/API 确认/原始 JSON/0 JS 错误）+ 回归全绿。
### 回合抽奖（roundLottery，2026-10-08 自研追加，用户需求）

- **需求**：第 3/6/10 回合送装备抽奖（复用凯瑟琳「定向投放」面板）；两轮独立 5 选 1；池按回合过滤（3 回合全阶、6 去 T1、10 去 T1T2）；参数全外置。
- **实现**：`customRules.js` 解析 `roundLottery`；`Match._grantRoundLottery` 在 `enterPrep` 推 `rolls` 个独立 offer；`_rollLotteryItems` 从 `shopItemsByTier[minTier..maxTier]` 抽不重复 N 件。**零改动复用** `pushItemOffer`（多轮靠 offers 队列，客户端自动显示「之后还有 N 项」）。
- **两个踩坑**：① 池上限默认 6（全阶）而非玩家商店等级——初版按个人等级致第 6/10 回合在等级 1 时池空、一件不发；② 默认不给 AI 发（`includeBots:false`）。
- **验证**：`round-lottery.test.mjs` **12/12** + golden 全绿；线上截图确认 5 选 1 + 「之后还有 1 项」。
### 回合编排（extraRounds，2026-10-08 自研追加，用户需求）

- **需求**：延后 BOSS 给玩家更多发育回合。定稿：第 13 回合后插 **4 个发育回合**（14–17），**复用第 13 回合的波次**（不换强度），怪组从同档池随机混排（多样性），**难度曲线「拉伸」**（用户明确「不是接龙而是拉伸」），**BOSS 定在 18、隐藏 BOSS 19**，其他不变；**改 BOSS 轮时间要热生效**（自动重算难度）；参数**全外置**。
- **实现**：① `customRules.js` 解析 `extraRounds`（insertAfter/count/templateRound/curve/4 个公式常数/poolTemplates/mixPerRound）；② `gamedata.js` 加**热读 getter**（非构造快照）+ `isInsertedRound`/`templateRoundFor`；③ `roundCfg(r)` 对插入回合复用模板回合配置、清 bossTemplates、从池随机挑波次模板（`_mixTemplateFor`，同回合稳定）；④ `enemyScale(r)` 按 curve 算；⑤ `Match.startRound` 抬 floor、`endPrep` 锁 BOSS。
- **难度曲线（官方公式反解）**：`hp = curveBase × curveRate^k`、`atk = curveBaseAtk × curveRateAtk^k`，k = config `enemyScale[回合].kHp`（**官方表自带 kHp/kAtk 但代码从不使用**；实测 `0.8×1.2^k` 逐值吻合）。五种：**stretchShape（定稿，形状保持横向拉伸，全程 ≤ 官方）** | stretch（线性重排，前中期略陡）| append | smooth | flat。
- **热改 BOSS 时间**：全部热读 getter → 改配置立即影响后续回合。两道保护：① `_erFloor`（每进一回合抬高）= BOSS 不落在已过去的回合；② `_erBossAt`（`lockBossRound` 在 endPrep 锁）= 触发后不漂移。**踩坑**：初版 `computed > floor ? computed : floor+1` 在 count=0/floor=14 时算成 15——边界该用 `>=`。
- **验证**：`extra-rounds.test.mjs` **15/15** + `extra-rounds-hot.test.mjs` **6/6**（推后生效/改小不落过去/触发后锁定/改 count 难度自动重算）+ golden 全绿 + 控制台 UI 14/14。
### 版本基点与公开 fork（2026-10-07）

- **基点写明**：README「简介」+ 新增「本仓库的追加能力（基于上游 v0.1.4）」一节——基点 = 上游 `sganggs/Stronghold-Protocol` **v0.1.4**（tag=master HEAD=`9f93096`，合并提交 `e3c17ee`），并列出自研能力清单（6 人联机/monitor 监看+影子观战/监控面板/定向甄选/中日配音热切换/皮肤/一键开服/四国语音管线/IPv6 双栈）；冲突裁定（玩法取官方）也写在 README。提交 `41ef8fb`。
- **公开 fork**：<https://github.com/Strinova-xinghui/Stronghold-Protocol>（`gh repo fork` 建的真 fork，公开，继承 GPL）——master 已推送到 `41ef8fb`（`9f93096..41ef8fb` fast-forward，上游历史在其祖先链上）。本地 remote 名 **`mine`**。
- **推送通道**：见全局 `~/.dsh/AGENTS.md`「GitHub 推送通道」——Clash Verge GUI 激活代理（服务常驻≠端口有监听）→ `$env:HTTPS_PROXY=http://127.0.0.1:7897` → git push 走 gh credential helper（Strinova-xinghui，repo 权限）。SSH 密钥路线已试并销毁（gh ssh-key add 需 admin:public_key scope，token 没有）。

### IPv6 直连（队友调研，报告 docs/ipv6-feasibility.md）

- 判定**高可行性**：本机已获移动全局 IPv6（2409:8a55::/64），出口 ping 10-15ms；服务器代码 `HOST='::'` 即双栈；Windows 防火墙已有放行。
- **唯一硬门槛**：移动光猫「IPv6 会话防火墙」默认拦入站，需用户超管登录光猫关闭 → 手机流量实测 `/healthz` 验证。延迟预估 10-80ms，优于 frp；frp 永久兜底无 v6 的朋友。

### 上游 v0.1.4 同步（2026-10-07，合并提交 e3c17ee）——已上线

- **范围**：19a8908 → v0.1.4（HEAD=9f93096），33 commit / 66 文件。
- **玩法修复（冲突处一律取官方）**：阿戈尔吞噬基础 ATK 改最终加算；高台按特性「可以放置于远程位」（崖心/见行者/歌蕾蒂娅普通+精锐+任意模组均可）；5-阿戈尔复活名额给最先倒下的 3 名；联防阿戈尔吞队友；沉睡敌人不可阻挡不占阻挡位；缇缇 S2 沉睡脉冲计入特质；耀骑士临光 S2 撤退+不屈不再丢戒律、伊内丝影哨收回；引星棘刺 S1 自动触发；盟约概率封顶 100%；观战按钮发密钥；Q 撤退 X 出售；结算语音 chess→char 映射；棋盘贴图 WebP；**golden 结果安全网**（`npm run golden`）。
- **合并方法**：`git merge-tree --write-tree --merge-base=19a8908 HEAD 9f93096`（**base 必须显式给，否则假冲突 30+**）→ worktree `read-tree -m -u <tree>` 物化 → 手工解 7 处 → `commit-tree` 双亲提交 → `merge --ff-only`。**坑**：`read-tree -m -u --reset` 报「Which one?」，别加 --reset。
- **验证**：核心 2351/2352（唯一失败=性能阈值抖动）· lobby 72/72 · golden 6/6 · 甄选 9/9 · UI 899/902（3 个失败与基线逐条相同=fork 存量）。

### 6 人联机（2026-10-07 已落实，提交 17bc472）——移植自第三方包 + 一键开服

> **状态：已实装并线上验证通过**（`/healthz` 报 `maxSeats`、真实 WS 建房 6 座全通）。**默认开的是 6 座房**；4 人及以下玩时逐字节等同官方（见下节实证）。

- **怎么开服（2026-10-07 已合并为单一启动器）**：双击 **`start-online.bat`** 即可，**默认就是 6 座房**——因为 4 人及以下玩时规则与数值逐字节等同官方，没必要再分两个入口。要严格 4 座（例如向人证明「就是官方」）：`start-online.ps1 -MaxSeats 4`。旧的 `start-6p-online.bat` **已删除**（它只是 `-MaxSeats 6` 的包装）。命令行等价：`$env:SP_MAX_SEATS='6'; npm start`。
- **座位数启动时固定、不能热改**：已在跑的房与请求的座位数不一致时，脚本会**明确提示「必须重启才生效」**并让你先 `stop-online.bat`（不会静默混用）。
- **自证**：`GET /healthz` 与 `/monitor?json` 都有 `maxSeats` 字段（4 或 6）；`welcome` 帧也带 `maxSeats`，所以**客户端在进房前就知道容量**——
  - 大厅「同盟模拟」卡片的人数文案改成**渲染时读 `RESULT_LIMITS.players`**（getter，不再用常量 `MAX_SEATS`），6 人服显示「1–6 名博士」而不是误导性的「1–4」；4 人服显示不变。
  - `public/js/net.js` 在收到 `welcome` 或 `room.state` 任一帧时提升协议上界（`setSeatLimit`），所以在房间外 `room.removeBot` 的座位上界也已经是 6。
  - 服务端 `welcome` 的 `maxSeats` 取自 `RESULT_LIMITS.players`（`Lobby` 构造时已写入）——**无需给 Network 加配置项**，老客户端收到多余字段无副作用。
- **4 人及以下行为不变**：两条缩放系数在 ≤4 人时恒为 1、盟约 ban 用模式自身值 —— 所以**6 人模式的房间里玩 4 人局 = 官方原版**，只是座位板显示 6 格。怕影响 4 人体验的顾虑可以放下。

- **来源**：第三方包（306MB 快照，基于上游 v0.1.2，无 .git）。**核心机制**：不动逻辑，只加 `SP_MAX_SEATS=6` 开关（不设=官方 4 人）。
- **改动集**：新增 `server/match/scaling.js`（3 纯函数）+ `test/match/seats6.test.js`；`shared/constants.js` 加 `MAX_SEATS_LIMIT=6`+`setMaxSeats()`；`shared/protocol.js` 的 `RESULT_LIMITS` 改可变+`setSeatLimit()`；`server/index.js` 读 env→`lobbyOptions.maxSeats`；`lobby.js` 座位数组按 maxSeats；`Match.js` 传 `seatCount`；`gamedata.js` 三个签名加 `players` 参数（默认 0=原版）；客户端 4 处（seatCapacity/net.setSeatLimit/runner slice/座位色 6 色，**前 4 色逐字节相同**）。
- **两条数值规则（仅 >4 人，≤4 恒 1）**：① 共享干员池 ×人数/4（按干员单独设的份数如缪尔赛思固定 4 **不放大**）；② 领袖血条 ×1.5（6 人 3 战场，全队共用血条与 LP，淘汰不缩水）；③ >4 人主/副盟约各少 ban 一个。
- **移植实证**：46/46 锚点全中（唯一要挪的是 `shared/constants.js` 因上游插入了 `MAX_SPECTATORS`）· seats6 10/10 · lobby 67/67 · 甄选 9/9 · 真实 WS 建房 6 座全通。
- **并发协作提醒**：本次移植期间**有另一个会话在同一仓库并行提交**（monitor 实时监看 `00ff41d`、影子观战 `649e726`），双方都改了 `server/index.js` / `server/match/Match.js` / `shared/protocol.js`。实测两者**逻辑上互不干扰**（函数级并存，17 个 6 人钩子点 + 3 个 monitor 符号全在）。**教训：在同一仓库并发提交时，先 `git log` 看有没有别人的新提交，提交前只 `git add` 自己改的文件，绝不 `git add -A`。**

#### 「6 人服玩 4 人」会有影响吗？—— 实测：不会，且这是硬保证（2026-10-07）

- **机制（一句话）**：所有缩放的唯一输入是 `Match.seatCount = players.size`（**实际入座人数**），房间容量 `Lobby.maxSeats` **从不进入对局引擎**——它只决定座位格子数与协议上界。所以 6 座房里坐 4 人 → `seatCount = 4` → 每个系数恒为 1。
- **逐项实测等价**（`test/match/seats6-compat.test.js`，2/2；同一 seed 分别起 `maxSeats:4` 与 `maxSeats:6` 的服务器各开一局 4 人 coop/HARD 对比）：
  | 项目 | 4 人服 | 6 人服玩 4 人 |
  | --- | --- | --- |
  | 房间座位格数 | 4 | 6（另 2 格空着） |
  | `match.seatCount` | 4 | **4** |
  | 禁用盟约（`disabledBonds`） | 3 core + 4 addon | **完全相同** |
  | 被 ban 干员（`bannedChess`） | — | **完全相同** |
  | 共享牌库总份数 | — | **逐干员相同**（并与手工按 ×1 构建的池一致） |
  | 领袖血池 | 官方值 | **官方值**（`bossPoolHp(..., players=0)`） |
  | 最终攻势战场数 | 2 | **2** |
- **已知差异（仅 UI/协议，不影响玩法）**：座位板显示 6 格（2 格空）；大厅显示「1–6 名博士」；`room.removeBot` / `room.kick` 的座位上界放宽到 5；玩家头像色板有 6 色（**前 4 色与原值逐字节相同**，所以 4 人局配色不变）。
- **⚠️ 血案（2026-10-07，必读）：三方包改 `RESULT_LIMITS` 时删掉了 `shared/protocol.js` 的 `MAX_SEATS` 导入，却漏改 `room.kick` 的 seat 上界**，导致 **所有服务器（4 人服也一样）房主踢人抛 `ReferenceError: MAX_SEATS is not defined`** → 被 `net.js` 的 catch 兜成 `INTERNAL`，表现为「踢不动人」。修复 = `kick` 上界改用 `RESULT_LIMITS.players - 1`（提交 `9a69db1`）。
  - **为什么差点漏掉**：我第一轮只单跑了 `test/lobby.test.js`，**真实覆盖在 `test/lobby-kick.test.js`**（名字不含 lobby 主文件），于是把 5 个失败误判成「并行抖动」。**教训：全量测试的失败清单必须逐条按文件单跑复核，不能凭文件名猜覆盖面。**
  - **防复发**：新增符号审计测试（同文件第 2 个 case）——对 16 个移植文件扫描 `MAX_SEATS` / `setSeatLimit` / `poolCopyMulFor` 等 10 个符号，要求「用到就必须 import 或 define」，已反向验证能抓住该 bug。

