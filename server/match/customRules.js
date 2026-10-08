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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(ROOT, 'config', 'custom-rules.json');

/** 默认排除的盟约：独行（单干）+ 经济类（远见/奇迹/投资人，countMode BOARD_AND_DECK）。 */
export const DEFAULT_EXCLUDE = Object.freeze(['soloShip', 'visiShip', 'miraShip', 'investShip']);

/** @type {{ mtimeMs: number, rules: object } | null} */
let cache = null;
let warned = false;

const OFF = Object.freeze({ rewardOffer: null, itemOffer: null, prepDebt: null, roundLottery: null, extraRounds: null, pacing: null, bossHp: null });

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function normalize(raw) {
  const out = { rewardOffer: null, itemOffer: null, prepDebt: null, roundLottery: null, extraRounds: null, pacing: null, bossHp: null };
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
      label: typeof rl.label === 'string' && rl.label ? rl.label : '军备抽奖',
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

  return out.rewardOffer || out.itemOffer || out.prepDebt || out.roundLottery || out.extraRounds || out.pacing || out.bossHp ? out : OFF;
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
