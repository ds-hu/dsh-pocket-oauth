// 打包结构测试：一个插件包（远程操控）+ 两个子包（手机端 WebUI / 弱网传输优化）。
//
// 两个子包分别由 mobile/（dsh-pocket-mobile）与 transport/（dsh-pocket-transport）交付：
// 各自声明 dsh.client，客户端半边由 client/build.mjs 打包成 <子包>/client/client.js。
// 这里固化的是「交付形态与可解析性」的那部分不变量：
//
//   - cordis.patch.yml 三条 row：三个**裸包名**、id 稳定（面板开关写的就是这三个 id）；
//   - 根 manifest：files 带上 mobile/ 与 transport/、postinstall 建链、不再有 file:/bundled 依赖；
//   - 子包 manifest：声明 dsh.client 与 ./client 产物入口、locale 元数据与版本号；
//   - 移动端实现（mobile/client/**）与弱网传输实现（transport/client/**）源码与产物齐全；
//   - **打包不变量**：真实 `npm pack` 产物里带着两个子包，且每条 row 的裸包名能从
//     解包后的包锚点解析到（DSH 的 packageDirFromAnchor 用的就是这个 Node 原语）；
//   - 三个客户端产物各归各的：远程操控产物不含移动端/传输标记，移动端产物不含自愈器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';
import {
  SUBPACKAGES,
  ensureSubpackageLinks,
  packageRoot as scriptPackageRoot,
  subpackageLink,
} from '../scripts/link-subpackages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
const mobileManifest = JSON.parse(readFileSync(join(root, 'mobile', 'package.json'), 'utf8'));
const transportManifest = JSON.parse(readFileSync(join(root, 'transport', 'package.json'), 'utf8'));
const transportPatch = readFileSync(join(root, 'transport', 'cordis.patch.yml'), 'utf8');

/** cordis.patch.yml 里 `- insert:` 列表内的 row（id + name），按出现顺序。
 *
 *  只取 insert 列表：文件**顶层**的 `- id: ...` 条目是"覆盖别的 bundle 已有行"的补丁
 *  （弱网心跳在 transport/cordis.patch.yml），它们不是本 bundle 插入的 row，因此既不参与
 *  "三条 row"的断言，也不该被要求能从包锚点解析到——那个包由 dsh-base 提供。 */
