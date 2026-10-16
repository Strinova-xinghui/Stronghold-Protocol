// server/match/customRules.js — 本项目的自定义规则（自研，上游无此文件）。
//
// 设计目标：**热更新**。规则从 config/custom-rules.json 读取，带 mtime 缓存——文件一改，下一次读取即生效
// （无需重启 Node 进程，也无需重开对局：每次生成奖励候选时都会重新读取）。文件不存在 = 全部关闭（原版行为）。
//
// 配置文件格式（config/custom-rules.json）：
//   {
//     "rewardOffer": {                  // 三合一赠送（晋升奖励）的三选一定向
//       "enabled": true,
//       "slots": [                      // 按候选位置映射：第 0 张、第 1 张…
//         { "kind": "mainCount",  "minCount": 3, "mult": 2 },   // 激活人数最多的主盟约（CORE 阈值 3 起）
//         { "kind": "maxLayers", "minCount": 2, "mult": 2,      // 层数最多的副盟约
//           "exclude": ["soloShip", "visiShip", "miraShip", "investShip"] }
//       ]
//     }
//   }
// 未列出的位置 = 保持原版纯随机。`exclude` 可省略（默认排除独行/远见/奇迹/投资人）。
//
// 读取失败 / JSON 非法 / 字段类型不对：记一次警告并退回「全部关闭」，绝不让配置错误打断对局。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../../shared/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(ROOT, 'config', 'custom-rules.json');

/** 默认排除的盟约：独行（单干）+ 经济类（远见/奇迹/投资人，countMode BOARD_AND_DECK）。 */
export const DEFAULT_EXCLUDE = Object.freeze(['soloShip', 'visiShip', 'miraShip', 'investShip']);

/** @type {{ mtimeMs: number, rules: object } | null} */
let cache = null;
let warned = false;

