// 音乐播放器服务器路由单测：/music/siren/* 白名单代理 + 磁盘缓存 + 开关行为。
// （/music/proxy 兜底路由已随外部源移除。）
// 真实网络不可用的测试环境用 node:test 的 mock（fetch 桩）。
// 用法: node --test tools/music-routes.test.mjs
import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequestHandler } from '../server/http/routes.js';

const CACHE = path.resolve('.cache', 'music');
const LOG = { warn() {}, error() {}, info() {} };

function startServer(health) {
  const handler = createRequestHandler({
    serveStatic: async (req, res, p) => { res.writeHead(404); res.end('no static'); },
    health,
    log: LOG,
  });
  const server = http.createServer(handler);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

function get(server, p) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
}

describe('音乐播放器路由 /music/*', () => {
  const origFetch = globalThis.fetch;
  before(() => { try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* ignore */ } });
  after(() => {
    globalThis.fetch = origFetch;
    try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('开关关闭：/music/* 落回静态（404）', async () => {
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: null }) });
    const r = await get(server, '/music/siren/albums');
    assert.equal(r.status, 404, 'music 关闭 = 原版无播放器');
    server.close();
  });

  test('开关开启 + fetch 桩：albums 代理成功并落缓存', async () => {
    globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ code: 0, data: [{ cid: '1', name: 'T' }] }) });
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) });
    const r = await get(server, '/music/siren/albums');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.code, 0);
    assert.ok(Array.isArray(j.data), '透传上游 JSON');
    // 缓存文件落盘
    assert.ok(fs.existsSync(path.join(CACHE, 'albums.json')), '元数据已缓存');
    // 第二次请求命中缓存（fetch 桩换成抛错，仍然成功）
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    const r2 = await get(server, '/music/siren/albums');
    assert.equal(r2.status, 200, '缓存命中不发外网');
    server.close();
  });

  test('白名单：未列出的路径 404，非法 cid 400/404', async () => {
    globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ code: 0, data: [] }) });
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) });
    const a = await get(server, '/music/siren/evil/../../etc');
    assert.ok(a.status >= 400, '路径穿越类一律拒绝');
    const b = await get(server, '/music/siren/album/!!!bad!!/detail');
    assert.ok(b.status >= 400, '非法 cid 拒绝');
    server.close();
  });

  test('专辑详情：带 /detail 与不带 /detail 都代理（线上旧客户端兼容），同一缓存', async () => {
    let calls = 0;
    globalThis.fetch = async (url) => { calls++; return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: '8913', name: 'A', songs: [] } }) }; };
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) });
    const a = await get(server, '/music/siren/album/8913/detail');
    assert.equal(a.status, 200, '带 /detail 必须 200（点专辑展开的全部）');
    const b = await get(server, '/music/siren/album/8913');
    assert.equal(b.status, 200, '不带 /detail 也 200（两种客户端形态互不打架）');
    assert.equal(calls, 1, '同一份缓存：第二次不再打外网');
    server.close();
  });

  test('搜索：/music/siren/search?kw= 代理上游 keyword=；空 kw 400；非法路径 404', async () => {
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ code: 0, data: { albums: { list: [{ cid: '1', name: 'X' }], end: true } } }) }; };
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) });
    const a = await get(server, '/music/siren/search?kw=' + encodeURIComponent('日常'));
    assert.equal(a.status, 200);
    assert.ok(seen[0].includes('keyword=%E6%97%A5%E5%B8%B8'), 'kw 映射为上游 keyword：' + seen[0]);
    const empty = await get(server, '/music/siren/search');
    assert.equal(empty.status, 400, '空关键词直接 400，不打外网');
    const evil = await get(server, '/music/siren/search?kw=x&evil=1&url=http://169.254.169.254');
    assert.equal(evil.status, 200, '多余参数被忽略（只取 kw）');
    assert.ok(!seen.some((u) => u.includes('169.254')), '绝不透传任意参数');
    const nope = await get(server, '/music/siren/whatever');
    assert.equal(nope.status, 404);
    server.close();
  });
});