// dsh-pocket 设置持久化（$DSH_HOME/dsh-pocket/settings.json）
//
// 当前项：
//   - proxyPort      代理监听端口（默认 3081），属「远程操控」组件
//
// 这份文件由**远程操控**组件（根包 dsh-pocket）独占读写：手机端与传输优化组件都是纯客户端
// 实现，不读写这里。引入本文件时**不要**引入第三方依赖（根 package.json 的 exports["./lib/*"]
// 对外暴露）。
//
// 本文件同时是**插件数据目录的唯一事实源**（`pocketDir()`）：settings.json / oauth.json
// （lib/oauth.mjs 管理）/ restarted.json 全部住在它下面。别的模块一律从它派生，不要各自再
// 拼一次 `$DSH_HOME ?? ~/.dsh` + `dsh-pocket`——三份拷贝迟早会漂移。

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** 插件在 $DSH_HOME 下的目录名。 */
const PLUGIN_DIR_NAME = 'dsh-pocket';

/** dsh-pocket 的插件数据目录（$DSH_HOME/dsh-pocket，默认 ~/.dsh/dsh-pocket）。 */
export function pocketDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), PLUGIN_DIR_NAME);
}

export function settingsPath() {
  return join(pocketDir(), 'settings.json');
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
