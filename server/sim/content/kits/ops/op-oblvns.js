// server/sim/content/kits/ops/op-oblvns.js — 丰川祥子 (char_4182_oblvns) 自选 operator kit: 6★ 领主 (近卫), an owned-6★
// pick of the tier-5 and tier-6 自选 slots; both talents and all three skills, her LOR-Y module at every form.
// Kit contract and the 自选 rules: ../README.md ("How to add an operator (自选)").
//
// Forms (data/backups.json units.char_4182_oblvns, the DIY slot statuses): normal = E2 Lv1, skills at rank 4, no module;
// elite = E2 Lv60, rank 7, the picked module at stage 1 (tier 5) or 3 (tier 6). Full potential (the owner's decision of
// 2026-10-07). Every number comes from the composed record and the selected skill's blackboard, so one file serves both
// tiers, both forms and both module stages; the constants are mechanics the tables carry no key for (PRTS 备注 only).
// Sources: character_table / skill_table / battle_equip_table / uniequip_table (zh_CN, as built into backups.json;
// teamId `mujica` — 丰川祥子 char_4182_oblvns / 若叶睦 char_4183_mortis / 三角初华 char_4184_dolris /
// 祐天寺若麦 char_4185_amoris / 八幡海铃 char_4186_tmoris); PRTS 丰川祥子 (the 备注 quoted at each mechanic
// below: the notes' 自由移动 / 追踪移动 / 已命中 states and their per-skill parameters, 颂乐音符 备注,
// 毋畏遗忘 备注, the Fever 术语, S1 备注 "触发技能时以自身朝向为基准，自左13.125°至右13.125°顺时针均匀
// 演奏音符（间隔3.75°）… 可充能2次，充能至最大层数时自动释放一次", S2 备注 "钢琴音符…【已命中】状态：
// 激活0.8半径的碰撞，固定3.0速度当前方向移动，持续0.5s；风琴音符…【已命中】状态：不存在", S3 的 "分别追踪
// 法术抗性和防御力最高的敌人"); PRTS 分支特性信息 领主 ("可以进行远程攻击，但此时攻击力降低至80%", 可对空,
// "可以且优先攻击自身阻挡的单位（即使目标处于攻击范围外）"); professions.js SUB.lord / TUNE.lord.
//
// WHAT THE ENGINE CANNOT CARRY YET — stated, not faked (kits/README.md 忠实规则: such a mechanic needs an engine
// change of its own; these are the open items). Everything else below is implemented as the game has it.
// - **Fever** (毋畏遗忘 "对敌人造成伤害时使Fever+3"; PRTS 术语: a team-shared 450-point meter, and a member's
//   MANUAL cast at full meter puts every Ave Mujica member on the field into 20 s of free, SP-ignoring recasts) is no
//   engine state and it drives OTHER operators' skills. NOT implemented: T2's Fever counter, S2's "Fever期间变为当前
//   音色的二连击" and "Fever期间此技能无法手动开启", S3's "Fever期间Ave Mujica成员受到致命伤害时不撤退，
//   Fever结束后退场". T2 keeps its other two clauses, S2 / S3 everything but their Fever halves.
// - 毋畏遗忘's "其他Ave Mujica成员的攻击范围若与自身原本攻击范围重合，则将其视作攻击范围的延伸" is not
//   implemented either: it rewrites ANOTHER unit's range geometry, which no kit hook expresses — 谬因's 延伸
//   (op-aphris.js) bends her OWN range; this bends everybody else's.
// - The notes (音符) are the engine's homing projectiles (sim/projectiles.js), not PRTS' three-state movers: a note flies
//   to the target it was played for (hitDead — it lands where that enemy got to, the engine's own rule) instead of
//   drifting a 自由移动 扩张正弦 path and re-searching targets with its 追踪范围半径. [ASSUMED] the 初始角度 of the
//   备注 (左20°至右20°, the `attack@angle` key) only seeds that 自由移动 drift, so it changes nothing here, and the
//   eight S1 notes of the 3.75° fan therefore share one direction: the current target. A note with nothing to hit drifts
//   straight ahead for its budget and fades (PRTS 备注: 持续攻击 cannot fire when the tile ahead is impassable — a board
//   edge this kit cannot read per note, so it plays anyway [ASSUMED]). A note lives from its play until it lands, which is
//   the count 颂乐音符 turns into penetration layers.
// - The module's trait line 「攻击范围内存在2名及以上敌人时攻击速度+12」 is applied to EVERY operator by the ENGINE
//   (../traitMods.js crowdInRange — her LOR-Y record puts `attack_speed` on `trait.bb` with exactly that clause; verified
//   with `traitAttackSpeedRule` ⇒ reason 'ok'), so this kit must NOT add it: a kit adding it too would count it twice.
//
// - Trait (领主) "可以进行远程攻击，但此时攻击力降低至80%" and 可对空: the branch's own `profile.rangedScale`
//   (read from the trait bb by professions.js) and `canHitFly`; blocked enemies are her targets first, range or not. Her
//   attacks ARE notes and she 持续攻击s (颂乐音符) whether or not a target stands there, so the profession's attack loop
//   is switched off (`trait.noAttack`) and this kit owns her rhythm: one note per attack interval (`unit.s.interval`, 1.3 s
//   at bat 1.3 / aspd 100) — an attack of hers in every bookkeeping sense (stats.attacks, lastAttackAt, and the
//   攻击回复 SP of all three skills through skill.onAttackPerformed; an attack made while a timed skill runs recovers
//   none, skills.js). Casting is the ENGINE's, not the kit's: for a unit that cannot attack, skills.js evaluates the
//   data's resolved rule every tick (DEFAULT on her initial range and the enemies she blocks; ACTIVE_RANGE for S3 on its
//   own 3-21 — the owner's larger-range rule of 2026-10-05, which is why the data carries that deviation here), under the
//   engine's own 3 s automatic-operation cooldown and its 沉默 / 攻速闸门 (ai.js returns before its cast check for a
//   noAttack profile, so the tick path in skills.js is what fires). The kit adds NO cast of its own — a second path would
//   spend a charge twice in one beat.
//   PRTS 颂乐音符 备注: "未阻挡敌人时发射的音符视为远程攻击…始终应用特性的80%倍率；阻挡敌人时发射的音符视为
//   近战攻击，即使阻挡目标死亡…也不会应用特性的80%倍率" — the scale comes from the target's blocked state, per
//   note. LOR-Y's 颂乐音符 adds "技能期间远程攻击不再降低攻击力" (the tables carry it in the talent's TEXT only,
//   no blackboard key → read from the composed record's text, and only when a module is on, i.e. on an elite).
// - T1 颂乐音符: every 【Ave Mujica】 operator on the field ignores def_penetrate_ratio of DEF and
//   magic_resist_penetrate_ratio of RES of the enemies IT damages, per note of hers, at most max_cnt layers (PRTS 备注
//   "无视防御与法抗的效果于每个Ave Mujica干员造成伤害时（伤害计算前）根据当前音符数量临时增加该干员的法术
//   穿透（百分比）与物理穿透（百分比）（直接加算）" → damage.js' `defIgnorePct` / `resIgnorePct`, added to the
//   DamageInfo at the 'hit' hook, which the mitigation reads afterwards; one note pool with one owner ⇒ exact layers, no
//   同名取最高 needed).
// - T2 毋畏遗忘 (`enable`, `attack_speed"): "攻击范围内干员攻击速度+attack_speed" — an aura over her range for every
//   deployed ally OPERATOR on it, her own tile included [ASSUMED: the clause says 攻击范围内干员, the selector does not
//   drop its owner]; the kits' non-stacking aura convention, the strongest source holds (as op-aphris.js 取样优化).
// - S1 新月的苏醒 (MANUAL, 攻击回复, 2 charges — "可充能2次，充能至最大层数时自动释放一次", the data's
//   `maxChargeTime`; skills.js' charges release at full meter): eight arts notes at atk_scale → atk_scale_8 × ATK
//   (80 % → 4 % at rank 7), played one after another (NOTE_STAGGER [ASSUMED: no source gives the tempo inside the fan]).
//   The cast replaces no attack: her 持续攻击 goes on beating meanwhile.
// - S2 满月的舞会 (MANUAL, 攻击回复, a timbre SWITCH — "可以切换钢琴（初始）或风琴音色演奏"): every cast takes the
//   voice she does not hold — 钢琴 ATK +attack@atk (+75 % at rank 7), its notes 物理 and fast (PIANO_SPEED — PRTS 备注
//   追踪移动 3.5) and, after a hit, they pass through: a PASSBY_RADIUS (0.8) collision sweeping on for
//   attack@passby_delay (0.5) s [ASSUMED: every enemy the corridor covers is hit once by it, never twice]; 风琴 ASPD
//   +attack@attack_speed (+110 at rank 7), its notes 法术 and slow (ORGAN_SPEED — PRTS 备注 1.0), gone on impact
//   ("【已命中】状态：不存在"). The voice outlives the cast (a buff of its own): her notes keep it until the next cast
//   switches it; both mods leave with her. Its Fever half (二连击) is not implemented (above).
// - S3 残月的余响 (MANUAL, 攻击回复, 25 s, its own 3-21 grid — a strict superset of her 3-12, so the data's
//   ACTIVE_RANGE trigger): 攻击范围扩大 and every beat plays BOTH timbres at once — 2 物理 notes at the highest-DEF
//   enemies and 2 法术 notes at the highest-RES ones, all at attack@atk_scale × ATK (180 % at rank 7): "各自演奏2个造成
//   相当于攻击力X%物理和法术伤害的音符，且分别追踪法术抗性和防御力最高的敌人" — both notes of a timbre take THAT one
//   enemy (the 备注's 分别 splits by timbre, not by rank on the field [ASSUMED: no source ranks the two notes apart]). Its `attack@attack_speed` is 0:
//   the organ's ASPD line belongs to S2's voice, not to this concert [ASSUMED: the text promises no ASPD change]. The
//   Fever half (成员致命伤不撤退) is not implemented (above).

