# ADR 0001：协议优化不依赖 DSH 上游改动，口袋网关跑在插件宿主进程内

- 状态：Superseded by [ADR 0006](./0006-remove-pocket-app-and-cache-official-assets.md)（极速版 App 与口袋网关已删除）
- 日期：2026-10-16

## 背景

在弱网（下行 ~500 kbps、RTT ~300 ms、丢包 ~3% 乃至偶发数秒黑洞）下，经 `dsh-pocket` 远程使用官方 DSH Web GUI 会出现三大顽疾：
1. 宿主 WebSocket 网关默认 2 s 心跳、`MAX_MISSED_HEARTBEATS = 2`（约 4–6 s 静默即杀连接），而 `$events` 与 `session.follow` 均无续传游标，任何闪断都会触发 `connection/reset`，重下最多 500 条未压缩历史消息与全量会话控制投影；
2. 官方会话面板在 `openState === 'loading'` 且 `shellPhase === 'blank'` 时将根容器置为 `data-phase="settling"`，通过 CSS 把输入框设为 `visibility: hidden`；流错误进入终态后只能靠刷新整页恢复；
3. 计划（Plan）与待办（Todos）混在全量控制基线和 `session.follow` 快照中且未开启 WebSocket `perMessageDeflate`，弱网下需要漫长等待。

由于 `dsh-pocket` 作为独立第三方插件分发，我们不能修改 DSH 上游源码，且必须支持 DSH `>= 0.2.0-rc.2` 并向前兼容 `0.2.1-alpha.5+`，同时保证卸载插件后零残留。

## 考虑过的备选方案

1. **在反向代理层解析并改写官方 `/api/remote.mux` WebSocket 帧**：耦合 DSH 内部 Typert 多路复用私有帧格式，且无法在无上游游标的情况下凭空造出增量续传。
2. **仅对官方 UI 打 CSS 与重连补丁**：能止住输入框消失与 4 s 误杀，但重连全量重拉 500 条消息与数 MB React 静态包首屏慢的问题依然存在。
3. **在 `dsh-pocket` 宿主半边内置「口袋网关」（`WS /pocket-gw`），进程内直连 DSH 宿主服务**：网关直接调用 `sessionController.page`、`sessionProjections` 并监听全局 `session/event`（自带稠密单调 `event.seq`），对外向手机端 App 提供带 `{epoch, seq}` 游标续传、80 ms 时间窗合并与 `perMessageDeflate` 压缩的紧凑协议。

## 决策

采用方案 3 + 方案 2 的组合：
- 保留 `:3081` 对官方 Web GUI 的透明反向代理作为兜底路径，并辅以阶段 1 止血补丁（`cordis.patch.yml` 放宽 `typert-gateway` 心跳、移动端 CSS 强制输入框可见与会话自愈）；
- 在口袋代理自建的 `http.Server` 上挂载 `WS /pocket-gw`（口袋网关）与 `/pocket-app/`（专属手机端 App），**不在 DSH 的 `webServer` 上注册这些远程路由**；
- 网关在宿主进程内以**冷读**方式访问会话（使用 `page` + `projections` + 被动 `session/event`，禁止调用会唤醒冷会话 Agent 的 `sessionController.follow`）；
- 由于进程内调用不携带 `ctx.invocation`、会绕过 DSH 的 `remoteAccess` 门禁，口袋网关必须在升级握手时严格执行与代理一致的 OAuth 会话校验（`sessionOk`），且只暴露静态白名单操作映射，绝不提供任意方法透传。

## 后果

- 无需改动 DSH 一行源码即可获得毫秒级游标续传（断线 5 s 恢复仅传输几 KB 增量）、帧级压缩与时间窗流合并。
- 启动时对宿主服务做能力探测（Capability Probe）：若未来 DSH 版本移除或改名内部服务，网关优雅降级并引导用户回退到官方界面兜底路径，代理透传本身零受影响。
- 所有新增路由均绑定在 `dsh-pocket` 自建代理端口上，卸载插件后端口与路由彻底消失，不留任何宿主残留。
