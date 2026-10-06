# 公网 IPv6 直连家庭游戏服务器 —— 可行性调研报告

> 调研日期：2026-10-06 · 调研人：ipv6-researcher（只读检查 + 资料调研）
> 对象：广东惠州移动家宽，让外地朋友（移动/联通手机流量、iOS、PC）直连本机 Node.js 游戏服务器（卫戍协议：盟约，端口 24500）。
> 合规声明：本轮**未修改**任何系统设置、防火墙规则、路由器配置；未启动/停止任何服务。所有需提权/登录设备的操作均列入下文清单由用户执行。

---

## 0. 实测快照（2026-10-06 17:36–17:45，只读命令）

**重要：任务背景中「本机无全局 IPv6 地址」的描述已过时。** 当天 16:26 本机已获取 IPv6 租约——上游（光猫/下级路由）的 IPv6 已开启，且前缀已传到下级路由的 LAN。

| 检查项 | 结果 |
| --- | --- |
| 全局稳定地址 | `2409:8a55:9481:aad1:9397:3e7a:c608:e62e`（/64，Preferred，RA 分配） |
| 临时隐私地址（出站用） | `2409:8a55:9481:aad1:c02f:6d40:b62:c9c9`（/128，Temporary） |
| 默认路由 | `::/0` → `fe80::ceb0:a8ff:fe8f:81b9`（即 192.168.3.1 的链路本地地址）✅ 存在 |
| 接口参数 | WLAN：Router Discovery=enabled，Managed/Other=enabled，MTU **1492**（PPPoE 特征），Router Lifetime 1800s |
| IPv6 绑定 | WLAN 上 `ms_tcpip6` = True |
| 网络类别 / 连通性 | WLAN = **Public**，IPv6Connectivity = **Internet** |
| v6 出口实测 | `ping -6 2400:3200::1`（阿里）→ **10ms**；`2400:3200:baba::1` → 13–15ms；`curl -6 https://api64.ipify.org` 返回本机 v6 地址（出口可用） |
| 测量假象 | `ping -6 2402:4e00::`（DNSPod）100% 超时——ICMP 被对端过滤，**不构成 v6 不通的否定证据** |
| Windows 防火墙 | 三档（Domain/Private/Public）DefaultInboundAction=NotConfigured（=默认阻止入站）；已有 **4 条「Node.js JavaScript Runtime Inbound」Allow 规则（Profile=Public，Enabled）**——WLAN 当前正是 Public 档 |
| DNS 后缀 | 无（Connection-specific DNS Suffix 为空，正常） |

前缀 `2409:8a5x::/28` 段为中国移动。`9481:aad1` 这个 /64 是动态前缀，会随光猫重拨变化（见 §6.2）。

---

## 1. 可行性判定：**高**（唯一硬门槛：光猫 IPv6 防火墙需现场验证放行）

三条核心理由：

1. **链路侧最大不确定性已经消除。** 本机已拿到全局 v6 地址 + 默认路由，出口实测 10–15ms 到阿里——说明「光猫→下级路由→主机」的 IPv6 前缀传递链路已打通（无论光猫是路由模式下发 PD 还是桥接，最终结果已就绪），不需要动任何网络结构。任务背景里最大的疑点「为什么没有全局 v6」已不复存在。
2. **两端运营商条件成熟。** 家侧：官方数据全国光猫 IPv6 开启率 96.86%（2025-09，央视网/《中国 IPv6 发展报告（2025）》）；朋友侧：移动/联通/电信 4G/5G **默认双栈、手机流量自带公网 v6**（36氪实测三网均通，iOS 12.1+/Android 8.0+ 全面支持），移动→移动同网直连路径最短。
3. **服务器与本机零结构性障碍。** 代码已支持 `HOST` 环境变量且无 `ipv6Only`（`server/index.js` L758-759、L867），设 `HOST='::'` 即双栈监听，现有 frp（IPv4）链路完全不受影响；Windows 防火墙已存在 node.exe 入站放行规则（Public 档）；端口 24500 是高位非标端口，不触碰运营商对家宽 80/443 的封锁。

