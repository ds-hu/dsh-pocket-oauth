# ADR 0004：会话尾部落盘缓存与无残留清除策略

- 状态：Superseded by [ADR 0006](./0006-remove-pocket-app-and-cache-official-assets.md)（极速版 App 与口袋网关已删除）
- 日期：2026-10-16

## 背景

当手机在弱网下冷启动打开某个长会话，或宿主刚重启、或者用户在多个历史会话之间快速切换时，若每次都实时穿透调用 DSH 会话存储读取并组装消息与投影，不仅增加首屏等待，也会在断线重连瞬间造成空白期。同时，用户明确要求：**卸载本插件或执行恢复出厂设置后，不能在系统中留下隐蔽残留**。

## 决策

在宿主侧引入 `lib/cache.mjs`，于 `$DSH_HOME/dsh-pocket/cache/` 下维护有界明文缓存（目录权限 `0700`、文件权限 `0600`、临时文件 + `rename` 原子写入）：

1. **严格配额**：
   - 每个会话最多缓存尾部 **50 条**消息项（`tape/<sessionId>.json`）与最新投影快照（`projections/<sessionId>.json`）；
   - 全局磁盘占用上限 **32 MiB**，超过时按最近最少使用（LRU `updatedAt`）淘汰旧会话文件；
   - 单文件 TTL **7 天**，读取或清扫时过期自动删除。
2. **只存非敏感投影视图**：缓存仅保存会话摘要列表、尾部转录项与 Plan/Todo 投影，绝不缓存任何 OAuth 凭据或会话密钥。
3. **一键清除与联动重置**：
   - 新增 RPC 端点 `pocket.cache.clear`，供桌面「手机访问」设置页与手机端 App 一键清空；
   - `resetPocketState()`（恢复出厂设置）同步调用 `clearPocketCache()`，保证「恢复出厂」一次性清空 `settings.json`、`oauth.json` 与 `cache/`。

## 后果

- 口袋网关在响应 `sub.session` 时可立即从内存/磁盘尾部缓存给出首屏快照，后台再异步校验最新游标并补齐增量。
- 所有持久化文件严格收束在 `$DSH_HOME/dsh-pocket/` 单一目录下，恢复出厂或删除该目录即 100% 无残留。
