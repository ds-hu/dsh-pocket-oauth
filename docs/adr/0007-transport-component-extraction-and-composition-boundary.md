# ADR 0007：弱网传输优化抽成第三个可开关组件，心跳补丁留在组合层

- 状态：Accepted
- 日期：2026-10-18
- 相关：ADR 0002（官方 WebSocket 原始 TCP 透传）、ADR 0005（心跳组合补丁）

## 背景

弱网加固最初直接长在两个既有半边里：强缓存规则写在 `lib/proxy.mjs`，会话自愈与连接状态条写在 `mobile/client/**`。这带来两个问题：

1. **关不掉**：不需要强缓存或自愈的用户只能整包禁用插件；而关掉「手机端 WebUI」会连带失去传输优化——尽管这些能力对桌面端同样有意义（settling 态输入框消失与流中断不是手机独有）。
2. **边界错位**：传输优化既不属于「远程操控」（代理 + OAuth），也不属于「手机端 WebUI」（窄屏排版），却同时在改前者的代理代码与后者的客户端产物。

## 决策

1. **新增第三个包内子包** `transport/`（`dsh-pocket-transport`），与 `dsh-pocket`、`dsh-pocket-mobile` 同级：自己的 Loader row、宿主半边、客户端半边、locale、组合补丁与客户端产物。根 `cordis.patch.yml` 增加第三条 insert row。
2. **运行时能力经 Cordis service 反向注册**：root 行 `ctx.provide('pocketTransport', hub)`；传输组件 `inject = ['pocketTransport']`，在 `ctx.effect` 里 `register(assetCachePolicy)`。代理只向枢纽询问 `cache-control`，**自身不内置任何优化规则**。row 关掉 → 注册随 effect 撤销 → 行为退回官方原生（HTML 的 `no-store` 不受影响）。
3. **组合补丁留在组合层**（`transport/cordis.patch.yml`，由根包 `dsh.bundle.patch` 数组引入）：`typert-gateway` 在构造时捕获配置（`RemoteStreamMuxServer`），运行期改配置只能走 `entry.update` → 重启 gateway fiber，会切断所有在飞流并可能级联重启服务。因此心跳放宽 / 流收件箱随包安装始终生效，**不随 row 开关切换**；row 开关控制的是缓存策略、会话自愈与状态条。
4. **共享 DOM 契约抽到 `lib/dom-contract.mjs`**（会话根、会话 id、对话滚动容器、回合节点）：两个客户端产物都从这里取，上游改名只改一处。

## 备选与取舍

- **把心跳也做成可切换**：需要运行期重启 gateway fiber——丢在飞流、可能级联重启，否决。
- **用共享可变模块代替 service**：两个包在 HMR 下会被分别重载，模块实例会分裂成两份状态；service 由 root fiber 拥有，重载时 Cordis 自动通知依赖方重新注册。
- **继续留在 `mobile/` 里**：关掉移动端排版会连带失去传输优化，且桌面端拿不到 settling 修复。
- **只把缓存规则挪走、自愈留在 mobile**：边界仍然错位，且自愈器与状态条在桌面端同样有用（状态条由样式表在 ≥1024px 隐藏）。

## 后果

- 面板里三条 row 各自可开关；传输优化关掉 = 不注册缓存策略、不加载自愈器与状态条、settling 输入框回到官方行为。
- 代理与传输组件解耦：代理不认识任何具体优化，新增优化 = 在传输组件里加一条策略。
- 代价：多一个包（多一份 postinstall 链接、locale 与客户端产物），以及「心跳补丁不随开关切换」这一条需要向用户解释的语义（README 与面板描述均已注明）。
- 面板开关的语义因此是「运行时传输能力」，不是「这个包的一切」——这正是 ADR 0005 第 4 条与本文档要共同说明的边界。
