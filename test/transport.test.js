// dsh-pocket-transport（弱网传输优化组件）专项测试：
//   - 宿主半边：/assets/** immutable 策略、策略枢纽注册/撤销、组合补丁生效自检；
//   - 客户端半边：会话自愈器、连接状态条与 settling 输入区常驻；
//   - 与移动端界面组件解耦：这些能力只属于本组件，关掉后移动端排版照旧。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ASSET_CACHE_CONTROL,
  GATEWAY_PACKAGE,
  GATEWAY_ROW_ID,
  apply,
  assetCachePolicy,
  reportGatewayOverride,
} from '../transport/index.js';
import { createTransportHub } from '../lib/transport-hub.mjs';
import {
  HEAL_MAX_ATTEMPTS,
  activeConversationSessionId,
  createSessionHealer,
  progressFingerprint,
} from '../transport/client/session-healer.js';
import { BANNER_ID, transportCss } from '../transport/client/styles.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// ── 弱网验证工具：netem 模拟器本身要可用 ────────────────────────────────────
// 组件自带的弱网复现装置（transport/test/netem.mjs，不随包发布）。它没有自动化用例时
// 就是死代码，所以这里做一次最小可用性验证：限速 + 延迟下字节流必须完整往返。

test('弱网模拟器：限速/延迟链路下字节流完整往返，统计可读', async () => {
  const { createServer: createTcpServer, connect: tcpConnect } = await import('node:net');
  const { createNetemProxy } = await import('../transport/test/netem.mjs');

  const echo = createTcpServer((socket) => socket.pipe(socket));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const netem = await createNetemProxy({
    targetHost: '127.0.0.1',
    targetPort: echo.address().port,
    delayMs: 5,
    rateKbps: 512,
    chunkBytes: 256,
  });
  try {
    const received = await new Promise((resolve, reject) => {
      const chunks = [];
      const socket = tcpConnect(netem.port, '127.0.0.1', () => socket.write('weak-network-payload'));
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length >= 'weak-network-payload'.length) {
          socket.end();
          resolve(Buffer.concat(chunks).toString('utf8'));
        }
      });
      socket.on('error', reject);
    });
    assert.equal(received, 'weak-network-payload', '限速链路不得丢字节');
    const stats = netem.stats();
    assert.equal(stats.connections, 1);
    assert.ok(stats.upBytes > 0 && stats.downBytes > 0, `双向字节都要计数：${JSON.stringify(stats)}`);
  } finally {
    await netem.close();
    await new Promise((r) => echo.close(r));
  }
});

// ── 宿主半边：/assets/** immutable 策略 ──────────────────────────────────────

test('assetCachePolicy：只对 /assets/** 的 200 生效，且不顶掉上游 cache-control', () => {
  assert.equal(assetCachePolicy({ pathname: '/assets/index-5SrrfWpU.js', status: 200 }), ASSET_CACHE_CONTROL);
  assert.equal(assetCachePolicy({ pathname: '/assets/fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2', status: 200 }), ASSET_CACHE_CONTROL);
  assert.equal(assetCachePolicy({ pathname: '/assets/index-5SrrfWpU.js', status: 404 }), null, '非 200 不设强缓存');
  assert.equal(assetCachePolicy({ pathname: '/', status: 200 }), null, 'HTML 文档不属于强缓存范围');
  assert.equal(assetCachePolicy({ pathname: '/api/events.mux', status: 200 }), null, 'API 不属于强缓存范围');
  assert.equal(assetCachePolicy({ pathname: '/plugins/??a/client.js&rev=x', status: 200 }), null,
    'DSH 自己的 /plugins/** 已由 dsh-client-modules 设置 immutable，本组件不重复接管');
  assert.equal(assetCachePolicy({ pathname: '/assets/a.js', status: 200, headers: { 'cache-control': 'no-store' } }), null,
    '上游明确说了 no-store 就不能被改写');
  assert.equal(assetCachePolicy({ pathname: '/assets/a.js', status: 200, headers: { 'Cache-Control': 'no-store' } }), null,
    '头名大小写不敏感');
});

test('传输策略枢纽：注册即生效、撤销即失效（组件开关的真实语义）', () => {
  const hub = createTransportHub();
  assert.equal(hub.size, 0);
  assert.equal(hub.assetCacheControl('/assets/a.js', 200, {}), null, '没有策略时不补任何头');

  const off = hub.register(assetCachePolicy);
  assert.equal(hub.assetCacheControl('/assets/a.js', 200, {}), ASSET_CACHE_CONTROL);
  assert.equal(hub.size, 1);

  off();
  assert.equal(hub.assetCacheControl('/assets/a.js', 200, {}), null, '撤销后立刻回到官方行为');
  assert.equal(hub.size, 0);
});

