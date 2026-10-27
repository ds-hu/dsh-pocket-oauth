// PWA 资源：pocket 自己的一份 manifest + 图标，**在认证门之前**提供。
//
// 为什么不能沿用 DSH 的 manifest（issue：3081 装不上）：
//   - 3080 是静态文件服务器，`/manifest.webmanifest` 无条件 200，所以浏览器总能安装；
//   - 3081 是认证代理，未登录时**所有**路径都被门挡成登录页 HTML（含 manifest 与图标）。
//     Chromium 拿到 text/html 的"manifest"必然判为不可安装，而登录页本身又没有
//     <link rel=manifest> —— 于是手机上永远装不了。
// 所以这里给 3081 一套自己的、无认证的 PWA 资源：任何入口（loopback / 局域网 / 隧道）
// 都能装，装完是 "DSH Pocket" 而不是 3080 的 "DeepSeek Harness"，两者互不覆盖。
//
// 全部用 `/` 开头的站内绝对路径，不写死 host —— 同一份 manifest 在隧道域名、局域网 IP、
// localhost 上都成立，换地址不用重新配置。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** manifest 的站内路径：DSH 页面里 `<link rel="manifest" href="./manifest.webmanifest">` 正指向它。 */
export const PWA_MANIFEST_PATH = '/manifest.webmanifest';
/** 图标前缀：表外名字一律 404（天然挡住 `..` 穿越）。 */
export const PWA_ICON_PREFIX = '/pocket-icons/';

/** 图标清单：名字 → 生成参数（见 scripts/build-pwa-icons.mjs）。 */
const ICON_NAMES = ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png'];

/** 图标缓存：首次请求时读盘（安装物里 assets/ 随包发布），读不到就是 404 而不是崩进程。 */
const iconCache = new Map();

function iconPath(name) {
  return fileURLToPath(new URL(`../assets/pwa/${name}`, import.meta.url));
}

/**
 * 取一个图标的字节；名字不在清单里或文件缺失 → null。
 * @param {string} name
 * @returns {Buffer|null}
 */
export function pwaIcon(name) {
  if (!ICON_NAMES.includes(name)) return null;
  if (iconCache.has(name)) return iconCache.get(name);
  let buf = null;
  try {
    buf = readFileSync(iconPath(name));
  } catch { /* 缺文件：当作没有（404），不影响代理其余功能 */ }
  iconCache.set(name, buf);
  return buf;
}

/**
 * pocket 的 manifest。
 * - display: standalone（不用 DSH 的 fullscreen：手机上保留状态栏，更像一个应用而不是全屏游戏）
 * - start_url/scope/id 都是 `/`：安装后从根进，登录与否由代理的门决定
 * - 名称与 3080 的 "DeepSeek Harness" 区分开，两个入口可以并存
 */
export function pwaManifest() {
  return {
    id: '/',
    name: 'DSH Pocket',
    short_name: 'DSH Pocket',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f3f4f6',
    theme_color: '#4f6ef7',
    icons: [
      { src: `${PWA_ICON_PREFIX}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${PWA_ICON_PREFIX}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${PWA_ICON_PREFIX}maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/**
 * 注入/自绘页面共用的 PWA 头部片段。
 *
 * 一处定义两处用：
 *   1. pageHtml()（登录页、setup 页、各种提示页）—— 没有它，登录页上的"安装"入口不存在；
 *   2. DEFAULT_INJECT（注入 DSH 自己的页面）—— iOS 的"添加到主屏幕"只认 apple-touch-icon，
 *      而 Android/桌面走 manifest（DSH 页面本来就有 manifest link，这里重复一条无害：
 *      同一个 URL，且浏览器取文档里第一条即我们的）。
 */
export const PWA_HEAD = `<link rel="manifest" href="${PWA_MANIFEST_PATH}">
<meta name="theme-color" content="#4f6ef7">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="DSH Pocket">
<link rel="apple-touch-icon" href="${PWA_ICON_PREFIX}apple-touch-icon.png">`;

/**
 * 处理 manifest / 图标请求；命中返回 true（调用方不要再往下走认证与转发）。
 *
 * 这两个路径是**故意公开**的：manifest 与图标不含任何会话信息，浏览器安装时也不会带
 * 认证上下文。真正的访问控制在它们之后那道门里。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname 已解析的路径（不含 query）
 * @returns {boolean} 是否已处理
 */
export function handlePwaRequest(req, res, pathname) {
  if (pathname !== PWA_MANIFEST_PATH && !pathname.startsWith(PWA_ICON_PREFIX)) return false;

  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('method not allowed');
    return true;
  }

  if (pathname === PWA_MANIFEST_PATH) {
    const body = Buffer.from(JSON.stringify(pwaManifest(), null, 2), 'utf8');
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'content-length': String(body.length),
      // 不带 max-age：manifest 是身份的一部分，改了要立刻生效；体积只有几百字节
      'cache-control': 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : body);
    return true;
  }

  const icon = pwaIcon(pathname.slice(PWA_ICON_PREFIX.length));
  if (icon === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('not found');
    return true;
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': String(icon.length),
    'cache-control': 'public, max-age=604800',
  });
  res.end(method === 'HEAD' ? undefined : icon);
  return true;
}
