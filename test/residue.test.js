// 零残留契约测试：卸载插件 / 恢复出厂设置之后，磁盘与宿主进程都不该留下任何东西。
//
// 分两层：
//   ① 磁盘：$DSH_HOME/dsh-pocket/ 下不留文件（设置、OAuth 凭据全清），且不往工作目录或别处
//      写任何东西；
//   ② 宿主进程：代理端口释放、重复卸载幂等——不能出现「插件没了，监听还在」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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

test('零残留：恢复出厂设置后 $DSH_HOME/dsh-pocket 下不留任何文件', () => withHome(async (home) => {
  const settings = await import('../lib/settings.mjs');
  const oauth = await import('../lib/oauth.mjs');
  const { resetPocketState } = await import('../lib/index.js');

  // 先把两类落盘造出来：设置、OAuth 凭据
  settings.setProxyPort(3099);
  const written = oauth.writeOAuthConfig({
    provider: 'gitee', clientId: 'cid', clientSecret: 'sec',
    callbackOrigins: ['https://pocket.example.com'], boundUid: '4242', boundLogin: 'alice',
  });
  assert.ok(written, 'OAuth 配置写盘成功');

  const before = leftovers(home);
  assert.ok(before.includes('settings.json'), `设置文件应在盘上：${before}`);
  assert.ok(before.some((f) => /oauth/i.test(f)), `OAuth 配置应在盘上：${before}`);

  resetPocketState();

  assert.deepEqual(leftovers(home), [], '恢复出厂后 dsh-pocket 目录下零残留');
  // 读回来也必须是干净的默认值（不是「文件没了但内存还记着」）
  assert.equal(settings.proxyPort(), 0, '代理端口回到默认（0 = 未显式指定）');
  assert.equal(oauth.readOAuthConfig(), null, 'OAuth 配置读回 null（fail closed）');
}));

test('零残留：插件数据目录只有一个事实源（settings / oauth 必须同目录）', () => withHome(async (home) => {
  const { pocketDir, settingsPath } = await import('../lib/settings.mjs');
  const { oauthConfigPath } = await import('../lib/oauth.mjs');
  assert.equal(pocketDir(), join(home, 'dsh-pocket'), 'pocketDir 跟随 $DSH_HOME');
  assert.equal(dirname(settingsPath()), pocketDir());
  assert.equal(dirname(oauthConfigPath()), pocketDir(),
    'oauth.json 必须和 settings.json 同目录——各模块各自拼 $DSH_HOME 迟早会漂移');
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
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{ not json at all');
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
