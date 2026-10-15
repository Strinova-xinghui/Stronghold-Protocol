// server/match/player/prepUndo.js — PlayerState 自研方法模块：休整期撤回（prepUndo，2026-10-15）。
// 设计：**快照式撤回**。休整期内玩家发出的每个「可撤回意图」执行前，先对该玩家做一次深快照（结构化克隆
// 全部私有状态 + 共享池/DIY 库存的占用差分），g.undo 弹栈整体恢复。比起记录逆操作（undo-log），快照式：
//   * 天然覆盖一切副作用——买卖、合并、装备转移、召唤物栈、临时区、资金、统计、每回合计数器；
//   * 共享池不是玩家私有的：快照记录「该玩家的动作前后，共享池 left 的差分」——恢复时按差分逆向 give/take，
//     同回合其他玩家的占用不受影响（他们在这段时间里的买卖不动）；
//   * 副作用事件（onBuy/onSold/onEquip 等 dispatch）会重放——快照恢复后手动 recompute + dirty，效果系统里
//     依赖「本回合买了 N 个」的特质（如拉普兰德的计数）随快照一起回滚（piece.meta.round 在快照里）。
// 边界（设计决定，不是疏漏）：
//   * 只撤「本玩家本休整期」的操作：换阶段（进入战斗/结算/下回合）即清栈——跨回合撤回会破坏战斗结果的因果；
//   * Ready 切换不入栈（它是阶段推进信号，撤它等于「取消准备」，已有专门按钮）；但 ready=false 后再操作，
//     新操作照常入栈（un-ready 后仍在同一 prep，可继续撤）；
//   * 免费刷新次数 freeRefreshes 也在快照里——撤一次误用的免费刷新，次数回来；
//   * 升级商店（levelUp）入栈——快照恢复商店等级/价格/空栏位布局，资金返还，无残留（用户点名「优先级低，
//     难就算了」，实际快照式下零额外成本，顺手支持）。
// 挂载：PlayerState.js parts 数组末尾（自研模块，不与上游重名）。

import { PHASE, ERR } from '../../../shared/constants.js';
import { getCustomRules } from '../customRules.js';
import { OK, fail } from './common.js';

/** 可撤回的意图类型（_handle 路由层传进来；不在表内的不入栈）。 */
export const UNDOABLE_INTENTS = new Set(['buy', 'refresh', 'freeze', 'levelUp', 'sell', 'move', 'equip', 'art', 'destroy', 'reward']);

/** 结构化克隆一个值（Node 17+ globalThis.structuredClone）。 */
const clone = (v) => structuredClone(v);

/**
 * 拍玩家快照：私有状态全部 + 共享池占用差分基线（此刻各池的 left）。
 * 只拷贝会被玩家操作改动的字段；loadout/ops/skins/standIns/diy 等 freeze 的对局级设置从不动，不拷。
 */