test('组件 apply：向 pocketTransport 注册策略，并随 effect 撤销', () => {
  const hub = createTransportHub();
  let disposer;
  const ctx = {
    pocketTransport: hub,
    logger: () => ({ info() {}, warn() {} }),
    get: () => undefined,
    effect: (callback) => { disposer = callback(); },
  };
  apply(ctx);
  assert.equal(hub.assetCacheControl('/assets/a.js', 200, {}), ASSET_CACHE_CONTROL);
  assert.equal(typeof disposer, 'function', 'apply 必须通过 ctx.effect 注册撤销');
  disposer();
  assert.equal(hub.assetCacheControl('/assets/a.js', 200, {}), null, '组件卸载后策略一并撤销');
});

test('组合补丁自检：生效 / 被顶掉 / id 被占用三种结果都有日志', () => {
  const logs = [];
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) };
  const ctxWith = (entries) => ({ get: (name) => (name === 'loader' ? { entries: () => entries } : undefined) });

  reportGatewayOverride(ctxWith([{ options: { id: GATEWAY_ROW_ID, name: GATEWAY_PACKAGE, config: { websocketHeartbeatIntervalMs: 10000, streamInboxBytes: 1048576 } } }]), logger);
  assert.equal(logs.at(-1)[0], 'info');
  assert.match(logs.at(-1)[1], /override active/);
  assert.match(logs.at(-1)[1], /websocketHeartbeatIntervalMs=10000/);

  reportGatewayOverride(ctxWith([{ options: { id: GATEWAY_ROW_ID, name: GATEWAY_PACKAGE } }]), logger);
  assert.equal(logs.at(-1)[0], 'warn');
  assert.match(logs.at(-1)[1], /override missing/);

  reportGatewayOverride(ctxWith([{ options: { id: GATEWAY_ROW_ID, name: 'other-plugin' } }]), logger);
  assert.equal(logs.at(-1)[0], 'warn');
  assert.match(logs.at(-1)[1], /name guard/);

  const before = logs.length;
  reportGatewayOverride(ctxWith([]), logger);
  assert.equal(logs.length, before, '找不到该行时保持安静');
  reportGatewayOverride({ get: () => { throw new Error('loader 未就绪'); } }, logger);
  assert.equal(logs.length, before, '取服务失败不得抛错');
});

// ── 弱网传输：settling 输入框常驻 + 会话自愈器 + 连接状态条 ───────────────────

