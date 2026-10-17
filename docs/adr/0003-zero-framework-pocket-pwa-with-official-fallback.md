# ADR 0003：零框架手机端专属 PWA App 与官方界面双轨兜底

- 状态：Superseded by [ADR 0006](./0006-remove-pocket-app-and-cache-official-assets.md)（极速版 App 与口袋网关已删除）
- 日期：2026-10-16

## 背景

官方 DSH Web GUI 是面向桌面大屏设计的大型 React 应用，首屏 JS/CSS 资源体积大，且其状态机将「连接世代（generation）」「流生命周期」与「面板可见性（`settling`）」深度绑定。在手机窄屏 + 弱 4G / 跨国隧道场景下，不仅首次加载耗时久，且任何流重置都会引起整树状态抖动；同时我们还需要在手机上流畅使用 `dsh-better-workspaces` 的全部 Git / Worktree / PR 能力。

## 决策

构建位于 `mobile/app/`、挂载在 `/pocket-app/` 下的**零框架（Vanilla JS + 原生 CSS）单页 PWA 应用**，与官方界面形成双轨并存：

1. **零框架与严格体积预算**：不打包 React 或任何 UI 框架，由 `client/build.mjs` 编译为单文件 IIFE 产物，JS + CSS 总计 **gzip ≤ 100 KB**，确保在 500 kbps 链路上 1–2 秒内完成下载与解析。
2. **本地副本与最终一致同屏（Paseo 范式）**：使用 IndexedDB 存储会话列表、每个会话最近 50 条尾部消息、投影（Plan / Todos / 提问）与本地草稿 / 出站队列。断线或重连期间保留旧视图并显示非阻塞状态条，输入框永远可编辑、可入队发送，绝不白屏或隐藏输入框。
3. **直接复用 `dsh-better-workspaces` 的同源 HTTP/SSE 接口**：对于 Git 徽标（`/snapshots`）、四模式 Diff（`/diff`）、提交历史（`/commits`）、操作阶梯（`/actions` + `/action`）、Worktree 命名式创建与 PR 检出（`/worktrees`、`/branches`、`/pulls`）、单文件 CAS 编辑器（`/file`）与 PR/Issue 引用 chip，App 直接通过同源代理调用 `/better-workspaces/api/*` 并做端点级能力探测（未安装该插件时自动隐藏 Git 控件）。
4. **窄屏自动引导与双向自由切换**：默认 `appEntry: 'auto'` 下，移动触屏窄屏设备访问 `/` 时自动切入 `/pocket-app/`；App 顶栏与菜单提供「电脑界面」一键切回官方 GUI（写入持久化 opt-out 标记，并在官方界面提供「打开 Pocket App」浮动入口以便随时切回）。
5. **限定作用域的 PWA**：Service Worker 仅注册在 `/pocket-app/` 作用域下，绝不拦截官方界面的任何请求；若检测到插件被卸载（接口返回 404），SW 自动注销并提示用户。

## 后果

- 手机端首屏时间、弱网恢复速度与触控交互体验获得质的飞跃，且完全覆盖会话、计划、审批、提问、附件与 `dsh-better-workspaces` 全套工作流。
- 官方界面随时可作为 100% 功能的兜底路径访问，用户不会被锁死在简化界面中。
