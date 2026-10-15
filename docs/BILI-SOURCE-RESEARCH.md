# Bilibili 音乐源调研 —— 现成轮子评估（player/external-sources）

> 调研人：bili-research · 日期：2026-10-16 · 分支：player/external-sources
> 目标：确认「有没有现成的 Bilibili 音乐源轮子」能接到我们的 lx-music 自定义源播放器里，并给出落地路线。

## 0. 我们现有架构的适配点（已确认，代码实测）

我们的外部音源体系（`public/js/ui/player-core.js` + `server/http/musicRoutes.js`）：

- **lx 脚本沙箱**：`globalThis.lx = { EVENT_NAMES, on, send, request, utils, version, env, currentScriptInfo }`，脚本在玩家浏览器本地执行；`send(EVENT_NAMES.inited, { sources })` 声明源；`on(EVENT_NAMES.request, ...)` 处理 `musicUrl` 等 action。
- **沙箱 `lx.request` = 浏览器 fetch**：无 CORS 代理包装——脚本作者自己负责兜底；返回 `{ statusCode, headers, body }`，**body 是 ArrayBuffer**（注意：lx-music-desktop 桌面版会把 JSON 响应自动 parse 成对象，社区脚本大多直接读 `response.body.data`——移植到我们的沙箱时脚本若假定 body 已解析，需要脚本自带兜底或我们侧补 JSON.parse，**兼容性风险点**）。
- **URL 导入脚本**：`fetchLxScript` 先浏览器直连（jsDelivr/GitHub raw 这类 CORS=* 直链可用），失败走同源 `/music/proxy?url=` 兜底（仅 JSON/文本 ≤512KB，音频 415 拒）。
- **`/music/proxy` 平台头注入表**（`PROXY_HOST_HEADERS`）：目前内置 163/qq/kuwo/kugou/migu 五家，**没有 bilibili**；但客户端可用 `&h_referer=` / `&h_cookie=` / `&h_user-agent=` 白名单头自行传递，也就是说 **B 站 API 的元数据请求今天就能经 proxy 代跑，只是在 URL 上多带一个 h_referer 参数，或我们在 PROXY_HOST_HEADERS 里加一行 bili 映射（一行改动）**。
- **内置点歌搜索**：固定 `wy`/`kg` 两个端点走 proxy；`lxSearch` 返回 lx musicInfo 形状（songmid/songName/singerName/albumName…）。给 B 站做内置搜索同样可行（新增一个端点映射 + proxy host 表加一行）。
- **播放取链**：`lxMusicUrl` 调脚本 `musicUrl` handler 拿到 URL 后交给 `<audio>`/`<video>` 元素直接加载——**音频字节流不经过我们的服务器**。B 站 CDN 直链若校验 Referer（实测见第 3 节），浏览器媒体元素默认会带我们站点的 Referer，防盗链可能 403——解法是媒体元素设 `referrerpolicy="no-referrer"`（主流做法，见第 3 节结论）或走服务器中转（我们明确不做，带宽红线）。

## 1. lx-music 社区自定义源生态：有没有现成的 bilibili 源脚本

调研法：GitHub code search（认证配额）+ 逐仓库抓脚本全文 grep 特征串（`globalThis.lx` / `EVENT_NAMES` / `musicUrl` / `playurl` / `bili`）+ api.github.com 读 LICENSE。全部命中项如下，**结论：没有可直接粘贴即用的成熟 bilibili lx 源**。

### 1.1 code search 命中（2 条）

- `code?q="bilibili" "musicUrl"` → total **75**；`code?q="bilibili EVENT_NAMES path:*.js"` → total **0**。
- 命中的 75 条里，绝大多数是 lx-music-desktop 的**分支/fork 内置 SDK**（`src/renderer/utils/musicSdk/bili/*`）、聊天机器人点歌插件（Lain/xiaofei/CQ 系）、Obsidian/OBS 挂件——**不是** 自定义源脚本。真正的「自定义源脚本 + bili」只有下面 2 个。

### 1.2 唯二命中「lx 规范 + bilibili」的自定义源脚本