test('弱网传输：settling 态输入框强制可见（与移动端输入框开关无关）', () => {
  assert.match(
    transportCss,
    /\[data-phase="settling"\]\s+\[data-composer-seat\],\s*\[data-content-phase="settling"\]\s+\[data-composer-seat\]\s*\{\s*visibility:\s*visible\s*!important/,
    'settling 态必须无条件强制 [data-composer-seat] visibility:visible',
  );
});

test('弱网传输：createSessionHealer 在会话 error / loading 超时后自动自愈并受限于 10 分钟 3 次上限', async () => {
  let fakeNow = 100_000;
  let connState = 'connected';
  let openState = 'open';
  const calls = { reconnect: 0, refresh: 0, refreshProjections: 0, retain: 0, release: 0 };
  const connListeners = new Set();
  const sessionListeners = new Set();

  const fakeSession = {
    getSnapshot: () => ({ openState }),
    subscribe: (fn) => {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
  };
  const ctx = {
    connection: {
      state: {
        getSnapshot: () => connState,
        subscribe: (fn) => {
          connListeners.add(fn);
          return () => connListeners.delete(fn);
        },
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['sess-1'] }), subscribe: () => () => {} },
      binding: (id) => (id === 'sess-1' ? { session: fakeSession } : undefined),
      refresh: async () => { calls.refresh += 1; },
      refreshProjections: async () => { calls.refreshProjections += 1; },
      retain: () => {
        calls.retain += 1;
        return {
          ready: Promise.resolve(),
          release: () => { calls.release += 1; },
        };
      },
    },
  };
  ctx.connection.reconnect = () => { calls.reconnect += 1; };

  const doc = {
    querySelector: (sel) => (sel === '[data-conversation-content]'
      ? { getAttribute: (k) => (k === 'data-conversation-session' ? 'sess-1' : null) }
      : null),
  };
  assert.equal(activeConversationSessionId(doc), 'sess-1');

  const healer = createSessionHealer(ctx, {
    doc,
    loadingTimeoutMs: 30,
    cooldownMs: 10,
    now: () => fakeNow,
  });

  try {
    // 1. 正常 open 态不触发自愈
    assert.equal(calls.reconnect, 0);

    // 2. 会话流中断（openState = 'error'）→ 自动触发自愈。
    //    此时连接是健康的：**不许**调 connection.reconnect()——那会 abort 当前 generation
    //    （拆掉共享 WebSocket），把单会话故障升级成全站断流。
    openState = 'error';
    for (const fn of sessionListeners) fn();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(calls.reconnect, 0, '连接健康时不得重连连接（会话级故障不该打断其它会话的在飞流）');
    assert.equal(calls.refreshProjections, 1, '刷新当前会话投影');
    assert.equal(calls.retain, 1, '通过 retain 重新拉起 session.open()');
    assert.equal(calls.release, 1, '临时引用随后释放');

    // 3. 推进时间越过冷却期，再触发第 2、3 次，验证达到 HEAL_MAX_ATTEMPTS 后不再自动触发
    fakeNow += 50;
    healer.check();
    await new Promise((r) => setTimeout(r, 15));
    fakeNow += 50;
    healer.check();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(calls.retain, HEAL_MAX_ATTEMPTS, '达到窗口内最大自动自愈次数（3 次）');

    fakeNow += 50;
    healer.check();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(calls.retain, HEAL_MAX_ATTEMPTS, '超过上限后不再自动触发死循环');

    // 4. 用户点状态条「立即重连」按钮（manual=true）不受自动上限阻挡
    await healer.healNow('manual-click');
    assert.equal(calls.retain, HEAL_MAX_ATTEMPTS + 1, '手动重连始终放行');
    assert.equal(calls.reconnect, 0, '连接仍然健康 → 手动恢复也只重建会话流，不拆连接');

    // 5. 连接本身不健康时（connecting/disconnected）才允许 reconnect：重置退避、立刻重试
    connState = 'disconnected';
    await healer.healNow('manual-offline');
    assert.equal(calls.reconnect, 1, '连接不健康时才重连连接');
  } finally {
    healer.dispose();
  }
});

test('弱网传输：连接健康时即使 loading 卡死也只重建会话流，不 abort 共享 WebSocket', async () => {
  let fakeNow = 0;
  let openState = 'loading';
  const calls = { reconnect: 0, retain: 0 };
  const ctx = {
    connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} }, reconnect: () => { calls.reconnect += 1; } },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s-1'] }), subscribe: () => () => {} },
      binding: () => ({
        session: { getSnapshot: () => ({ openState }), subscribe: () => () => {} },
        eventSource: { getSnapshot: () => ({ revision: 1, entries: [] }) },
      }),
      refresh: async () => {},
      refreshProjections: async () => {},
      retain: () => { calls.retain += 1; return { ready: Promise.resolve(), release: () => {} }; },
    },
  };
  const doc = {
    querySelector: (sel) => (sel === '[data-conversation-content]'
      ? { getAttribute: (k) => (k === 'data-conversation-session' ? 's-1' : null) }
      : null),
  };
  const healer = createSessionHealer(ctx, { doc, loadingTimeoutMs: 20, cooldownMs: 1, now: () => fakeNow });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(healer.getSnapshot().lastReason, 'loading-stalled', '黑洞期无进展 → 触发自愈');
    assert.equal(calls.reconnect, 0, '连接健康 → 不碰 connection.reconnect()');
    assert.ok(calls.retain >= 1, '改为重建会话流（retain → open()）');
  } finally {
    healer.dispose();
  }
});

