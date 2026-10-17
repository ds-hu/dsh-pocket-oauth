# dsh-pocket 上下文

把 DeepSeek Harness（DSH）装进手机口袋的远控插件：以单端口反向代理承接远程访问与 OAuth 鉴权，配上手机端 WebUI 增强与代理层弱网加固，让**官方 Web GUI 本身**在窄屏与弱网下好用。曾经并行维护的「极速版 App + 口袋网关」已整体删除（见 [ADR 0006](./docs/adr/0006-remove-pocket-app-and-cache-official-assets.md)）。本文件是项目领域语言的术语表。

## 远控拓扑与入口

**口袋代理（Pocket Proxy）**：
本插件在宿主上监听的单端口 HTTP/WebSocket 反向代理（默认 `0.0.0.0:3081`）。对非回环入站请求执行 OAuth 会话门禁，其余请求改写权威为本机回环后透传给上游 `dsh web`；同时负责 HTML 注入、大响应压缩、官方静态资源强缓存与 `/pocket-app/**` 的退役路由。
_Avoid_: 中转服务器、内网穿透服务

**官方 Web 界面（Official Web UI）**：
经口袋代理透传的原生 `dsh web` 界面，加上 `dsh-pocket-mobile` 的窄屏响应式与连接自愈。它现在是**唯一**的界面——手机与电脑看到的是同一个应用、同一份实时状态。
_Avoid_: 兜底界面、老板界面、电脑端

**回环免密边界（Loopback Trust Boundary）**：
以 TCP 源地址为下限修饰 `Host` 头后判定为本机回环（`127.0.0.0/8`、`::1`、`localhost`）的访问边界。回环访问免除 OAuth 登录且允许访问初始化页；一切局域网与公网域名访问均受 OAuth 会话门禁保护。
_Avoid_: 内网免密、IP 白名单

## 传输与缓存

**静态资源强缓存（Immutable Asset Cache）**：
代理对官方前端 `/assets/**` 的 200 响应补 `public, max-age=31536000, immutable`。前提是这些文件由 Vite 产出、文件名带内容哈希，且 HTML 文档仍是 `no-store`——文档是版本锚点，资源名变了自然换缓存键。这是极速版删除后唯一搬迁到官方界面的弱网增益。
_Avoid_: 永久缓存、CDN 缓存

**传输压缩（Transport Compression）**：
代理对未压缩的 JSON/text 大响应做流式 gzip 或 brotli（质量 6），典型效果是长会话历史 17 MB → ~1 MB；SSE 与已压缩响应原样透传，不缓冲。
_Avoid_: 压测、缓存压缩

**退役路由（Retirement Route）**：
`/pocket-app/**` 不再是 App，而是旧入口的出口：`sw.js` 返回自注销的 Service Worker（清空 cache 并 unregister），其余路径 302 回 `/`，`/pocket-gw` 的 WS 升级返回 410。目的是让已装到主屏幕的旧图标不会永远显示缓存住的旧应用。
_Avoid_: 兼容层、重定向

**零残留（Zero Residue）**：
卸载插件或执行恢复出厂设置后，宿主磁盘（设置、OAuth 凭据、极速版时代遗留的 `cache/` 目录）、宿主进程（事件监听、定时器、监听端口）与浏览器侧（旧 Service Worker 缓存）都不留任何残留物。极速版遗留的 `cache/` 在插件启动时被一次性物理删除。
_Avoid_: 清理脚本、卸载钩子
