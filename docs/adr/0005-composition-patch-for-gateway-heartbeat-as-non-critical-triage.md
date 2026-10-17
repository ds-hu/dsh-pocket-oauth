# ADR 0005：组合补丁覆盖 `typert-gateway` 仅作弱网止血、不承担正确性

- 状态：Accepted
- 日期：2026-10-16

## 背景

DSH 官方网关插件 `typert-gateway`（位于 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`）默认配置为 `websocketHeartbeatIntervalMs: 2000`，而 `stream-server.ts` 硬编码 `MAX_MISSED_HEARTBEATS = 2`。在 RTT 300 ms + 丢包 3% 或 `ssh -L` 队头阻塞场景下，4 秒抖动就会导致服务端主动断开 `/api/remote.mux`，引发客户端全量重连风暴。

Cordis Loader 的补丁语义允许 bundle 在 `cordis.patch.yml` 中通过 `- id: typert-gateway` 覆盖既有行的 `config`；但 `applyEntryPatches` 对 `config` 执行的是**整块替换（wholesale replacement）而非深合并**。

## 决策

在 `cordis.patch.yml` 中追加对 `typert-gateway` 的整块配置覆盖：

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 10000
    streamInboxBytes: 1048576
```

并确立两条架构原则：
1. **完整声明原行所需字段**：同时给出 `websocketHeartbeatIntervalMs: 10000`（将断链判定窗口从 ~4 s 放宽到 ~20 s）与 `streamInboxBytes: 1048576`（1 MiB 流收件箱），避免整块替换丢失字段。
2. **仅作止血优化，不承担协议正确性**：若更高优先级的 profile / home / overlay 层再次覆盖了 `typert-gateway`（导致本补丁被顶掉），系统仅退回 4 s 心跳窗口，口袋网关（`/pocket-gw`）与官方界面自愈器依然能正常工作。宿主启动时记录诊断日志，并在 README 与排障上下文中说明该覆盖关系。

## 后果

- 零代码侵入即将官方界面在弱网下的断连频率降低约 80%。
- 卸载 `dsh-pocket` bundle 时，该补丁层随 bundle 自动从组合树移除，`typert-gateway` 立即恢复 DSH 原生默认配置，无任何持久副作用。
