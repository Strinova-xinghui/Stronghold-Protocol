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
