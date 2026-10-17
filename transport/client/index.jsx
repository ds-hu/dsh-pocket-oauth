/**
 * dsh-pocket-transport: 弱网传输优化的客户端半边
 *
 * 只做两件事，且都可以随组件 row 一起关掉：
 *   1. 会话自愈（session-healer.js）：连接抖动 / 会话流中断 / 加载卡死时按退避重建会话流；
 *   2. 底部连接状态条：断线、自愈中或会话流报错时浮现，提供「立即重连」。
 *
 * 状态条通过 `shell.overlay` 槽位挂载（root scope 的 list 槽，AppFrame 无条件渲染），
 * 因此主栏被面板接管时它仍然在；窄屏之外由样式表隐藏，不影响桌面。
 */

import { createElement as h, useSyncExternalStore } from 'react';
import { createSessionHealer } from './session-healer.js';
import {
  BANNER_ACTIONS_CLASS,
  BANNER_ID,
  BANNER_LABEL_CLASS,
  injectTransportStyles,
} from './styles.js';

export const name = 'dsh-pocket-transport';

// 只需要槽位；connection / sessions 由 ctx.inject 在服务就绪后补挂（可能比本插件晚）。
export const inject = ['slots'];

/** 底部连接状态条：只在异常/自愈中渲染，正常时零占用。 */
function TransportBanner({ healer }) {
  const snap = useSyncExternalStore(
    (listener) => healer.subscribe(listener),
    () => healer.getSnapshot(),
  );
  const disconnected = snap.connState === 'disconnected' || snap.connState === 'connecting';
  const sessionFault = snap.openState === 'error';
  if (!disconnected && !sessionFault && !snap.healing) return null;

  let label;
  if (snap.healing) label = '🔄 正在自动补齐会话状态…';
  else if (snap.connState === 'disconnected') label = '📡 连接已断开（输入框仍可编辑）';
  else if (snap.connState === 'connecting') label = '⏳ 正在重连服务器…';
  else label = '⚠️ 会话流中断，点右侧立即恢复';

  return h(
    'div',
    { id: BANNER_ID, role: 'status', 'aria-live': 'polite' },
    h('span', { className: BANNER_LABEL_CLASS }, label),
    h(
      'span',
      { className: BANNER_ACTIONS_CLASS },
      h(
        'button',
        { type: 'button', onClick: () => { void healer.healNow('banner-button'); } },
        '立即重连',
      ),
    ),
  );
}

/**
 * 客户端插件注册入口。
 * @param {object} ctx 客户端插件上下文
 */
export function apply(ctx) {
  // 1. 弱网样式（settling 输入区常驻 + 状态条）；卸载时整条移除
  const disposeStyles = injectTransportStyles();
  ctx.effect(() => disposeStyles, 'dsh-pocket-transport: weak-network styles');

  // 2. 会话自愈器：监听 connection / sessions，失败或卡 loading 自动重连补齐
  const healer = createSessionHealer(ctx);
  ctx.effect(() => () => healer.dispose(), 'dsh-pocket-transport: session healer');
  if (typeof ctx.inject === 'function') {
    // 服务可能比本插件晚就绪：就绪后补挂监听（attach 幂等，已挂的不会重复挂）
    try {
      ctx.inject(['connection'], () => { healer.attach(); });
      ctx.inject(['sessions'], () => { healer.attach(); });
    } catch { /* 测试桩无可选 inject 时忽略 */ }
  }

  // 3. 状态条：挂在 shell.overlay（root scope 的 list 槽），面板接管主栏时也不消失
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-pocket-transport#conn-banner',
        inject: () => ({ healer }),
      },
      TransportBanner,
    ),
  );
}
