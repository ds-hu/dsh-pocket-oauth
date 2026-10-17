// dsh-pocket-transport —— 弱网传输优化组件（Loader row: dsh-pocket-transport）
//
// 这个包把「让官方 Web UI 在弱网下更耐用」的传输层优化集中到一处，独立于
// 远程操控（dsh-pocket）与手机端界面（dsh-pocket-mobile）：
//
//   宿主半边（本文件）
//     - 官方前端 `/assets/**` 的 immutable 强缓存：由代理在响应时向本组件询问
//       `cache-control`，行关掉就不补头（代理本身不内置规则）。
//
//   客户端半边（client/）
//     - 会话自愈：连接抖动/会话流中断/加载卡死时按退避重建会话流；
//     - 底部连接状态条：断线/自愈中才出现，提供「立即重连」；
//     - settling 态输入区常驻。
//
//   组合补丁（cordis.patch.yml）
//     - typert-gateway 心跳 2000 → 10000 ms、流收件箱 1 MiB。组合补丁在 row 启动
//       之前由 Loader 组合，无法随 row 开关切换，因此它是「随本包安装生效」的策略；
//       组件的开关控制的是上面的运行时部分。
//
// 代理侧接入点是 Cordis service `pocketTransport`（见根包 lib/transport-hub.mjs）：
// root 行先 provide，本行 inject 之后注册策略；任何一边被关掉/重载，注册都会自动撤销。

export const name = 'dsh-pocket-transport';

/** 需要远程操控组件（root 行）提供的策略枢纽；root 关掉时本行保持未激活。 */
export const inject = ['pocketTransport'];

/** 官方前端静态产物的强缓存头。 */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * 策略：只给「官方前端 Vite 内容哈希产物」的 200 响应补 immutable。
 *
 * 两条不变量保证安全：
 *   1. 文件名即版本——内容一变哈希就变，浏览器不会拿到「同名的旧内容」；
 *   2. HTML 文档仍由代理改写成 `no-store`，它是版本锚点。
 *
 * 只补**缺失**的 `cache-control`，绝不顶掉上游语义：今天上游不设该头，行为不变；
 * 未来上游若给某个 `/assets/` 路径明确设了 `no-store`，那是它的语义，不能被我们改写。
 * 范围也只限 `/assets/` 前缀：DSH 自己的 `/plugins/**` 客户端包已由 dsh-client-modules
 * 设置同样的 immutable 头，不由本组件重复接管。
 *
 * @param {{pathname?: string, status?: number, headers?: object}} context
 * @returns {string|null} 需要设置的 cache-control；不接管时返回 null
 */
export function assetCachePolicy({ pathname, status, headers } = {}) {
  if (status !== 200) return null;
  if (!String(pathname ?? '').startsWith('/assets/')) return null;
  // 上游明确给了 cache-control 就不覆盖（大小写不敏感：原始头名可能是 Cache-Control）。
  const existing = headers ?? {};
  for (const key of Object.keys(existing)) {
    if (key.toLowerCase() === 'cache-control') return null;
  }
  return ASSET_CACHE_CONTROL;
}

// ---------- 组合补丁生效自检 ----------
// transport/cordis.patch.yml 对 dsh-base `typert-gateway` 行的心跳覆盖是**跨 bundle** 的：
// 更高优先级的 profile / home / overlay 层若也覆盖了同一行，我们那段会被静默顶掉，而组件
// 自身完全感知不到。这里在启动时把组合树里那一行读出来，让「生效 / 被顶掉 / id 被占用」
// 变成一条可检索的日志。读不到就什么都不说，任何异常都不影响启动。
export const GATEWAY_ROW_ID = 'typert-gateway';
export const GATEWAY_PACKAGE = '@deepseek-ai/dsh-api-gateway';

/**
 * 在 Loader 的组合树里找目标 row。
 *
 * 不能用 `loader.resolve(id)`：bundle patch 插入的 row 挂在各自 bundle 的 include 子树下，
 * 完整 id 带父级前缀（`<bundle>:typert-gateway`）。这里按 options 扫全部条目，id/包名任一
 * 命中即可，嵌套与否都能找到。
 * @param {object} ctx Cordis 插件上下文
 * @returns {object|null}
 */
function findGatewayEntry(ctx) {
  try {
    const loader = ctx?.get?.('loader') ?? ctx?.loader ?? ctx?.reflect?.get?.('loader', false);
    for (const entry of loader?.entries?.() ?? []) {
      const options = entry?.options ?? {};
      if (options.id === GATEWAY_ROW_ID || options.name === GATEWAY_PACKAGE) return entry;
    }
  } catch { /* loader 未就绪 / 取服务失败：静默跳过 */ }
  return null;
}

/**
 * 把组合补丁的生效状态记成一条日志（info = 生效；warn = 被顶掉 / id 被占用）。
 * @param {object} ctx Cordis 插件上下文
 * @param {object} logger 至少含 info/warn 的日志器
 */
export function reportGatewayOverride(ctx, logger) {
  const entry = findGatewayEntry(ctx);
  if (!entry) return;
  const rowName = entry.options?.name;
  if (typeof rowName === 'string' && rowName !== GATEWAY_PACKAGE) {
    logger.warn?.(`dsh-pocket-transport: row "${GATEWAY_ROW_ID}" is ${rowName}, not ${GATEWAY_PACKAGE} — heartbeat patch skipped by its name guard | 行 id 被别的包占用，弱网心跳补丁已按 name 守卫跳过`);
    return;
  }
  const cfg = entry.options?.config;
  if (!cfg || typeof cfg !== 'object') {
    logger.warn?.(`dsh-pocket-transport: ${GATEWAY_ROW_ID} override missing — a higher-priority layer replaced this row; weak-network heartbeat patch is NOT active | 弱网心跳覆盖被更高优先级层顶掉了，未生效`);
    return;
  }
  logger.info?.(`dsh-pocket-transport: ${GATEWAY_ROW_ID} override active — websocketHeartbeatIntervalMs=${cfg.websocketHeartbeatIntervalMs ?? '(default 2000)'} streamInboxBytes=${cfg.streamInboxBytes ?? '(default 262144)'} | 弱网心跳覆盖已生效`);
}

/**
 * 注册本组件的宿主侧策略。没有可注册的内容时也不报错——组件应能安静地待在面板里。
 * @param {object} ctx Cordis 插件上下文（已注入 pocketTransport）
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.pocketTransport.register(assetCachePolicy),
    'dsh-pocket-transport: /assets/** immutable cache',
  );
  reportGatewayOverride(ctx, ctx.logger?.(name) ?? console);
}