> 唯一可能在现场卡死的点：移动光猫的 **IPv6 防火墙（IPv6 Session/会话防火墙）默认丢弃所有发往 LAN 侧设备的新入站连接**（多个独立来源证实，见附录）。必须登录光猫关闭该开关后用手机流量实测；关不掉（个别地区定制固件）则本方案不可行，frp 兜底。

---

## 2. 前置条件清单

### A. 需要用户登录设备操作（脚本/本会话无法完成）

| # | 操作 | 在哪里 | 关键说明 |
| --- | --- | --- | --- |
| A1 | **关闭光猫 IPv6 防火墙** | 光猫管理页 `192.168.1.1`（超级管理员，移动常见账号 `CMCCAdmin`，密码各地不同，可打 10086 报装/维修查询） | 找「安全 → 防火墙 → IPv6 防火墙 / IPv6 会话限制」开关关闭。这个开关开着时所有新入站 v6 连接一律被丢。**不要改桥接**——路由模式已能下发前缀（实测证明），改桥接需重配拨号、风险大于收益 |
| A2 | 核实下级路由（华为 `192.168.3.1`）IPv6 状态 | 路由器后台「更多功能 → 网络设置 → IPv6」 | 实测已在工作（主机拿到 RA），确认开关为开即可；顺带查看是否支持 **IPv6 端口映射/防火墙级别**（给 §3.4 路由器 DDNS 方案用） |
| A3 | 核实路由器 DDNS 能力 | 路由器后台 DDNS 页 | 确认服务商列表、有无 IPv6/AAAA 相关选项（详见 §3.4，价值存疑） |
| A4 | 手机流量实测 | 朋友手机关 WiFi 用流量 | 访问 `http://[稳定v6地址]:24500/healthz`——这是整个方案的最终验收 |

### B. 脚本可自动完成（本轮均未执行，仅列清单）

| # | 操作 | 谁执行 |
| --- | --- | --- |
| B1 | `start-online.ps1` 增加 `$env:HOST = '::'`（双栈监听） | 直接改脚本，无需提权 |
| B2 | 脚本打印/复制**稳定** v6 地址到剪贴板（`Get-NetIPAddress -AddressFamily IPv6 -InterfaceAlias WLAN` 里非 Temporary 那条） | 直接改脚本 |
| B3 | Windows 防火墙精确放行（可选，现有规则已够用）：管理员运行 `New-NetFirewallRule -DisplayName 'Stronghold 24500 TCP' -Direction Inbound -Protocol TCP -LocalPort 24500 -Action Allow -Profile Any` | 用户批准后 |
| B4 | DDNS 客户端（ddns-go）或 Cloudflare API 更新脚本（若走域名路线） | 普通权限即可 |

---

## 3. 服务器端改动清单（本轮均未执行）

### 3.1 HOST='::' 双栈监听 ✅ 代码已支持

- `server/index.js` L759：`const host = opts.host ?? process.env.HOST ?? '0.0.0.0'`；L867：`server.listen(port, host)`。**全文无 `ipv6Only` 设置** → Node 默认双栈：监听 `::` 时同时接受 IPv4 映射连接（`::ffff:x.x.x.x`），`http://127.0.0.1:24500/healthz` 照常工作。
- `start-online.ps1` 现状：只设置 `PORT` 与 `SP_BOND_BOOST`，**未设置 HOST** → 当前默认 `0.0.0.0`（仅 IPv4）。改动 = 在 L45 附近加一行 `$env:HOST = '::'`。
- 兼容性：樱花 frp 两条隧道指向 `127.0.0.1:24500`（IPv4），Node 双栈下不受任何影响；Radmin VPN（IPv4 26.x）同样不受影响。

### 3.2 Windows 防火墙 ✅ 基本已就绪

