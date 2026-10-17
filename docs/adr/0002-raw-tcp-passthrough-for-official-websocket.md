# ADR 0002：官方界面透传路径保持原始 TCP 管道，不做 WebSocket 终止

- 状态：Accepted
- 日期：2026-10-16

## 背景

上游 DSH 的 `WebSocketServer({ noServer: true })` 默认关闭了 `perMessageDeflate`。一种直观想法是在 `dsh-pocket` 代理的 `upgrade` 处理中终止客户端 WebSocket（开启 `perMessageDeflate`），再由代理作为 WebSocket 客户端连向上游 `127.0.0.1:<dshPort>/api/remote.mux` 逐帧转发。

## 决策

**不在官方界面透传路径上终止 WebSocket**：代理对非 `/pocket-gw` 的一切 WebSocket 升级继续保持原始 TCP 字节流双向 `pipe`（加上既有的 30 s 帧级 Ping 保活注射器）。只对我们自建的 `/pocket-gw` WebSocket 端点开启 `perMessageDeflate`。

理由如下：
1. **避免双重帧解析与背压失真**：在代理层把 `/api/remote.mux` 解包再重打包会破坏端到端 TCP 背压，且一旦上游协议扩展二进制帧、分片帧或自定义扩展头，中间终止层极易引入隐蔽的断流 bug（此前 PR #49、#56 已证明 upgrade 生命周期边界非常脆弱）。
2. **收益已被口袋网关覆盖**：弱网下的主力交互由 `/pocket-gw` + 手机端 App 承担，该通道原生具备 `perMessageDeflate`、80 ms 流合并与增量续传，流量节省比单纯给 `/api/remote.mux` 套一层 deflate 高出一个数量级。
3. **官方路径靠组合补丁止血即可**：通过 `cordis.patch.yml` 将 `typert-gateway` 的 `websocketHeartbeatIntervalMs` 从 2000 ms 放宽到 10000 ms，`streamInboxBytes` 提升至 1 MiB，即可消除官方界面在弱网下的频繁误杀。

## 后果

- 官方界面透传路径零回归风险，既有 16 个测试文件的 WebSocket 握手、首帧 head 送达、半开连接 RST 销毁与心跳探针不变量完全保留。
- `/pocket-gw` 在 `upgrade` 入口按 `pathname === '/pocket-gw'` 分流到独立的 `WebSocketServer({ noServer: true, perMessageDeflate: ... })`，两条路径互不干扰。