import { num, talentBb, skillRec, moduleOn, up } from '../shared/tier1.js';
import { absoluteRangeKeys } from '../../../targeting.js';
import { COLS } from '../../../constants.js';
import { dirVec } from '../../../dir.js';

const S1 = 'skchr_oblvns_1';
const S2 = 'skchr_oblvns_2';
const S3 = 'skchr_oblvns_3';
/** 【Ave Mujica】: character_table teamId `mujica` (as op-headb2.js lists 【乌萨斯学生自治团】). */
const MUJICA = new Set(['char_4182_oblvns', 'char_4183_mortis', 'char_4184_dolris', 'char_4185_amoris', 'char_4186_tmoris']);
/** The kit's flight ceiling for a note (PRTS gives none; the slowest note crosses her 3-tile range in ~3 s). */
const NOTE_MAX_AGE = 5;
/** How far a note with nothing to hit drifts ahead before it fades (the engine needs a point; [ASSUMED] 4 tiles). */
const NOTE_AHEAD = 4;
/** PRTS 音符参数, every 追踪移动 speed (tiles/s): off-skill 2.0, S1 2.2, S2 piano 3.5 / organ 1.0, S3 1.3 ("技能期间
 *  音符（无论种类）…固定1.3速度…【已命中】状态：不存在" — S3's notes pierce NOTHING). */
