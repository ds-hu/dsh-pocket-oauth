// 把包内子包接到安装物里：node_modules/<子包名> -> <包根>/<目录>
//
// 为什么必须靠这个脚本，而不是 dependencies / bundledDependencies：
//   - row 名（dsh-pocket-mobile / dsh-pocket-transport）要能被解析成**包**，DSH 的
//     packageDirFromAnchor() 只认 Node 的 node_modules 向上查找
//     （`<包根>/node_modules/<名字>/package.json`）；
//   - `"dsh-pocket-mobile": "file:./mobile"` 在 git 安装时会被 pnpm 相对**profile 目录**解析，
//     而那里没有 mobile/ → 安装直接失败：ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND；
//   - pnpm 打 git 包时会丢掉仓库里提交的 node_modules/**（软链与实体目录都丢），
//     所以「提交一条软链」这条路在安装态不存在；
//   - 因此由 postinstall 在**已解包的真实包目录**里把链接建出来，anchor 查找即可命中。
//
// 链接指向 `<包根>/<目录>`，也就是随 files 一起发布的子包源码目录（不是 ../mobile 这种
// 依赖相对位置的写法）：即使 pnpm 将来把包目录挪到别处，链接依然指向包内的子包目录。
//
// pnpm 11 默认拦下依赖脚本：首次 `dsh plugin add` 会以 build-blocked 失败，
// 由 DSH 插件面板「允许这些脚本并重试」（或 allowBuilds）放行后重跑，链接才会建立。
// 本脚本**永不失败**：链接建不出来时只打印警告并 exit 0——子包缺失只会让对应 row
// 保持 Not running，不能因此弄挂整个插件的安装。

import { lstat, mkdir, readlink, rm, symlink, cp, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录（postinstall 的 cwd 即包根，这里仍按脚本位置解析，二者一致）。 */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 需要接进安装物的子包：包名（= cordis.patch.yml 里那条 row 的 name）与包内目录。
 * 顺序无关，但保持与面板里 row 的顺序一致，日志更好读。
 */
export const SUBPACKAGES = Object.freeze([
  Object.freeze({ name: 'dsh-pocket-mobile', dir: 'mobile' }),
  Object.freeze({ name: 'dsh-pocket-transport', dir: 'transport' }),
]);

/**
 * 某个子包需要存在的链接：安装物内的 node_modules/<name> → 包内目录。
 * @param {{name:string,dir:string}} subpackage 子包描述
 * @param {string} [root] 包根目录
 * @returns {{path:string, target:string}}
 */
export function subpackageLink(subpackage, root = packageRoot) {
  return { path: join(root, 'node_modules', subpackage.name), target: join(root, subpackage.dir) };
}

/**
 * 复原子包链接：已经是正确链接就跳过，否则删掉（副本目录/文件）重建。
 * Windows 的 junction 不接受相对目标，所以统一用绝对目标；`dir` 类型在两端都成立。
 * @param {{path:string, target:string}} link 链接路径与绝对目标
 * @param {string} [platform] 目标平台（测试注入用）
 * @returns {Promise<'ok'|'linked'>} 是否发生了改动
 */
export async function ensureLink(link, platform = process.platform) {
  const current = await lstat(link.path).catch(() => null);
  if (current?.isSymbolicLink()) {
    const target = await readlink(link.path).catch(() => null);
    if (target === link.target || target === resolve(link.path, '..', target)) return 'ok';
  }
  await mkdir(dirname(link.path), { recursive: true });
  await rm(link.path, { recursive: true, force: true });
  await symlink(link.target, link.path, platform === 'win32' ? 'junction' : 'dir');
  return 'linked';
}

/**
 * 确保一个子包链接存在。链接不可用时退化为复制，再不行就只告警——绝不抛错。
 * @param {{name:string,dir:string}} subpackage 子包描述
 * @param {string} [root] 包根目录
 * @param {string} [platform] 目标平台（测试注入用）
 * @returns {Promise<'ok'|'linked'|'copied'|'skipped'>}
 */
export async function ensureSubpackageLink(subpackage, root = packageRoot, platform = process.platform) {
  const link = subpackageLink(subpackage, root);
  const source = await stat(link.target).catch(() => null);
  if (source?.isDirectory() !== true) {
    console.warn(`dsh-pocket: ${link.target} is missing; the ${subpackage.name} row will not activate`);
    return 'skipped';
  }
  try {
    return await ensureLink(link, platform);
  } catch (error) {
    // 某些 Windows 环境不允许建链接（开发者模式 / 权限）；退回复制，功能等价，只是不再共享源码。
    try {
      await rm(link.path, { recursive: true, force: true });
      await cp(link.target, link.path, { recursive: true });
      console.warn(`dsh-pocket: could not link ${subpackage.name} (${String(error)}); copied it instead`);
      return 'copied';
    } catch (copyError) {
      console.warn(`dsh-pocket: could not deliver ${subpackage.name} (${String(copyError)}); the row will not activate`);
      return 'skipped';
    }
  }
}

/**
 * 确保全部子包链接存在（postinstall 入口）。
 * @param {string} [root] 包根目录
 * @param {string} [platform] 目标平台（测试注入用）
 * @returns {Promise<Array<{name:string,result:'ok'|'linked'|'copied'|'skipped'}>>}
 */
export async function ensureSubpackageLinks(root = packageRoot, platform = process.platform) {
  const results = [];
  for (const subpackage of SUBPACKAGES) {
    results.push({ name: subpackage.name, result: await ensureSubpackageLink(subpackage, root, platform) });
  }
  return results;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const subpackage of SUBPACKAGES) {
    const result = await ensureSubpackageLink(subpackage);
    if (result !== 'skipped') console.log(`dsh-pocket: ${result} ${subpackageLink(subpackage).path}`);
  }
}
