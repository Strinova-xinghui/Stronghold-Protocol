# 免费云端部署指南（Hugging Face Spaces & Render & Azure 学生订阅）

本项目已全面支持 **Hugging Face Spaces** 与 **Render** 的自动化开箱即用云端托管。两者均**完全免费**、支持长连接 WebSocket（`wss://`）以及全量素材和干员中日双语语音。

若已通过 GitHub 学生认证，**Azure for Students 是延迟最低、最稳定的选择**（见方案三）。

---

## 方案一：Hugging Face Spaces 部署（最推荐 · 16G 内存免休眠）

Hugging Face Spaces 提供永久免费的 **2 vCPU · 16GB RAM · 50GB 存储** 容器环境，免绑信用卡，配额极大。

### 部署步骤：
1. 注册并登录 [Hugging Face](https://huggingface.co/)。
2. 点击右上角头像 ➔ **New Space**：
   - **Space name**：自定义（如 `stronghold-protocol`）
   - **License**：`gpl-3.0`
   - **Space SDK**：选择 **Docker** ➔ **Blank**
   - **Space hardware**：保持默认免费的 **CPU basic · 2 vCPU · 16GB RAM · Free**
   - **Privacy**：选择 **Public**
   - 点击 **Create Space**。
3. 将本项目代码推送到该 Space（二选一）：
   - **方式 A（网页直接关联 GitHub 同步，最省心）**：
     在刚建好的 Space 页面 ➔ 点击 **Settings** ➔ 找到 **Repository Mirroring** ➔ 输入你的 GitHub 仓库地址（`https://github.com/Paper-Yuan/Stronghold-Protocol.git`），开启自动同步。
   - **方式 B（Git 命令行推送）**：
     ```bash
     git remote add space https://huggingface.co/spaces/<你的用户名>/<Space名称>
     git push space 0.1.6-pre-skin:main
     ```
4. 容器会自动读取仓库根目录的 `Dockerfile` 与 `README.md` 元数据（已配置 `app_port: 3000`），约 3~5 分钟构建完成。
5. 页面顶部会直接显示游戏主界面，右上方有 **Embed this Space** 或直接获取专属公网网址（形如 `https://<用户名>-<Space名>.hf.space`），发给朋友即可开黑。

---

## 方案二：Render 部署（每月 750 小时免费 · 支持 GitHub 自动触发）

Render 支持通过仓库根目录的 `render.yaml` 实现 Blueprint（一键基础设施编排）。

### 部署步骤：
1. 打开 [Render 官网](https://render.com/)，使用 GitHub 账号登录。
2. 点击右上角 **New +** ➔ 选择 **Blueprint**：
   - 连接你的 GitHub 仓库 `Paper-Yuan/Stronghold-Protocol`（分支选 `0.1.6-pre-skin`）。
   - Render 会自动识别仓库根目录的 `render.yaml`，并自动填好全部参数：
     - Service: `stronghold-protocol`
     - Runtime: `Docker`
     - Plan: `Free`
     - Region: `Singapore` (新加坡，亚太延迟低)
     - Health Check: `/healthz`
3. 点击底部的 **Apply** 按钮。
4. Render 会自动拉取代码并基于 Docker 构建游戏镜像（自动下载全量素材与语音）。
5. 部署完成后，在 Render 控制台即可看到分配的专属 HTTPS 链接（形如 `https://stronghold-protocol-xxxx.onrender.com`）。

---

## 方案三：Azure for Students 云服务器（延迟最低 · 需学生认证）

已通过 **GitHub 学生认证** 后可开通 [Azure for Students](https://azure.microsoft.com/en-us/free/students/)：**$100 额度 + 一批 12 个月免费服务**，免绑信用卡。相比 HF Spaces / Render 的容器方案，它是**一台真正的 VM**：不休眠、无冷启动、延迟最低，还能彻底摆脱樱花 frp 隧道。

### 免费额度的真相（2026-10-09 按官方页面核实）

| 项目 | 额度 | 说明 |
| --- | --- | --- |
| Azure 额度 | **$100 / 年** | 有效一年，在读可每年续；免绑卡（仅限新 Azure 客户） |
| 12 个月免费 VM | **750 小时/月**，三种规格各一份 | B1s、B2pts v2（Arm）、B2ats v2（AMD） |
| 出站流量 | **前 100 GB/月免费** | 全球所有区域 |
| 公网 IP | **Basic 动态/静态 $0** | Standard 静态才 $0.01/小时 |
| 托管磁盘 | 不免费 | P6（64 GiB）≈ **$0.73/月** |

**750 小时 ≈ 31.25 天 > 一个月（约 730 小时）**，所以**一台 VM 24/7 常驻不额外扣额度**。这是它明显强于 Render（512 MB、15 分钟休眠冷启动 30~50 秒）和 HF Spaces（闲置挂起、约 10 秒唤醒）的地方。

> ⚠️ 免费额度覆盖的是**计算小时数**，**不含磁盘**。64 GiB 系统盘约 $0.73/月 ≈ **$8.8/年**，从 $100 额度里扣，一年下来还剩 90 多美元。

三种免费规格（**内存都只有 1 GiB**）：

| 规格 | vCPU | 内存 | 架构 | 建议 |
| --- | --- | --- | --- | --- |
| **Standard_B2ats_v2** | 2 | 1 GiB | x86 (AMD) | ✅ **首选**：2 核，x86 无任何兼容顾虑 |
| Standard_B2pts_v2 | 2 | 1 GiB | Arm | 备选：本项目纯 JS，Arm 可跑 |
| Standard_B1s | 1 | 1 GiB | x86 | 兜底：够用但偏紧 |

本项目依赖全是纯 JS（`ws` / `pixi.js` / `three` / `preact`，**无原生 `.node` 模块**），Arm 与 x86 都能跑；仓库 `Dockerfile` 用的 `node:22-alpine` 也是多架构镜像。

### 建 VM（门户，约 10 分钟）

1. 用 GitHub 学生认证开通 [Azure for Students](https://azure.microsoft.com/en-us/free/students/)（点 **Activate**，从 GitHub Student Pack 入口或学校邮箱进）。
2. 门户 → **创建虚拟机**：
   - **订阅**：Azure for Students
   - **区域**：**东亚（香港）** 或 **东南亚（新加坡）** —— 到国内延迟最低
   - **映像**：Ubuntu Server 24.04 LTS (x64)
   - **大小**：**Standard_B2ats_v2**（2 vCPU / 1 GiB）—— 点「查看全部大小」搜 `B2ats`
   - **身份验证**：SSH 公钥（门户可代生成，**记得下载私钥**）
   - **入站端口**：SSH(22) + HTTP(80) + HTTPS(443)；游戏端口 24500 建好后在 NSG 补
   - **磁盘**：默认 30 GiB 可改 **64 GiB**（P6 档，约 $0.73/月）
3. 建好后进 **网络 → 网络安全组** 加入站规则：`TCP 24500`，源 `任何`。
4. 记下**公共 IP 地址**（概览页）—— 这就是朋友们要连的地址。

### 部署项目

SSH 上去（`ssh azureuser@<公网IP>`），二选一：

**方式 A：直接跑 Node（简单，改代码方便）**

```bash
# Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/Strinova-xinghui/Stronghold-Protocol.git sp && cd sp
npm ci
node tools/setup.mjs --no-local          # 下载素材 ~271 MB
SP_MAX_SEATS=6 PORT=24500 HOST=0.0.0.0 npm start
```

**方式 B：Docker（与 HF Spaces / Render 同一套，环境一致）**

```bash
git clone https://github.com/Strinova-xinghui/Stronghold-Protocol.git sp && cd sp
docker build -t stronghold --build-arg FETCH_ASSETS=1 .
docker run -d --name stronghold --restart unless-stopped \
  -p 24500:3000 -e SP_MAX_SEATS=6 stronghold
```

**常驻**（方式 A 用 systemd，写到 `/etc/systemd/system/stronghold.service`）：

```ini
[Unit]
Description=Stronghold Protocol
After=network.target

[Service]
WorkingDirectory=/home/azureuser/sp
Environment=PORT=24500 HOST=0.0.0.0 SP_MAX_SEATS=6
ExecStart=/usr/bin/node server/index.js
Restart=always
User=azureuser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now stronghold
curl -s localhost:24500/healthz          # 应返回 {"ok":true,...}
```

### 地址与 HTTPS

- **明文 HTTP 直接可用**：`http://<公网IP>:24500`。因为是自己 IP，**没有樱花隧道那套自签证书问题**，安卓 APK 的 WebView 也能直接进 —— 这是相对樱花隧道的一个实打实的改善（原先要专门开一条海外明文线给 APK）。
- **要 HTTPS/wss**：需要域名。把域名 A 记录指向公网 IP，再用 Caddy 自动申请证书：
  ```bash
  sudo apt install -y caddy
  # /etc/caddy/Caddyfile:
  #   game.你的域名.com {
  #       reverse_proxy 127.0.0.1:24500
  #   }
  sudo systemctl reload caddy
  ```
  Caddy 自动申请 Let's Encrypt 证书并处理 WebSocket 升级。反向代理时给服务器加 `TRUST_PROXY=1`（本项目已支持该环境变量，见 `server/index.js`）。

### 迁移后能退役什么

| 组件 | 迁移后 |
| --- | --- |
| 樱花 frp 隧道 | **不再需要**（已有公网 IP） |
| 樱花每日签到自动化 | **整套可退役** —— 两个 DSH 定时任务 + `sakurafrp-checkin` 脚本 |
| `start-online.bat` / `stop-online.bat` | 本地保留作备用房；线上改由 Azure 常驻 |
| Cloudflare 临时隧道 | 保留作兜底 |

也就是说，**这一迁就把「流量不够 → 每天签到」这条链子整个消掉了** —— 比每天签到更根本的解法。

### 成本核对（一年）

| 项目 | 费用 |
| --- | --- |
| VM 计算（B2ats_v2，750 h/月额度内） | **$0** |
| 公网 IP（Basic 静态） | **$0** |
| 出站流量（< 100 GB/月） | **$0** |
| 系统盘 P6 64 GiB | ≈ $8.8 |
| **合计** | **≈ $8.8 / 年**，$100 额度绰绰有余 |

> 素材约 271 MB/人：100 GB 出站 ≈ 约 **370 人次/月**，正常开黑远用不到。

---

## 运维与特性对照

| 特性 | Hugging Face Spaces | Render | **Azure for Students** |
|---|---|---|---|
| **免费内存** | **16 GB** | 512 MB | 1 GiB |
| **免费磁盘** | **50 GB** | 容器临时磁盘 | 64 GiB（约 $0.73/月） |
| **绑卡要求** | **免绑卡** | **免绑卡** | **免绑卡** |
| **休眠机制** | 闲置挂起，访客进入约 10 秒唤醒 | 15 分钟无访问休眠，冷启动约 30~50 秒 | **不休眠，无冷启动** |
| **月度限额** | 无固定小时上限 | 每月 750 小时 Free 运行时长 | 750 小时/月免费 VM（≈31 天，可 24/7） |
| **域名与 SSL** | 自带 `*.hf.space` (HTTPS/WSS) | 自带 `*.onrender.com` (HTTPS/WSS) | 公网 IP 直连；HTTPS 需自有域名 + Caddy |
| **门槛** | 注册即可 | 注册即可 | **需 GitHub 学生认证** |
| **延迟（国内）** | 中继，一般 | 新加坡节点 | **东亚/东南亚直连，最低** |
| **APK 兼容** | HTTPS 正常 | HTTPS 正常 | **明文 HTTP 可用，最省事** |
| **适合** | 零成本长期挂机 | 有 GitHub 自动部署 | **延迟敏感 + 学生认证在手** |