test('弱网传输：服务晚就绪时 attach() 必须补挂监听（只调 check() 永远挂不上）', async () => {
  let openState = 'open';
  const sessionListeners = new Set();
  const connListeners = new Set();
  const calls = { refreshProjections: 0 };
  // 构造时 connection / sessions 都还没就绪——正是 index.jsx 里 ctx.inject 回调要兜的场景
  const ctx = {};
  const doc = {
    querySelector: (sel) => (sel === '[data-conversation-content]'
      ? { getAttribute: (k) => (k === 'data-conversation-session' ? 's-1' : null) }
      : null),
  };
  const healer = createSessionHealer(ctx, { doc, loadingTimeoutMs: 5000, cooldownMs: 1, now: () => 0 });
  try {
    assert.equal(healer.getSnapshot().connState, 'connected', '读不到连接服务时按 connected 兜底');

    // 服务就绪
    ctx.connection = {
      state: {
        getSnapshot: () => 'connected',
        subscribe: (fn) => { connListeners.add(fn); return () => connListeners.delete(fn); },
      },
      reconnect: () => {},
    };
    ctx.sessions = {
      list: { getSnapshot: () => ({ ids: ['s-1'] }), subscribe: () => () => {} },
      binding: () => ({ session: { getSnapshot: () => ({ openState }), subscribe: (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); } } }),
      refresh: async () => {},
      refreshProjections: async () => { calls.refreshProjections += 1; },
      retain: () => ({ ready: Promise.resolve(), release: () => {} }),
    };

    healer.attach();

    assert.equal(sessionListeners.size, 1, 'per-session 订阅已补挂');
    assert.equal(connListeners.size, 1, '连接状态订阅已补挂（构造时挂不上就必须在这里补）');

    // 补挂之后再触发会话故障，必须真的被观察到
    openState = 'error';
    for (const fn of sessionListeners) fn();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.refreshProjections, 1, '补挂后的监听真的能驱动自愈');

    // attach 幂等：重复调用不会重复挂
    healer.attach();
    assert.equal(sessionListeners.size, 1, 'attach 幂等');
    assert.equal(connListeners.size, 1, 'attach 幂等');
  } finally {
    healer.dispose();
    assert.equal(sessionListeners.size, 0, 'dispose 摘掉 per-session 订阅');
    assert.equal(connListeners.size, 0, 'dispose 摘掉连接订阅');
  }
});

test('弱网传输：客户端入口在服务晚就绪时补挂 attach()，而不是只跑一次 check()', () => {
  const src = readFileSync(join(root, 'transport/client/index.jsx'), 'utf8');
  assert.match(src, /ctx\.inject\(\['connection'\],[\s\S]{0,80}healer\.attach\(\)/,
    'connection 就绪后必须补挂监听');
  assert.match(src, /ctx\.inject\(\['sessions'\],[\s\S]{0,80}healer\.attach\(\)/,
    'sessions 就绪后必须补挂监听');
  assert.ok(!/healer\.check\(\)/.test(src),
    '只调 check() 在「构造时服务还没就绪」的场景下永远挂不上监听（check 只巡检、不订阅）');
});

test('弱网传输：无会话标记时不做任何自愈（不回退到 sessions.list 的任意会话）', async () => {
  const calls = { retain: 0, refreshProjections: 0 };
  const ctx = {
    connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} }, reconnect: () => {} },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['background-1'] }), subscribe: () => () => {} },
      // 后台会话是「活」的，但主栏不在会话视图 → 它不该被当成本次自愈的目标
      binding: () => ({ session: { getSnapshot: () => ({ openState: 'error' }), subscribe: () => () => {} } }),
      refresh: async () => {},
      refreshProjections: async () => { calls.refreshProjections += 1; },
      retain: () => { calls.retain += 1; return { ready: Promise.resolve(), release: () => {} }; },
    },
  };
  const doc = { querySelector: () => null }; // hero / 非会话面板
  const healer = createSessionHealer(ctx, { doc, cooldownMs: 1, now: () => 0 });
  try {
    await healer.healNow('manual');
    assert.equal(healer.getSnapshot().sessionId, null);
    assert.equal(calls.retain, 0, '不能给后台会话做 retain + 重新 open');
    assert.equal(calls.refreshProjections, 0, '也不该给后台会话刷投影');
  } finally {
    healer.dispose();
  }
});

