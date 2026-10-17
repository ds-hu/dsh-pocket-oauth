# ADR 0006：删除极速版 PWA，只保留官方界面并给它强缓存

- 状态：Accepted
- 日期：2026-10-17
- 取代：ADR 0001、ADR 0003、ADR 0004
- 保留：ADR 0002（官方 WebSocket 原始 TCP 透传）、ADR 0005（`typert-gateway` 心跳放宽）

## 背景

ADR 0001/0003/0004 建立了一条「双轨」路线：官方界面兜底，另加一个位于 `/pocket-app/` 的零框架手机端 App，配 `WS /pocket-gw` 与宿主侧尾部落盘缓存。这套东西在弱网下确实有效（游标续传只补差量、幂等重投、冷读、本地尾部秒开），但它同时带来了明确的代价：

1. **两套客户端要各自维护**：协议、样式、测试、CI、文档全部翻倍；任何一次 DSH 上游改动都要验证两条路径。
2. **价值高度绑定协议**：App 的全部优势都建立在 `/pocket-gw` 上。只要用户回到官方界面（或 App 没装、被关掉），这些优势**一个都不生效**。
3. **用户实际选择**：维护者不再需要独立 App，日常在手机上直接用浏览器打开官方界面；此时「App 是否存在」只影响认知负担，不影响使用。

决定删除的原因不是「弱网优化没用」，而是**收益只在一个不再被使用的客户端里，维护成本却由整个插件承担**。

## 决策

### 1. 删除整个 App 子系统

- `mobile/app/**`（PWA 源码与外壳）、`lib/pocket-app.mjs`（静态服务）、`lib/gateway.mjs`（口袋网关）、`lib/cache.mjs`（尾部落盘缓存）、`.github/workflows/pocket-app.yml`。
- 相应的设置项（`appEnabled` / `appEntry` / `cacheEnabled` / `cacheMaxItems` / `cacheMaxMiB` / `cacheTtlDays`）、RPC 端点（`pocket.app.get` / `pocket.app.set` / `pocket.cache.clear`）、`redirect` 引导脚本（`buildAppEntryBootstrap`）一并删除。
- 删除后 `ws` 只被测试使用，从 `dependencies` 移到 `devDependencies`。

### 2. 保留并继续生效的弱网加固（都在官方路径上）

| 加固 | 位置 | 为什么保留 |
| --- | --- | --- |
| `typert-gateway` 心跳 2000 → 10000 ms | `cordis.patch.yml` | 宿主组合树里，官方界面与任何 `:3080` 直连都吃；断连频率降约 80%（ADR 0005） |
| 大 JSON 响应流式 gzip/brotli | `lib/proxy.mjs` | 长会话历史 17 MB → ~1 MB |
| 官方 WS 的 30 s 保活 ping + 静默检测 | `lib/proxy.mjs` | 防 NAT/省电机制静默断链 |
| `settling` 态强制输入区可见 + 会话自愈 | `mobile/client/**` | 官方界面的输入框消失问题（上游行为） |
| 窄屏响应式（抽屉、两级设置、触屏输入框、Plan/审批/提问卡片排版） | `mobile/client/**` | 与 App 无关，本来就作用在官方界面上 |

### 3. 把唯一可安全搬迁的增益搬过来：官方静态资源强缓存

`@deepseek-ai/dsh-web-frontend` 的 `dist/assets/**` 全部是 Vite 内容哈希产物（`index-5SrrfWpU.js`、`KaTeX_AMS-Regular-BQhdFMY1.woff2`、59 个 hljs 语言分块），但实测响应**没有任何** `cache-control` / `etag` / `expires`。实测经代理的首屏四件套线上字节 476 KB gzip（JS 237+211 KB、CSS 19+9 KB；同一批文件本地 `gzip -6` 压出来是 404 KB，dsh web 自带的压缩率略低），500 kbps 下约 7.6 秒，而且每次冷开都可能重下。

代理因此对 `/assets/**` 的 200 响应补：

```
cache-control: public, max-age=31536000, immutable
```

两条不变量保证它安全：

- **文件名即版本**：内容一变哈希就变，浏览器不会拿到「同名的旧内容」；
- **HTML 仍是 `no-store`**：文档由代理注入 polyfill，必须每次重新取，它就是版本锚点。

