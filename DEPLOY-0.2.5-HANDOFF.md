# 0.2.5 上服务器交接文档（给下一个会话）

> 本文档是「合并上游 v0.2.5 → 部署云服」任务的完整交接。代码已在本地 master 与 GitHub（mine/master = c8d1f712），
> 全部测试通过。剩下唯一未完成的事：**把 0.2.5 部署到 Azure 云服 strinova.me（20.89.110.22）**。

## 云服现状（2026-10-13 16:45 SSH 实测）

- `~/sp` 是**解压部署，无 .git**（不能 git pull，用解压覆盖升级）
- 运行中 `stronghold.service`（systemd），**app 0.1.6-pre-skin**，healthz `matches:0`、`maxSeats:6`，uptime ~19h
- 代码 = 本地提交 `7e3791df` 逐字节一致（package.json/customRules/Match/protocol 3+ 文件 md5 抽验全同）
- 依赖 `node_modules` 在（ws 8.22）；0.2.5 **dependencies 零变化**（只有 devDependencies 新增 eslint/ts，不影响运行）
- 素材 `~/sp/public/assets` 567MB（旧版）；0.2.5 新增 ~3580 文件（新干员/皮肤/语音，本地已下载齐全）
- 磁盘 22G 可用、内存 842Mi（+2G swap）充足

## 代码位置

- **本地 master**：`E:\卫戍协议`，HEAD = `c8d1f712`（= GitHub mine/master）
- **升级包**：`E:\sp-deploy\Stronghold-Protocol-v0.2.5\`（后台构建中，`node tools/package.mjs --out E:/sp-deploy（已执行完成；注意不要 --no-install，否则 stage 缺 node_modules/vendor）`）
  - 产物：`Stronghold-Protocol-v0.2.5.tar.gz`（455MB，11586 文件 = 代码 + production node_modules + public/vendor + 全量素材；Windows 无 zip 工具，改用 GNU tar.gz，云服 `tar -xzf` 解压）
  - 附 `MANIFEST.json`（每文件 sha256）——上游 `server/update.js` 启动时会自动校验并清理旧文件（UPDATE 机制）
- 回滚备份分支：本地 `backup/pre-upstream-0.2.5-20261013-0414`（= 7e3791df，与云服现状同代码）
- CI workflows 提交在本地分支 `backup/workflows-scope`（`47a4f5cd`），**尚未推送**（GitHub token 缺 workflow scope；
  授权：`gh auth refresh -h github.com -s workflow` 后 `git push mine backup/workflows-scope:master`——注意这会
  把 workflows 也带上去，如果只想推 workflows 内容需要 rebase 整理）

## 推荐部署步骤（打断最小、可回滚）

```bash
# 0. 本机 Clash 在跑但 SSH 实测正常（未劫持）；若 SSH 卡住 banner 不回 → 退出 Clash 重试
KEY=/e/keys/MyVM_key.pem; SSH="ssh -i $KEY -o ConnectTimeout=10 azureuser@20.89.110.22"

# 1. 确认无对局（matches:0 才能动；有对局等打完）
$SSH 'curl -s http://127.0.0.1:24500/healthz'

# 2. 云服上先备份当前版本（回滚用，~600MB 磁盘足够）
$SSH 'cd ~ && tar -czf sp-backup-0.1.6-$(date +%m%d%H%M).tar.gz --exclude=sp/node_modules sp'
#   备份含 assets 567MB，注意 tar 排除了 node_modules（63MB，重装很快）

# 3. 上传新包（本机 → 云服，约 400-500MB，取决于上行带宽）
scp -i $KEY E:/sp-deploy/Stronghold-Protocol-v0.2.5/Stronghold-Protocol-v0.2.5.tar.gz azureuser@20.89.110.22:~/sp-025.tar.gz

# 4. 云服解压到新目录 → 无缝切换（比原地覆盖安全）
$SSH 'cd ~ && mkdir sp-025 && tar -xzf sp-025.tar.gz -C ~ && mv Stronghold-Protocol-v0.2.5/Stronghold-Protocol sp-025 && ls sp-025 | head'
#    解压后结构与 ~/sp 相同（app/ node_modules/ public/ server/ ...）——注意确认 unzip 根目录层级

# 5. 校验 MANIFEST（上游 update 机制会校验；手动校验一条也行）
$SSH 'cd ~/sp-025 && node -e "const m=require(\"./MANIFEST.json\"); console.log(Object.keys(m).length, \"entries\")"'

# 6. 切换 systemd 指向新目录 → 重启 → 健康检查
$SSH 'sudo sed -i "s|WorkingDirectory=.*|WorkingDirectory=/home/azureuser/sp-025|" /etc/systemd/system/stronghold.service 2>/dev/null; \
      sudo grep -E "ExecStart|WorkingDirectory" /etc/systemd/system/stronghold.service; \
      sudo systemctl daemon-reload && sudo systemctl restart stronghold && sleep 3 && \
      curl -s http://127.0.0.1:24500/healthz'