const NOTE_SPEED = 2.0, BURST_SPEED = 2.2, PIANO_SPEED = 3.5, ORGAN_SPEED = 1.0, DUET_SPEED = 1.3;
/** PRTS S2 备注: the piano's 已命中 pass-by — a 0.8-radius collision moving on for passby_delay s. */
const PASSBY_RADIUS = 0.8;
/** PRTS S1 备注: the eight notes of one fan (a 3.75° step); the tempo between them is in no source [ASSUMED]. */
const NOTE_STAGGER = 0.12;
/** How many notes S1 plays: the text's 8, and the eight blackboards go with it. */
const S1_NOTES = 8;
/** T2's aura refresh and buff length (the kits' aura convention). */
const AURA_IV = 0.25, AURA_DUR = 0.4;
const VOICE_KEY = 'oblvns:voice';
const T2_KEY = 'oblvns:t2';

const bbOf = (chess, id) => skillRec(chess, id)?.bb ?? {};
const isMujica = (u) => !!u && u.kind === 'op' && MUJICA.has(u.def?.charId);
/** Her live notes: played until they land — 颂乐音符 counts them into penetration layers. */
const noteList = (unit) => (unit.mem.oblvnsNotes ?? (unit.mem.oblvnsNotes = []));
function dropNote(unit, note) {
  const l = unit.mem.oblvnsNotes;
  if (!l) return;
  const i = l.indexOf(note);
  if (i >= 0) l.splice(i, 1);
}
/** The 领主 80 % line for this note: a blocked target means melee (no scale); LOR-Y drops it while a skill runs. */
function noteScale(unit, target, noPenalty) {
  // PRTS 备注 verbatim: "阻挡敌人时发射的音符视为近战攻击，即使阻挡目标死亡，阻挡期间发射的音符攻击其他敌人时也
  // 不会应用特性的80%倍率" — what decides it is that SHE BLOCKS something, not which enemy the note lands on
  if (unit.blocking && unit.blocking.length) return 1;
  if (noPenalty && (unit.skill?.active || unit.mem.oblvnsAlwaysSkill)) return 1;
  return num(unit.profile?.rangedScale, 0.8);
}
/** The enemies of her current range, plus the ones she blocks outside it — the blocked first (领主 特性). */
function beatTargets(battle, unit) {
  const inRange = battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile);
  const out = (battle.blockedTargets(unit, unit.profile) || []).filter((e) => e && !inRange.includes(e));
  return out.length ? [...out, ...inRange] : inRange;
}
/** The enemies S3 plays at: its own 3-21 range (the skill range while it runs) and the ones she blocks. */
function concertTargets(battle, unit, grid) {
  const keys = grid && grid.length ? absoluteRangeKeys(grid, unit.tileR, unit.tileC, unit.dir, 0) : unit.rangeKeys;
  const inRange = battle.enemiesInKeys(keys, unit, unit.profile);
  const out = (battle.blockedTargets(unit, unit.profile) || []).filter((e) => e && !inRange.includes(e));
  return [...out, ...inRange];
}
/** Enemies by DEF / RES, highest first (S3's two trackers; ties: the nearer tile, then the id). */
function byStat(list, key) {
  return list.filter((e) => e.s && Number.isFinite(e.s[key]))
    .sort((a, b) => (b.s[key] - a.s[key]) || ((a.tileR * COLS + a.tileC) - (b.tileR * COLS + b.tileC)) || (a.id - b.id));
}

