// dsh-pocket 网页客户端打包：
//   - client/index.jsx → client/client.js（loader id = 根包名，即 package.json 的 name）
//   - mobile/client/index.jsx → mobile/client/client.js（loader id = 手机端子包的 name）
//
// **loader id 必须等于所属包的 name**：宿主把每个插件包当作一个客户端模块，浏览器按
// **包名**去请求 `<name>/client` 并要求同一个 id 完成注册。id 与包名不一致时页面会炸成
//     @ds-hu/dsh-pocket: import failed: client-modules: could not load "@ds-hu/dsh-pocket":
//     plugins/??...: loaded without registering "@ds-hu/dsh-pocket" via __ModuleLoader__.load
// 且整页 "Failed to load plugins"（改包名却忘了改这里 = 整个 Web GUI 起不来）。
// 所以 id 一律从 manifest 读，不写字面量；测试也按 manifest 断言。
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceDir, '..');

/** 两个包的 manifest：包名就是各自的 loader id（唯一事实来源）。 */
const rootManifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const mobileManifest = JSON.parse(readFileSync(resolve(packageRoot, 'mobile/package.json'), 'utf8'));

/**
 * 打包目标：入口、默认产物路径、loader id、以及一致性测试用的产物覆盖环境变量。
 * 只要设置了任意一个 OUT 环境变量，就**只**构建被覆盖的目标——测试不会顺手改写工作区里
 * 另一份产物（那会让「源码 ↔ 产物」一致性校验失去意义）。
 */
export const TARGETS = Object.freeze([
  {
    id: process.env.DSH_POCKET_CLIENT_ID ?? rootManifest.name,
    entry: resolve(packageRoot, 'client/index.jsx'),
    output: resolve(packageRoot, 'client/client.js'),
    override: process.env.DSH_POCKET_CLIENT_OUT,
  },
  {
    id: process.env.DSH_POCKET_MOBILE_CLIENT_ID ?? mobileManifest.name,
    entry: resolve(packageRoot, 'mobile/client/index.jsx'),
    output: resolve(packageRoot, 'mobile/client/client.js'),
    override: process.env.DSH_POCKET_MOBILE_CLIENT_OUT,
  },
]);

/**
 * 把 esbuild 产物包进 DSH 客户端模块系统的注册包装。
 * @param {string} bundled esbuild 产出的 CJS 代码
 * @param {string} loaderId 图行 id（= 包名）
 * @returns {string} 可被页面直接执行的注册脚本
 */
export function wrapBundle(bundled, loaderId) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // The DSH client module system provides react as a module, never as a
    // global. esbuild keeps react external (see the build config above) and its
    // classic JSX transform emits bare React.createElement calls, so the
    // factory must bind React itself - otherwise any JSX in the sources crashes
    // at render time with "ReferenceError: React is not defined". The binding
    // costs nothing and must survive a future second target.
    var React = require("react");
${bundled}
    return module.exports;
  }
});
`;
}

/**
 * 构建一个目标。
 * @param {{id:string, entry:string, output:string, override?:string}} target 目标描述
 * @returns {Promise<string>} 实际写入的路径
 */
export async function buildTarget(target) {
  const result = await build({
    entryPoints: [target.entry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome100'],
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
    write: false,
    minify: process.env.NODE_ENV === 'production',
    legalComments: 'none',
    loader: {
      '.css': 'text',
    },
  });
  const bundled = result.outputFiles?.[0]?.text;
  if (!bundled) throw new Error(`esbuild did not produce a client bundle for ${target.id}`);
  const outputPath = target.override ? resolve(target.override) : target.output;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, wrapBundle(bundled, target.id), 'utf8');
  return outputPath;
}

const overridden = TARGETS.some((target) => target.override !== undefined && target.override !== '');
const selected = overridden ? TARGETS.filter((target) => target.override !== undefined && target.override !== '') : TARGETS;
for (const target of selected) console.log(`Wrote ${await buildTarget(target)}`);
