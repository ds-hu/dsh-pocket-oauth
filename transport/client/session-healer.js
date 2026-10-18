/**
 * dsh-pocket-transport: 弱网会话自愈器与连接状态监控（客户端半边）
 *
 * 解决的问题：
 *   1. 官方客户端在流中断（`failEventStream`）后把会话 `openState` 置为终态 `'error'` 并丢弃流，
 *      或在弱网黑洞期间长期卡在 `'loading'`（触发 `data-phase="settling"` 隐藏输入框）。
 *   2. 本模块被动监听 `ctx.connection`（连接状态与世代）和 `ctx.sessions`（当前主栏会话的
 *      `openState`）：
 *      - 会话落入 `'error'`，或 `'loading'` 超时（默认 10s）且**毫无进展**时，按退避窗口自动触发
 *        `ctx.sessions.refreshProjections(id)` → 短暂 `retain` + `release` 重新激活 `session.open()`；
 *        只有连接本身不健康（`connecting`/`disconnected`）时才额外调 `ctx.connection.reconnect()`；
 *      - 同一会话 10 分钟窗口内最多自愈 3 次，避免死循环风暴；
 *      - 向状态条组件暴露可订阅的诊断快照（连接态、是否正在补齐、自愈计数与手动立即重连入口）。
 *
 * 依赖的服务（`ctx.connection` / `ctx.sessions`）可能比本插件晚就绪：构造时挂不上的监听由
 * {@link createSessionHealer} 返回的 `attach()` 幂等补挂，宿主插件在 `ctx.inject` 回调里再调一次。
 */

import {
  CONVERSATION_MARKER_SELECTOR,
  CONVERSATION_SCROLL_SELECTOR,
  CONVERSATION_SESSION_ATTR,
  TURN_NODE_SELECTOR,
} from '../../lib/dom-contract.mjs';

export { CONVERSATION_SCROLL_SELECTOR };

/** 会话卡在 loading 态触发自愈的阈值（毫秒）。 */
export const HEAL_LOADING_MS = 10_000;

/**
 * 判定「卡住」而不是「只是慢」：加载期间若观察到任何进展，就重新计时而不打断它。
 *
 * 这一条至关重要：弱网下历史本来就慢（500 kbps 拉一段长会话十几秒很正常），
 * 若只看「loading 超过 N 秒」就重连重拉，会把本来能成的加载打成永远加载不完。
 *
 * 进展信号取 `binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`）：
 * `revision` 随每次窗口变更单调递增、`entries.length` 随历史分页增长——这是上游**唯一**
 * 真实反映「历史在推进」的公开信号。注意 `SessionSnapshot` 里**没有** `seq` /
 * `historyLength` / `messageCount`（见 dsh 的 `session-controller/.../contract/snapshot.ts`），
 * 所以不能从 `session.getSnapshot()` 取进度。
 *
 * @param {string} sessionId
 * @param {{ ctx?: object, doc?: Document }} [deps]
 * @returns {string} 指纹；相同字符串代表「窗口内毫无进展」
 */
export function progressFingerprint(sessionId, { ctx, doc } = {}) {
  const parts = [];
  let hasEventWindow = false;
  try {
    const binding = ctx?.sessions?.binding?.(sessionId);
    const st = binding?.session?.getSnapshot?.();
    if (st) {
      parts.push(st.openState ?? '', st.hasMore === true ? '1' : '0', st.loadingOlder === true ? '1' : '0');
    }
    const win = binding?.eventSource?.getSnapshot?.();
    if (win) {
      hasEventWindow = true;
      parts.push(win.revision ?? '', win.entries?.length ?? '');
    }
  } catch { /* ignore */ }
  if (!hasEventWindow) {
    // 兜底（上游没有 eventSource，或测试桩没提供）：滚动容器的直接子节点数 + 每回合节点数。
    // 放在 eventSource 分支之外是刻意的——真实 binding 上永远走不到这里，DOM 查询不进入热路径。
    try {
      const el = doc?.querySelector?.(CONVERSATION_SCROLL_SELECTOR) ?? doc?.querySelector?.(CONVERSATION_MARKER_SELECTOR);
      parts.push(el?.childElementCount ?? '', el?.querySelectorAll?.(TURN_NODE_SELECTOR)?.length ?? '');
    } catch { /* ignore */ }
  }
  return parts.join('|');
}