#    预期：app:"0.2.5"、maxSeats:6、matches:0
#    ※ 若 service 文件用的是 ExecStart=node /home/azureuser/sp/server/index.js 形式（无 WorkingDirectory），
#      改 ExecStart 里的路径代替。

# 7. 外网验证：https://strinova.me 打开 → 标题页应显示 v0.2.5；healthz 的 build 值变化
curl -s https://strinova.me/healthz   # 本机 curl 即可

# 8. 回滚（如需）：把 systemd 指回旧目录（或解压备份 tar）→ daemon-reload → restart
```

## 注意事项

- **0.2.5 有 UPDATE 机制**（`server/update.js`）：如果解压包根有 `UPDATE.json`，启动时会自动完成旧文件清理并校验
  MANIFEST；校验失败会拒绝启动（exit 1）。这是正常保护，不是事故。
- **全关 = 原汁原味**：`config/custom-rules.json` 随包带过去，8 个自研开关全 true（定向甄选/负债/抽奖/编排/节奏/BOSS
  倍率/GM 发放）。想暂时全关，改 `enabled: false` 即可（mtime 热更，无需重启）。
- **素材**：包内已含全量 10963 个 assets 文件（含 0.2.5 新增的克莱门莎语音等），云服旧的 567MB 会被新目录替代，
  无需单独同步素材。
- **磁盘**：升级期间双份目录（sp + sp-025）约 1.3GB，22G 可用绰绰有余；确认稳定后 `rm -rf ~/sp sp-025.zip` 腾空间。
- **测试基线**：部署前若想再验一遍，本地 `SP_OFFICIAL_RULES=1 node --test test/*.test.js`（官方模式全绿 934/933+）。
- **CLAUDE.md 阅读顺序**：先读本文件 → AGENTS.md「迁移执行记录」节（SSH 私钥 /caddy/systemd 细节）→ NOTES.md
  「上游 0.2.5 同步」节（本次合并完整变更清单）。

## ✅ 部署完成记录（2026-10-13 19:35–19:50 执行）

**结果：云服已上线 v0.2.5**（app:"0.2.5"、build 619e3407dde9、maxSeats:6、matches:0），三条线全通：
- `https://strinova.me/healthz` ✅
- `http://20.89.110.22:24500/healthz`（APK 明文线）✅
- 本机外网打开首页标题正常 ✅

服务端实测 `getCustomRules()` 8 项自研开关全 true（定向甄选/负债/抽奖/编排/节奏/BOSS 倍率/GM 发放）。

### 实际执行步骤（与上文推荐步骤的差异已修正）

1. 备份：`~/sp-backup-0.1.6-10131133.tar.gz`（404MB，回滚点；不含 node_modules）。
2. 整包 scp 直传 455MB 一次成功（未用分块），远端 sha256 = `f6a15be9…34bbce` 与本地一致。
3. **包顶层是单层 `Stronghold-Protocol/`**（上文第 4 步的双层 `mv` 写法不适用）：
   `tar -xzf sp-025.tar.gz -C ~ && mv Stronghold-Protocol sp-025`。
4. ⚠️ **`config/custom-rules.json` 不在包里**（`tools/package.mjs` 按「per-machine config」排除整个 `config/`，
   与上文注意事项第 2 条矛盾——照旧文档做会静默全关自研规则）。已单独 scp 补传到 `~/sp-025/config/`。
   **下次打包部署记住：config 必须手动补传。**
5. 体检新目录：version 0.2.5 / MANIFEST files:6489 / 自研三文件在 / ws 8.22.0 / assets 10956 个 / vendor 5 件。
6. 切 systemd：仅改 `WorkingDirectory=/home/azureuser/sp → /home/azureuser/sp-025`（unit 是 npm start 形式），
   daemon-reload + restart，4 秒后 healthz 即 0.2.5。
7. 旧目录 `~/sp` 与 `~/sp-025.tar.gz` 暂保留（回滚用），确认稳定玩过几次后可删：
   `rm -rf ~/sp ~/sp-025.tar.gz`（备份 tar 建议留）。

### 回滚方法（如 0.2.5 有问题）

```bash
sudo sed -i 's|WorkingDirectory=/home/azureuser/sp-025|WorkingDirectory=/home/azureuser/sp|' /etc/systemd/system/stronghold.service
sudo systemctl daemon-reload && sudo systemctl restart stronghold
```

## 🔧 上线后热修复（2026-10-13 21:25）

**症状**：干员调配页崩溃（`setStatLevel is not defined` 的 SYSTEM FAULT + Preact `insertBefore` 报错）；朋友反馈 IP 与域名进服版本不一致。

- **根因**：0.2.5 合并漏改一行——上游把 `Detail` 的数值档位从内部 state 改为受控 props
  （`level`/`onLevel`），`loadout.js:383` 仍引用上游内部命名 `setStatLevel`（本地该名字不存在）。
  修复：`onLevel=${setStatLevel}` → `onLevel=${setLevel}`（321 行的受控别名，技能 普通/精锐 切换同款）。
- **验证**：`node --check` ✓、`check-missing-imports` ✓、`test/lobby-loadout.test.js` 6/6 ✓；
  scp 上云后 curl served JS：`setStatLevel` 0 处、`onLevel=${setLevel}` 在位。**纯静态文件，未重启服务**（healthz uptime 连续）。
- **「版本不一致」结论**：游戏 JS 无 `?v=` 版本参数、走 no-cache+ETag（`server/http/files.js` 长缓存仅 assets/fonts/vendor），
  服务器侧没有顽固缓存层；不一致来自升级窗口期（19:35–19:50）已打开的旧标签页 + IP(`:24500`) 与域名(https) 是不同 origin 各自缓存。
  **让朋友强刷/重开标签页（APK 重启 WebView）即归位**；`insertBefore` 是前者的次生症状，应随之消失。
- UPDATE 机制核实：云服无 UPDATE.json，单文件 scp 覆盖不触发 MANIFEST 校验拒绝启动。

## 📌 裁定：上游无换装，自研皮肤子系统保留（2026-10-13 21:35）

用户疑「上游 0.2.5 有自己的换装，自研皮肤若冗余则删」。全树对比结论：**上游没有任何玩家可见的换装功能，自研不冗余，保留**。

- 上游 `git grep -i skin`（public/js、server、shared）全部命中为 Spine 骨骼技术语义（skeleton skins/attachments/动画裁剪），非 UI；
- 中文词「换装/时装/皮肤/外观」上游零命中（「替换装备」= 装备栏替换，另一功能）；
- 上游 `data/` 无 skins.json；0.2.5 CHANGELOG 无换装条目；
- 干员详情页第 4 个页签「换装 SKIN」本就是自研 SkinSection（loadout.js ← ui/skinPicker.js），0.2.5 合并后工作正常（skins.test.js 全绿）。
- 疑似混淆源：0.2.5 上游新增「3D 官方场景 / 官方伤害数字 / 内容包与 i18n」等，观感像官方外观功能。

## 🔐 控制台登录制恢复（2026-10-13 22:00–22:20）

**背景**：控制台（/console）因 0.2.5 换目录部署失去密码保护。根因：登录录（内网免密/公网 HTTP Basic）
是 2026-10-11 直接改在云服旧目录 ~/sp/server/index.js 里的，从未进 git——0.2.5 部署到 sp-025 后随旧目录丢失。

**已恢复并上线**（账号 strinova / 密码走 systemd 的 SP_CONSOLE_PASSWORD 环境变量，未变）：

- `server/http/customRoutes.js`：新增 `realClientIp(req)` 严格判源 + console 登录制 + monitor/lan 内层门
- 判源规则：socket 非回环 → 只信 socket 本身（转发头一律无视）；socket 回环（Caddy）→ 只取 XFF **最右**值
  （Caddy 必追加真实来源在最右，伪造条目被挤到左边），**禁信 cf-connecting-ip / x-real-ip**（Caddy 会透传客户端伪造的头）
- 提交 5debc0a9（登录制+判源）+ a5c358e6（monitor/lan 内层门），已推送

**云服终验九项全过**：本机免密 200 / 域名无凭据 401 / 域名对凭据 200 / 域名伪造内网XFF 仍 401 /
直连公网 404（伪造头不救）/ 域名 monitor 404（此前公网可无凭据看监看台，已关）/ VM 本机 monitor 200。

⚠️ **纪律违规记录**：22:0x 第一次重启云服时未先确认 matches==0（脚本虽有检查但无守卫，打断了 1 场进行中对局）。
第二次起脚本加了硬守卫（matches!=0 则 ABORT），教训：守卫必须放在重启语句之前硬性拦截。

**⚠️ 本机 Clash 修复的持久化缺口（下次会话关注）**：SSH 被劫持系 21:52 订阅更新重合成丢失 Merge.yaml 规则。
已生效的修复是经 mihomo pipe API（\\.\pipe\verge-mihomo-production-<hash>）PATCH /configs 写入
`tun.route-exclude-address: [20.89.110.22/32, 198.41.192.0/24, 198.41.200.0/24]`——**只存在于内存态**，
核心重启/订阅更新后会丢。持久化待办（按优先级）：
1. Verge UI → 订阅右键「编辑合并配置」确认 m0gurPPZFZSw.yaml（当前订阅绑定的 merge）里 IP-CIDR 规则在，
   并把 tun.route-exclude-address 三条也补进去（已手工写入该文件 prepend-rules 段，但 tun 段未加）
2. 验证方式：订阅更新后 `Find-NetRoute 20.89.110.22` 应指向物理网卡而非 Mihomo
3. mihomo pipe API 可用：GET /version、PATCH /configs（tun 子键可热改）；PUT /configs payload 重载无效（204 但不生效）；
   SAFE_PATHS 限 C:\ProgramData\clash-verge-service\users\<hash>\runtime（SYSTEM 权限写不进）
