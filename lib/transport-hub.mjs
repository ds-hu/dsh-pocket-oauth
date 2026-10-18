// dsh-pocket「传输优化」组件的宿主侧接入点。
//
// 代理（lib/proxy.mjs）不内置任何弱网优化规则，只保留一个**运行时策略枢纽**：
// `dsh-pocket-transport` 那条 row 启动时把策略注册进来，行关掉时注册自动撤销。
// 这样「传输优化」既能独立开关，又不需要让代理反向依赖某个具体组件包。
//
// 为什么用 Cordis service 而不是共享模块：两个包在 HMR 下会被分别重载（各自持有
// 模块实例），共享可变模块会悄悄分裂成两份状态；service 由 root fiber 拥有，
// 重载时 Cordis 会自动通知依赖方重新注册。

/** 服务名：`ctx.provide(POCKET_TRANSPORT_SERVICE, hub)` / `inject = [POCKET_TRANSPORT_SERVICE]`。 */
export const POCKET_TRANSPORT_SERVICE = 'pocketTransport';

/**
 * 创建传输策略枢纽。
 *
 * 策略是纯函数：`(context) => string|null`，context 含 `pathname` / `status` / `headers`
 * （上游响应头，只读）。多个策略按注册顺序询问，第一个返回非空字符串的生效。
 *
 * @returns {{
 *   register(policy: (ctx: {pathname:string,status:number,headers:object}) => string|null): () => void,
 *   assetCacheControl(pathname: string, status: number, headers?: object): string|null,
 *   size: number,
 * }}
 */
export function createTransportHub() {
  const policies = new Set();
  return {
    register(policy) {
      if (typeof policy !== 'function') throw new TypeError('transport policy must be a function');
      policies.add(policy);
      return () => { policies.delete(policy); };
    },

    /**
     * 询问所有策略是否要为这个响应补 `cache-control`。
     * @param {string} pathname 请求路径（不含 query）
     * @param {number} status 上游状态码
     * @param {object} [headers] 上游响应头
     * @returns {string|null} 需要设置的 cache-control；没有策略接管时返回 null
     */
    assetCacheControl(pathname, status, headers) {
      for (const policy of policies) {
        try {
          const value = policy({ pathname, status, headers: headers ?? {} });
          if (typeof value === 'string' && value.length > 0) return value;
        } catch { /* 一个策略出错不影响其它策略与代理本身 */ }
      }
      return null;
    },

    /** 当前注册的策略数（诊断/测试用）。 */
    get size() { return policies.size; },
  };
}