**A. `iamcool666/music` → `音源/非常刀.js`**（★6，JS 15 KB，push 2026-09-07，**无 LICENSE**）
- 脚本头 `@name 非常刀 / @description 接入网易、酷我、JOOX、哔哩哔哩`；`const { EVENT_NAMES, request, on, send } = globalThis.lx`；`SOURCE_MAP = { wy:'netease', kw:'kuwo', jo:'joox', bl:'bilibili' }`；action 支持 `musicUrl` + `search`（是真·lx 规范）。
- **硬伤**：取链并不直连 B 站 API，而是转发到第三方黑盒 `SOLARA_API = https://yy.bttts.com/proxy`（网易/酷我/JOOX/B 站共用一个未审计的中转服务），且脚本头挂 TG 引流群。**随时可失效、来源不可审计、无许可证 ⇒ 不能内置，也不建议玩家自贴。**

**B. `HittyGubby/LX-Source-Vanced` → `lx-source.js`**（★0，JS 4 KB，push 2026-08-12，**MIT**）
- 真·lx 规范：`on(EVENT_NAMES.request, ...)` + `send(EVENT_NAMES.inited, { sources })`，注册源含 `bili`（`actions:["musicUrl"], qualitys:["128k"]`）。
- bili 取链是**直连官方 API 的极简版**（值得抄的就是这 5 行）：
  \`\`\`js
  if (source === "bili") {
    await httpFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${musicInfo.songmid}`)
      .then(async (response) => {
        await httpFetch(`https://api.bilibili.com/x/player/playurl?bvid=${musicInfo.songmid}&cid=${response.body.data.cid}&qn=16&fnval=16`)
          .then((res) => { returnurl = res.body.data.dash.audio[1].baseUrl || null; });
      });
  }
  \`\`\`
- **硬伤**（对本项目致命）：
  1. `response.body.data` 直读 —— 假定桌面版「JSON 自动 parse」语义，**我们沙箱给的是 ArrayBuffer，粘进来第一步就 TypeError**（见第 0 节兼容性风险点）。
  2. `songmid` 被当成 `bvid` 用，但脚本没实现 `search` action ⇒ 搜索结果只能由别的源/手动导入提供，玩家无从搜到 B 站曲目。
  3. `dash.audio[1]` 写死下标取第 2 个流（实测我们的样本返回 30216/30232/30280，`[1]` = 128k，**永远拿不到 192k**）。
  4. 取到 baseUrl 后仍是「交给客户端播放」——**撞上第 3.3 节 Referer 403**。
  5. 个人玩具（`API_LOC = http://127.0.0.1:8080`、`kg` 源写着 `'Fuck you KuGou'`），无维护。

### 1.3 中文社区聚合音源仓库：逐个验证「sources 里有没有 B 站」

搜 `lx music 音源`（total 61）、`音源 bilibili`（total 22）等，聚合型头部仓库实测**全部不含 B 站**：

| 仓库 | ★ | LICENSE | push | 含 bili？ |
| --- | --- | --- | --- | --- |
| `pdone/lx-music-source`（洛雪源聚合，最大） | 9891 | **无 LICENSE** | — | 逐文件抓全文：`sixyin/latest.js`(332 KB)、`lx/latest.js`(58 KB)、`huibq`、`flower`、`ikun`、`juhe`、`grass`、`huanyin`、`changqing`、`qdy` —— **全部 bili:false、playurl:false** |
| `Macrohard0001/lx-ikun-music-sources` | 2706 | NOASSERTION | 2026-10-08 | README 无 bili |
| `skxingyu/lx_music-`（六音） | 241 | **无 LICENSE** | 2026-09-12 | README 1 KB，仅 ghproxy raw 直链列表（pdone/huibq/sixyin 三跳），无 bili |
| `cdyUuu/lx-music-xinghai-source`（星海，聚合 GDAPI/ChKSz） | 205 | **无 LICENSE** | 2026-08-24 | 酷我加密解密方向，无 bili |
| `ZxwyWebSite/lx-source` | 699 | MIT | 2024-06-22 | **Go 写的音源生成/管理 CLI**（action.go/build.go/release.go），不是含 bili 的脚本；已停更 |
| `fengs2021/lx-music-merged-source`（10 源精炼聚合） | 4 | 无 LICENSE | 2026-09-29 | 星海+溯音链回退，无 bili |
| `haonanren118/jiexiang-Music-Source`（墨澜二改超聚合） | 12 | MIT | 2026-09-13 | 未逐文件验证（**网络受限未验证**） |