let noteSeq = 0;
/**
 * One note of hers (header): an attack in every sense — counted, recovering her 攻击回复 SP unless the skill says it is
 * not a plain attack, and dealing her attack damage with the 领主 80 % line on it. `pierce` = the piano's pass-by.
 */
function playNote(battle, unit, { scale, type, target, speed, isSkill = false, pierce = 0 }) {
  const note = { id: ++noteSeq };
  noteList(unit).push(note);
  const strike = (t) => {
    if (!t || !t.alive || !up(unit)) return;
    battle.dealDamage(unit, t, {
      amount: unit.s.atk * scale * noteScale(unit, t, unit.mem.oblvnsNoPenalty),
      type, isAttack: true, isSkill, tags: ['oblvns:note', isSkill ? 'skill' : 'attack'],
    });
  };
  const [dr, dc] = dirVec(unit.dir);
  battle.addProjectile({
    from: unit, target, to: target ? undefined : { x: unit.x + dc * NOTE_AHEAD, y: unit.y + dr * NOTE_AHEAD },
    speed, visual: 'arrow', source: unit, hitDead: true, maxAge: NOTE_MAX_AGE,
    onHit: (c) => {
      // PRTS 颂乐音符 备注 "丰川祥子命中目标的当个音符可计入音符数量": the note that strikes is still one of the
      // live ones, so it leaves the pool only AFTER its own hit — and a piano note stays alive through its pass-by
      if (c.target && c.target.alive) strike(c.target);
      if (!(pierce > 0)) { dropNote(unit, note); return; }
      const px = c.x, py = c.y;
      battle.after(pierce, () => {                        // 钢琴 "命中目标后穿过敌人": the box sweeps on
        for (const e of battle.foesInRadius(px + dc * 0.5, py + dr * 0.5, PASSBY_RADIUS, true)) strike(e);
        dropNote(unit, note);
      }, { owner: unit });
    },
  });
}

