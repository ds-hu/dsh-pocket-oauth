// PWA 资源测试：3081 的 manifest 与图标必须在**认证门之前**可取，否则手机上永远装不了
// （Chromium 拿到登录页 HTML 当 manifest，判为不可安装）；同时证明这道豁免没有顺手把
// 认证门放宽——同一组请求打到 `/` 与 `/api` 仍然被拦。
//
// 另外覆盖认证统一后的两条行为：loopback 也要会话；loopback 仍是隐式 OAuth origin。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPocketProxy } from '../lib/proxy.mjs';
import { SESSION_COOKIE, sessionCookieValue, OAUTH_CALLBACK_PATH } from '../lib/oauth.mjs';
import { decodePng, ICONS, renderIconPixels } from '../scripts/build-pwa-icons.mjs';

// 包根用 fileURLToPath 取：URL.pathname 在 Windows 给 `/D:/…`，且会把空格/CJK 转义成 %20，
// 拼盘符的 hack 在含空格的路径上会直接失效。
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 假上游：回显一个可识别的 body，用来区分"透传到应用"和"被门拦下"。 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dsh-upstream:${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

/** 原始 http 请求（fetch 不能设 Host 头，也拿不到未解码的路径）。 */
function raw(port, { method = 'GET', path = '/', host = '127.0.0.1', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        location: res.headers.location,
        setCookie: res.headers['set-cookie'],
        body: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 带 OAuth 的代理；cfg 为可变配置对象（与 lib/index.js 的 auth 同形状）。 */
async function pwaProxy({ cfg, session = { key: 'sk-pwa' }, upstreamPort }) {
  return createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstreamPort },
    injectHtml: '',
    auth: {
      sessionKey: () => session.key,
      getConfig: () => cfg.value,
      saveConfig: (draft) => { cfg.value = draft; },
      bindUser: () => {},
    },
  });
}

const BOUND_CFG = () => ({
  value: {
    provider: 'gitee', clientId: 'cid', clientSecret: 'sec',
    callbackOrigins: ['https://pocket.example.com'],
    boundUid: '4242', boundLogin: 'alice',
  },
});

/** 合法会话 cookie 头。 */
function sessionHeaders(cfg, session) {
  return { cookie: `${SESSION_COOKIE}=${sessionCookieValue(cfg.value.boundUid, session.key)}` };
}