**结论**：社区主流聚合音源清一色只做 `wy/kw/kg/tx/mg` 五家——**不是没人会做 B 站，而是第 3 节那条 Referer 硬墙**。这反过来是「音频源不可行」的最强社区口碑证据。

### 1.4 顺带记录：官方 lx-music-desktop 也没有 B 站源

`lyswhut/lx-music-desktop`（★54464，Apache-2.0）`musicSdk` 目录实测只有 **bd / kg / kw / mg / tx / wy**（+ api-source），**bili 文件数 = 0**。B 站 SDK 只存在于第三方 fork（见 2.1）。

### 1.5 分享链接形态（玩家自贴的可用性）

社区帖子里流传的音源「订阅链接」形态是 `https://ghproxy.net/raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js` 这类 **raw/加速代理直链**。我们的 `fetchLxScript` 正好兼容：浏览器直连（jsDelivr / GitHub raw 发 CORS=*）失败就自动走 `/music/proxy?url=`（文本 ≤512 KB）——**「贴一个 URL 导入脚本」这条路本身已经通了**，问题只在于没有合格的 bili 脚本可贴（332 KB 的 sixyin 也在 512 KB 限额内，能进）。

## 2. 独立轮子：B 站音乐/音频开源项目盘点

### 2.1 与 lx 生态直接相关（最高价值参考）

| 仓库 | 语言/形态 | LICENSE | 状态 | 与我们的关系 |
| --- | --- | --- | --- | --- |
| `lyswhut/lx-music-desktop`（★54.4k） | Electron | **Apache-2.0** | 活跃 | 官方本体；musicSdk 无 bili（见 1.4）。lx 规范事实标准 |
| `xinzhihong-ship-it/lx-music-desktop-enhanced`（★36） | Electron | **Apache-2.0 ✅ 可内置** | **活跃（push 2026-10-06）** | **最完整开源 bili 音乐实现**：`musicSdk/bili/` 9 文件——wbi 签名（`wbiSign`：nav 取 img/sub key + mixin 表 + MD5 `w_rid`）、访客 buvid3/buvid4 cookie、`fnval=4048` DASH 全档（30250 atmos/30251 hires 登录解锁）、搜索（`wbi/search/type` + 多 P 合集展开）、b23.tv 短链解析、歌词（字幕接口）。**移植成 lx 脚本的 API 知识全在这，且 Apache-2.0 与 GPL-3.0 兼容** |
| `Tabris-Ayanami/LX-Music-TAchanged`（★44） | Electron | AGPL-3.0 | 活跃 | 同类魔改；AGPL 也能作参考，但复制进我们仓库会传染 AGPL，**只看不抄** |
| `TIMER-succ/qplayer-bilibili-source`（MIT，push 2026-10-03） | JS（QPlayer 插件 ABI，非 lx 规范） | **MIT ✅** | 活跃 | `src/wbi.js`(2.5 KB) 独立 wbi 实现可参考；插件 ABI 与 lx 不同，不能直接粘 |
| `1970905901/LX-Y-Music-IOS` | JS（lx fork 移动端） | （未核，**网络受限未验证**） | — | 含 `musicSdk/bilibili` + `bilibili_source.js` 用户 API 模板，可作二手参考 |

### 2.2 浏览器端 JS provider 类

- **`listen1/listen1_chrome_extension`（★12.1k，MIT ✅，JS）**：`js/provider/bilibili.js`（14 KB）纯浏览器代码，实现 nav→wbi key（node-forge MD5）、`view`、`playurl?fnval=16 → dash.audio[0].baseUrl`、音乐区 `audio/music-service-c/web/{menu/hit,menu/info,song/of-menu,url?sid}`、UP 主投稿 `space/wbi/acc/info`、歌单/搜索全套。**但它跑在 Chrome 扩展特权环境（host_permissions 免 CORS、Referer 可造）** ——普通网页拿不到这个能力；且 `dash.audio[0]` 同样写死下标、无 192k 择优。许可 MIT，端点知识可移植进我们的 lx 脚本（走 `/music/proxy` 后 API 侧等价可达）。
- `spacemeowx2/obs-html`（OBS 弹幕点歌挂件）：无 LICENSE，仅历史参考。

