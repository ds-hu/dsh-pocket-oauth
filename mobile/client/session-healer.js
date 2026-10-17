/**
 * dsh-pocket-mobile: 弱网会话自愈器与连接状态监控（阶段 1 止血）
 *
 * 解决的问题：
 *   1. 官方客户端在流中断（`failEventStream`）后把会话 `openState` 置为终态 `'error'` 并丢弃流，
 *      或在弱网黑洞期间长期卡在 `'loading'`（触发 `data-phase="settling"` 隐藏输入框）。
 *   2. 本模块被动监听 `ctx.connection`（连接状态与世代）和 `ctx.sessions`（当前主栏会话的
 *      `openState`）：
 *      - 当连接恢复或会话落入 `'error'` / `'loading'` 超时（默认 8s）时，按退避窗口自动触发
 *        `ctx.connection.reconnect()` → `ctx.sessions.refreshProjections(id)` → 短暂
 *        `retain` + `release` 重新激活 `session.open()`；
 *      - 同一会话 10 分钟窗口内最多自愈 3 次，避免死循环风暴；
 *      - 向状态条组件暴露可订阅的诊断快照（连接态、是否正在补齐、自愈计数与手动立即重连入口）。
 */

/** 会话卡在 loading 态触发自愈的阈值（毫秒）。 */
export const HEAL_LOADING_MS = 10_000;

/**
 * 判定「卡住」而不是「只是慢」：加载期间若观察到任何进展（会话 seq 前进、
 * 对话流 DOM 变长、消息数增加），就重新计时而不打断它。
 *
 * 这一条至关重要：弱网下历史本来就慢（500 kbps 拉一段长会话十几秒很正常），
 * 若只看「loading 超过 N 秒」就重连重拉，会把本来能成的加载打成永远加载不完。
 */
export function progressFingerprint(sessionId, { ctx, doc } = {}) {
  const parts = [];
  try {
    const st = ctx?.sessions?.binding?.(sessionId)?.session?.getSnapshot?.();
    if (st) {
      parts.push(st.seq ?? '', st.openState ?? '', st.historyLength ?? st.messageCount ?? '');
    }
  } catch { /* ignore */ }
  try {
    const el = doc?.querySelector?.('[data-conversation-scroll]') ?? doc?.querySelector?.('[data-conversation-content]');
    parts.push(el?.childElementCount ?? '', el?.querySelectorAll?.('[data-message-id],[data-turn]')?.length ?? '');
  } catch { /* ignore */ }
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
    const el = doc?.querySelector?.('[data-conversation-content]');
    if (!el || typeof el.getAttribute !== 'function') return null;
    const id = el.getAttribute('data-conversation-session');
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

  function resolveSessionId() {
    const domId = activeConversationSessionId(doc);
    if (domId) return domId;
    try {
      const list = ctx?.sessions?.list?.getSnapshot?.();
      if (list && Array.isArray(list.ids)) {
        for (const id of list.ids) {
          const b = ctx?.sessions?.binding?.(id);
          if (b) return id;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  function readOpenState(sessionId) {
    if (!sessionId) return null;
    try {
      const binding = ctx?.sessions?.binding?.(sessionId);
      const st = binding?.session?.getSnapshot?.();
      return st?.openState ?? null;
    } catch {
      return null;
    }
  }

  function attemptsFor(sessionId) {
    if (!sessionId) return 0;
    const rec = historyBySession.get(sessionId);
    if (!rec) return 0;
    const cutoff = now() - windowMs;
    rec.timestamps = rec.timestamps.filter((t) => t > cutoff);
    return rec.timestamps.length;
  }

  function canAutoHeal(sessionId) {
    if (!sessionId) return false;
    const count = attemptsFor(sessionId);
    if (count >= maxAttempts) return false;
    const rec = historyBySession.get(sessionId);
    if (rec && now() - rec.lastAt < cooldownMs) return false;
    return true;
  }

  function recordAttempt(sessionId) {
    const ts = now();
    let rec = historyBySession.get(sessionId);
    if (!rec) {
      rec = { timestamps: [], lastAt: 0 };
      historyBySession.set(sessionId, rec);
    }
    const cutoff = ts - windowMs;
    rec.timestamps = rec.timestamps.filter((t) => t > cutoff);
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
    if (disposed) return;
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
    // 真卡住（窗口内毫无变化）且连接也不健康 → 自愈
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

    // 绑定当前会话的 snapshot 订阅
    if (sessionId !== observedSessionId) {
      if (sessionUnsub) {
        try { sessionUnsub(); } catch { /* ignore */ }
        sessionUnsub = null;
      }
      observedSessionId = sessionId;
      if (sessionId) {
        try {
          const binding = ctx?.sessions?.binding?.(sessionId);
          if (typeof binding?.session?.subscribe === 'function') {
            sessionUnsub = binding.session.subscribe(() => check());
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
      // 1. 触发底层连接立即重连（重置指数退避）
      try {
        ctx?.connection?.reconnect?.();
      } catch { /* ignore */ }

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

  // 挂载外围监听
  const unsubs = [];
  try {
    const u1 = ctx?.connection?.state?.subscribe?.(() => check());
    if (typeof u1 === 'function') unsubs.push(u1);
  } catch { /* ignore */ }
  try {
    const u2 = ctx?.connection?.generation?.subscribe?.(() => check());
    if (typeof u2 === 'function') unsubs.push(u2);
  } catch { /* ignore */ }
  try {
    const u3 = ctx?.sessions?.list?.subscribe?.(() => check());
    if (typeof u3 === 'function') unsubs.push(u3);
  } catch { /* ignore */ }

  check();

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    healNow: (reason = 'manual') => performHeal(reason, { manual: true }),
    check,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearLoadingTimer();
      if (sessionUnsub) {
        try { sessionUnsub(); } catch { /* ignore */ }
        sessionUnsub = null;
      }
      for (const u of unsubs) {
        try { u(); } catch { /* ignore */ }
      }
      unsubs.length = 0;
      listeners.clear();
    },
  };
}
