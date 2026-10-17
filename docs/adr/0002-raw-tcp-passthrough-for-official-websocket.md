# ADR 0002：官方界面透传路径保持原始 TCP 管道，不做 WebSocket 终止

- 状态：Accepted
- 日期：2026-10-16

## 背景

上游 DSH 的 `WebSocketServer({ noServer: true })` 默认关闭了 `perMessageDeflate`。一种直观想法是在 `dsh-pocket` 代理的 `upgrade` 处理中终止客户端 WebSocket（开启 `perMessageDeflate`），再由代理作为 WebSocket 客户端连向上游 `127.0.0.1:<dshPort>/api/remote.mux` 逐帧转发。

## 决策

**不在官方界面透传路径上终止 WebSocket**：代理对一切 WebSocket 升级继续保持原始 TCP 字节流双向 `pipe`（加上既有的 30 s 帧级 Ping 保活注射器），没有任何一条 WebSocket 路径被代理终止。

理由如下：
1. **避免双重帧解析与背压失真**：在代理层把 `/api/remote.mux` 解包再重打包会破坏端到端 TCP 背压，且一旦上游协议扩展二进制帧、分片帧或自定义扩展头，中间终止层极易引入隐蔽的断流 bug（此前 PR #49、#56 已证明 upgrade 生命周期边界非常脆弱）。
2. **弱网收益走更薄的路径**：不改协议也能拿到大部分收益——大响应压缩（17 MB 历史 → ~1 MB）、`/assets/**` 强缓存、客户端会话自愈，以及组合补丁放宽网关心跳（`transport/cordis.patch.yml`：`websocketHeartbeatIntervalMs` 2000 → 10000 ms、`streamInboxBytes` 1 MiB，见 ADR 0005）。

## 后果

- 官方界面透传路径零回归风险：既有测试里的 WebSocket 握手、首帧 head 送达、半开连接 RST 销毁与心跳探针不变量完全保留。
- `upgrade` 入口只做认证与头改写（`loopbackAuthority`、清理 `dsh-desktop-*` 参数），然后原样 `pipe` 到上游。
