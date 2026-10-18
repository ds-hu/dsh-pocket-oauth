# ADR 0005：组合补丁覆盖 `typert-gateway` 仅作弱网止血、不承担正确性

- 状态：Accepted
- 日期：2026-10-16

## 背景

DSH 官方网关插件 `typert-gateway`（位于 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`）默认配置为 `websocketHeartbeatIntervalMs: 2000`，而 `stream-server.ts` 硬编码 `MAX_MISSED_HEARTBEATS = 2`。在 RTT 300 ms + 丢包 3% 或 `ssh -L` 队头阻塞场景下，4 秒抖动就会导致服务端主动断开 `/api/remote.mux`，引发客户端全量重连风暴。

Cordis Loader 的补丁语义允许 bundle 在 `cordis.patch.yml` 中通过 `- id: typert-gateway` 覆盖既有行的 `config`；但 `applyEntryPatches` 对 `config` 执行的是**整块替换（wholesale replacement）而非深合并**。

## 决策

在弱网传输优化组件自带的 `transport/cordis.patch.yml` 中对 `typert-gateway` 做整块配置覆盖（由根包 `dsh.bundle.patch` 数组引入）：

```yaml
- id: typert-gateway
  name: '@deepseek-ai/dsh-api-gateway'
  config:
    websocketHeartbeatIntervalMs: 10000
    streamInboxBytes: 1048576
```

并确立三条架构原则：

1. **完整声明原行所需字段**：同时给出 `websocketHeartbeatIntervalMs: 10000`（将断链判定窗口从 ~4 s 放宽到 ~20 s）与 `streamInboxBytes: 1048576`（1 MiB 流收件箱，默认 256 KiB），避免整块替换丢失字段。
2. **`name` 是守卫而不是冗余**：`applyEntryPatches` 只在补丁提供 `name` 时才做一致性校验（`vendor/include/src/index.ts`）。不写 `name` 的话，一旦有别的 bundle 复用了 `typert-gateway` 这个 id，这段 `config` 会被**静默套到错误的插件上**（被对方 schema 拒绝或直接忽略，都不报错）；写上之后，id 冲突会退化成 `patch: name mismatch for "typert-gateway"` 警告 + 跳过。
3. **仅作止血优化，不承担协议正确性**：若更高优先级的 profile / home / overlay 层再次覆盖了 `typert-gateway`（导致本补丁被顶掉），系统仅退回 4 s 心跳窗口，官方界面自愈器依然能正常工作。宿主启动时由 `transport/index.js` 的 `reportGatewayOverride()` 读回该行并记一条 info/warn 日志——「生效 / 被顶掉 / id 被占用」三种结果都可检索；README 排障表另给离线自检命令。
4. **补丁在组合层，不随组件开关切换**：`typert-gateway` 在构造时捕获配置，运行期改配置只能重启 gateway fiber（会切断所有在飞流），因此这条补丁随包安装始终生效；组件 row 的开关控制的是缓存策略与会话自愈这些运行时能力（见 ADR 0007）。

### `streamInboxBytes` 的取舍

1 MiB 是**每逻辑流**的上行缓冲上限（`UplinkInbox` 的 `maxBytes`），不是全局上限：并发 N 条流最坏占用 N × 1 MiB。官方界面同时活跃的流通常是「一条会话 + 事件通道」量级，因此这个提升是安全的；但它确实把单个失控流的最坏内存占用放大了 4 倍（256 KiB → 1 MiB）。若未来出现大量并发流的组合，应重新评估这个值。

## 后果

- 零代码侵入即将官方界面在弱网下的断连频率降低约 80%。
- 卸载 `dsh-pocket` bundle 时，该补丁层随 bundle 自动从组合树移除，`typert-gateway` 立即恢复 DSH 原生默认配置，无任何持久副作用。
- 单独关掉 `dsh-pocket-transport` 这条 row **不会**撤掉心跳放宽——这是刻意取舍，代价是面板开关与组合补丁的语义不完全重合。
- 该覆盖**不承担正确性**：被顶掉只损失重连容忍度。但「被顶掉」不再是静默的——启动日志会给出结论（见决策第 3 条）。