### 2.3 原生 app / 下载器 / API 封装类（轮子很多，全部绕不开我们的墙）

| 仓库 | 语言 | LICENSE | 备注 |
| --- | --- | --- | --- |
| `the1812/Bilibili-Evolved` ★30.8k | TS（油猴/扩展） | **MIT + 附加限制条款**（LICENCE.md：转载须署名等条件） | 下载组件能存 B 站音频，但靠扩展特权设头 |
| `nilaoda/BBDown` ★13.9k | C# | MIT | 命令行下载器，HTTP 层随便设 Referer |
| `soimort/you-get` ★56.9k | Python | **MIT**（LICENSE.txt 实测） | 老牌，含 bili 音频提取 |
| `Nemo2011/bilibili-api` ★4.2k | **Python** | **GPL-3.0-or-later**（PyPI 元数据实测） | 功能最全的 B 站 API 封装（含 audio 模块），**但 Python 服务端库，玩家浏览器跑不了，我们不内置音源服务器 ⇒ 用不上**；若同证 GPL-3.0 想借代码也只能搬算法知识 |
| `SocialSisterYi/bilibili-API-collect` ★20.2k | 文档 | 无 LICENSE 接口返回（README 标注 CC 类许可，细节**未逐条验证**）；**已 archived（2026-01-30）** | B 站 API 的百科文档（wbi/playurl/DASH id 表），**写脚本必读的事实来源**，代码无涉 |
| `Moriafly/DsoMusic` ★1.5k Kotlin GPL-3.0 | **archived 2023** | 音源含 B 站的安卓播放器 | 死项目 |
| `DJChanahCJD/otter-music` ★451 TS | 无 LICENSE | 依赖 `GD Studio Online Music Platform` 黑盒中转（与「非常刀」同类风险） | 不可内置不可推荐 |
| `wood3n/biu` ★2.7k TS | **PolyForm Noncommercial** | 与 GPL-3.0 不兼容，参考都谨慎 | B 站音频 Web URL 逻辑在 `src/service/audio-web-url.ts` |
| `panda472328/yuyin-music`(+mobile) ★~2 TS/Java | MIT 活跃（2026-10-15 同日双推） | Windows/安卓「余音」播放器 | **独立 app，可自由用 B 站页内 WebView/原生 HTTP 设 Referer**——网页架构享受不到 |
| `amns56780/bili-music-android` ★1 Kotlin | MIT 活跃 | 同上：收藏夹/稍后再看/投稿导入做得最全的移动端参考 |
| `motto1/motto-music` Dart Apache-2.0 / `Q-wind520/flind-player` Dart GPL-3.0 / `Akilaea/Aerome`（Mineradio GPL-3.0 二创，加 B 站源）/ `xxxnnn1231/BLiveMusic`（MIT，B 站弹幕点歌 + LX Music 联动） | — | — | 生态位佐证：B 站当音源的活体项目全是 app/扩展 |

### 2.4 盘点结论

1. **「直接粘进我们外部音源 tab 就能用的 lx 脚本」：不存在**（1.2 的两个半成品质检不过）。
2. **写脚本所需的 API 知识有成熟开源实现**，且许可最友好的两条线：enhanced fork（Apache-2.0）+ listen1 provider（MIT）——元数据、wbi 签名、DASH 档位、搜索映射全有现成代码可改写。
3. **所有活着的 B 站音乐轮子都是「能控制 HTTP 头的宿主」**（Electron / 浏览器扩展 / 原生 app / 服务器中转）。纯网页播放器阵营里，没有一个项目解决 Referer 墙——与第 3.3 节实测互相印证，这不是巧合，是结构性限制。

## 3. 技术可行性：B 站 API 现状实测（2026-10-16，本机 curl 直连 api.bilibili.com）

