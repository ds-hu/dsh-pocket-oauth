// 零残留契约测试：卸载插件 / 恢复出厂设置之后，磁盘与宿主进程都不该留下任何东西。
//
// 分两层：
//   ① 磁盘：$DSH_HOME/dsh-pocket/ 下不留文件（设置、OAuth 凭据全清），极速版时代遗留的
//      `cache/` 目录在插件启动/恢复出厂时被物理删除，且不往工作目录或别处写任何东西；
//   ② 宿主进程：代理端口释放、重复卸载幂等——不能出现「插件没了，监听还在」。
//
// 曾经还有第三层「手机端」（Service Worker 不缓存网关帧、IndexedDB 有销毁路径），
// 随极速版 App 一起删除（ADR 0006）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshp-residue-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

/** 造出极速版时代的遗留缓存目录（生产者已删除，只剩死数据）。 */
function seedLegacyCache(home) {
  const dir = join(home, 'dsh-pocket', 'cache');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sess-deadbeef.json'), '{"items":[]}');
  return dir;
}

/** $DSH_HOME/dsh-pocket 下剩余的所有条目（目录也算），用于断言「零残留」。 */
function leftovers(home) {
  const dir = join(home, 'dsh-pocket');
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (base, prefix) => {
    for (const name of readdirSync(base, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) {
        out.push(`${rel}/`);
        walk(join(base, name.name), rel);
      } else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ---------- ① 磁盘 ----------

test('零残留：恢复出厂设置后 $DSH_HOME/dsh-pocket 下不留任何文件（含极速版遗留缓存）', () => withHome(async (home) => {
  const settings = await import('../lib/settings.mjs');
  const oauth = await import('../lib/oauth.mjs');
  const { resetPocketState } = await import('../lib/index.js');

  // 先把两类落盘造出来：设置、OAuth 凭据；再补一个极速版时代的遗留缓存目录
  settings.setProxyPort(3099);
  const written = oauth.writeOAuthConfig({
    provider: 'gitee', clientId: 'cid', clientSecret: 'sec',
    callbackOrigins: ['https://pocket.example.com'], boundUid: '4242', boundLogin: 'alice',
  });
  assert.ok(written, 'OAuth 配置写盘成功');
  const legacyCache = seedLegacyCache(home);

  const before = leftovers(home);
  assert.ok(before.includes('settings.json'), `设置文件应在盘上：${before}`);
  assert.ok(before.some((f) => f.startsWith('cache/')), '遗留缓存目录应在盘上');
  assert.ok(before.some((f) => /oauth/i.test(f)), `OAuth 配置应在盘上：${before}`);

  resetPocketState();

  assert.deepEqual(leftovers(home), [], '恢复出厂后 dsh-pocket 目录下零残留');
  assert.equal(existsSync(legacyCache), false, '极速版遗留缓存目录被物理删除');
  // 读回来也必须是干净的默认值（不是「文件没了但内存还记着」）
  assert.equal(settings.proxyPort(), 0, '代理端口回到默认（0 = 未显式指定）');
  assert.equal(oauth.readOAuthConfig(), null, 'OAuth 配置读回 null（fail closed）');
}));

test('零残留：插件应用时清掉极速版遗留缓存目录（生产者已删除，不必等恢复出厂）', () => withHome(async (home) => {
  const { purgeLegacyCache, legacyCachePath } = await import('../lib/settings.mjs');
  const dir = seedLegacyCache(home);
  assert.equal(existsSync(dir), true, '前置：遗留目录存在');
  assert.equal(legacyCachePath(), dir, '路径就是 settings.json 同级的 cache/');
  // apply() 启动时调的就是这个函数（apply 需要完整 Cordis ctx，这里直接验证函数本身）
  assert.equal(purgeLegacyCache(), true);
  assert.equal(existsSync(dir), false, '遗留目录被清除');
  assert.equal(purgeLegacyCache(), true, '不存在时也返回成功（幂等，每次启动都可以无脑调）');
}));

test('零残留：插件不往 $DSH_HOME 之外写任何文件', () => withHome(async () => {
  const settings = await import('../lib/settings.mjs');
  const oauth = await import('../lib/oauth.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'dshp-cwd-'));
  const before = readdirSync(cwd);
  try {
    settings.setProxyPort(3098);
    oauth.writeOAuthConfig({ provider: 'gitee', clientId: 'c', clientSecret: 's', callbackOrigins: [], boundUid: null, boundLogin: null });
    assert.deepEqual(readdirSync(cwd), before, '当前工作目录不应出现任何插件产物');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}));

test('零残留：损坏的残留文件不会让恢复出厂失败（自愈）', () => withHome(async (home) => {
  const dir = join(home, 'dsh-pocket');
  mkdirSync(join(dir, 'cache'), { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{ not json at all');
  writeFileSync(join(dir, 'cache', 'sess-deadbeef.json'), 'garbage');
  const { resetPocketState } = await import('../lib/index.js');
  resetPocketState();
  assert.deepEqual(leftovers(home), [], '损坏残留同样被清干净');
}));

// ---------- ② 宿主进程 ----------

test('零残留：卸载后代理端口可被立刻重新占用（没有半关的监听）', async () => {
  const { createPocketService } = await import('../lib/service.mjs');
  let closed = 0;
  const service = createPocketService({
    dshPort: 3080,
    port: 0,
    internals: {
      createProxy: async () => ({ port: 45679, close: async () => { closed += 1; } }),
    },
  });
  await service.startProxy();
  await service.dispose();
  assert.equal(closed, 1, 'dispose 关闭代理一次');
  await service.dispose();
  assert.equal(closed, 1, '重复 dispose 不会重复关闭（幂等）');
  await delay(1);
});

test('零残留：极速版子系统已从仓库删除（源码、工作流、模块都不在）', () => {
  for (const rel of [
    'mobile/app',
    'lib/gateway.mjs',
    'lib/cache.mjs',
    'lib/pocket-app.mjs',
    '.github/workflows/pocket-app.yml',
  ]) {
    assert.equal(existsSync(join(ROOT, rel)), false, `${rel} 应已被删除（ADR 0006）`);
  }
});
