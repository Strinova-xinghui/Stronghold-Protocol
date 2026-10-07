// public/js/ui/shadow.js — monitor 影子观战（自研，2026-10-06）
//
// 用途：让 /monitor 的「全功能观战」入口以「被看玩家」的视角渲染整个游戏界面，但**不占座位、不被计入
// 房间、不影响被看者**——服务端 m.monitor 把被看者的每一帧（m.public / m.private / 战场 / 结果）原样
// 转发给影子连接（已带 `_monitor: true` 标记）。
//
// 工作方式：
//   1. 入口 URL `/?shadow=CODE&as=PLAYERID`（由 monitor 页面生成）。
//   2. 启动时替换 store.me.playerId 为被看者 id —— 客户端的每一处 `useStore((s) => s.me.playerId)`
//      （棋盘归属、商店所有权、HUD）都会以他的视角渲染，无需改任何渲染代码。
//   3. 只读：所有发往服务器的 g.* / room.* 操作被吞掉（影子不是玩家，发出去也会被拒），
//      本地 UI 动作（打开详情、切换相机、看盟约）照常可用。
//
// 安全：影子身份只影响本浏览器的 store，不写回服务器；断线/关闭后无残留。

const PARAM = 'shadow';
const PARAM_AS = 'as';

/** 是否为影子观战入口；返回 { code, playerId } 或 null。 */
export function parseShadowParam(search) {
  try {
    const q = new URLSearchParams(search || '');
    const code = (q.get(PARAM) || '').trim().toUpperCase();
    const as = (q.get(PARAM_AS) || '').trim();
    if (!/^[A-Z0-9]{4}$/.test(code) || !as) return null;
    return { code, playerId: as };
  } catch { return null; }
}

/**
 * 安装影子模式。返回 { active, targetId, code } 供调用方判断。
 * @param {{ store: object, net: object, session?: object }} deps
 */
export function installShadow({ store, net }) {
  const cfg = parseShadowParam(typeof location !== 'undefined' ? location.search : '');
  if (!cfg) return { active: false };
  let targetId = cfg.playerId;

  // ① 身份改写：进入后立刻把 me.playerId 指向被看者 → 渲染视角切换
  const applyIdentity = () => {
    const me = store.get().me || {};
    if (me.playerId !== targetId) store.set({ me: { ...me, playerId: targetId, shadow: true } });
  };
  applyIdentity();

  // ② 只读屏蔽：影子不是玩家，任何操作都不该发到服务器（发了也会被拒，且可能污染真实对局）
  const BLOCKED = /^(g\.|room\.(create|join|ready|setDifficulty|addBot|removeBot|kick|start|loadout|skins|spectate|removeSpectator|leave)|m\.monitor$)/;
  const rawSend = net.send.bind(net);
  net.send = (t, fields) => {
    if (typeof t === 'string' && BLOCKED.test(t) && t !== 'm.monitor') return undefined;
    return rawSend(t, fields);
  };
  const rawRequest = net.request.bind(net);
  net.request = (t, fields, opts) => {
    if (typeof t === 'string' && BLOCKED.test(t)) return Promise.resolve({ t: 'ok', _shadowBlocked: true });
    return rawRequest(t, fields, opts);
  };

  // ③ 生命周期：welcome 后订阅目标；目标切换/结束则退出影子
  const subscribe = () => {
    try { net.send('m.monitor', { code: cfg.code, targetPlayerId: targetId }); } catch { /* ignore */ }
  };
  net.on('welcome', () => { applyIdentity(); subscribe(); });
  // 服务端确认帧（m.private 带 _monitor）到达时刷新身份（防止 welcome 覆盖）
  net.on('m.private', (msg) => { if (msg && msg._monitor && msg.playerId && msg.playerId !== targetId) { targetId = msg.playerId; applyIdentity(); } });

  window.addEventListener('beforeunload', () => {
    try { net.send('m.monitor', { code: cfg.code, targetPlayerId: null }); } catch { /* ignore */ }
  });

  return { active: true, targetId, code: cfg.code };
}