测试 UA=Chrome/124，Referer=https://www.bilibili.com/；样本视频 BV1KiJk67Ezw / cid=42758769592。

### 3.1 元数据接口（免登录可达性）

| 接口 | 结果 | 说明 |
| --- | --- | --- |
| `x/web-interface/nav` | HTTP 200 `code:-101 账号未登录` | **但仍返回 `data.wbi_img`（img_key/sub_key）** ⇒ wbi 签名的 key 免登录可取（公开知识，非秘密） |
| `x/web-interface/view?bvid=` | 200 `code:0` | **免登录免签名可用**，返回 aid/cid/pages/pic/title/author，是「按 BV/av 取曲目」的主入口 |
| `x/web-interface/search/type?search_type=video` | 200 `code:0`（numResults 1000） | 本次**未强制 wbi**（历史上 -412 风控）；带 buvid3 cookie 即过 |
| `x/web-interface/search/type?search_type=audio` | 200 `code:-1200 请尝试登录/验证` | **B 站音乐区（audio 稿件）搜索风控更严**，免登录不可用 |
| `x/space/arc/search?mid=`（UP 主投稿列表，老端点） | 200 `code:-799 请求过于频繁` | 已被 wbi 版 `x/space/wbi/arc/search` 取代，老端点直接限流 |
| `x/v2/medialist/list`（收藏夹/歌单） | HTTP 404 返回 HTML | 端点路径已变更，**不确定**（需 `manga`/`favlist` 系列重测） |
| `x/player/playurl?bvid&cid&fnval=16` | 200 `code:0` | **免登录可取音频 DASH 流**，见 3.2 |
| `audio/music-service-c/web/menu/info?sid=` | 200 `code:0` `data:null` | 音乐区歌单端点**仍活着**（sid=1 无内容），但内容大面积下架 |
| `audio/music-service-c/web/song/of-menu` | 200 `code:0` 空列表 | 同上；`url?sid=1` → `code:4511001 音频未找到或已下架` |

**结论**：元数据侧「视频/稿件（view + playurl）」路径免登录畅通；「音乐区原生 audio 稿件」路径基本废弃/严风控（B 站 2018 音乐区整改 + 近年下架的长期后果）。做 B 站音源，现实路线是**把视频/音频投稿当曲目源**（view→cid→playurl），与 lx-music-desktop 增强版 fork、MoeMusic/余音 等社区项目的做法一致。

### 3.2 音频取链：档位与时效

- `playurl?fnval=16` 免登录返回 `dash.audio` 三档：**id 30216 / 30232 / 30280** = **128k / 128k / 192k**（DASH m4s）。**免登录没有 320k**；社区共识需登录（+ 部分需大会员）才解锁 `30250 atmos / 30251 hires / flac`（fork 的 `DASH_QUALITY_MAP` 与之吻合，见 2.x）。
- `fnval=0` 老式 `durl` 也返回数组（mp4 容器整段），仍可用，但体积/时效更差，不推荐。
- 直链带 `deadline=1792097063`（签发后约 2 小时过期）+ `e`/`mids`/| `buvid` 参数 ⇒ **直链是限时签名地址，不能缓存进播放列表**（与我们塞壬 `/song` 1h TTL 同一类问题）。

### 3.3 直链防盗链/CORS（决定能否在浏览器直接放）⚠️ 本节是可行性核心

对 `backupUrl` 首节点 `b-*.edge.mountaintoys.cn:4483`（upcdn 系）实测：

| 请求姿势 | 结果 |
| --- | --- |
| 无 Referer | **HTTP 403** |
| `Referer: https://www.bilibili.com/` | **HTTP 206**（Range 正常，`Content-Type: video/mp4`，Content-Range 齐全） |
| `Referer: https://example.org/`（模拟我们站点） | **HTTP 403** |
| 正确 Referer + `Origin: https://example.org` | 206，响应头有 `Access-Control-Allow-Credentials: true` / Allow-Methods / Allow-Headers，**但没有 `Access-Control-Allow-Origin` 回显** ⇒ 浏览器 `fetch` 拿字节会被 CORS 拦 |