const OFF = Object.freeze({ rewardOffer: null, itemOffer: null, prepDebt: null, roundLottery: null, extraRounds: null, pacing: null, bossHp: null, grant: null, prepUndo: null, music: null, bossBgm: null });

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function normalize(raw) {
  const out = { rewardOffer: null, itemOffer: null, prepDebt: null, roundLottery: null, extraRounds: null, pacing: null, bossHp: null, grant: null, prepUndo: null, music: null, bossBgm: null };
  if (!raw || typeof raw !== 'object') return OFF;

  // ---- 干员三选一定向（rewardOffer）----
  const ro = raw.rewardOffer && typeof raw.rewardOffer === 'object' ? raw.rewardOffer : null;
  if (ro && ro.enabled !== false) {
    const slots = Array.isArray(ro.slots) ? ro.slots : [];
    const list = [];
    for (const s of slots) {
      if (!s || typeof s !== 'object') continue;
      const slot = Number.isInteger(s.slot) ? s.slot : list.length;
      const kind = s.kind === 'mainCount' || s.kind === 'maxLayers' ? s.kind : null;
      if (!kind) continue;
      const mult = Number(s.mult);
      list.push({
        slot,
        kind,
        minCount: Number.isInteger(s.minCount) ? s.minCount : (kind === 'mainCount' ? 3 : 2),
        mult: Number.isFinite(mult) && mult > 1 ? mult : 2,
        // 'filter'（默认）= 该位置必须是该盟约的干员；'weight' = 不限定，只提高该盟约权重
        mode: s.mode === 'weight' ? 'weight' : 'filter',
        exclude: Array.isArray(s.exclude) ? s.exclude.filter((x) => typeof x === 'string') : [...DEFAULT_EXCLUDE],
        // 层数最多：默认要求该盟约已激活；可选 minLayers 门槛
        minLayers: Number.isInteger(s.minLayers) ? s.minLayers : 1,
      });
    }
    if (list.length) out.rewardOffer = Object.freeze({ slots: Object.freeze(list) });
  }

  // ---- 装备甄选（itemOffer）：提高「与主盟约同阵营、可参与变形同构体转职」装备的出率 ----
  const io = raw.itemOffer && typeof raw.itemOffer === 'object' ? raw.itemOffer : null;
  if (io && io.enabled !== false) {
    const mult = Number(io.mult);
    const minRound = Number(io.minRound);
    out.itemOffer = Object.freeze({
      // 从第几回合起生效（含）。0 / 未设 = 全程生效。
      minRound: Number.isFinite(minRound) && minRound > 0 ? Math.floor(minRound) : 0,
      mult: Number.isFinite(mult) && mult > 1 ? mult : 2,
      // 'filter'（默认）= 必须是该盟约的转职装备；'weight' = 不限定，只提高其权重
      mode: io.mode === 'weight' ? 'weight' : 'filter',
      // 'mainCount'（默认，取当前激活人数最多的盟约）或固定盟约 id
      targetBond: typeof io.targetBond === 'string' && io.targetBond ? io.targetBond : 'mainCount',
      minCount: Number.isInteger(io.minCount) ? io.minCount : 3,
      // tier 层没有目标装备时：'fallback'（默认，退到该装备所在 tier）| 'random'（保持层级，退回随机）
      onTierMiss: io.onTierMiss === 'random' ? 'random' : 'fallback',
    });
  }

  // ---- 休整期负债规则（prepDebt，自研 2026-10-07 v3）：lp ≤ 0 不淘汰进入负债，全队总和 < 0 才清算；
  //      敌人波次强度按**净负债**量化——只有真正负血（lp < 0）才算负债，高出血策略（lp > Ā）是存款可对冲
  //      队友负债；net = Σ负债 − Σ存款（与准备/等待完全独立）。详见 AGENTS.md「休整期负债规则」。
  const pd = raw.prepDebt && typeof raw.prepDebt === 'object' ? raw.prepDebt : null;
  if (pd && pd.enabled) {
    out.prepDebt = Object.freeze({
      enabled: true,   // 进入产物即启用（使用方统一检查 rule.enabled；enabled:false 在上方已被拦下）
      // 净负债斜率：净负债每满一份 Ā，敌人 HP ×(1 + k)。默认 0.3
      k: Math.max(0, numOr(pd.k, 0.3)),
      // 盈余斜率：净存款（歌利亚等高血策略撑起来的存款）每一份 Ā，敌人 HP ×(1 − k2)。默认 0.15
      k2: Math.max(0, numOr(pd.k2, 0.15)),
      // 倍率钳制 [floor, cap]
      cap: Math.max(1, numOr(pd.cap, 1.3)),
      floor: Math.min(1, numOr(pd.floor, 0.85)),
    });
  }

  // ---- 回合抽奖（roundLottery，自研 2026-10-08）：指定回合给所有活人送装备抽奖，复用凯瑟琳「定向投放」的
  //      商店栏 pick-one 面板（pushItemOffer）。每回合推 `rolls` 个独立 offer（各 `choices` 选 1）= 多轮独立抽奖。
  //      装备池 = 当前商店等级可出的全部装备（choices.json pool_equip_kathe 语义），可再按回合设 minTier 剔除低阶。
  const rl = raw.roundLottery && typeof raw.roundLottery === 'object' ? raw.roundLottery : null;
  if (rl && rl.enabled) {
    const rolls = Math.max(1, Math.min(10, Math.trunc(numOr(rl.rolls, 2))));
    const choices = Math.max(1, Math.min(6, Math.trunc(numOr(rl.choices, 5))));
    // 回合表：{ round: 3, minTier: 1 } —— minTier = 该回合抽奖的最低装备阶（1 = 全阶混池，3 = 只出 T3+）
    const src = Array.isArray(rl.rounds) ? rl.rounds : [];
    const rounds = [];
    for (const r of src) {
      const round = Math.trunc(numOr(typeof r === 'object' && r ? r.round : r, 0));
      if (!(round >= 1)) continue;
      const minTier = Math.max(1, Math.min(6, Math.trunc(numOr(r && r.minTier, 1))));
      // maxTier：默认 6（全阶，抽奖是奖励不该被个人商店等级卡住）；'shopLevel' = 按该玩家当前商店等级
      const rawMax = r && r.maxTier;
      const maxTier = rawMax === 'shopLevel' ? 'shopLevel' : Math.max(1, Math.min(6, Math.trunc(numOr(rawMax, 6))));
      rounds.push(Object.freeze({ round, minTier, maxTier }));
    }
    if (rounds.length) out.roundLottery = Object.freeze({
      enabled: true,
      rolls,
      choices,
      rounds: Object.freeze(rounds),
      label: typeof rl.label === 'string' && rl.label ? rl.label : t('军备抽奖'),
      // 是否也给 AI 座位发（默认 false——AI 不需要，且要替它做选择逻辑；用户 2026-10-08 定）
      includeBots: rl.includeBots === true,
    });
  }

  // ---- 回合编排（extraRounds，自研 2026-10-08）：延后 BOSS 给玩家更多发育回合。
  //      语义：把原 bossRound/hiddenRound/lastRound 整体顺延 `count` 回合；插入的回合**复用 `templateRound`
  //      （默认 13）的波次**（官方 data/ 零改动 → golden 安全），难度按 `curve` 策略决定：
  //        stretch = 整条难度曲线重排到新的最后普通回合（端点不变，前期随之变缓）—— 用户 2026-10-08 定稿
  //        append  = 从模板回合的等级接着涨（k+1, k+2…，每回合 +20%）
  //        smooth  = 插入的回合共同完成「一级」的成长（总量 1.2×，平摊）
  //        flat    = 完全沿用模板回合难度（不涨）
  //      怪组多样性：`poolTemplates`（同难度模板池）里随机混排，强度不变、组合变化。
  const er = raw.extraRounds && typeof raw.extraRounds === 'object' ? raw.extraRounds : null;
  if (er && er.enabled) {
    const insertAfter = Math.max(1, Math.trunc(numOr(er.insertAfter, 13)));
    const count = Math.max(1, Math.min(10, Math.trunc(numOr(er.count, 4))));
    const templateRound = Math.max(1, Math.trunc(numOr(er.templateRound, insertAfter)));
    const pool = Array.isArray(er.poolTemplates)
      ? er.poolTemplates.filter((x) => typeof x === 'string' && x)
      : [];
    const CURVES = ['stretch', 'stretchShape', 'append', 'smooth', 'flat'];
    out.extraRounds = Object.freeze({
      enabled: true,
      insertAfter,                        // 从这一回合之后开始插入（即原 BOSS 之前）
      count,                              // 插入几个发育回合
      templateRound,                      // 波次模板取自哪一回合
      curve: CURVES.includes(er.curve) ? er.curve : 'stretch',
      // ---- 难度曲线（官方公式 hp = curveBase × curveRate^k，k = 表里的 kHp/kAtk）----
      // 默认值即官方反解值：0.8 × 1.2^k / 0.8 × 1.1^k
      curveBase: Math.max(0.01, numOr(er.curveBase, 0.8)),
      curveRate: Math.max(1, numOr(er.curveRate, 1.2)),
      curveBaseAtk: Math.max(0.01, numOr(er.curveBaseAtk, 0.8)),
      curveRateAtk: Math.max(1, numOr(er.curveRateAtk, 1.1)),
      poolTemplates: Object.freeze(pool), // 怪组多样性池（波次模板 id；空 = 只用 templateRound 的模板）
      mixPerRound: er.mixPerRound !== false, // 每个插入回合是否从池里随机挑一个模板
    });
  }

  // ---- 对局节奏（pacing，自研 2026-10-08）：分项时间倍率，**只加时长、不改难度**。
  //      bandDraftMul = 策略轮选（BAND_DRAFT）每轮时长倍率（1.5 = 加时到 1.5 倍）
  //      spDraftMul   = 机变（SP_DRAFT）每轮时长倍率（用户要求与策略轮选一起加）
  //      prepMul      = 休整期时长倍率
  //      combatSpeed  = 对局速度（游戏秒/现实秒；默认 2 = 官方强制的 2×）——**默认不启用**，要用时填 >0
  const pc = raw.pacing && typeof raw.pacing === 'object' ? raw.pacing : null;
  if (pc && pc.enabled) {
    const bandDraftMul = Math.max(0.1, Math.min(10, numOr(pc.bandDraftMul, 1)));
    const spDraftMul = Math.max(0.1, Math.min(10, numOr(pc.spDraftMul, 1)));
    const prepMul = Math.max(0.1, Math.min(10, numOr(pc.prepMul, 1)));
    const csRaw = Number(pc.combatSpeed);
    const combatSpeed = Number.isFinite(csRaw) && csRaw > 0 ? Math.min(csRaw, 200) : null;   // null = 用官方默认
    out.pacing = Object.freeze({ enabled: true, bandDraftMul, spDraftMul, prepMul, combatSpeed });
  }

  // ---- BOSS 血量（bossHp，自研 2026-10-08）：复用上游预留的 `gd.bossHpMul` 钩子（finalAssault.bossPoolHp 调用）。
  //      mul      = 基础倍率（1 = 官方）
  //      按层数加压：layerMul = min(layerCap, 1 + layerK × max(0, layerSum − layerFloor))
  //        layerSum = 本局所有活人的盟约层数总和（Match.startFinalAssault 传入 = hiddenLayerSum）
  //        开发回合会让层数远超官方 13 回合的水位，用 layerFloor 把「官方水位以内」的部分免计，超出才加压。
  const bh = raw.bossHp && typeof raw.bossHp === 'object' ? raw.bossHp : null;
  if (bh && bh.enabled) {
    out.bossHp = Object.freeze({
      enabled: true,
      mul: Math.max(0.01, Math.min(100, numOr(bh.mul, 1))),
      layerK: Math.max(0, Math.min(1, numOr(bh.layerK, 0.0005))),
      layerFloor: Math.max(0, Math.trunc(numOr(bh.layerFloor, 0))),
      layerCap: Math.max(1, Math.min(100, numOr(bh.layerCap, 5))),
    });
  }

  // ---- GM 实时发放（grant，自研 2026-10-09 上线 / 2026-10-12 补总开关）：/console「发放棋子/装备/发钱」的总闸。
  //      enabled=false 时 /console/api/grant 一律 403 拒绝——原版没有任何 GM 发放能力，
  //      关掉它「全关 = 原汁原味」才彻底成立。面板在 __grant（特殊面板，开关在 h2 里）。
  const gr = raw.grant && typeof raw.grant === 'object' ? raw.grant : null;
  if (gr && gr.enabled) out.grant = Object.freeze({ enabled: true });

  // ---- 休整期撤回（prepUndo，自研 2026-10-15）：休整期内玩家自己的一切操作（刷新/买卖/装备/销毁/移动/升级商店…）
  //      均可撤回，含资源返还（资金、卡池占用、DIY 库存）。快照式实现：每个可撤回意图执行前深快照，
  //      g.undo 弹栈恢复。enabled=false 时 g.undo 一律拒绝——原版没有任何撤回，全关 = 原汁原味。
  const pu = raw.prepUndo && typeof raw.prepUndo === 'object' ? raw.prepUndo : null;
  if (pu && pu.enabled) {
    out.prepUndo = Object.freeze({
      enabled: true,
      // 撤回栈上限（每回合每玩家）：防止极端情况无限连按囤快照（快照含整块玩家状态，1 条 ≈ 几 KB）
      maxDepth: Math.max(1, Math.min(64, Math.trunc(numOr(pu.maxDepth, 32)))),
    });
  }

  // ---- 音乐播放器（music，自研 2026-10-15）：/music/siren/* 塞壬元数据代理的总闸（外部音源/proxy 已于 2026-10-16 移除）。
  //      enabled=false 时路由不挂载（404）——原版没有任何播放器，全关 = 原汁原味。音频/封面始终 CDN 直连
  //      （浏览器流量），服务器侧只有几十 KB 的 JSON 缓存读取。
  const mu = raw.music && typeof raw.music === 'object' ? raw.music : null;
  if (mu && mu.enabled) out.music = Object.freeze({ enabled: true });

  // ---- BOSS 战 BGM 替换（bossBgm，自研 2026-10-16；2026-10-16 晚改为**按轮次类型**匹配）----
  //      ⚠️ 不再按回合号匹配（旧设计）：BOSS 回合号会随「开不开加时赛」变化——官方 14/15，开了加时赛
  //      顺延成 18/19（见 gamedata.bossRound/hiddenRound 与 extraRounds 规则）。把 BOSS 绑死在 18/19
  //      在未开加时赛的局里完全失效。改为按**轮次类型**（作战期的种类）匹配，两种：
  //        scope: 'combat' = 常规战斗轮（COMBAT 阶段，非 BOSS）
  //        scope: 'boss'   = BOSS 轮（FINAL_ASSAULT 最终攻势 / HIDDEN_CORE 隐秘核心）
  //        scope: '*'      = 所有作战期（两种都覆盖；列表序在前者优先）
  //      rules 每条 { scope, track }；track = 曲目标识（见下）或**数组 = 随机池**（本回合从池里取一首）。
  //      （兼容：仍接受 { round: N, track } 的旧形态——按具体回合号匹配，高级用法，控制台不再暴露。）
  //      未命中任何规则 = 官方日程逐字节不变（audio.js bgmKeyFor）。
  //      曲目合法性：服务器不解析 1.6 MB 的 data/assets.json（零新增内存/流量红线）——宽松校验格式，
  //      真正的存在性由客户端 resolveBgm 兜底：清单/上传目录里没有该曲 ⇒ 回落官方 key，绝不静音、绝不 404。
  const bb = raw.bossBgm && typeof raw.bossBgm === 'object' ? raw.bossBgm : null;
  if (bb && bb.enabled) {
    const src = Array.isArray(bb.rules) ? bb.rules : [];
    const STEMS = /^[a-z0-9_]{1,64}$/;
    const SCOPES = new Set(['combat', 'boss', '*']);
    const list = [];
    for (const r0 of src) {
      if (!r0 || typeof r0 !== 'object') continue;
      // 轮次类型：'combat' | 'boss' | '*'；给了 scope 就按类型匹配，否则退回旧的具体回合号
      const scope = typeof r0.scope === 'string' && SCOPES.has(r0.scope.trim().toLowerCase()) ? r0.scope.trim().toLowerCase() : null;
      const round = scope ? 0 : Math.trunc(numOr(r0.round, 0));
      if (!scope && (!(round >= 1) || round > 200)) continue;   // 无 scope 时 round 必须合法；有 scope 则忽略 round
      // 曲目来源（2026-10-16）：`track` 可以是**单个曲目**（字符串）或**随机池**（数组）。
      //   内置素材 stem  `m_bat_xxx`         → 客户端 resolveBgm 走 assets 清单（'stem:<x>'）
      //   自定义上传曲目  `x:<name>`          → 客户端走 /media/cbgm/<name>（'cbgm:<name>'，管理员上传目录）
      // 池 = 本回合作战期从这几首里随机取一首（**服务器确定性随机**：同局同回合永远同一首，全房同曲；
      // 见 bossBgmTrackFor 的 seed 参数）。自定义 stem 允许大小写与连字符，仍禁点/斜杠 ⇒ 无路径穿越。
      const norm = (v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!s) return null;
        const custom = /^x:/i.test(s);
        const stem = custom ? s.slice(2).trim() : s;
        const ok = custom ? /^[A-Za-z0-9_-]{1,64}$/.test(stem) : STEMS.test(stem);
        return ok ? (custom ? 'x:' + stem : stem) : null;
      };
      const arr = Array.isArray(r0.track) ? r0.track : [r0.track];
      const pool = [];
      for (const v of arr) { const t = norm(v); if (t && !pool.includes(t)) pool.push(t); if (pool.length >= 32) break; }
      if (!pool.length) continue;                              // 非法/空曲目池丢弃（宽松格式校验，见上注释）
      // 单曲也存成 1 元池：下游只需处理池这一种形态（视图下发时再解析成字符串）
      list.push(Object.freeze(scope ? { scope, pool: Object.freeze(pool) } : { round, pool: Object.freeze(pool) }));
      if (list.length >= 64) break;                            // 硬上限：视图字段最多 64 条（防滥用撑大 m.public）
    }
    if (list.length) out.bossBgm = Object.freeze({ enabled: true, rules: Object.freeze(list) });
  }

  return out.rewardOffer || out.itemOffer || out.prepDebt || out.roundLottery || out.extraRounds || out.pacing || out.bossHp || out.grant || out.prepUndo || out.music || out.bossBgm ? out : OFF;
}

