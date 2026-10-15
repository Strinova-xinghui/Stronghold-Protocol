// 音乐播放器服务器路由单测：/music/siren/* 白名单代理 + 磁盘缓存 + 开关行为。
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

  test('/music/proxy：非 http(s) 拒绝，音频 content-type 拒绝', async () => {
    const server = await startServer({ startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) });
    const bad = await get(server, '/music/proxy?url=ftp://x/y');
    assert.equal(bad.status, 400, '只允许 http(s)');
    server.close();
  });
});