function snapshotPlayer(ps) {
  const m = ps.m;
  // 共享池与 DIY 库存的占用基线：记录每个 entry 的当前 left（恢复时按差分逆向）。
  // DIY 库存是玩家私有的，直接全量记；共享池全量记（条目 ~200 个，每条 1 数字，代价可忽略）。
  // 池恢复不记 left 基线（写回基线在多人并发下会把别人的消耗也「还」回去，打破 left + held == cap），
  // 改记「本玩家自己每 base 的持有份数」：恢复时 left = cap − 其他玩家的持有（他们同期的买卖不受影响）。
  const mineHeld = new Map();
  const seeMine = (p) => {
    if (p && p.kind === 'chess' && p.poolCopies > 0) {
      const b = ps.gd.baseIdOf(p.id);
      mineHeld.set(b, (mineHeld.get(b) || 0) + p.poolCopies);
    }
  };
  for (const p of ps.hand) seeMine(p);
  for (const p of ps.temp) seeMine(p);
  for (const p of ps.board.values()) seeMine(p);
  const diyLeft = new Map();
  for (const [id, e] of ps.diyStock.entries) diyLeft.set(id, e.left);
  return {
    // ---- 经济 ----
    funds: ps.funds,
    pendingFunds: ps.pendingFunds,
    // ---- 商店 ----
    shop: clone({ level: ps.shop.level, upgradePrice: ps.shop.upgradePrice, slots: ps.shop.slots, frozen: ps.shop.frozen, freeRefreshes: ps.shop.freeRefreshes, layout: ps.shop.layout }),
    // ---- 招募/装备 offer 队列 ----
    offers: clone(ps.offers),
    // ---- 手牌 / 临时区 / 棋盘 ----
    hand: clone(ps.hand),
    temp: clone(ps.temp),
    board: clone([...ps.board]),
    _tempDue: clone([...ps._tempDue]),
    // ---- 盟约层数 / 每回合计数 ----
    layers: clone(ps.layers),
    round: clone(ps.round),
    stats: clone(ps.stats),
    // ---- 策略/效果计数器（用户 2026-10-15 实测漏洞：绮良【通关奖励】「每使用 20 资金获得随机干员」）----
    // ctx.counter/incCounter/setCounter 的存储（server/match/effectsMeta.js）：绮良 band:kirara:acc、
    // 潘格尼尼 band:paganini:spent/done、克劳妮 band:chiave:refreshes、松鼠 band:sciurus:r、
    // 商业包装方案 pack:<uid>（卖出计数）。不随快照回滚 = 「买 → 撤回 → 再买」无限累计计数器白刷奖励
    // （撤回返还资金，acc 却留着）——与 rng 回滚同类的 SL 漏洞。纯 { string: number }，克隆安全。
    counters: clone(ps.counters),
    // ---- 池占用：自己每 base 的持有份数（恢复对账用，见上）----
    mineHeld,
    diyLeft,
    // ---- 阶段锚（恢复校验用） ----
    phase: m.phase,
    roundNo: m.round,
    prepsEnded: ps.prepsEnded,
    // ---- 反 SL（用户 2026-10-15 要求）：随机数状态一并回滚 ----
    // 松果卖出/寻呼模块/拟态物质/简易通讯机/商业包装方案等效果消耗 rngMeta（ctx.rollChess / rollPool →
    // m.pool.roll(m.rngMeta, …)）。撤回若不恢复 rng 状态，重做一次会得到不同随机结果 = 无限 SL 刷随机。
    // 把 match 级 rngMeta 的内部状态存进快照、恢复时写回：重做 = 精确重放同一条随机序列（同卡、同 offer、
    // 同干员）。意图处理串行，撤回者操作间隙无人消耗 rngMeta，写回不影响别人。
    rngMetaState: typeof m.rngMeta?.state === 'function' ? m.rngMeta.state() : null,
    // 商店刷新 / 奖励 offer 抽卡走 rngShop：不回滚它 = 撤回后重刷可无限抽面（免费 SL）。
    rngShopState: typeof m.rngShop?.state === 'function' ? m.rngShop.state() : null,
  };
}

/** 恢复快照到玩家（含池差分回滚）。 */
function restorePlayer(ps, snap) {
  const m = ps.m;
  ps.funds = snap.funds;
  ps.pendingFunds = snap.pendingFunds;
  ps.shop.level = snap.shop.level;
  ps.shop.upgradePrice = snap.shop.upgradePrice;
  ps.shop.slots = snap.shop.slots;
  ps.shop.frozen = snap.shop.frozen;
  ps.shop.freeRefreshes = snap.shop.freeRefreshes;
  ps.shop.layout = snap.shop.layout;
  ps.offers = snap.offers;
  ps.hand = snap.hand;
  ps.temp = snap.temp;
  ps.board = new Map(snap.board);
  ps._tempDue = new Map(snap._tempDue);
  ps.layers = snap.layers;
  ps.round = snap.round;
  ps.stats = snap.stats;
  ps.counters = snap.counters; // 策略计数器随快照回滚（绮良 acc 等，见 snapshotPlayer 注释）
  ps.prepsEnded = snap.prepsEnded;
  // 共享池对账：left = cap − 全场所有玩家的持有（A 恢复后的持有 = 恢复到字段里的手牌/棋盘 piece.poolCopies）。
  // 其他人同期的买卖不动——他们还持有的份数被自然减去；A 自己的持有随快照回滚。
  // 恒等式 left + Σheld == cap 自动闭合（快照本身合法 ⇒ A 恢复后的持有合法 ⇒ 差值 = 池该有的 left）。
  for (const [id, e] of m.pool.entries) {
    let held = 0;
    for (const pl of m.order) {
      const see = (p) => {
        if (p && p.kind === 'chess' && pl.gd.baseIdOf(p.id) === id) held += p.poolCopies || 0;
      };
      for (const p of pl.hand) see(p);
      for (const p of pl.temp) see(p);
      for (const p of pl.board.values()) see(p);
    }
    e.left = e.cap - held;
  }
  // DIY 库存同理（玩家私有，无并发问题）。
  for (const [id, e] of ps.diyStock.entries) {
    const base = snap.diyLeft.get(id);
    if (base !== undefined) e.left = base;
  }
  // 反 SL：随机数状态回滚——重做一次消耗随机的效果得到同样的结果，撤回不能当刷新用。
  if (snap.rngMetaState !== null && typeof m.rngMeta?.setState === 'function') m.rngMeta.setState(snap.rngMetaState);
  // 商店刷新同理：撤回恢复旧商店面 + rngShop 状态，重刷得到同样的面（免费 SL 堵死）。
  if (snap.rngShopState !== null && typeof m.rngShop?.setState === 'function') m.rngShop.setState(snap.rngShopState);
  // 池缓存失效（deployMap 等派生缓存不涉及池，但求稳）+ 重算盟约 + 标脏
  ps.recompute();
  ps.dirty();
}