/**
 * 当前生效的自定义规则（带 mtime 热更）。文件不存在/读取失败 → OFF（原版行为）。
 * @param {{ log?: object }} [opts]
 */
export function getCustomRules({ log = null } = {}) {
  // golden 安全网等「官方基线」场景：SP_OFFICIAL_RULES=1 强制全部规则关闭（worker 线程继承环境变量），
  // 使 golden 结果与 config/custom-rules.json 的用户配置完全解耦。
  if (process.env.SP_OFFICIAL_RULES === '1') return OFF;
  let stat = null;
  try { stat = fs.statSync(CONFIG_PATH); } catch { stat = null; }
  if (!stat) {
    if (cache !== null) cache = null;
    return OFF;
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.rules;
  let rules = OFF;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    rules = normalize(raw);
    warned = false;
  } catch (e) {
    if (!warned) { log?.warn?.(`[custom-rules] 配置读取失败，按原版运行：${e.message}`); warned = true; }
    rules = OFF;
  }
  cache = { mtimeMs: stat.mtimeMs, rules };
  return rules;
}

/** 测试用：丢弃缓存。 */
export function resetCustomRules() { cache = null; warned = false; }

/**
 * BOSS 战 / 指定回合 BGM 替换（bossBgm，自研 2026-10-16）的**命中纯函数**：本回合作战期用哪首自定义曲目。
 * 列表序取首条命中（同回合多条规则 = 先配的生效）。规则关闭 / 未命中 ⇒ null（官方日程不变）。
 *
 * **随机池（2026-10-16 用户要求）**：规则可以配多首（`track` 数组 = 池），本回合从池里随机取一首。
 * 随机的三条硬约束：
 *   ① 必须**服务器**掷——若客户端各自随机，同一局里队友会听到不同的歌（且每帧视图重算会不断换曲）；
 *   ② 必须**每局每回合固定**——同一回合的多次视图构建（节流广播 / 重连 resync）必须给出同一首；
 *   ③ 不得消耗 rngMeta/rngShop——那两个流被反 SL 快照与 golden 基线依赖，掺进来会污染整局随机序列。
 * 所以用 `deriveSeed(match.seed, 'bgm:<round>')` 现推一个独立确定性种子（同一局同一回合恒定；不同局/不同回合
 * 各不相同），不碰任何既有 rng 流。seed 省略时退化为「取池首」——纯函数单测与旧调用点无需构造 seed。
 *
 * 服务器唯一新增开销 = 每次 m.public 视图构建多这一次整数查找（+ 命中池时一次小型哈希）；
 * 命中时多下发一个 ≤64 字节的字符串字段；音频文件本身已在客户端（assets 清单或 public/cbgm 上传目录），
 * 零内存零流量红线成立。
 * @param {{ bossBgm?: { enabled: boolean, rules: readonly { round: number, pool: readonly string[], kind: string }[] } | null }} rules getCustomRules() 的产物
 * @param {number} round 对局回合号（extraRounds 顺延后的**实际**回合：BOSS=18 / 隐藏核心=19；未开加时赛则官方 14/15）
 * @param {number} [seed] 对局种子（Match.seed）。给了就做确定性随机；省略 ⇒ 取池首。
 * @returns {string|null} 曲目标识（内置 stem 或 `x:<name>`）或 null
 */