- 现有 4 条「Node.js JavaScript Runtime Inbound」Allow 规则（Profile=Public，Enabled），按程序放行、不限端口/协议版本，对 IPv6 入站同样生效；WLAN 当前为 Public 档。
- 可选收紧为按端口规则（见 B3，需管理员）。参考：[netsh advfirewall firewall 文档](https://learn.microsoft.com/zh-cn/windows-server/administration/windows-commands/netsh-advfirewall-firewall) / `New-NetFirewallRule`。

### 3.3 IPv6 地址管理（动态前缀应对）

- **发地址时必须发「稳定地址」**（`...:9397:3e7a:...` 那条），不要发 Temporary/隐私地址（`...:c02f:6d40:...`，生命周期约 1 天会轮换，发出去过阵子失效）。
- 四个方案对比：

| 方案 | 成本 | 优点 | 缺点 | 评价 |
| --- | --- | --- | --- | --- |
| ① 手动发地址（start-online.ps1 打印+复制） | 零 | 零依赖，与现有剪贴板机制一致 | 光猫重拨后要重发 | **推荐起步**，先把链路验证通 |
| ② [ddns-go](https://github.com/jeessy2/ddns-go)（开源） | 需自有域名（年费约 ¥10–80） | 支持 Cloudflare/阿里/DNSPod 等 20+ 服务商，勾选 IPv6 接口自动更新 AAAA，Token 最小权限 | 要常驻一个小进程 | **推荐长期** |
| ③ Cloudflare API 直更 AAAA | 域名 + 免费 Token | 几行 PowerShell `curl` 的事，透明可控，可挂进 start-online.ps1 | 要自己写十几行脚本 | 有域名时的最简自动化 |
| ④ DuckDNS | 完全免费送子域名 | 不用买域名 | 服务器在海外，国内解析稳定性/移动网络可达性一般 | 备选 |
| ⑤ 花生壳（Oray） | 免费版 1 条记录、需实名 | 国内、华为路由器内置支持 | 免费额度小，AAAA 支持需实测 | 备选 |

> ⚠ 合规提醒（[ddns-go issue #1 案例](https://github.com/jeessy2/ddns-go/issues/1)）：不要把**对外建站**的域名解析到家用宽带——阿里云 DNS 联合工信部检测到「解析目标为家宽且存在网站内容」会直接封宽带。给朋友联机的游戏服务器（无公开网页内容、非标端口、低流量）属于低风险用法，但应保持低调：不挂公开宣传页、不用 80/443。

### 3.4 路由器内置 DDNS（用户补充：华为路由器支持 DDNS）——价值存疑，需 A3 验证

路由器后台帮助文本表明支持「服务商/域名/用户名/密码」四项，示例服务商为 oray.com（花生壳）。**对本方案它有三个存疑点：**

1. **家用路由器 DDNS 传统上只更新 WAN 口 IPv4（A 记录）**。本环境无公网 IPv4，A 记录毫无用处。
2. **即使支持 AAAA，它记录的是路由器自身的 WAN/管理地址，不是游戏主机（192.168.3.20）的地址**——两者同前缀但 IID 不同，解析到路由器本身连不到主机，除非配合路由器的「IPv6 防火墙端口映射 / 虚拟服务器 / DMZ」把入站 TCP 24500 指向主机的 v6 地址，而该功能是否支持 IPv6 条目取决于具体固件（华为各型号差异大）。
3. 服务商列表（花生壳/Oray 等）对 AAAA 动态更新支持有限。

**验证步骤（A2/A3 合并做）**：登录 `192.168.3.1` → 看 DDNS 页有无 IPv6 选项 → 看「防火墙/端口映射」能否添加 IPv6 目标条目。两者皆无 → 放弃方案 ④，仍走 §3.3 方案 ①/②/③（它们直接读**主机**网卡地址，天然指向正确目标，这也是主机侧 DDNS 优于路由器侧的根本原因）。

---

## 4. 朋友侧要求

| 项 | 结论 |
| --- | --- |
| 运营商覆盖 | 移动/联通/电信 4G/5G **默认双栈，流量自带公网 v6**——掘金踩坑指南明确「手机移动网访问一定通过验证，因为移动网默认开启 IPv6」；官方口径：移动终端全面支持 IPv6，主要品牌全部默认开启（2025 报告） |
| 设备 | iOS 12.1+、Android 8.0+、鸿蒙全面支持——朋友的 iPhone/安卓/PC 浏览器全部覆盖 |
| 推荐姿势 | **关 WiFi 用流量玩**（直连可行性最高）；朋友若连自家 WiFi，取决于其路由器是否开启 IPv6（老路由器/未开开关则无 v6） |
| 已知盲区 | 公司/校园网常无 v6；手机开 VPN/加速器时 v6 可能被截走（参照本项目 Clash TUN 掐断隧道的同类问题） |
| 自测方法 | 手机浏览器开 [test-ipv6.com](https://test-ipv6.com) 或 [6.ipw.cn](https://6.ipw.cn) 看有无 v6 地址；或直接访问 `http://[家里v6地址]:24500/healthz` |
| 无 v6 的朋友 | 走现有 frp 固定网址（见 §6.3），零额外要求 |

---

## 5. 预期延迟 vs 现有 frp 方案

| 路径 | 预期 RTT | 依据 |
| --- | --- | --- |
| 现状：樱花 frp（国内节点中转，两条固定网址） | **54–120ms**（实测基线） | 建档数据；朋友→frp 节点→家，两跳 + 隧道开销 |
| IPv6 直连：移动流量 ↔ 移动家宽（同网） | **约 10–40ms**（估） | 主机→阿里 v6 实测 10–15ms（省内骨干级）；同网段走移动骨干，无第三方中转 |
| IPv6 直连：联通/异地 ↔ 移动家宽（跨网） | **约 20–80ms**（估） | 跨网互联经互联互通节点，国内典型区间；最差情况与 frp 持平，一般仍略优 |

- 本游戏是**回合制自走棋 + WebSocket 长连接**，50ms 级差异体感轻微；直连的真正收益是**稳定性与带宽**（不依赖第三方节点存活、无隧道流量合规拦截问题、上行带宽全速可用）。
- 注意：延迟区间为估算（无法在本轮模拟朋友端实测），以 A4 验收实测为准。另见机核 IPv6 指南对「直连优于穿透」的定性结论（附录）。

---

## 6. 风险与限制

1. **光猫 IPv6 防火墙（硬门槛）**：移动光猫默认丢弃 LAN 侧新入站 v6 连接，需超级管理员登录关闭「IPv6 防火墙/会话限制」。个别地区固件关闭入口被隐藏/禁用 → 方案不可行，frp 兜底。关闭后全 LAN 的 v6 设备都暴露在入站扫描下——Windows 各机默认入站为 Block（本机三档均 NotConfigured→默认 Block，仅 node 有放行），光猫侧如支持按端口放行（ip6tables）比整体关闭更稳。
2. **动态前缀**：`2409:8a55:9481:aad1::/64` 随光猫重拨变化（恩山帖证实家宽无固定前缀）；主机 IID 部分稳定。应对 = DDNS（分钟级生效）或手动发地址（变化频率≈重拨频率，光猫长期不重拨时可稳定数周）。手机流量侧朋友地址同样动态，但对本方向（朋友→家）无影响。
3. **朋友侧无 v6 的情形**（WiFi 下老路由器、公司/校园网、开 VPN）：自动回落 frp 固定网址——与现有「双隧道并存」架构完全一致，frp 保留为永久兜底，本方案是**增路而非换路**。
4. **暴露面与安全**：无鉴权的游戏大厅公网可达（与 frp 现状等同，未变差）；建议不开放 RDP/SMB 等其他入站；Windows 只对 node.exe 放行；若走域名路线遵守 §3.3 合规提醒（不建公开站、不用 80/443）。
5. **temporary 地址陷阱**：发错隐私地址 → 一两天后朋友连不上且原因难查。脚本必须过滤 Temporary 地址（`Get-NetIPAddress` 的 SuffixOrigin/`ipconfig` 的「临时」标记）。
6. **测量假象提醒**：ping 不通 ≠ 不通（DNSPod ICMP 被滤即一例）；入站最终验收必须用「手机流量开 `/healthz`」做端到端测试，不要用 ping 判定。
7. **MTU 1492**：PPPoE 特征，IPv6 依赖 PMTUD，个别防火墙全丢 ICMPv2「Packet Too Big」会导致大包黑洞——如遇「能握手、页面/素材卡住」，优先查 MTU（少见，记录备查）。

---

## 附录：实测记录与关键来源

**本轮实测命令（全部只读）**：`ipconfig /all`；`Get-NetIPAddress -AddressFamily IPv6`；`Get-NetAdapterBinding -Name WLAN`；`netsh interface ipv6 show interfaces`；`netsh interface ipv6 show route`；`netsh interface ipv6 show interface "WLAN"`；`Get-NetConnectionProfile`；`Get-NetFirewallProfile`；`Get-NetFirewallApplicationFilter -Program '*node.exe*'`；`ping -6 2400:3200::1`；`ping -6 2400:3200:baba::1`；`curl -6 https://api64.ipify.org`。

**关键来源**：

- 光猫 IPv6 防火墙默认拦入站与放行方法：
  [恩山·光猫 IPv6 外网访问及防火墙规则](https://www.right.com.cn/forum/thread-8335406-1-1.html) ·
  [技术栈·移动光猫放开 IPv6 入站（5G 手机直连 NAS）](https://jishuzhan.net/article/2105296998391623682) ·
  [博客园·烽火光猫关闭 IPv6 防火墙](https://www.cnblogs.com/libitum/p/18512702) ·
  [飞牛论坛·光猫桥接+iStoreOS+IPv6 公网访问](https://club.fnnas.com/forum.php?extra=&mod=viewthread&ordertype=1&tid=13693)
- 双层路由前缀委派：
  [V2EX·如何让光猫的下级路由也获取公网 IPv6（DHCPv6-PD 流程）](https://www.v2ex.com/t/799717) ·
  [华为官方·路由器无法获取 IPv6 前缀](https://consumer.huawei.com/cn/support/content/zh-cn00769601) ·
  [CSDN·DHCPv6 PD 实战解析（运营商前缀长度：移动 /60 或 /64）](https://bbs.csdn.net/weixin_33462167/article/details/100121165) ·
  [恩山·移动光猫下级路由无法获取前缀案例](https://www.right.com.cn/forum/thread-8253426-1-1.html)
- 手机流量 IPv6 覆盖：
  [央视网·我国 IPv6 活跃用户数达 8.65 亿（2025-10，含光猫开启率 96.86%、终端默认双栈）](https://news.cctv.com/2025/10/29/ARTIglnoeEGkWBrDjDwnujgd251029.shtml) ·
  [新华网·《中国 IPv6 发展报告（2025）》](http://www.news.cn/info/20251103/601a7a366fb34891beed650d3974c937/c.html) ·
  [36氪·5 亿人用 IPv6 实测（三网手机流量默认可解析 v6）](https://m.36kr.com/p/1336132478081289) ·
  [掘金·IPv6 公网访问内网设备踩坑指南](https://juejin.cn/post/7206228205819166775)
- 端口封锁与家宽建站风控：
  [腾讯云·EdgeOne 实现 80/443 访问家宽 IPv6（反证家宽标准端口被封）](https://cloud.tencent.com/developer/article/2556242) ·
  [CSDN·家庭宽带的公网 IPv4 到底封了多少端口](https://blog.csdn.net/gtj0617/article/details/138992558) ·
  [ddns-go issue #1·解析家宽建站被封宽带案例](https://github.com/jeessy2/ddns-go/issues/1)
- DDNS 方案：
  [DDNS-GO 动态域名部署（支持 20+ 服务商、IPv6 勾选）](https://www.ygcloud.com/knowledge/3063) ·
  [从花生壳到 DDNS-GO 的升级实践（对比表）](https://www.moldde.com/h-nd-2844.html) ·
  [V2EX·无公网 IPv4 时代如何低成本暴露家庭服务（IPv6+DDNS 为主流之一）](https://www.v2ex.com/t/1225326)
- 直连体验定性：
  [机核·没有公网也能直连家里的电脑？IPv6 使用指南](https://www.gcores.com/articles/184766)
- 防火墙命令参考：
  [Microsoft Learn·netsh advfirewall firewall](https://learn.microsoft.com/zh-cn/windows-server/administration/windows-commands/netsh-advfirewall-firewall)

---

## 下一步建议（按序）

1. 用户做 A1（光猫关 IPv6 防火墙）→ A4（手机流量开 `http://[稳定v6]:24500/healthz`）——**先验证链路，再谈自动化**。
2. 验证通过后：改 `start-online.ps1`（B1+B2：`HOST='::'` + 打印/复制稳定 v6 地址）。
3. 嫌手动发地址麻烦再上 ddns-go / Cloudflare API（需先买域名）；期间先核实 A3 路由器 DDNS 的 IPv6 能力（预期不高）。
4. frp 两条固定网址保留不动，作为无 v6 朋友的永久兜底。