export class PlayerPrepUndo {
  /** 当前生效的撤回规则（custom-rules.json prepUndo，mtime 热更）；null = 关闭。 */
  get _undoRule() {
    try { return getCustomRules({ log: this.m.log }).prepUndo || null; } catch { return null; }
  }

  /** 本回合撤回栈（懒建）。 */
  get _undoStack() {
    if (!this.__undoStack) this.__undoStack = [];
    return this.__undoStack;
  }

  /**
   * 包装一个可撤回意图（intents 路由层）：PREP + 规则开 + 可撤回类型 → 执行前压栈快照；
   * 执行失败（返回 error）时弹掉刚压的快照——失败的操作没改状态，留在栈里会让下一次撤回「什么都没发生」。
   * @param {string} intent @param {object} msg @param {() => object} fn
   */
  _undoWrap(intent, msg, fn) {
    const m = this.m;
    if (m.phase !== PHASE.PREP || typeof fn !== 'function') return fn ? fn() : undefined;
    const rule = this._undoRule;
    if (!rule || !UNDOABLE_INTENTS.has(intent)) return fn();
    const stack = this._undoStack;
    if (stack.length >= rule.maxDepth) stack.shift(); // 深度上限：丢最旧的
    stack.push({ intent, msg: clone(msg), snap: snapshotPlayer(this) });
    let res;
    try {
      res = fn();
    } catch (e) {
      stack.pop(); // 抛错 = 平台会兜成 INTERNAL，同样不留栈
      throw e;
    }
    if (res && typeof res === 'object' && res.error) stack.pop();
    return res;
  }

  /** g.undo：弹栈恢复。校验：规则开、PREP、同回合、非 ready（ready 后不允许操作，撤回同理）。 */
  undo() {
    const rule = this._undoRule;
    if (!rule) return fail(ERR.BAD_TARGET, '撤回功能未开启');
    if (!this.alive) return fail(ERR.ELIMINATED);
    if (this.m.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (this.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const stack = this._undoStack;
    if (!stack.length) return fail(ERR.BAD_TARGET, '没有可撤回的操作');
    const entry = stack.pop();
    const snap = entry.snap;
    // 阶段锚校验：跨回合/跨阶段的栈已被清空，这里再防一手（快照属于别的回合 = 逻辑错误，拒绝并清栈）
    if (snap.phase !== PHASE.PREP || snap.roundNo !== this.m.round || snap.prepsEnded !== this.prepsEnded) {
      this.__undoStack = [];
      return fail(ERR.BAD_TARGET, '没有可撤回的操作');
    }
    restorePlayer(this, snap);
    this.m.toast(this, 'info', '已撤回：' + (UNDO_LABELS[entry.intent] || '操作'));
    return OK;
  }

  /** 阶段切换/回合推进时清栈（Match 侧调用）。 */
  _undoClear() {
    this.__undoStack = [];
  }
}

/** 撤回提示用的意图名。 */
export const UNDO_LABELS = {
  buy: '购买', refresh: '刷新', freeze: '冻结', levelUp: '升级商店', sell: '出售', move: '移动',
  equip: '装备', art: '战术道具', destroy: '销毁', reward: '选择奖励',
};