实现落在 `lib/proxy.mjs` 的 `immutableAssetCacheControl(pathname, status)`，在压缩分支与透传分支两处应用（上游已 gzip 走后者，未压缩走前者）。范围**只限** `/assets/` 前缀：DSH 自己的 `/plugins/**` 客户端包早已由 `dsh-client-modules` 设置同样的 immutable 头，不需要也不应该由我们重复处理。

### 4. 退役出口：`/pocket-app/**` 不返回 404

已经「添加到主屏幕」的图标背后是作用域 `/pocket-app/` 的 Service Worker，它会把整页缓存住——直接 404 的话，用户看到的是**永远不更新的旧 App**，而不是「它没了」。因此保留一条极小的路由：

- `/pocket-app/sw.js` → 200 + `no-store`，内容是自注销脚本（清空 `caches.keys()` 并 `registration.unregister()`）；
- 其余 `/pocket-app/**` → `302 Location: /` + `no-store`（文档、图标、manifest 都回官方界面）；
- `/pocket-gw` 的 WS 升级 → `410 Gone`（不落到上游去换一个 404）。

顺带把 `?pocket=desktop|app` 加进 `stripDesktopMarkers`：这两个参数是极速版时代的开关，App 没了就只剩垃圾 query，别透传给上游。

### 5. 明确不搬迁的增益（以及为什么）

| 增益 | 结论 |
| --- | --- |
| `{epoch, seq}` 游标续传 | 官方重连走 mux 层 `connection/reset`，没有游标可续；要做得解析 Typert 私有帧（ADR 0001 已否决） |
| 幂等 `requestId` | 去重必须发生在发送语义里；代理按内容去重会吞掉两条合法的相同消息 |
| 80 ms 时间窗合并 | 合并需要理解 mux 帧语义；多个帧塞进一个 WS message，官方客户端解析不了 |
| `perMessageDeflate` | 要在代理里终止 WS、改成帧桥接（放弃 ADR 0002 的原始 TCP 透传），属于新功能而非常规改动 |
| 冷读、审批旁路 | 官方界面本身就 `follow`、本身就是主审批 UI |
| 首页尾部缓存秒开 | 官方会话数据走 WS，代理的 HTTP 缓存拦不到 |
| 输入框草稿落盘 | 官方 composer 是 Lexical contenteditable（`data-composer-input`），只能靠 `execCommand` 注入，属脆弱 DOM hack |
| `/assets/**` 再 brotli 重压 | 只对「每个版本一次」的冷加载有效（约再省 20%），不值得多一条压缩路径与内存状态 |

### 6. 计划框 / 选择框消失：记录，不在本 ADR 解决

两张卡（PlanReviewPanel `conversation.input.plan`；QuestionComposer `conversation.composer`，`select: pendingInteraction instanceof PendingQuestion`）都由**客户端瞬时状态**驱动。皮肤侧该做的已经做了（`planCss` 里两张卡 + 审批卡都有窄屏样式与 44 px 热区），所以现象是「状态没了」而不是「没样式」。剩下两类原因都不安全：

1. 弱网闪断后上游丢瞬时状态，官方客户端不会主动补拉——这正是游标续传要解决的问题，没有网关就只能做猜测式重拉；
2. 官方 right sidebar 在 `< 768 px` 时 `autoFullscreen`，面板接管主栏会连同会话与 composer 一起替换，改它属于侵入上游服务。

后续若要处理，需要一次可复现的现场（哪张卡、何时消失、是否发生在断线/切后台/点「查看全文」之后）。

## 后果

- 插件回到单一客户端：官方 Web UI 一份界面、浏览器直达，文档/测试/CI 只剩一条路径。
- 手机端仍拿到实打实的三项改善：心跳误杀减少、大响应压缩、静态资源不再重复下载（首屏 475 KB gzip 的重复成本归零）。
- 失去：断点续传、投递幂等、离线可用、秒开。**这是明确接受的取舍**——它们只在已删除的 App 里存在，而 App 不再被使用。
- 旧安装升级后：`/pocket-app/` 变 302、旧 SW 自注销、遗留 `~/.dsh/dsh-pocket/cache/` 在插件启动时被物理删除、`settings.json` 里的孤儿键不读也不写（恢复出厂整份删除）。
- 若将来 DSH 不再给 `/assets/**` 使用内容哈希文件名，immutable 会让升级后继续跑旧资源；届时必须撤掉这条规则（HTML 的 `no-store` 只是锚点，不是保护）。