（主 `baseUrl` 这次命中的 `xy…x.mcdn.bilivideo.cn:8082` 节点对本机 IP 三种姿势全 400，属节点/区域性异常，**不代表普遍行为，标注不确定**。）

**推论（架构级判定）**：
1. B 站音频直链**严格校验 Referer 必须是 `bilibili.com` 域**——无头 403、错域 403。
2. 浏览器媒体元素（`<audio>`/`<video>`）的 Referer 由页面自身与 Referrer-Policy 决定，**只能是我们的站点或被删除，永远伪造不出 bilibili.com**。⇒ `referrerpolicy="no-referrer"` 也实测等价于「无 Referer」=403。**结论：浏览器直连播放 B 站音频结构性不可行。**
3. `fetch` 更不行（CORS 无 ACAO）；`/music/proxy` 设计上只转 JSON/文本 ≤512KB、**音频直接 415 拒**，且带宽红线明确不允许改。⇒ **三条常见路全部封死。**
4. 唯一可行的取数层：**由玩家浏览器本地执行的 lx 脚本调用 B 站 API 拿元数据/直链是可行的**（API 侧 CORS 实测见下），但**音频字节必须找一个不锁 Referer 的取回方式**——见 3.4 补测与第 4 节路线。

### 3.4 API 与多 CDN 节点的浏览器可达性（第四轮实测）

- **B 站 API 拒绝陌生 Referer/Origin**：带 `Origin: https://example.org` + `Referer: https://example.org/` 的 GET，`view`/`playurl`/`nav` 全部 **HTTP 403**（同参数带 `Referer: bilibili.com` 则 200）。⇒ **lx 脚本在我们沙箱里用浏览器 fetch 直调 B 站 API 拿元数据不可行**，但元数据全是 JSON 小体——**正好是我们 `/music/proxy` 的设计用途**：只需在 `PROXY_HOST_HEADERS` 加一行 `{ re: /(^|\.)bilibili\.com$/i, h: { Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com' } }`，脚本即可 `request('/music/proxy?url=…')` 拿到 view/playurl 结果（≤512KB 完全够用，playurl 响应 ~10KB）。
- **backupUrl 三个不同 CDN 节点**（mountaintoys.cn ×2 / cn-gdjm-cm-01-03.bilivideo.com）行为一致：`no-ref=403 / bili-ref=206` ⇒ **Referer 锁是全域政策，不是个别节点**；第二轮 observed 的 mcdn 400 异常可判定为该节点区域性故障。
- **音频字节无解**：媒体元素设不了 Referer、fetch 被 CORS 拦、proxy 拒音频、服务器中转踩带宽红线。四路全封。

### 3.5 可行性总判定

| 环节 | 浏览器直连 | /music/proxy 兜底 | 判定 |
| --- | --- | --- | --- |
| 元数据（view/playurl/search） | ✗ 403 | ✓（加一行 bili host 映射） | **可行** |
| 音频流（DASH m4s 字节） | ✗ 403（Referer 锁死） | ✗ 415（设计上拒音频） | **不可行** |

⇒ **给播放器接 B 站音源，"搜得到、链得到、播不出"是当前的硬约束。** 能落地的只有绕开直链的变体：① 把 `<video>` 指向 `bilibili.com/video/BVxxx` 官方页（iframe/媒体页内嵌）——播放器拿不到播放态控制，体验割裂；② 引导玩家装 B 站浏览器扩展/本地代理自行处理 Referer——把复杂度推给用户；③ 换目标：把「B 站」当作**歌词/元数据补充源**（弹幕歌词、视频简介里的曲目信息）而非音频源。三者都不改变「B 站不能作为我们的 lx 音频源」这一结论。

## 4. 结论与落地路线（三选一排序）

### 4.1 核心判定（一句话）

**B 站「有轮子、缺脚本、撞硬墙」：lx 社区不存在粘贴即用的 bilibili 音源脚本；API 封装与取链逻辑开源可抄（Apache-2.0/MIT），但 B 站 CDN 对音频直链的 Referer 全域锁（实测无头 403 / 错域 403 / 仅 bilibili.com 域 206）叠加我们「音频不过服务器」的带宽红线与 `/music/proxy` 的 512 KB JSON/文本设计，使纯网页播放器**播不出 B 站音频字节**——这是结构性不可行，不是工作量问题。**