test('PWA：未登录时 manifest 也能取（非 loopback Host），且内容自洽', async () => {
  const up = await fakeUpstream();
  const cfg = BOUND_CFG();
  const session = { key: 'sk-pwa' };
  const proxy = await pwaProxy({ cfg, session, upstreamPort: up.port });
  try {
    const res = await raw(proxy.port, { host: 'pocket.example.com', path: '/manifest.webmanifest' });
    assert.equal(res.status, 200, 'manifest 必须在认证门之前可取（否则手机装不了）');
    assert.match(String(res.headers['content-type']), /^application\/manifest\+json/, '按 manifest 的 MIME 返回');
    const manifest = JSON.parse(res.text);
    assert.equal(manifest.name, 'DSH Pocket', '与 3080 的 DeepSeek Harness 区分开：两个入口可以并存');
    assert.equal(manifest.short_name, 'DSH Pocket');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone', '保留状态栏，不用 DSH 的 fullscreen');
    assert.equal(manifest.icons.length, 3, 'any 192 / any 512 / maskable 512');
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith('/pocket-icons/'), '图标走站内绝对路径');
      assert.equal(icon.type, 'image/png', 'Chromium 的安装判定要位图，SVG 不保险');
    }
    assert.ok(!/'https?:\/\//.test(res.text), 'manifest 里不能写死 host：换隧道域名不用改配置');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('PWA：manifest 声明的每个图标都可取，且是真正的 PNG', async () => {
  const up = await fakeUpstream();
  const cfg = BOUND_CFG();
  const proxy = await pwaProxy({ cfg, upstreamPort: up.port });
  try {
    const manifest = JSON.parse((await raw(proxy.port, { path: '/manifest.webmanifest' })).text);
    for (const icon of manifest.icons) {
      const res = await raw(proxy.port, { host: 'pocket.example.com', path: icon.src });
      assert.equal(res.status, 200, `图标 ${icon.src} 必须能取到`);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.deepEqual([...res.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${icon.src} 必须是 PNG`);
      assert.ok(res.body.length > 500, `${icon.src} 太小，可能是个空文件`);
      // IHDR：宽高必须与 manifest 声明的尺寸一致
      const width = res.body.readUInt32BE(16);
      const height = res.body.readUInt32BE(20);
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} 的实际尺寸与 manifest 不符`);
    }
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('PWA：图标白名单挡目录穿越与未知名字（都按 404 处理）', async () => {
  const up = await fakeUpstream();
  const proxy = await pwaProxy({ cfg: BOUND_CFG(), upstreamPort: up.port });
  try {
    for (const path of ['/pocket-icons/nope.png', '/pocket-icons/..%2fpackage.json', '/pocket-icons/']) {
      const res = await raw(proxy.port, { path });
      assert.equal(res.status, 404, `${path} 必须 404`);
      assert.ok(!res.text.includes('"name"'), '不能把 package.json 之类的文件漏出去');
    }
    // `..` 未编码时 URL 会先规范化成 `/package.json` —— 它已不在图标前缀下，
    // 于是落到下一道认证门（401）。两条路径都到不了文件系统，这正是要证明的。
    const normalized = await raw(proxy.port, { path: '/pocket-icons/../../package.json' });
    assert.equal(normalized.status, 401, '规范化后已不是图标请求，交给认证门');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('PWA：方法限制——HEAD 只回头，其余方法 405', async () => {
  const up = await fakeUpstream();
  const proxy = await pwaProxy({ cfg: BOUND_CFG(), upstreamPort: up.port });
  try {
    const head = await raw(proxy.port, { method: 'HEAD', path: '/manifest.webmanifest' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0, 'HEAD 不返回 body');
    assert.ok(Number(head.headers['content-length']) > 0, 'content-length 仍然给出长度');
    const post = await raw(proxy.port, { method: 'POST', path: '/manifest.webmanifest' });
    assert.equal(post.status, 405);
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('豁免只覆盖 PWA 资源：同一 Host 下 / 是登录页、/api 仍 401，带会话才透传', async () => {
  const up = await fakeUpstream();
  const cfg = BOUND_CFG();
  const session = { key: 'sk-pwa' };
  const proxy = await pwaProxy({ cfg, session, upstreamPort: up.port });
  try {
    const host = 'pocket.example.com';
    const page = await raw(proxy.port, { host, headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.text, /DSH Pocket/, '未登录的导航仍然是登录页');
    assert.ok(!page.text.includes('dsh-upstream'), '登录页不能把上游内容漏出去');
    const api = await raw(proxy.port, { host, path: '/api/x', headers: { accept: 'application/json' } });
    assert.equal(api.status, 401, 'API 未认证仍是 401（豁免没有放宽）');
    assert.equal(JSON.parse(api.text).error, 'unauthorized');
    const authed = await raw(proxy.port, { host, headers: sessionHeaders(cfg, session) });
    assert.equal(authed.status, 200);
    assert.match(authed.text, /dsh-upstream/, '带会话才透传到上游');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('登录页自身声明 manifest：手机第一次打开就能装', async () => {
  const up = await fakeUpstream();
  const proxy = await pwaProxy({ cfg: BOUND_CFG(), upstreamPort: up.port });
  try {
    const page = await raw(proxy.port, { host: 'pocket.example.com', headers: { accept: 'text/html' } });
    assert.match(page.text, /<link rel="manifest" href="\/manifest\.webmanifest">/, '登录页缺 manifest link 就不会出现安装入口');
    assert.match(page.text, /<meta name="theme-color" content="#4f6ef7">/);
    assert.match(page.text, /apple-touch-icon/, 'iOS 的"添加到主屏幕"只认 apple-touch-icon');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('PWA：没配置 OAuth 时 manifest 依然可取（安装不被初始化状态阻断）', async () => {
  const up = await fakeUpstream();
  const cfg = { value: null };
  const proxy = await pwaProxy({ cfg, upstreamPort: up.port });
  try {
    const res = await raw(proxy.port, { host: 'pocket.example.com', path: '/manifest.webmanifest' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.text).name, 'DSH Pocket');
    const page = await raw(proxy.port, { host: 'pocket.example.com', headers: { accept: 'text/html' } });
    assert.equal(page.status, 503, '未初始化时页面仍是 fail closed 的 503 指引页');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('认证统一：loopback 也要会话（不再是免认证旁路）', async () => {
  const up = await fakeUpstream();
  const cfg = BOUND_CFG();
  const session = { key: 'sk-pwa' };
  const proxy = await pwaProxy({ cfg, session, upstreamPort: up.port });
  try {
    const host = `127.0.0.1:${proxy.port}`;
    const anonymous = await raw(proxy.port, { host, headers: { accept: 'text/html' } });
    assert.equal(anonymous.status, 200);
    assert.match(anonymous.text, /DSH Pocket/, '本机未登录也应看到登录页');
    assert.ok(!anonymous.text.includes('dsh-upstream'), '本机不再是免认证旁路');
    const api = await raw(proxy.port, { host, path: '/api/x' });
    assert.equal(api.status, 401, '本机 API 也要会话');
    const authed = await raw(proxy.port, { host, headers: sessionHeaders(cfg, session) });
    assert.match(authed.text, /dsh-upstream/, '登录后本机照常透传');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('认证统一：loopback 即使不在白名单里也能发起登录（避免升级后自锁）', async () => {
  const up = await fakeUpstream();
  const cfg = BOUND_CFG(); // 白名单只有隧道域名
  const proxy = await pwaProxy({ cfg, upstreamPort: up.port });
  try {
    const host = `127.0.0.1:${proxy.port}`;
    const start = await raw(proxy.port, { host, path: '/pocket-oauth/start' });
    assert.equal(start.status, 302, '本机必须还能发起登录，否则改不了配置也进不去');
    const location = new URL(String(start.location));
    assert.equal(location.searchParams.get('redirect_uri'), `http://${host}${OAUTH_CALLBACK_PATH}`,
      'loopback 隐式 origin：redirect_uri 指向本机回调');
    // 反过来：非白名单的陌生域名不能借 loopback 那条配置通过校验
    const evil = await raw(proxy.port, { host: 'evil.example.com', path: '/pocket-oauth/start' });
    assert.equal(evil.status, 403, '白名单匹配看请求 Host，不看列表里有没有 loopback');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('迁移安全：初始化页保存时自动补上本机两条 origin（否则升级后本机登录会自锁）', async () => {
  const up = await fakeUpstream();
  const cfg = { value: null };
  const proxy = await pwaProxy({ cfg, upstreamPort: up.port });
  try {
    const host = `127.0.0.1:${proxy.port}`;
    const page = await raw(proxy.port, { host, path: '/pocket-setup' });
    const nonce = /<input type="hidden" name="nonce" value="([0-9a-f]+)">/.exec(page.text)?.[1];
    assert.ok(nonce, '初始化页带 nonce');
    const res = await raw(proxy.port, {
      method: 'POST', host, path: '/pocket-setup/save',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ nonce, client_id: 'cid', client_secret: 'sec', origins: 'https://pocket.example.com' }).toString(),
    });
    assert.equal(res.status, 303, '保存成功并跳去绑定');
    const saved = cfg.value.callbackOrigins;
    assert.ok(saved.includes('https://pocket.example.com'), '用户填的 origin 保留');
    assert.ok(saved.includes(`http://127.0.0.1:${proxy.port}`), '自动补 127.0.0.1（本机登录要用）');
    assert.ok(saved.includes(`http://localhost:${proxy.port}`), '自动补 localhost（浏览器常用别名）');
    assert.equal(new Set(saved).size, saved.length, '不产生重复');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('提交的图标与生成器输出一致（按像素比对，防止改了画法忘了重新生成）', () => {
  // 比像素而不是比字节：PNG 的 zlib 压缩输出会随 Node 版本变化，字节比对会在别的机器上
  // 无故变红；图标的真实内容是像素。
  for (const [name, { size, maskable }] of Object.entries(ICONS)) {
    const png = decodePng(readFileSync(join(ROOT, 'assets', 'pwa', name)));
    assert.equal(png.width, size, `${name} 宽度`);
    assert.equal(png.height, size, `${name} 高度`);
    const expected = renderIconPixels(size, { maskable });
    assert.ok(
      Buffer.from(png.pixels).equals(Buffer.from(expected)),
      `assets/pwa/${name} 的像素与 scripts/build-pwa-icons.mjs 不一致，重跑 node scripts/build-pwa-icons.mjs`,
    );
  }
});