/** 同一会话自愈计数滑动窗口（10 分钟）。 */
export const HEAL_WINDOW_MS = 10 * 60 * 1000;

/** 同一会话在滑动窗口内的最大自动自愈次数。 */
export const HEAL_MAX_ATTEMPTS = 3;

/** 两次自动自愈之间的最小冷却间隔（毫秒）。 */
export const HEAL_COOLDOWN_MS = 2500;

/**
 * 读取当前主栏正在展示的会话 ID（若主栏不在会话视图或为空白 hero，返回 null）。
 * @param {Document} [doc]
 * @returns {string|null}
 */
export function activeConversationSessionId(doc = typeof document !== 'undefined' ? document : null) {
  try {
    const el = doc?.querySelector?.(CONVERSATION_MARKER_SELECTOR);
    if (!el || typeof el.getAttribute !== 'function') return null;
    const id = el.getAttribute(CONVERSATION_SESSION_ATTR);
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * 创建会话自愈与连接状态协调器。
 * @param {object} ctx 客户端 Cordis 上下文（可选含 connection / sessions）
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {number} [opts.loadingTimeoutMs]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.cooldownMs]
 * @param {() => number} [opts.now]
 * @returns {{
 *   getSnapshot: () => { connState: string, sessionId: string|null, openState: string|null, healing: boolean, attempts: number, lastReason: string|null },
 *   subscribe: (fn: () => void) => () => void,
 *   healNow: (reason?: string) => Promise<boolean>,
 *   check: () => void,
 *   attach: () => void,
 *   dispose: () => void,
 * }}
 */
export function createSessionHealer(ctx, opts = {}) {
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : null);
  const loadingTimeoutMs = opts.loadingTimeoutMs ?? HEAL_LOADING_MS;
  const windowMs = opts.windowMs ?? HEAL_WINDOW_MS;
  const maxAttempts = opts.maxAttempts ?? HEAL_MAX_ATTEMPTS;
  const cooldownMs = opts.cooldownMs ?? HEAL_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());

  const listeners = new Set();
  /** @type {Map<string, { timestamps: number[], lastAt: number }>} */
  const historyBySession = new Map();

  let disposed = false;
  let loadingTimer = null;
  let loadingSessionId = null;
  let loadingFingerprint = null;
  let sessionUnsub = null;
  let observedSessionId = null;
  let healing = false;
  let lastReason = null;

  // 外围监听按来源分别记录，晚就绪的服务各自补挂（见 attach()）。
  let connStateUnsub = null;
  let connGenerationUnsub = null;
  let sessionsListUnsub = null;

  let snapshot = Object.freeze({
    connState: 'connected',
    sessionId: null,
    openState: null,
    healing: false,
    attempts: 0,
    lastReason: null,
  });

  function emit() {
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* 隔离监听异常 */ }
    }
  }

  function readConnState() {
    try {
      const s = ctx?.connection?.state?.getSnapshot?.();
      if (s === 'connected' || s === 'connecting' || s === 'disconnected') return s;
      const gen = ctx?.connection?.generation?.getSnapshot?.();
      if (gen !== undefined) return 'connected';
    } catch { /* ignore */ }
    return 'connected';
  }

  /**
   * 当前主栏正在展示的会话（**只认 DOM 标记**）。
   *
   * 刻意不回退到 `sessions.list` 里"第一个有 binding 的 id"：那个 id 未必是用户正在看的
   * 会话，用它当自愈目标会给后台会话做 `retain` + 重新 `open`，状态条也会为没在看的会话报故障。
   * 主栏不在会话视图（hero / 非会话面板）时返回 null —— 此时没有可自愈的目标。
   */
  function resolveSessionId() {
    return activeConversationSessionId(doc);
  }

  function readBinding(sessionId) {
    if (!sessionId) return null;
    try {
      return ctx?.sessions?.binding?.(sessionId) ?? null;
    } catch {
      return null;
    }
  }

  function readOpenState(sessionId) {
    const binding = readBinding(sessionId);
    try {
      return binding?.session?.getSnapshot?.()?.openState ?? null;
    } catch {
      return null;
    }
  }

  /** 丢弃窗口外的时间戳，并清掉彻底过期的会话记录（避免 Map 随会话数无限增长）。 */
  function pruneHistory() {
    if (historyBySession.size === 0) return;
    const ts = now();
    const cutoff = ts - windowMs;
    for (const [id, rec] of historyBySession) {
      rec.timestamps = rec.timestamps.filter((t) => t > cutoff);
      if (rec.timestamps.length === 0 && ts - rec.lastAt > windowMs) historyBySession.delete(id);
    }
  }

  /** 纯读：不修改任何状态（修剪由 pruneHistory/recordAttempt 负责）。 */
  function attemptsFor(sessionId) {
    if (!sessionId) return 0;
    return historyBySession.get(sessionId)?.timestamps.length ?? 0;
  }

  function canAutoHeal(sessionId) {
    if (!sessionId) return false;
    if (attemptsFor(sessionId) >= maxAttempts) return false;
    const rec = historyBySession.get(sessionId);
    if (rec && now() - rec.lastAt < cooldownMs) return false;
    return true;
  }

  function recordAttempt(sessionId) {
    const ts = now();
    pruneHistory();
    let rec = historyBySession.get(sessionId);
    if (!rec) {
      rec = { timestamps: [], lastAt: 0 };
      historyBySession.set(sessionId, rec);
    }
    rec.timestamps.push(ts);
    rec.lastAt = ts;
  }

  function clearLoadingTimer() {
    if (loadingTimer !== null) {
      clearTimeout(loadingTimer);
      loadingTimer = null;
    }
    loadingSessionId = null;
    loadingFingerprint = null;
  }

  /** 重新武装 loading 计时器（发现进展时用它续命，而不是新开一个自愈）。 */
  function armLoadingTimer(sessionId) {
    loadingSessionId = sessionId;
    loadingFingerprint = progressFingerprint(sessionId, { ctx, doc });
    loadingTimer = setTimeout(onLoadingTimeout, loadingTimeoutMs);
  }

  function onLoadingTimeout() {
    loadingTimer = null;
    if (disposed) {
      clearLoadingTimer();
      return;
    }
    const sessionId = loadingSessionId;
    if (!sessionId || readOpenState(sessionId) !== 'loading') {
      clearLoadingTimer();
      return;
    }
    // 有进展 → 只是慢，继续等（不打断正在进行的加载）
    const fingerprint = progressFingerprint(sessionId, { ctx, doc });
    if (fingerprint !== loadingFingerprint) {
      armLoadingTimer(sessionId);
      return;
    }
    // 真卡住（窗口内毫无变化）且还在自愈预算内 → 自愈
    if (!canAutoHeal(sessionId)) {
      clearLoadingTimer();
      return;
    }
    void performHeal('loading-stalled', { manual: false });
  }

  function syncSnapshot() {
    if (disposed) return;
    const connState = readConnState();
    const sessionId = resolveSessionId();
    const openState = readOpenState(sessionId);
    const attempts = attemptsFor(sessionId);
    pruneHistory();

    // 绑定当前会话的 snapshot 订阅。只有**订阅成功**才记账 observedSessionId，
    // 否则 binding 晚就绪时这个会话的订阅会被永久跳过。
    if (sessionId !== observedSessionId) {
      if (sessionUnsub) {
        try { sessionUnsub(); } catch { /* ignore */ }
        sessionUnsub = null;
      }
      if (!sessionId) {
        observedSessionId = null;
      } else {
        const binding = readBinding(sessionId);
        try {
          if (typeof binding?.session?.subscribe === 'function') {
            sessionUnsub = binding.session.subscribe(() => check());
            observedSessionId = sessionId;
          }
        } catch { /* ignore */ }
      }
    }

    const next = Object.freeze({
      connState,
      sessionId,
      openState,
      healing,
      attempts,
      lastReason,
    });

    const changed =
      next.connState !== snapshot.connState ||
      next.sessionId !== snapshot.sessionId ||
      next.openState !== snapshot.openState ||
      next.healing !== snapshot.healing ||
      next.attempts !== snapshot.attempts ||
      next.lastReason !== snapshot.lastReason;

    snapshot = next;
    if (changed) emit();
  }

  /**
   * 执行一次恢复动作。
   * @param {string} [reason]
   * @param {{ manual?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function performHeal(reason = 'auto', { manual = false } = {}) {
    if (disposed || healing) return false;
    const sessionId = resolveSessionId();
    if (!manual && sessionId && !canAutoHeal(sessionId)) {
      syncSnapshot();
      return false;
    }
    if (sessionId) recordAttempt(sessionId);
    healing = true;
    lastReason = reason;
    syncSnapshot();

    try {
      // 1. 只有连接本身不健康时才重连。`connection.reconnect()` 会 abort 当前 generation
      //    （拆掉共享 WebSocket），把会话级故障升级成全站断流——其它会话的在飞流会被一起打断。
      if (readConnState() !== 'connected') {
        try {
          ctx?.connection?.reconnect?.();
        } catch { /* ignore */ }
      }

      // 2. 刷新会话列表与当前会话的投影（Plan / Todo / 提问）
      try {
        await ctx?.sessions?.refresh?.();
      } catch { /* ignore */ }

      if (sessionId) {
        try {
          await ctx?.sessions?.refreshProjections?.(sessionId);
        } catch { /* ignore */ }

        // 3. 若当前会话处于 error 或未打开，借用一次 retain 触发 session.open() 重跑
        const openState = readOpenState(sessionId);
        if (openState === 'error' || openState === 'loading' || openState === 'cold') {
          try {
            const ref = ctx?.sessions?.retain?.(sessionId, { source: 'controllerOperation' });
            if (ref && typeof ref.release === 'function') {
              // 给 open() 启动留一个微任务窗口再释放临时引用（主栏引用仍持有 scope）
              Promise.resolve(ref.ready).catch(() => {}).finally(() => {
                try { ref.release(); } catch { /* ignore */ }
              });
            }
          } catch { /* ignore */ }
        }
      }
      return true;
    } finally {
      healing = false;
      syncSnapshot();
    }
  }

  function check() {
    if (disposed) return;
    syncSnapshot();
    const { connState, sessionId, openState } = snapshot;

    if (!sessionId) {
      clearLoadingTimer();
      return;
    }

    // 只在连接健康时自动自愈 error：连接不健康时它自己正在退避重连，此时 retain/open
    // 只会立刻再失败一次、白白烧掉自愈预算；等 connection.state 回到 'connected' 会再进这里。
    if (openState === 'error' && connState === 'connected') {
      clearLoadingTimer();
      if (canAutoHeal(sessionId)) {
        void performHeal('session-error', { manual: false });
      }
      return;
    }

    if (openState === 'loading') {
      if (loadingSessionId !== sessionId || loadingTimer === null) {
        clearLoadingTimer();
        armLoadingTimer(sessionId);
      }
      return;
    }

    clearLoadingTimer();
  }

  /**
   * 幂等挂载外围监听：`connection.state` / `connection.generation` / `sessions.list` 各自独立
   * 补挂。构造时服务可能还没就绪（宿主插件在 `ctx.inject` 回调里会再调一次本函数）。
   */
  function attach() {
    if (disposed) return;
    if (connStateUnsub === null) {
      try {
        const u = ctx?.connection?.state?.subscribe?.(() => check());
        if (typeof u === 'function') connStateUnsub = u;
      } catch { /* ignore */ }
    }
    if (connGenerationUnsub === null) {
      try {
        const u = ctx?.connection?.generation?.subscribe?.(() => check());
        if (typeof u === 'function') connGenerationUnsub = u;
      } catch { /* ignore */ }
    }
    if (sessionsListUnsub === null) {
      try {
        const u = ctx?.sessions?.list?.subscribe?.(() => check());
        if (typeof u === 'function') sessionsListUnsub = u;
      } catch { /* ignore */ }
    }
  }

  attach();
  check();

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    healNow: (reason = 'manual') => performHeal(reason, { manual: true }),
    check,
    attach() {
      attach();
      check();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearLoadingTimer();
      if (sessionUnsub) {
        try { sessionUnsub(); } catch { /* ignore */ }
        sessionUnsub = null;
      }
      for (const u of [connStateUnsub, connGenerationUnsub, sessionsListUnsub]) {
        if (typeof u !== 'function') continue;
        try { u(); } catch { /* ignore */ }
      }
      connStateUnsub = null;
      connGenerationUnsub = null;
      sessionsListUnsub = null;
      observedSessionId = null;
      historyBySession.clear();
      listeners.clear();
    },
  };
}
