// dsh-pocket 设置持久化（$DSH_HOME/dsh-pocket/settings.json）
//
// 当前项：
//   - proxyPort      代理监听端口（默认 3081），属「远程操控」组件
//
// 极速版时代还有 appEnabled / appEntry / cacheEnabled / cacheMaxItems / cacheMaxMiB /
// cacheTtlDays 六个键，随 App 与口袋网关一起删除（ADR 0006）。旧文件里若还留着这些孤儿键，
// 读写都不会碰它们，「恢复出厂设置」会连同整份文件一起清掉——与历史遗留的
// mobileRightbarEnabled 同一套处理方式。
//
// 这份文件由**远程操控**组件（根包 dsh-pocket）独占读写：手机端组件是纯客户端实现，
// 不读写这里。引入本文件时**不要**引入第三方依赖（根 package.json 的 exports["./lib/*"]
// 对外暴露）。
// OAuth 凭据/绑定/回调白名单存在同目录 oauth.json（lib/oauth.mjs 管理，属远程操控组件）。

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const settingsRel = join('dsh-pocket', 'settings.json');
export function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { /* 无文件/损坏 → 默认 */ }
  return {};
}

function writeSettings(s) {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch { /* 忽略 */ }
  return s;
}

// ---------- 恢复出厂设置 ----------
// 设置出问题时的临时兜底：删掉 settings.json 即回到出厂默认。
// DSH 自身的会话、模型、插件配置都在 $DSH_HOME 的其他目录，不受影响。

/** 删除本机设置文件（不存在也算成功）；返回 true 表示已清空。 */
export function resetSettings() {
  try {
    rmSync(settingsPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------- 代理端口（issue #70） ----------
// 局域网代理的监听端口（默认 3081）。插件模式下唯一改法就是写 settings.json 的
// proxyPort 字段（CLI 模式可用 dsh-pocket --port）。允许范围 1-65535；
// 端口已被占用时 dsh web 启动会直接抛 EADDRINUSE（保持原行为），不必在 setter 校验。
/** 当前代理端口（0 = 用默认 3081）。 */
export function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}

/** 设置代理端口（持久化）。空/0/非法值清除，回退默认 3081。 */
export function setProxyPort(value) {
  const n = Number(value);
  const s = readSettings();
  if (Number.isInteger(n) && n >= 1 && n <= 65535) s.proxyPort = n;
  else delete s.proxyPort;
  writeSettings(s);
  return proxyPort();
}

// ---------- 极速版遗留缓存（ADR 0006） ----------
// 生产者（lib/cache.mjs 与口袋网关）已随极速版 App 删除，`cache/` 目录里的 ≤32 MiB 数据
// 再也没有任何读路径。插件启动与恢复出厂各清一次，路径就是 settings.json 所在目录的子目录，
// 不存在误删面。

/** 极速版时代的尾部落盘缓存目录（可能不存在）。 */
export function legacyCachePath() {
  return join(dirname(settingsPath()), 'cache');
}

/** 删除极速版遗留缓存目录（best-effort；不存在也算成功）。 */
export function purgeLegacyCache() {
  try { rmSync(legacyCachePath(), { recursive: true, force: true }); return true; } catch { return false; }
}