function patchRows() {
  const at = patch.indexOf('- insert:');
  if (at < 0) return [];
  const body = patch.slice(at);
  const end = body.slice(1).search(/\n(?=\S)/);
  const block = end < 0 ? body : body.slice(0, end + 1);
  return [...block.matchAll(/-\s*id:\s*([^\s#]+)\s*\n\s*name:\s*([^\s#]+)/g)].map(([, id, name]) => ({ id, name }));
}

/** 某个 patch 文件顶层的覆盖型补丁条目 id（`- id:` + `config:`，不带 name 就不是本 bundle 的 row）。 */
function overridePatchIds(text) {
  const at = text.indexOf('- insert:');
  const head = at < 0 ? text : text.slice(0, at);
  return [...head.matchAll(/^-\s*id:\s*([^\s#]+)/gm)].map(([, id]) => id);
}

// ── bundle patch：三条 row ───────────────────────────────────────────────────

test('cordis.patch.yml：一个 bundle、三条 row，都是裸包名', () => {
  const rows = patchRows();
  assert.deepEqual(rows, [
    { id: 'dsh-pocket', name: 'dsh-pocket' },
    { id: 'dsh-pocket-mobile', name: 'dsh-pocket-mobile' },
    { id: 'dsh-pocket-transport', name: 'dsh-pocket-transport' },
  ], '三条 row：远程操控 + 手机端 WebUI + 弱网传输（独立客户端包；id/name 稳定 → 面板开关覆盖在升级后依然生效）');
  // 行 id 是面板开关写 disabled 覆盖的键：必须唯一
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
  for (const row of rows) {
    assert.ok(!row.name.includes('/'), `${row.name} 必须是裸包名：带 "/" 的行名解析不到包`);
  }
  assert.deepEqual(overridePatchIds(patch), [], 'row 插入文件里不再有跨 bundle 的顶层覆盖（已移入 transport 子包）');
  // 组合补丁清单：root patch + transport 子包 patch 一起组成这个 bundle 的补丁层
  assert.deepEqual(pkg.dsh.bundle.patch, ['./cordis.patch.yml', './transport/cordis.patch.yml'],
    'dsh.bundle.patch 必须同时引入弱网传输子包的组合补丁');
});

test('transport/cordis.patch.yml：网关心跳放宽（组合补丁属于弱网传输组件）', () => {
  assert.deepEqual(overridePatchIds(transportPatch), ['typert-gateway'], '顶层覆盖条目只有 typert-gateway 一条');
  assert.match(transportPatch, /-\s*id:\s*typert-gateway/, '必须覆盖 typert-gateway 行');
  assert.match(transportPatch, /websocketHeartbeatIntervalMs:\s*10000/, 'WebSocket 心跳间隔放宽至 10000ms');
  assert.match(transportPatch, /streamInboxBytes:\s*1048576/, '流收件箱缓冲放宽至 1 MiB');
  // name 是守卫：applyEntryPatches 只在补丁带 name 时才校验，不写就可能把 config 套到别的插件上
  assert.match(transportPatch, /-\s*id:\s*typert-gateway\s*\n\s*name:\s*'@deepseek-ai\/dsh-api-gateway'/,
    '覆盖必须带 name 守卫（id 被别的包占用时退化成 warn + skip，而不是改错插件）');
  assert.ok(transportManifest.files.includes('cordis.patch.yml'), '组合补丁必须随子包发布');
});

// ── 根 manifest：子包随包发布 + postinstall 建链 ─────────────────────────────

test('根 manifest：files 带两个子包、postinstall 建链，且没有 file:/bundled 依赖', () => {
  assert.ok(pkg.files.includes('mobile'), 'files 必须带上 mobile：子包靠它进安装物');
  assert.ok(pkg.files.includes('transport'), 'files 必须带上 transport：子包靠它进安装物');
  assert.equal(pkg.scripts.postinstall, 'node scripts/link-subpackages.mjs', 'postinstall 是子包的交付机制');
  // 这三种写法都被证明到不了安装态，回潮即回归：
  for (const name of ['dsh-pocket-mobile', 'dsh-pocket-transport']) {
    assert.equal(pkg.dependencies[name], undefined,
      `file:./... 会被 pnpm 相对 profile 目录解析并让整个安装失败（ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND）：${name}`);
  }
  assert.equal(pkg.bundledDependencies, undefined,
    'bundledDependencies 只被 pnpm 记成元数据，子包不进依赖图（也就没人装它）');
  assert.equal(pkg.optionalDependencies, undefined, 'optionalDependencies 的 file: 会被 pnpm 静默丢弃');
  assert.equal(pkg.exports['./client'], './client/client.js', '根包客户端产物 = 远程操控');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(typeof pkg.exports['./lib/*'], 'string', 'exports["./lib/*"]：子包复用共享层（DOM 契约 / 传输枢纽 / 剪贴板）');
  assert.equal(pkg.exports['./mobile'], undefined, '不再有 ./mobile 子路径行名（子路径不贡献客户端模块）');
  assert.equal(pkg.exports['./transport'], undefined, '不再有 ./transport 子路径行名（子路径不贡献客户端模块）');
});

test('postinstall 脚本：链接指向包内子包目录，且解析出的包根与 manifest 一致', () => {
  assert.equal(resolve(scriptPackageRoot), resolve(root), 'packageRoot 必须解析到包根（postinstall 的 cwd 未必可靠）');
  assert.ok(existsSync(join(root, 'scripts', 'link-subpackages.mjs')), 'postinstall 脚本必须随包发布');
  assert.deepEqual(SUBPACKAGES.map((s) => [s.name, s.dir]), [
    ['dsh-pocket-mobile', 'mobile'],
    ['dsh-pocket-transport', 'transport'],
  ], '子包清单：包名 ↔ 包内目录一一对应');
  for (const sub of SUBPACKAGES) {
    assert.equal(subpackageLink(sub).target, join(root, sub.dir));
  }
});

// ── 子包 manifest：移动端 WebUI 客户端组件 ──────────────────────────────

test('mobile/package.json：声明 dsh.client 与 ./client 客户端产物入口', () => {
  assert.equal(mobileManifest.name, 'dsh-pocket-mobile');
  assert.ok(mobileManifest.description && mobileManifest.description.length > 0, '面板组件行需要描述');
  assert.deepEqual(mobileManifest.dsh, {
    client: {
      platform: 'web',
      inject: ['slots', 'layout'],
    },
  }, '声明 dsh.client：DSH 判定它是客户端包（只依赖真正用到的 slots / layout）');
  assert.equal(mobileManifest.exports['.'], './index.js');
  assert.equal(mobileManifest.exports['./client'], './client/client.js', '客户端产物入口');
  assert.equal(mobileManifest.exports['./package.json'], './package.json');
  assert.equal(mobileManifest.exports['./locale/*'], './locale/*', '面板行的标题/描述靠它解析');
  assert.ok(existsSync(join(root, 'mobile', 'client', 'client.js')), 'mobile/client/client.js 产物必须存在');
  assert.equal(mobileManifest.version, pkg.version, 'mobile 子包版本必须与根包一致（同步由发版插件负责）');
});

test('transport/package.json：声明 dsh.client 与 ./client 客户端产物入口', () => {
  assert.equal(transportManifest.name, 'dsh-pocket-transport');
  assert.ok(transportManifest.description && transportManifest.description.length > 0, '面板组件行需要描述');
  assert.deepEqual(transportManifest.dsh, {
    client: {
      platform: 'web',
      inject: ['slots'],
    },
  }, '声明 dsh.client：DSH 判定它是客户端包（自愈器/状态条只需要 slots）');
  assert.equal(transportManifest.exports['.'], './index.js');
  assert.equal(transportManifest.exports['./client'], './client/client.js', '客户端产物入口');
  assert.equal(transportManifest.exports['./package.json'], './package.json');
  assert.equal(transportManifest.exports['./locale/*'], './locale/*', '面板行的标题/描述靠它解析');
  assert.ok(existsSync(join(root, 'transport', 'client', 'client.js')), 'transport/client/client.js 产物必须存在');
  assert.equal(transportManifest.version, pkg.version, 'transport 子包版本必须与根包一致（同步由发版插件负责）');
});

test('子包 locale 元数据：面板标题/描述（zh/en 通过包名解析）', () => {
  for (const dir of ['mobile', 'transport']) {
    for (const lang of ['zh', 'en']) {
      const file = join(root, dir, 'locale', `${lang}.json`);
      assert.ok(existsSync(file), `${dir}/locale/${lang}.json 必须存在`);
      const meta = JSON.parse(readFileSync(file, 'utf8')).meta;
      assert.ok(meta.title && meta.description, `${dir}/${lang}.json 需要 meta.title 与 meta.description`);
    }
  }
});

// ── 移动端实现完整性 ─────────────────────────────────────────────────────────

test('移动端实现：源码与客户端产物结构完整', () => {
  assert.ok(existsSync(join(root, 'mobile', 'client', 'index.jsx')), 'mobile/client/index.jsx 存在');
  assert.ok(existsSync(join(root, 'mobile', 'client', 'client.js')), 'mobile/client/client.js 存在');
  assert.ok(existsSync(join(root, 'mobile', 'client', 'responsive-shell.js')), 'responsive-shell.js 存在');
  assert.ok(existsSync(join(root, 'mobile', 'client', 'settings-adapter.js')), 'settings-adapter.js 存在');
  assert.ok(existsSync(join(root, 'mobile', 'client', 'styles.js')), 'styles.js 存在（移动端样式的唯一来源）');
  const bundle = readFileSync(join(root, 'mobile', 'client', 'client.js'), 'utf8');
  assert.ok(bundle.includes('id: "dsh-pocket-mobile"'), 'mobile bundle loader id 正确');
  assert.ok(bundle.includes('var React = require("react")'), 'mobile bundle 注入 React');
  assert.ok(bundle.includes('dsh-mobile-sidebar-backdrop'), 'mobile bundle 包含抽屉遮罩');
  assert.ok(bundle.includes('data-mobile-settings-view'), 'mobile bundle 包含两级设置导航');
  // 弱网能力已抽到 transport 组件：移动端产物不得再夹带自愈器/状态条（否则关掉传输组件也关不掉）
  assert.ok(!bundle.includes('createSessionHealer'), 'mobile bundle 不应包含会话自愈器');
  assert.ok(!bundle.includes('dsh-pocket-transport-banner'), 'mobile bundle 不应包含连接状态条');
});

test('弱网传输实现：源码与客户端产物结构完整', () => {
  assert.ok(existsSync(join(root, 'transport', 'index.js')), 'transport/index.js 存在（宿主半边）');
  assert.ok(existsSync(join(root, 'transport', 'client', 'index.jsx')), 'transport/client/index.jsx 存在');
  assert.ok(existsSync(join(root, 'transport', 'client', 'session-healer.js')), 'session-healer.js 存在');
  assert.ok(existsSync(join(root, 'transport', 'client', 'styles.js')), 'styles.js 存在（弱网样式唯一来源）');
  const bundle = readFileSync(join(root, 'transport', 'client', 'client.js'), 'utf8');
  assert.ok(bundle.includes('id: "dsh-pocket-transport"'), 'transport bundle loader id 正确');
  assert.ok(bundle.includes('var React = require("react")'), 'transport bundle 注入 React');
  assert.ok(bundle.includes('dsh-pocket-transport-banner'), 'transport bundle 包含连接状态条');
  assert.ok(bundle.includes('banner-button'), 'transport bundle 包含状态条的「立即重连」入口');
  assert.ok(bundle.includes('data-phase'), 'transport bundle 包含 settling 输入区常驻样式');
});

test('子包宿主：弱网传输的宿主半边只注册策略、不依赖具体代理实现', async () => {
  const mod = await import('../transport/index.js');
  assert.equal(mod.name, 'dsh-pocket-transport');
  assert.deepEqual(mod.inject, ['pocketTransport'], '依赖 root 行提供的策略枢纽');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.assetCachePolicy, 'function');
});

test('子包宿主：插件形状完整（name / inject / apply 空实现）', async () => {
  const mod = await import('../mobile/index.js');
  assert.equal(mod.name, 'dsh-pocket-mobile');
  assert.deepEqual(mod.inject, [], '宿主半边不依赖任何服务');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.apply({}, {}, {}), undefined, 'apply 是空实现（全部界面能力由客户端半边提供）');
  const rootMod = await import('../lib/index.js');
  assert.equal(typeof rootMod.apply, 'function');
  assert.equal(rootMod.name, 'dsh-pocket');
});

// ── 打包不变量（缺陷就长在这一层） ───────────────────────────────────────────
//
// 只测工作区会漏掉真正的缺陷：上面的软链恰好让工作区解析得到，而安装物里什么都没有。
// 所以这里走一次**真实的 npm pack**，在解包目录上断言，并用 DSH 的同一个原语
// （createRequire(anchor).resolve.paths → 找 <searchPath>/<name>/package.json）验证解析。

/** 工作区内的临时目录：测试期间由本进程持有，结束后删除。 */
function tempDir(prefix) {
  const base = join(root, '.test-tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/**
 * `npm pack` 出 tarball 并解包到 dest。
 *
 * 有意**不捕获**子进程输出（`stdio: 'ignore'`）：受限环境会拒绝带管道的子进程
 * （spawn EPERM）。`--pack-destination` 已经指定了落盘目录，产物名由清点该目录得到。
 * @returns {{extract: string, entries: {name: string, rel: string, type: string, size: number}[]}}
 */
function packAndExtract(dest) {
  const cache = join(dest, '..', `${basename(dest)}-cache`);
  execFileSync('npm', ['pack', '--pack-destination', dest, '--cache', cache], {
    cwd: root, shell: true, stdio: 'ignore',
  });
  const tarball = readdirSync(dest).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarball.length, 1, `npm pack 应产出唯一 tarball，实际 ${tarball.join(', ') || '(无)'}`);
  const tgz = readFileSync(join(dest, tarball[0]));
  // npm pack 出的 tar 对每个文件各有一段 gzip member；一次性解压整条流即可。
  const tar = gunzipSync(tgz);
  const extract = join(dest, 'unpacked');
  mkdirSync(extract, { recursive: true });
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (name === '') break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const rel = name.replace(/^package\//, '');
    entries.push({ name, rel, type, size });
    if (type === '0' || type === '\0' || type === '') {
      const file = join(extract, rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, body);
    } else if (type === '5') {
      mkdirSync(join(extract, rel), { recursive: true });
    } else if (type === '2') {
      const link = body.toString('utf8');
      mkdirSync(join(extract, rel, '..'), { recursive: true });
      writeFileSync(join(extract, rel), link); // 解包器把软链落成普通文件，仅用于「是否悬空」判定
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { extract, entries };
}

test('打包：两个子包都在 tarball 里，且裸包名能从解包后的包锚点解析到', async () => {
  const dir = tempDir('pack-');
  try {
    const { extract, entries } = packAndExtract(dir);
    const rels = entries.map((entry) => entry.rel);

    // 1) 子包必须真的在产物里（放在 node_modules/ 下没用：pnpm/npm 会丢掉它）
    assert.ok(rels.includes('mobile/package.json'), `tarball 缺少 mobile/package.json；实际顶层：${[...new Set(rels.map((r) => r.split('/')[0]))].join(', ')}`);
    assert.ok(rels.includes('mobile/client/client.js'), 'tarball 缺少 mobile/client/client.js（手机端产物）');
    assert.ok(rels.includes('mobile/index.js'), 'tarball 缺少 mobile/index.js（子包宿主入口）');
    assert.ok(rels.includes('transport/package.json'), 'tarball 缺少 transport/package.json');
    assert.ok(rels.includes('transport/client/client.js'), 'tarball 缺少 transport/client/client.js（弱网传输产物）');
    assert.ok(rels.includes('transport/index.js'), 'tarball 缺少 transport/index.js（宿主半边）');
    assert.ok(rels.includes('transport/cordis.patch.yml'), 'tarball 缺少 transport/cordis.patch.yml（组合补丁）');
    assert.ok(rels.includes('scripts/link-subpackages.mjs'), 'tarball 缺少 postinstall 脚本');
    assert.ok(!rels.some((rel) => rel.startsWith('node_modules/')),
      '安装物里不得再带仓库内的 node_modules 内容（pnpm 解包时会丢，且会掩盖真实解析）');

    // 2) postinstall 在解包目录上跑一次，复现安装态
    const extractedRoot = join(extract);
    const results = await ensureSubpackageLinks(extractedRoot);
    assert.ok(results.every((r) => r.result !== 'skipped'), `postinstall 必须能把子包接进解包目录：${JSON.stringify(results)}`);
    for (const sub of SUBPACKAGES) {
      assert.ok(existsSync(join(extractedRoot, 'node_modules', sub.name, 'package.json')),
        `postinstall 之后 node_modules/${sub.name}/package.json 必须存在`);
    }

    // 3) 每条非根包的裸包名，都要能从包锚点解析到——用 DSH packageDirFromAnchor 的同一个原语
    const anchor = join(extractedRoot, 'package.json');
    for (const row of patchRows()) {
      if (row.name === pkg.name) continue;
      const searchPaths = createRequire(anchor).resolve.paths(row.name) ?? [];
      const resolved = searchPaths.map((p) => join(p, row.name)).find((c) => existsSync(join(c, 'package.json')));
      assert.ok(resolved !== undefined,
        `row ${row.id}（${row.name}）必须能从包锚点解析到；搜索路径：\n  ${searchPaths.join('\n  ')}`);
      // 解析到的必须是**本包内**的子包，而不是恰好存在的别处副本
      assert.equal(resolved, join(extractedRoot, 'node_modules', row.name), `row ${row.id} 应解析到包内子包`);
    }
    // 4) 子包 manifest 与 locale 也要跟着解析得到（面板元数据靠它）
    for (const sub of SUBPACKAGES) {
      for (const name of [sub.name, `${sub.name}/package.json`, `${sub.name}/locale/zh.json`]) {
        assert.ok(createRequire(anchor).resolve(name).startsWith(extractedRoot), `${name} 应能从包锚点解析`);
      }
    }

    // 5) 解包产物里不得有悬空链接（软链在 tar 里是常规条目，解包后按链接落盘）
    for (const entry of entries) {
      const file = join(extract, entry.rel);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() !== true) continue;
      const target = readFileSync(file, 'utf8');
      assert.ok(existsSync(join(file, '..', target)), `解包产物里的软链 ${entry.rel} -> ${target} 悬空`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 远程操控产物不含移动端专有标记 ───────────────────────────────────────────

test('客户端产物：远程操控产物不含移动端专有标记', () => {
  const remote = readFileSync(join(root, 'client', 'client.js'), 'utf8');
  assert.ok(remote.includes('id: "dsh-pocket"'), '根产物 loader id = 包名 dsh-pocket');
  assert.ok(remote.includes('PocketSettingsTab'), '根产物含「手机访问」设置页');
  for (const marker of [
    '/dsh-pocket-mobile',
    'pocketMobile',
    'data-dsh-pocket-layout',
    'dsh-mobile-nav',
    'dsh_pocket_mobile_prefs',
    'dsh-mobile-sidebar-backdrop',
    'data-mobile-settings-view',
    'data-dsh-pocket-mobile-rightbar',
    'mobile.rightbar.setEnabled',
    'mobile.fileRead',
  ]) {
    assert.ok(!remote.includes(marker), `根产物不应包含移动端标记 ${marker}`);
  }
  assert.ok(!remote.includes('__DSH_POCKET_COMPONENTS__'), '旧的页面开关协议应当已删除');
  assert.ok(!remote.includes('createSessionHealer'), '根产物不应包含弱网传输组件的自愈器');
  // 客户端 inject：这份产物仍然声明自己需要的 cordis 服务
  assert.ok(
    remote.includes('inject = ["slots", "connection", "layout", "locale", "sessionLogDownload"]'),
    '根产物缺少客户端 inject 声明',
  );
});

test('远程操控通道：端点集合里没有移动端端点（它们已随组件删除）', () => {
  assert.equal(POCKET_RPC_CHANNEL, '/dsh-pocket');
  const endpoints = Object.values(POCKET_ENDPOINTS);
  for (const gone of ['mobile.status', 'mobile.rightbar.setEnabled', 'mobile.fileRead']) {
    assert.ok(!endpoints.includes(gone), `${gone} 不应再出现在任何契约里`);
  }
});

// ---------- 发行包形态 ----------

test('子包 manifest：files 覆盖宿主入口、客户端产物与 locale', () => {
  for (const rel of ['index.js', 'client', 'locale']) {
    assert.ok(mobileManifest.files.includes(rel), `files 应包含 ${rel}`);
  }
});

test('client/build.mjs：三个客户端产物', async () => {
  const mod = await import('../client/build.mjs');
  assert.equal(mod.TARGETS.length, 3, '三个客户端产物：远程操控 + 手机端 WebUI + 弱网传输');
  const outs = mod.TARGETS.map((t) => resolve(t.output));
  assert.deepEqual(outs, [
    resolve(root, 'client', 'client.js'),
    resolve(root, 'mobile', 'client', 'client.js'),
    resolve(root, 'transport', 'client', 'client.js'),
  ], '产物落盘位置与各子包 dsh.client 指向一致');
});
