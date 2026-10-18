window.__ModuleLoader__.load({
  id: "dsh-pocket-transport",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // The DSH client module system provides react as a module, never as a
    // global. esbuild keeps react external (see the build config above) and its
    // classic JSX transform emits bare React.createElement calls, so the
    // factory must bind React itself - otherwise any JSX in the sources crashes
    // at render time with "ReferenceError: React is not defined". The binding
    // costs nothing and must survive a future second target.
    var React = require("react");
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// transport/client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// lib/dom-contract.mjs
var CONVERSATION_MARKER_SELECTOR = "[data-conversation-content]";
var CONVERSATION_SESSION_ATTR = "data-conversation-session";
var CONVERSATION_SCROLL_SELECTOR = "[data-conversation-scroll]";
var TURN_NODE_SELECTOR = "[data-turn-trigger],[data-turn-process],[data-turn-tail]";

// transport/client/session-healer.js
var HEAL_LOADING_MS = 1e4;
function progressFingerprint(sessionId, { ctx, doc } = {}) {
  const parts = [];
  let hasEventWindow = false;
  try {
    const binding = ctx?.sessions?.binding?.(sessionId);
    const st = binding?.session?.getSnapshot?.();
    if (st) {
      parts.push(st.openState ?? "", st.hasMore === true ? "1" : "0", st.loadingOlder === true ? "1" : "0");
    }
    const win = binding?.eventSource?.getSnapshot?.();
    if (win) {
      hasEventWindow = true;
      parts.push(win.revision ?? "", win.entries?.length ?? "");
    }
  } catch {
  }
  if (!hasEventWindow) {
    try {
      const el = doc?.querySelector?.(CONVERSATION_SCROLL_SELECTOR) ?? doc?.querySelector?.(CONVERSATION_MARKER_SELECTOR);
      parts.push(el?.childElementCount ?? "", el?.querySelectorAll?.(TURN_NODE_SELECTOR)?.length ?? "");
    } catch {
    }
  }
  return parts.join("|");
}
var HEAL_WINDOW_MS = 10 * 60 * 1e3;
var HEAL_MAX_ATTEMPTS = 3;
var HEAL_COOLDOWN_MS = 2500;
function activeConversationSessionId(doc = typeof document !== "undefined" ? document : null) {
  try {
    const el = doc?.querySelector?.(CONVERSATION_MARKER_SELECTOR);
    if (!el || typeof el.getAttribute !== "function") return null;
    const id = el.getAttribute(CONVERSATION_SESSION_ATTR);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
function createSessionHealer(ctx, opts = {}) {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : null);
  const loadingTimeoutMs = opts.loadingTimeoutMs ?? HEAL_LOADING_MS;
  const windowMs = opts.windowMs ?? HEAL_WINDOW_MS;
  const maxAttempts = opts.maxAttempts ?? HEAL_MAX_ATTEMPTS;
  const cooldownMs = opts.cooldownMs ?? HEAL_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const listeners = /* @__PURE__ */ new Set();
  const historyBySession = /* @__PURE__ */ new Map();
  let disposed = false;
  let loadingTimer = null;
  let loadingSessionId = null;
  let loadingFingerprint = null;
  let sessionUnsub = null;
  let observedSessionId = null;
  let healing = false;
  let lastReason = null;
  let connStateUnsub = null;
  let connGenerationUnsub = null;
  let sessionsListUnsub = null;
  let snapshot = Object.freeze({
    connState: "connected",
    sessionId: null,
    openState: null,
    healing: false,
    attempts: 0,
    lastReason: null
  });
  function emit() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
      }
    }
  }
  function readConnState() {
    try {
      const s = ctx?.connection?.state?.getSnapshot?.();
      if (s === "connected" || s === "connecting" || s === "disconnected") return s;
      const gen = ctx?.connection?.generation?.getSnapshot?.();
      if (gen !== void 0) return "connected";
    } catch {
    }
    return "connected";
  }
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
  function pruneHistory() {
    if (historyBySession.size === 0) return;
    const ts = now();
    const cutoff = ts - windowMs;
    for (const [id, rec] of historyBySession) {
      rec.timestamps = rec.timestamps.filter((t) => t > cutoff);
      if (rec.timestamps.length === 0 && ts - rec.lastAt > windowMs) historyBySession.delete(id);
    }
  }
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
    if (!sessionId || readOpenState(sessionId) !== "loading") {
      clearLoadingTimer();
      return;
    }
    const fingerprint = progressFingerprint(sessionId, { ctx, doc });
    if (fingerprint !== loadingFingerprint) {
      armLoadingTimer(sessionId);
      return;
    }
    if (!canAutoHeal(sessionId)) {
      clearLoadingTimer();
      return;
    }
    void performHeal("loading-stalled", { manual: false });
  }
  function syncSnapshot() {
    if (disposed) return;
    const connState = readConnState();
    const sessionId = resolveSessionId();
    const openState = readOpenState(sessionId);
    const attempts = attemptsFor(sessionId);
    pruneHistory();
    if (sessionId !== observedSessionId) {
      if (sessionUnsub) {
        try {
          sessionUnsub();
        } catch {
        }
        sessionUnsub = null;
      }
      if (!sessionId) {
        observedSessionId = null;
      } else {
        const binding = readBinding(sessionId);
        try {
          if (typeof binding?.session?.subscribe === "function") {
            sessionUnsub = binding.session.subscribe(() => check());
            observedSessionId = sessionId;
          }
        } catch {
        }
      }
    }
    const next = Object.freeze({
      connState,
      sessionId,
      openState,
      healing,
      attempts,
      lastReason
    });
    const changed = next.connState !== snapshot.connState || next.sessionId !== snapshot.sessionId || next.openState !== snapshot.openState || next.healing !== snapshot.healing || next.attempts !== snapshot.attempts || next.lastReason !== snapshot.lastReason;
    snapshot = next;
    if (changed) emit();
  }
  async function performHeal(reason = "auto", { manual = false } = {}) {
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
      if (readConnState() !== "connected") {
        try {
          ctx?.connection?.reconnect?.();
        } catch {
        }
      }
      try {
        await ctx?.sessions?.refresh?.();
      } catch {
      }
      if (sessionId) {
        try {
          await ctx?.sessions?.refreshProjections?.(sessionId);
        } catch {
        }
        const openState = readOpenState(sessionId);
        if (openState === "error" || openState === "loading" || openState === "cold") {
          try {
            const ref = ctx?.sessions?.retain?.(sessionId, { source: "controllerOperation" });
            if (ref && typeof ref.release === "function") {
              Promise.resolve(ref.ready).catch(() => {
              }).finally(() => {
                try {
                  ref.release();
                } catch {
                }
              });
            }
          } catch {
          }
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
    if (openState === "error" && connState === "connected") {
      clearLoadingTimer();
      if (canAutoHeal(sessionId)) {
        void performHeal("session-error", { manual: false });
      }
      return;
    }
    if (openState === "loading") {
      if (loadingSessionId !== sessionId || loadingTimer === null) {
        clearLoadingTimer();
        armLoadingTimer(sessionId);
      }
      return;
    }
    clearLoadingTimer();
  }
  function attach() {
    if (disposed) return;
    if (connStateUnsub === null) {
      try {
        const u = ctx?.connection?.state?.subscribe?.(() => check());
        if (typeof u === "function") connStateUnsub = u;
      } catch {
      }
    }
    if (connGenerationUnsub === null) {
      try {
        const u = ctx?.connection?.generation?.subscribe?.(() => check());
        if (typeof u === "function") connGenerationUnsub = u;
      } catch {
      }
    }
    if (sessionsListUnsub === null) {
      try {
        const u = ctx?.sessions?.list?.subscribe?.(() => check());
        if (typeof u === "function") sessionsListUnsub = u;
      } catch {
      }
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
    healNow: (reason = "manual") => performHeal(reason, { manual: true }),
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
        try {
          sessionUnsub();
        } catch {
        }
        sessionUnsub = null;
      }
      for (const u of [connStateUnsub, connGenerationUnsub, sessionsListUnsub]) {
        if (typeof u !== "function") continue;
        try {
          u();
        } catch {
        }
      }
      connStateUnsub = null;
      connGenerationUnsub = null;
      sessionsListUnsub = null;
      observedSessionId = null;
      historyBySession.clear();
      listeners.clear();
    }
  };
}