export function bossBgmTrackFor(rules, scope, round, seed) {
  const bb = rules && rules.bossBgm;
  if (!bb || !bb.enabled || !Array.isArray(bb.rules)) return null;
  // 兼容旧签名 bossBgmTrackFor(rules, round, seed)：第二参是数字（或纯数字串）时视为回合号
  if (typeof scope === 'number' || (typeof scope === 'string' && scope !== '' && Number.isFinite(Number(scope)))) {
    seed = round; round = scope; scope = null;
  }
  // scope = 'combat'（常规战斗轮）| 'boss'（BOSS 轮）；round 只给「旧形态的按回合号规则」用
  const sc = scope === 'boss' ? 'boss' : scope === 'combat' ? 'combat' : null;
  const r = Number(round);
  for (const rule of bb.rules) {
    // 命中判定：规则带 scope ⇒ 比较类型（'*' 通配）；规则带 round（旧形态）⇒ 比较回合号
    const hit = rule.scope != null
      ? (rule.scope === '*' || (sc != null && rule.scope === sc))
      : (Number.isFinite(r) && rule.round === r);
    if (!hit) continue;
    // 归一化后是 rule.pool；这里也容忍手写对象 { scope, track }（单测/旧调用点直接构造规则时的形态）
    const pool = Array.isArray(rule.pool) ? rule.pool
      : (typeof rule.track === 'string' ? [rule.track] : Array.isArray(rule.track) ? rule.track : []);
    if (!pool.length) continue;
    if (pool.length === 1 || !Number.isFinite(seed)) return pool[0];
    // 确定性选择：FNV-1a(seed:scope:round) % pool.length（不占任何 rng 流；同局同轮次恒定 ⇒ 全房同曲、
    // 节流广播/重连 resync 不换曲；不同局/不同轮次有变化）。轮次号进哈希 ⇒ 同一池在第 3 轮与第 9 轮可不同。
    let h = 0x811c9dc5;
    const s = `${seed >>> 0}:${rule.scope != null ? rule.scope : 'r' + rule.round}:${Number.isFinite(r) ? r : ''}`;
    for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
    return pool[h % pool.length];
  }
  return null;
}

/**
 * 写回配置（自研控制台 /console 用）。**校验后再落盘**：非法 JSON 结构或写盘失败都抛错，绝不写坏文件。
 * 写入成功后立即清缓存 → 下一次 getCustomRules() 读到的就是新值（热更，无需重启）。
 * @param {object} raw 完整配置对象（与 config/custom-rules.json 同构）
 * @returns {{ ok: true, rules: object }}
 */
export function saveCustomRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是 JSON 对象');
  // 先规范化一遍：能通过 normalize 且不抛错才允许落盘（防手写非法结构）
  const rules = normalize(raw);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  // 原子写：先写临时文件再改名，避免写一半崩溃留下坏配置
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  resetCustomRules();
  return { ok: true, rules };
}

export const CUSTOM_RULES_PATH = CONFIG_PATH;