export default {
  char_4182_oblvns: (bb, chess) => {
    const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
    const b1 = bbOf(chess, S1), b2 = bbOf(chess, S2), b3 = bbOf(chess, S3);
    const s1 = skillRec(chess, S1), s3 = skillRec(chess, S3);
    const s3Grid = s3?.rangeGrid ?? null;
    // LOR-Y's 颂乐音符 line, which the tables carry in the talent's TEXT only (no blackboard key)
    const noPenalty = moduleOn(chess) && /技能期间远程攻击不再降低攻击力/.test(String(chess?.talents?.[0]?.desc ?? ''));
    // PRTS S2 备注 "携带此技能时，<Y模组>强化后的第一天赋始终将自身视为技能期间": with LOR-Y's upgraded T1 and S2
    // picked, her notes never take the ranged penalty, skill running or not
    const alwaysSkill = noPenalty && chess?.skill?.skillId === S2;
    const passby = num(b2['attack@passby_delay'], 0.5);

    /** S1 新月的苏醒: eight arts notes, atk_scale → atk_scale_8 (header). */
    function s1Burst(battle, unit) {
      for (let i = 0; i < S1_NOTES; i++) {
        const scale = num(i === 0 ? b1.atk_scale : b1['atk_scale_' + (i + 1)], 0);
        const play = () => {
          if (!up(unit) || battle.finished) return;
          playNote(battle, unit, { scale, type: 'arts', target: beatTargets(battle, unit)[0] ?? null, speed: BURST_SPEED, isSkill: true });
        };
        const at = i * NOTE_STAGGER;
        if (at <= 0) play(); else battle.after(at, play, { owner: unit });
      }
    }

    /** S3 残月的余响: two piano notes at the highest DEF, two organ notes at the highest RES (header). */
    function s3Concert(battle, unit) {
      const sc = num(b3['attack@atk_scale'], 1);
      const pool = concertTargets(battle, unit, s3Grid);
      // "各自演奏2个造成…物理和法术伤害的音符，且分别追踪法术抗性和防御力最高的敌人" — 分别 pairs the two lists in the
      // ORDER they are written: the PHYSICAL notes chase the enemy with the highest 法术抗性 (so its magic soak is
      // worthless against them), the ARTS notes the one with the highest 防御力. Both notes of a timbre take THAT enemy,
      // not the 1st / 2nd of the field. The S3 备注 gives the notes no 已命中 state: no piano pass-through here.
      const res = byStat(pool, 'res')[0] ?? null, def = byStat(pool, 'def')[0] ?? null;
      for (let i = 0; i < 2; i++) {
        playNote(battle, unit, { scale: sc, type: 'phys', target: res, speed: DUET_SPEED, isSkill: true });
        playNote(battle, unit, { scale: sc, type: 'arts', target: def, speed: DUET_SPEED, isSkill: true });
      }
    }

    /**
     * Her 持续攻击 beat (PRTS 术语 持续攻击; the rhythm of op-phenxi.js S3). ONE beat = ONE attack: the notes it plays
     * are not separate attacks — PRTS 攻击回复 "每次攻击回复1点技力" — and the attack the ENGINE would have made is the
     * one this counts (stats.attacks / lastAttackAt / skill.onAttackPerformed, which also paces the 攻速闸门).
     */
    function playBeat(battle, unit) {
      const id = unit.skill?.id ?? null;
      const duet = id === S3 && unit.skill.active;
      const first = beatTargets(battle, unit)[0] ?? null;
      unit.stats.attacks++;
      unit.lastAttackAt = battle.time;
      if (unit.skill) unit.skill.onAttackPerformed(first ? [first] : [], duet);
      if (duet) { s3Concert(battle, unit); return; }
      if (id === S2) {
        const piano = unit.mem.oblvnsVoice === 'piano';
        playNote(battle, unit, {
          scale: 1, type: piano ? 'phys' : 'arts', target: beatTargets(battle, unit)[0] ?? null,
          speed: piano ? PIANO_SPEED : ORGAN_SPEED, pierce: piano ? passby : 0,
        });
        return;
      }
      playNote(battle, unit, { scale: 1, type: 'phys', target: beatTargets(battle, unit)[0] ?? null, speed: NOTE_SPEED });
    }

    return {
      trait: { noAttack: true },      // her notes are played by this kit (header: 持续攻击), never by the attack loop
      skills: {
        [S1]: {
          kind: 'charges',
          charges: Math.max(1, num(s1?.maxChargeTime, 2)),   // 可充能2次: at full meter the engine releases it once
          onStart({ battle, unit }) { s1Burst(battle, unit); },
        },
        [S2]: {
          kind: 'instant',            // a switch: every cast takes the voice she does not hold (header)
          onStart({ battle, unit }) {
            const piano = unit.mem.oblvnsVoice !== 'piano';
            unit.mem.oblvnsVoice = piano ? 'piano' : 'organ';
            battle.removeBuff(unit, VOICE_KEY);
            battle.addBuff(unit, piano
              ? { key: VOICE_KEY, mods: { atkPct: num(b2['attack@atk']) }, tags: ['skill'] }
              : { key: VOICE_KEY, mods: { aspd: num(b2['attack@attack_speed']) }, tags: ['skill'] });
          },
        },
        [S3]: {
          kind: 'duration',
          duration: Math.max(0.01, num(s3?.duration, 25)),
          targeting: { rangeGrid: s3Grid },   // 3-21 over her 3-12 (the data's ACTIVE_RANGE trigger)
          onStart({ unit }) { unit.mem.oblvnsCd = unit.s.interval; },   // the concert starts with her next beat
        },
      },
      talents: [
        { install(battle, unit) { // 颂乐音符: per note of hers, 无视防御 / 法抗 on every 【Ave Mujica】 member's damage
          const dp = num(t0.def_penetrate_ratio), mr = num(t0.magic_resist_penetrate_ratio);
          const max = Math.max(1, num(t0.max_cnt, 10));
          if (!(dp > 0) && !(mr > 0)) return;
          battle.on('hit', (ctx) => {
            if (!ctx.dmg || ctx.dmg.type === 'element' || !isMujica(ctx.source)) return;
            const n = Math.min(max, noteList(unit).length);
            if (!(n > 0)) return;
            if (dp > 0) ctx.dmg.defIgnorePct = (ctx.dmg.defIgnorePct || 0) + dp * n;
            if (mr > 0) ctx.dmg.resIgnorePct = (ctx.dmg.resIgnorePct || 0) + mr * n;
          }, { owner: unit, priority: -10 });
        } },
        { install(battle, unit) { // 毋畏遗忘: 攻击范围内干员攻速+attack_speed (its Fever clause needs an engine state — header)
          const v = num(t1.attack_speed);
          if (!(num(t1.enable) > 0) || !(v > 0)) return;
          battle.every(AURA_IV, () => {
            if (!up(unit) || !unit.rangeKeySet) return;
            for (const a of battle.allyUnits) {
              if (a.kind !== 'op' || !up(a) || !unit.rangeKeySet.has(a.tileR * COLS + a.tileC)) continue;
              const cur = a.findBuff(T2_KEY);
              if (cur && cur.source !== unit && (cur.data?.v ?? 0) > v && cur.timeLeft > 0.05) continue;
              battle.addBuff(a, { key: T2_KEY, duration: AURA_DUR, mods: { aspd: v }, source: unit, data: { v }, tags: ['aura'] });
            }
          }, { owner: unit, immediate: true });
        } },
      ],
      install(battle, unit) {
        unit.mem.oblvnsVoice = 'piano';               // S2's initial timbre ("钢琴（初始）")
        unit.mem.oblvnsNoPenalty = noPenalty;
        unit.mem.oblvnsAlwaysSkill = alwaysSkill;
        unit.mem.oblvnsNotes = [];
        unit.mem.oblvnsCd = 0;
        // 持续攻击: one note per attack interval, target or none (header). The kit owns that rhythm — a stun / freeze /
        // sleep (canAct) and a 缴械 hold it exactly as the engine's own attack cooldown would; casting is skills.js'
        battle.on('tick', () => {
          if (!up(unit) || !unit.canAct || unit.s.flags.disarm) return;
          unit.mem.oblvnsCd = num(unit.mem.oblvnsCd) + battle.dt;
          if (unit.mem.oblvnsCd < unit.s.interval - 1e-9) return;
          unit.mem.oblvnsCd = 0;
          playBeat(battle, unit);
        }, { owner: unit });
        // PRTS 颂乐音符 备注 "自身退场时，清除所有不处于【追踪移动】状态的音符": her note pool goes with her, so no
        // 【Ave Mujica】 ally keeps stacking penetration on notes of a 丰川祥子 that is off the field
        battle.on('death', (c) => { if (c.unit === unit) unit.mem.oblvnsNotes = []; }, { owner: unit });
      },
    };
  },
};