### 4.2 三选一排序

**✅ 推荐 = c 为主 + b 的窄化变体（组合路线）**

**c) 作为 lx 音频源：搁置。**（第一优先结论）
- 依据：第 3.3/3.5 实测四路封死（媒体元素 ✗ / fetch ✗ / proxy ✗ / 中转 ✗）+ 第 1.3 社区全部聚合源避开 B 站的旁证。
- 不做的事：不改 `/music/proxy` 放行音频（带宽红线 + 415 设计边界）；不内置任何指向「黑盒中转服务器」的脚本（非常刀/GD Studio 路线＝把玩家流量交给不可审计的第三方，TG 引流源，安全与下线风险双高）。

**b) 若仍想「加一个 B 站入口」，只做一个窄化变体：BV 链接/短链 → 官方页内嵌播放 + 元数据卡。**
- 玩家粘贴 `BVxxx` / `avxxx` / `b23.tv` → 经 `/music/proxy`（加一行 bili host 映射）调 `view` 拿标题/UP 主/封面/分 P 列表（JSON 小体，proxy 完全胜任），播放交给页面里一个指向 `https://www.bilibili.com/video/BVxxx` 的 iframe/弹窗（B 站自家页能正常播；我们只是「跳转到官方播放」，不是 lx 音源）。
- 工作量：**0.5～1 天**（PROXY_HOST_HEADERS 一行 + player-core 加一个「B 站链接」点歌入口 + 元数据卡片 UI），API 知识抄 `lx-music-desktop-enhanced`（Apache-2.0，GPL-3.0 兼容）与 `url.js` 的短链解析逻辑。
- 代价诚实声明：iframe 内嵌受 B 站 X-Frame-Options 态度影响（**未实测，不确定**）；若被拒则退化为「新标签页打开官方链接」，价值有限——所以只排第二。

**a) 直接采用现成 lx 脚本：不可行。** 唯二候选「非常刀」（黑盒中转+无 LICENSE）与「LX-Source-Vanced」（body 语义不兼容+无 search+写死档位+玩具）都不满足「贴进 URL 导入框就能正常用」；且即便修好，第 3.3 节墙依然存在，修了也播不出。

### 4.3 GPL-3.0 许可红线（若未来走 b，内置代码的取用规则）

| 来源 | 许可 | 可否复制代码进我们仓库（GPL-3.0） |
| --- | --- | --- |
| lx-music-desktop / enhanced fork | Apache-2.0 | ✅ 可以（保留 NOTICE/版权声明） |
| listen1 / you-get / BBDown / LX-Source-Vanced / qplayer-bilibili-source | MIT | ✅ 可以（保留版权行） |
| Nemo2011/bilibili-api | GPL-3.0-or-later | ⚠️ 许可兼容但 Python 无用 |
| lx-music-desktop TAchanged 等魔改 | AGPL-3.0 | ❌ 传染性强，只看不抄 |
| wood3n/biu | PolyForm Noncommercial | ❌ 与 GPL 不兼容 |
| skxingyu/lx_music- / pdone/lx-music-source / 星海 / 非常刀 / otter-music | **无 LICENSE** | ❌ 默认版权保留——**只能玩家自己贴链接，绝不内置**；1.5 的 URL 导入机制天然支持这种「用户自带脚本」模式，我们不分发就不构成再许可 |
| bilibili-API-collect | 文档（CC 类，细节未逐条验证） | ✅ 算法/端点事实不受版权保护，实现照文档写即可 |

### 4.4 给玩家的一句话答复

「B 站音乐没有现成 lx 轮子可接：社区没人做出能用的（硬墙在 CDN Referer 防盗链，与我们架构无关，桌面端 Electron 应用反而能绕是因为它们控制 HTTP 栈）。想看 B 站歌单/UP 主投稿，建议直接用 B 站网页或 app；我们的播放器继续走『五家聚合音 + 玩家自贴脚本』路线。」

## 附录

