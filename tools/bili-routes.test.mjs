// B 站本地中转路由单测（player/external-sources，2026-10-16）：/music/bili/{info,search,audio}。
// fetch 桩按 URL 分派：view / search/type / playurl / CDN 下载。缓存目录用后清理。
// 用法: node --test --test-concurrency=1 tools/bili-routes.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequestHandler } from '../server/http/routes.js';

const CACHE = path.resolve('.cache', 'music', 'bili');
const LOG = { warn() {}, error() {}, info() {} };
const VIEW = { code: 0, data: { bvid: 'BV1TESTTEST', aid: 1, title: '测试曲', owner: { name: 'UP测试' }, pic: 'http://i0.hdslb.com/a.jpg', duration: 10, pages: [{ page: 1, part: 'P1', cid: 123, duration: 10 }, { page: 2, part: 'P2', cid: 124, duration: 11 }] } };
const SEARCH = { code: 0, data: { result: [{ bvid: 'BV1SEARCHXX', type: 'video', title: '<em>关键词</em>命中', author: 'A君', duration: '1:30', pic: '//i0.hdslb.com/p.jpg@1280w_720h' }, { type: 'bangumi' }] } };
const PLAYURL = { code: 0, data: { durl: [{ url: 'https://upos-sz-mirrorcos.bilivideo.com/hello.mp4?mid=1&deadline=99', size: 5 }] } };

function makeFetch(st) {
  return async (url, opts) => {
    st.calls.push({ url: String(url), headers: (opts && opts.headers) || {} });
    if (String(url).includes('/x/web-interface/view')) return { status: 200, json: async () => (st.view !== undefined ? st.view : VIEW) };
    if (String(url).includes('/x/web-interface/search/type')) return { status: 200, json: async () => st.search || SEARCH };
    if (String(url).includes('/x/player/playurl')) return { status: 200, json: async () => st.playurl || PLAYURL };
    if (String(url).includes('bilivideo.com/hello.mp4')) {
      if (st.cdnStatus) return { status: st.cdnStatus, headers: new Map(), body: null };
      const len = st.cdnLen != null ? st.cdnLen : 5;
      return { status: 200, headers: new Map([['content-length', String(len)]]), body: (async function* () { yield Buffer.from('HELLO'); })() };
    }
    return { status: 404, json: async () => ({ code: -1 }) };
  };
}

function startServer(enabled) {
  const handler = createRequestHandler({
    serveStatic: async (req, res) => { res.writeHead(404); res.end('no static'); },
    health: { startedAt: Date.now(), customRules: () => ({ music: enabled ? { enabled: true } : null }) },
    log: LOG,
  });
  const server = http.createServer(handler);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}
function get(server, p) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('/music/bili/*', () => {
  const origFetch = globalThis.fetch;
  let st;
  before(() => { fs.rmSync(CACHE, { recursive: true, force: true }); });
  after(() => { globalThis.fetch = origFetch; fs.rmSync(CACHE, { recursive: true, force: true }); });

  test('开关关闭：/music/bili/* 落回静态 404', async () => {
    st = { calls: [] }; globalThis.fetch = makeFetch(st);
    const server = await startServer(false);
    const r = await get(server, '/music/bili/info?url=BV1TESTTEST');
    assert.equal(r.status, 404);
    server.close();
  });

  test('info：BV 输入 → 元数据 + 分 P；Referer 注入', async () => {
    st = { calls: [] }; globalThis.fetch = makeFetch(st);
    const server = await startServer(true);
    const r = await get(server, '/music/bili/info?url=BV1TESTTEST');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(j.bvid, 'BV1TESTTEST');
    assert.equal(j.pages.length, 2);
    const call = st.calls.find((c) => c.url.includes('/view'));
    assert.equal(call.headers.Referer, 'https://www.bilibili.com/', '服务器注入 B 站 Referer');
    // 缓存命中：再来一次不再打外网
    const n = st.calls.length;
    const r2 = await get(server, '/music/bili/info?url=BV1TESTTEST');
    assert.equal(r2.status, 200);
    assert.equal(st.calls.length, n, 'view 走缓存');
    server.close();
  });

  test('info：非法输入 400；上游 code!=0 → 502', async () => {
    st = { calls: [], view: { code: -404 } }; globalThis.fetch = makeFetch(st);
    const server = await startServer(true);
    assert.equal((await get(server, '/music/bili/info?url=notanid')).status, 400);
    const r = await get(server, '/music/bili/info?url=BV1MISSING');
    assert.equal(r.status, 502);
    server.close();
  });

  test('search：stripHtml + 时长换算 + pic 去后缀', async () => {
    st = { calls: [], search: SEARCH }; globalThis.fetch = makeFetch(st);
    const server = await startServer(true);
    const r = await get(server, '/music/bili/search?kw=' + encodeURIComponent('关键词'));
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.list.length, 1, '过滤非 video 条目');
    assert.equal(j.list[0].title, '关键词命中');
    assert.equal(j.list[0].duration, 90);
    assert.equal(j.list[0].pic, 'https://i0.hdslb.com/p.jpg');
    server.close();
  });

  test('audio：playurl(durl) → 带 Referer 拉 CDN → mp4 转发', async () => {
    st = { calls: [] }; globalThis.fetch = makeFetch(st);
    const server = await startServer(true);
    const r = await get(server, '/music/bili/audio?bvid=BV1TESTTEST&p=2');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.toString(), 'HELLO');
    const call = st.calls.find((c) => c.url.includes('hello.mp4'));
    assert.equal(call.headers.Referer, 'https://www.bilibili.com/', 'CDN 拉流带 B 站 Referer');
    server.close();
  });

  test('audio：CDN 403 → 502；超 50MB → 413；playurl 拒绝 → 502', async () => {
    st = { calls: [], cdnStatus: 403 }; globalThis.fetch = makeFetch(st);
    let server = await startServer(true);
    assert.equal((await get(server, '/music/bili/audio?bvid=BV1TESTTEST')).status, 502);
    server.close();
    st = { calls: [], cdnLen: 60 * 1024 * 1024 }; globalThis.fetch = makeFetch(st);
    server = await startServer(true);
    assert.equal((await get(server, '/music/bili/audio?bvid=BV1TESTTEST')).status, 413);
    server.close();
    st = { calls: [], playurl: { code: -352 } }; globalThis.fetch = makeFetch(st);
    server = await startServer(true);
    assert.equal((await get(server, '/music/bili/audio?bvid=BV1TESTTEST')).status, 502);
    server.close();
  });

  test('audio：陌生域名直链被拒（白名单外）', async () => {
    st = { calls: [], playurl: { code: 0, data: { durl: [{ url: 'https://evil.example.com/x.mp4', size: 5 }] } } };
    globalThis.fetch = makeFetch(st);
    const server = await startServer(true);
    assert.equal((await get(server, '/music/bili/audio?bvid=BV1TESTTEST')).status, 502);
    server.close();
  });
});
