// dsh-pocket-transport: 弱网传输组件的客户端样式（唯一来源）
//
// 只放「弱网生效」的两条视觉契约：
//   1. settling 态输入区常驻（官方在 openState==='loading' && shellPhase==='blank'
//      时置 data-phase="settling" 并 visibility:hidden，弱网重拉期间输入框会消失）；
//   2. 底部连接状态条（断线 / 自愈中 / 流错误时出现，非阻塞）。
//
// 与移动端界面（dsh-pocket-mobile）的窄屏排版互相独立：本组件关掉后移动端排版照旧，
// 只是回到官方原生的「settling 隐藏输入框 + 没有连接状态条」行为。

/** 状态条根元素 id（组件与测试共用）。 */
export const BANNER_ID = 'dsh-pocket-transport-banner';

/** 状态条文案类名。 */
export const BANNER_LABEL_CLASS = 'dsh-pocket-transport-label';

/** 状态条操作区类名。 */
export const BANNER_ACTIONS_CLASS = 'dsh-pocket-transport-actions';

/** 样式标签的 data-plugin-css 标识（重复注入时原地改写，卸载时整条移除）。 */
export const STYLE_TAG_ID = 'dsh-pocket-transport/weak-network';

export const transportCss = `
/* ==========================================================================
   dsh-pocket-transport: 弱网传输（settling 输入区常驻 + 连接状态条）
   ========================================================================== */

@media (max-width: 1023px) {
  /* 阶段 1 弱网止血：弱网重连/流失败重拉期间保持输入框可见。
     与紧凑输入框等移动端开关无关——这是「输入框突然消失」的直接修复。 */
  [data-phase="settling"] [data-composer-seat],
  [data-content-phase="settling"] [data-composer-seat] {
    visibility: visible !important;
  }

  /* 弱网连接与补齐状态条（挂在 shell.overlay，仅断线/流错误/自愈中时出现） */
  #${BANNER_ID} {
    position: fixed !important;
    left: 12px !important;
    right: 12px !important;
    bottom: max(76px, calc(env(safe-area-inset-bottom, 8px) + 70px)) !important;
    z-index: 1220 !important;
    /* 非阻塞：本体不吃触摸事件（底下的正文照样能滚动/点按），只有按钮可点。
       弱网下这条横幅会长期挂着，挡住操作比不显示更糟。 */
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

  /* 文案单行省略（样式统一收在样式表，组件里不再写内联 style） */
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

/* 桌面端隐藏状态条（与移动端排版断点 1024 对齐；本组件在桌面不呈现视觉元素） */
@media (min-width: 1024px) {
  #${BANNER_ID} {
    display: none !important;
  }
}
`;

/**
 * 注入（或原地更新）组件样式表。
 *
 * 重复调用只改写同一条 `<style>` 的内容；返回的 disposer 会把它整条移除，
 * 保证组件关掉后页面上不残留任何样式。
 *
 * @param {Document} [doc] 目标文档（测试注入用）
 * @returns {() => void} 卸载函数（幂等）
 */
export function injectTransportStyles(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc?.head) return () => {};
  let styleEl = doc.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`);
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.dataset.plugin = 'dsh-pocket-transport';
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