### A. 证据链接清单

- lx 规范：<https://lxmusic.toside.cn/desktop/custom-source>
- 非常刀（黑盒中转+无 LICENSE）：<https://github.com/iamcool666/music>（`音源/非常刀.js`）
- LX-Source-Vanced（MIT，bili 极简取链）：<https://github.com/HittyGubby/LX-Source-Vanced>（`lx-source.js`）
- pdone/lx-music-source（聚合，无 bili，无 LICENSE）：<https://github.com/pdone/lx-music-source>
- 六音 skxingyu/lx_music-（无 bili，无 LICENSE）：<https://github.com/skxingyu/lx_music->
- lyswhut/lx-music-desktop（Apache-2.0，无 bili SDK）：<https://github.com/lyswhut/lx-music-desktop>
- enhanced fork（Apache-2.0，bili SDK 9 文件）：<https://github.com/xinzhihong-ship-it/lx-music-desktop-enhanced>（`src/renderer/utils/musicSdk/bili/`）
- listen1（MIT，浏览器 provider）：<https://github.com/listen1/listen1_chrome_extension>（`js/provider/bilibili.js`）
- BBDown（MIT）：<https://github.com/nilaoda/BBDown>；you-get（MIT）：<https://github.com/soimort/you-get>
- Bilibili-Evolved（MIT+限制条款）：<https://github.com/the1812/Bilibili-Evolved>（LICENCE.md）
- bilibili-api（Python，GPL-3.0+）：<https://github.com/Nemo2011/bilibili-api> + <https://pypi.org/project/bilibili-api-python>
- bilibili-API-collect（文档，archived）：<https://github.com/SocialSisterYi/bilibili-API-collect>
- qplayer-bilibili-source（MIT，非 lx ABI）：<https://github.com/TIMER-succ/qplayer-bilibili-source>
- MoeMusic-bilibili-source（AGPL-3.0，Kotlin 插件）：<https://github.com/lolicode-org/MoeMusic-bilibili-source>
- 余音 yuyin-music（MIT 活跃）：<https://github.com/panda472328/yuyin-music>；bili-music-android（MIT）：<https://github.com/amns56780/bili-music-android>
- BLiveMusic（MIT，B 站弹幕+LX 点歌联动）：<https://github.com/xxxnnn1231/BLiveMusic>
- 我方代码锚点：`server/http/musicRoutes.js`（PROXY_HOST_HEADERS / 512 KB / 415）、`public/js/ui/player-core.js`（lx 沙箱 / fetchLxScript / lxSearch）

### B. MIT 片段摘录（LX-Source-Vanced 的 bili 取链，出处署名 HittyGubby, MIT）

\`\`\`js
// https://github.com/HittyGubby/LX-Source-Vanced lx-source.js (MIT)
if (source === "bili") {
  await httpFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${musicInfo.songmid}`)
    .then(async (response) => {
      await httpFetch(`https://api.bilibili.com/x/player/playurl?bvid=${musicInfo.songmid}&cid=${response.body.data.cid}&qn=16&fnval=16`)
        .then((res) => { returnurl = res.body.data.dash.audio[1].baseUrl || null; });
    });
}
\`\`\`

（注意 1.2-B 列出的 5 处硬伤，此片段仅证明「社区已有的全部 bili lx 实现水平」。）

### C. 探测记录（2026-10-16）

- 四轮 curl 实测脚本留存 `.cache/bili-probe*.sh`（不入库）；关键数据：nav 免登录回 wbi_img；view/playurl 免登录 code:0；免登录档位 {30216,30232,30280}；deadline≈签发后 2h；upcdn 系 Referer 三姿势 none/bili/other = 403/206/403（3 个异节点一致）；API 带陌生 Origin+Referer 全 403、带 bilibili Referer 200；mcdn 节点对本机 IP 恒 400（区域异常，标注不确定）。
- 网络受限项：haonanren118/jiexiang-Music-Source 逐文件内容、LX-Y-Music-IOS 的 LICENSE 文件、bilibili-API-collect 的 CC 条款细节（GitHub 匿名配额曾触发限流，改用认证 api.github.com 后主要项均已验证）。