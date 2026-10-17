// DSH 官方 Web UI 的 DOM 契约（客户端组件共享的唯一来源）
//
// 这些属性/选择器由 `@deepseek-ai/dsh-client-ui-*` 渲染，不是本插件发明的：
//   - `[data-conversation-content]`：会话根元素（空会话也渲染，绑定会话后带 id 属性）；
//   - `data-conversation-session`：会话 id（主栏当前打开的是哪个会话）；
//   - `[data-conversation-scroll]`：对话滚动容器（历史分页时直接子节点会增加）；
//   - `data-turn-*`：每回合节点（Turn*NodeView），数量随历史分页增长。
//
// 客户端组件（mobile / transport）与测试都从这里取，避免同一份契约在多个包里各写一遍、
// 上游改名时只改到一处。**只放无副作用的常量**：这个模块会被打进两个客户端产物。

/** 会话根元素（恒在，但只有绑定会话时才有下面的 id 属性）。 */
export const CONVERSATION_MARKER_SELECTOR = '[data-conversation-content]';

/** 会话根携带的会话 id 属性。 */
export const CONVERSATION_SESSION_ATTR = 'data-conversation-session';

/** 对话滚动容器（ConversationContent 的 scrollBody）——DOM 兜底进度探针的锚点。 */
export const CONVERSATION_SCROLL_SELECTOR = '[data-conversation-scroll]';

/**
 * 每回合节点：ui-chat 的 Turn*NodeView 会带这些属性，数量随历史分页增长。
 * 仅在会话事件窗口（binding.eventSource）不可用时作为兜底探针。
 */
export const TURN_NODE_SELECTOR = '[data-turn-trigger],[data-turn-process],[data-turn-tail]';