test('弱网传输：慢加载不被打断——有进展时续命，真卡住才自愈', async () => {
  const { createSessionHealer, progressFingerprint } = await import('../transport/client/session-healer.js');
  let openState = 'loading';
  // 进展信号必须来自 binding.eventSource：SessionSnapshot 里根本没有 seq/historyLength/messageCount
  let revision = 1;
  let entries = 0;
  let now = 0;
  const binding = {
    session: { getSnapshot: () => ({ openState }), subscribe: () => () => {} },
    eventSource: { getSnapshot: () => ({ revision, entries: new Array(entries).fill(null) }) },
  };
  const ctx = {
    sessions: { binding: () => binding },
    connection: { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
  };
  // 会话 ID 的主来源是 DOM（主栏根节点的 data-conversation-session）
  const el = { getAttribute: (name) => (name === 'data-conversation-session' ? 's-1' : null), childElementCount: 0, querySelectorAll: () => [] };
  const doc = { querySelector: () => el };
  const healer = createSessionHealer(ctx, { doc, loadingTimeoutMs: 1000, now: () => now });

  // 计时窗口内事件窗口一直在推进（弱网下正常的长加载）→ 不许自愈
  for (let i = 0; i < 5; i++) {
    now += 900;
    revision += 1;
    entries += 10;
    healer.check();
    await new Promise((r) => setTimeout(r, 950));
  }
  assert.equal(healer.getSnapshot().lastReason, null, '有进展时不得触发自愈');
  assert.equal(healer.getSnapshot().attempts, 0);

  // 之后彻底没有进展（黑洞）→ 才允许自愈
  now += 2000;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(healer.getSnapshot().lastReason, 'loading-stalled', '无进展才自愈');
  assert.ok(healer.getSnapshot().attempts >= 1);

  // 进度指纹必须能区分「有进展」与「没进展」
  openState = 'loading';
  const a = progressFingerprint('s-1', { ctx, doc });
  revision += 1;
  const b = progressFingerprint('s-1', { ctx, doc });
  assert.notEqual(a, b, 'eventSource.revision 前进 → 指纹变化');

  const c = progressFingerprint('s-1', { ctx, doc });
  assert.equal(c, b, '没有进展时指纹必须稳定（否则永远不会判定为卡住）');

  healer.dispose();
});

test('弱网传输：progressFingerprint 只用真实存在的字段（不能依赖 SessionSnapshot 里没有的 seq/消息数）', async () => {
  const { progressFingerprint } = await import('../transport/client/session-healer.js');
  // 真实 SessionSnapshot 的字段（dsh session-controller contract/snapshot.ts）：
  // 只有 openState / hasMore / loadingOlder …，**没有** seq / historyLength / messageCount。
  const snap = { openState: 'loading', hasMore: true, loadingOlder: false };
  const ctx = {
    sessions: {
      binding: () => ({ session: { getSnapshot: () => snap }, eventSource: { getSnapshot: () => ({ revision: 7, entries: [1, 2, 3] }) } }),
    },
  };
  const fp = progressFingerprint('s-1', { ctx, doc: { querySelector: () => null } });
  assert.match(fp, /loading/, '含 openState');
  assert.match(fp, /7/, '含 eventSource.revision');
  assert.match(fp, /3/, '含 entries.length');
  assert.doesNotMatch(fp, /undefined/, '不能把不存在的字段渲染成 undefined');

  // 没有 eventSource 时（老上游 / 桩）退回 DOM 探针，且不得抛错
  const noWin = { sessions: { binding: () => ({ session: { getSnapshot: () => snap } }) } };
  const fallback = progressFingerprint('s-1', {
    ctx: noWin,
    doc: { querySelector: () => ({ childElementCount: 4, querySelectorAll: () => [1, 2] }) },
  });
  assert.match(fallback, /4/, 'DOM 兜底：直接子节点数');
  assert.match(fallback, /2/, 'DOM 兜底：每回合节点数');
  assert.doesNotMatch(fallback, /undefined/);
});

test('弱网传输：重连状态条是非阻塞的（不盖住输入框、可手动重连、断网才出现）', () => {
  const css = transportCss;
  // 非阻塞：必须避开底部输入区，且不吞触摸事件
  assert.match(css, /#dsh-pocket-transport-banner\s*\{[\s\S]{0,400}pointer-events:\s*none/,
    '状态条不能吞掉触摸事件（否则弱网下反而更难点到输入框）');
  const at = css.indexOf('#dsh-pocket-transport-banner {');
  const banner = css.slice(at, at + 700);
  // 位置：浮在输入框**上方**（留出 composer 的高度），不是压在最底部
  const bottom = banner.match(/bottom:\s*max\((\d+)px/);
  assert.ok(bottom, '状态条用 bottom 偏移定位');
  assert.ok(Number(bottom[1]) >= 60, `状态条要给输入框让位（实际 ${bottom[1]}px）`);
  assert.ok(!/bottom:\s*0/.test(banner), '不许贴底压住输入框');
  assert.match(css, /#dsh-pocket-transport-banner \.dsh-pocket-transport-actions \{[\s\S]{0,120}pointer-events:\s*auto/,
    '状态条本体不响应，但里面的按钮要能点（手动重连）');

  // 行为：只有真的断开/自愈中才出现，正常时零占用
  const src = readFileSync(join(root, 'transport/client/index.jsx'), 'utf8');
  assert.match(src, /BANNER_ID/, '状态条真的被渲染出来');
  assert.match(src, /if \(!disconnected && !sessionFault && !snap\.healing\) return null/,
    '一切正常时不渲染（弱网下也不该常驻占位）');
  assert.match(src, /立即重连/, '给一个手动重连入口，不用等退避');
  assert.match(src, /输入框仍可编辑/, '明确告诉用户输入框没坏（这正是原来的痛点）');
});