// transport/client/styles.js
var BANNER_ID = "dsh-pocket-transport-banner";
var BANNER_LABEL_CLASS = "dsh-pocket-transport-label";
var BANNER_ACTIONS_CLASS = "dsh-pocket-transport-actions";
var STYLE_TAG_ID = "dsh-pocket-transport/weak-network";
var transportCss = `
/* ==========================================================================
   dsh-pocket-transport: \u5F31\u7F51\u4F20\u8F93\uFF08settling \u8F93\u5165\u533A\u5E38\u9A7B + \u8FDE\u63A5\u72B6\u6001\u6761\uFF09
   ========================================================================== */

@media (max-width: 1023px) {
  /* \u9636\u6BB5 1 \u5F31\u7F51\u6B62\u8840\uFF1A\u5F31\u7F51\u91CD\u8FDE/\u6D41\u5931\u8D25\u91CD\u62C9\u671F\u95F4\u4FDD\u6301\u8F93\u5165\u6846\u53EF\u89C1\u3002
     \u4E0E\u7D27\u51D1\u8F93\u5165\u6846\u7B49\u79FB\u52A8\u7AEF\u5F00\u5173\u65E0\u5173\u2014\u2014\u8FD9\u662F\u300C\u8F93\u5165\u6846\u7A81\u7136\u6D88\u5931\u300D\u7684\u76F4\u63A5\u4FEE\u590D\u3002 */
  [data-phase="settling"] [data-composer-seat],
  [data-content-phase="settling"] [data-composer-seat] {
    visibility: visible !important;
  }

  /* \u5F31\u7F51\u8FDE\u63A5\u4E0E\u8865\u9F50\u72B6\u6001\u6761\uFF08\u6302\u5728 shell.overlay\uFF0C\u4EC5\u65AD\u7EBF/\u6D41\u9519\u8BEF/\u81EA\u6108\u4E2D\u65F6\u51FA\u73B0\uFF09 */
  #${BANNER_ID} {
    position: fixed !important;
    left: 12px !important;
    right: 12px !important;
    bottom: max(76px, calc(env(safe-area-inset-bottom, 8px) + 70px)) !important;
    z-index: 1220 !important;
    /* \u975E\u963B\u585E\uFF1A\u672C\u4F53\u4E0D\u5403\u89E6\u6478\u4E8B\u4EF6\uFF08\u5E95\u4E0B\u7684\u6B63\u6587\u7167\u6837\u80FD\u6EDA\u52A8/\u70B9\u6309\uFF09\uFF0C\u53EA\u6709\u6309\u94AE\u53EF\u70B9\u3002
       \u5F31\u7F51\u4E0B\u8FD9\u6761\u6A2A\u5E45\u4F1A\u957F\u671F\u6302\u7740\uFF0C\u6321\u4F4F\u64CD\u4F5C\u6BD4\u4E0D\u663E\u793A\u66F4\u7CDF\u3002 */
    pointer-events: none !important;
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 10px !important;
    padding: 8px 12px !important;
    border-radius: 10px !important;
    font-size: 12px !important;
    line-height: 1.4 !important;
    background: var(--dsw-alias-bg-layer-2, rgba(31, 41, 55, 0.94)) !important;
    color: var(--dsw-alias-label-primary, #f9fafb) !important;
    border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14)) !important;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25) !important;
    backdrop-filter: blur(8px) !important;
  }

  /* \u6587\u6848\u5355\u884C\u7701\u7565\uFF08\u6837\u5F0F\u7EDF\u4E00\u6536\u5728\u6837\u5F0F\u8868\uFF0C\u7EC4\u4EF6\u91CC\u4E0D\u518D\u5199\u5185\u8054 style\uFF09 */
  #${BANNER_ID} .${BANNER_LABEL_CLASS} {
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
  }

  #${BANNER_ID} .${BANNER_ACTIONS_CLASS} {
    pointer-events: auto !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 6px !important;
    flex-shrink: 0 !important;
  }

  #${BANNER_ID} button {
    padding: 4px 10px !important;
    border-radius: 999px !important;
    border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2)) !important;
    background: var(--dsw-alias-button-primary-fill, #4f6ef7) !important;
    color: #fff !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    cursor: pointer !important;
  }
}

/* \u684C\u9762\u7AEF\u9690\u85CF\u72B6\u6001\u6761\uFF08\u4E0E\u79FB\u52A8\u7AEF\u6392\u7248\u65AD\u70B9 1024 \u5BF9\u9F50\uFF1B\u672C\u7EC4\u4EF6\u5728\u684C\u9762\u4E0D\u5448\u73B0\u89C6\u89C9\u5143\u7D20\uFF09 */
@media (min-width: 1024px) {
  #${BANNER_ID} {
    display: none !important;
  }
}
`;
function injectTransportStyles(doc = typeof document !== "undefined" ? document : null) {
  if (!doc?.head) return () => {
  };
  let styleEl = doc.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`);
  if (!styleEl) {
    styleEl = doc.createElement("style");
    styleEl.dataset.plugin = "dsh-pocket-transport";
    styleEl.dataset.pluginCss = STYLE_TAG_ID;
    doc.head.appendChild(styleEl);
  }
  styleEl.textContent = transportCss;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    styleEl?.remove();
  };
}

// transport/client/index.jsx
var name = "dsh-pocket-transport";
var inject = ["slots"];
function TransportBanner({ healer }) {
  const snap = (0, import_react.useSyncExternalStore)(
    (listener) => healer.subscribe(listener),
    () => healer.getSnapshot()
  );
  const disconnected = snap.connState === "disconnected" || snap.connState === "connecting";
  const sessionFault = snap.openState === "error";
  if (!disconnected && !sessionFault && !snap.healing) return null;
  let label;
  if (snap.healing) label = "\u{1F504} \u6B63\u5728\u81EA\u52A8\u8865\u9F50\u4F1A\u8BDD\u72B6\u6001\u2026";
  else if (snap.connState === "disconnected") label = "\u{1F4E1} \u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF08\u8F93\u5165\u6846\u4ECD\u53EF\u7F16\u8F91\uFF09";
  else if (snap.connState === "connecting") label = "\u23F3 \u6B63\u5728\u91CD\u8FDE\u670D\u52A1\u5668\u2026";
  else label = "\u26A0\uFE0F \u4F1A\u8BDD\u6D41\u4E2D\u65AD\uFF0C\u70B9\u53F3\u4FA7\u7ACB\u5373\u6062\u590D";
  return (0, import_react.createElement)(
    "div",
    { id: BANNER_ID, role: "status", "aria-live": "polite" },
    (0, import_react.createElement)("span", { className: BANNER_LABEL_CLASS }, label),
    (0, import_react.createElement)(
      "span",
      { className: BANNER_ACTIONS_CLASS },
      (0, import_react.createElement)(
        "button",
        { type: "button", onClick: () => {
          void healer.healNow("banner-button");
        } },
        "\u7ACB\u5373\u91CD\u8FDE"
      )
    )
  );
}
function apply(ctx) {
  const disposeStyles = injectTransportStyles();
  ctx.effect(() => disposeStyles, "dsh-pocket-transport: weak-network styles");
  const healer = createSessionHealer(ctx);
  ctx.effect(() => () => healer.dispose(), "dsh-pocket-transport: session healer");
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["connection"], () => {
        healer.attach();
      });
      ctx.inject(["sessions"], () => {
        healer.attach();
      });
    } catch {
    }
  }
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "dsh-pocket-transport#conn-banner",
        inject: () => ({ healer })
      },
      TransportBanner
    )
  );
}

    return module.exports;
  }
});
