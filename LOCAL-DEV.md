# 本地联调（开发软链）

改完代码想在本机 dsh web 里直接验证，**不用发版**——把已安装的插件换成指向本地仓库的软链即可。

原理：dsh 的插件装在 profile 的 `node_modules` 里（pnpm 软链），我们把它重新指向本地仓库目录，dsh web 重启后就加载本地代码。

---

## 一、建立软链（只需做一次）

```sh
# 插件安装位置：$DSH_HOME/profiles/web/node_modules/dsh-pocket（默认 $DSH_HOME=~/.dsh）
# 若你改过 DSH_HOME，把下面的 ~/.dsh 换成实际路径
cd ~/.dsh/profiles/web/node_modules

rm dsh-pocket
ln -s /你的/仓库/绝对路径/dsh-pocket dsh-pocket

# 确认
ls -l dsh-pocket
# dsh-pocket -> /你的/仓库/绝对路径/dsh-pocket
```

桌面版 profile 同理，把路径里的 `web` 换成 `desktop` 即可。

## 二、日常改代码流程

| 改了哪里 | 要做什么 |
| --- | --- |
| `lib/**`（远程操控组件的宿主半边 + 共享层：DOM 契约 / 传输策略枢纽 / 设置） | 直接重启 dsh web 生效 |
| `mobile/index.js`、`transport/index.js`（两个界面/传输组件的宿主半边） | 直接重启 dsh web 生效 |
| `client/**`（远程操控的客户端产物源码） | 先 `npm run build:client` 打包，再刷新页面 |
| `mobile/client/**`（手机端 WebUI 的客户端源码：`styles.js` / `responsive-shell.js` / `settings-adapter.js` / `index.jsx`） | 先 `npm run build:client` 打包成 `mobile/client/client.js`，再刷新页面 |
| `transport/client/**`（弱网传输的客户端源码：`session-healer.js` / `styles.js` / `index.jsx`） | 先 `npm run build:client` 打包成 `transport/client/client.js`，再刷新页面 |
| `mobile/package.json`、`mobile/locale/**`、`transport/package.json`、`transport/locale/**`（面板那两条 row 的包身份与标题描述） | 重启 dsh web 生效（无产物要打） |
| `cordis.patch.yml`、`transport/cordis.patch.yml`（row 结构与网关心跳等组合补丁） | 重启 dsh web 生效 |
| `mobile/` 或 `transport/` 目录本身挪了位置/改了名 | 同步改 `scripts/link-subpackages.mjs` 里的 `SUBPACKAGES`（包名 ↔ 目录的对应表） |

```sh
npm run build:client      # 打包客户端产物（只改后端可跳过）
npm test                  # 建议顺手跑一遍（沙箱内 `node --test` 会被拒时，改为逐文件 node test/xxx.test.js）
```

> **两个子包（dsh-pocket-mobile / dsh-pocket-transport）是怎么到安装物里的**：`mobile/` 与 `transport/` 是它们的源码目录，随根包 `package.json` 的 `files` 一起发布；**装完之后**由根包的 `postinstall`（`scripts/link-subpackages.mjs`）在包内建出 `node_modules/dsh-pocket-mobile -> <包根>/mobile` 与 `node_modules/dsh-pocket-transport -> <包根>/transport`，面板那两条 row 因此解析得到这两个包。
> 为什么不能靠 `dependencies` / `bundledDependencies` / 提交软链：pnpm 做 git 安装时会把 `"file:./mobile"` **相对 profile 目录**解析（那里没有 `mobile/`，安装直接失败），而仓库里提交的 `node_modules/**`（无论软链还是实体目录）在解包时会被 pnpm 丢掉——三条路都到不了安装态。
> 代价：pnpm 11 默认拦下依赖脚本，**首次 `dsh plugin add` 会以 build-blocked 失败一次**，在插件面板点「允许这些脚本并重试」后才会建出链接（`allowBuilds` 记在该 profile 的 `pnpm-workspace.yaml`）。这一步只需做一次，之后就跟着 profile 走。
> 本地开发时这个链接由 `npm install` / `npm run build:client` 顺带建出；`npm test` 的 pretest 也会跑一次，所以本机不需要手动处理。


### 三个组件怎么验证

包里有三条 Loader row（`cordis.patch.yml`），装好后在 **侧边栏 → 插件 → dsh-pocket** 卡片里应能看到「包含的组件 共 3 个」与三个独立开关：

| 组件行 | 期望 |
| --- | --- |
| `dsh-pocket`（远程操控） | 关掉后 3081 不再监听、设置里没有「手机访问」；页面/手机端照常打开官方界面 |
| `dsh-pocket-mobile`（手机端 WebUI） | 面板里有「配置」按钮，可开关遮罩、输入框优化、设置分步导航；**把浏览器窗口缩到 1024px 以下**即可看到移动端排版（左上汉堡按钮 → 抽屉侧边栏） |
| `dsh-pocket-transport`（弱网传输优化） | 关掉后 `/assets/**` 不再补 `immutable`（见下一节的第 2/3 步）、页面没有底部连接状态条、`settling` 态输入框回到官方行为；移动端排版不受影响 |
| 只开手机端 | 窄屏排版生效；远程操控那半边的功能（代理 / OAuth）不可用，传输优化也不生效（策略枢纽由远程操控行提供） |

### 静态资源强缓存怎么验证

官方前端的 `dist/assets/**` 是 Vite 内容哈希产物；**`dsh-pocket-transport` 组件开启时**，代理会给它们的 200 响应补 `immutable`（组件关掉就不补——代理本身不内置规则）：

```sh
# 1) 找一个真实产物名（本机免登录）
ASSET=$(curl -s http://127.0.0.1:3081/ | grep -o '/assets/[^"]*\.js' | head -1)
echo "$ASSET"

# 2) 响应头必须带一年 immutable
curl -sI -H 'Accept-Encoding: gzip, br' "http://127.0.0.1:3081$ASSET" | grep -i 'cache-control'
# 期望：cache-control: public, max-age=31536000, immutable

# 3) HTML 仍是 no-store（它是版本锚点，注入过 polyfill，不能缓存）
curl -sI http://127.0.0.1:3081/ | grep -i 'cache-control'
# 期望：cache-control: no-store
```

把 `dsh-pocket-transport` 关掉后重跑第 2 步，`cache-control` 应当整条消失（HTML 的 `no-store` 不受影响）。

### 弱网复现（netem 模拟器）

`transport/test/netem.mjs` 是一个可编程弱网 TCP 代理（单向延迟 / 抖动 / 令牌桶限速 / 丢包重传 / 静默黑洞 / 强制闪断 + 双向字节统计），用来在本机复现「心跳误杀、流中断、卡 loading」这些只有弱网才出现的场景：

```js
import { createNetemProxy } from './transport/test/netem.mjs';

// 把 3081 代理挂到 400 kbps、150ms 延迟、1% 丢包的链路后面，客户端连 netem.port
const netem = await createNetemProxy({ targetPort: 3081, delayMs: 150, rateKbps: 400, lossPct: 1 });
netem.blackholeFor(5000, 'stall');   // 5 秒静默：应用层能看到心跳被拖长（stall 结束后补齐字节）
netem.stats();                       // { upBytes, downBytes, connections, retransmits, blackhole }
await netem.close();
```

`node --test test/transport.test.js` 里有一条最小可用性用例（限速链路字节完整往返）保证这个装置本身不会烂掉。

改完 `lib/proxy.mjs` 想在本机验证，必须先重启 dsh web（宿主半边是进程内模块）。重新打包客户端产物不适用于这条规则（它在宿主侧）。
改了 `cordis.patch.yml` 的行结构后，可以先不重启、只用 CLI 验证组合结果：

```sh
dsh --profile web --dump-config | grep -A 4 '== dsh-pocket'
# 期望看到三条：- id: dsh-pocket / - id: dsh-pocket-mobile / - id: dsh-pocket-transport（都是裸包名）
```

### 重启 dsh web

直接 `kill` 后用 `nohup` 拉起**会被终端会话回收**，必须用 detached 方式（和插件自带的自重启同一套做法）：

```sh
# 1) 停掉当前 dsh web
kill $(lsof -ti :3080 -sTCP:LISTEN)

# 2) detached 重新拉起（日志在 /tmp/dsh-web-dev.log）
node -e "
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const out = fs.openSync('/tmp/dsh-web-dev.log', 'a');
const err = fs.openSync('/tmp/dsh-web-dev.log', 'a');
spawn('$(command -v dsh)', ['web'], {
  detached: true, stdio: ['ignore', out, err], env: process.env, cwd: process.env.HOME,
}).unref();
"

# 3) 等服务起来
curl -s -o /dev/null -w "3080:%{http_code}\n" http://127.0.0.1:3080/   # dsh web
curl -s -o /dev/null -w "3081:%{http_code}\n" http://127.0.0.1:3081/   # dsh-pocket 代理
```

## 三、确认加载的确实是本地代码

页面引用的 `client.js` 带一个 `rev` 参数，它是打包产物内容的 sha1 前 12 位。比对一下就知道有没有生效：

```sh
# 页面正在引用的版本
REV=$(curl -s http://127.0.0.1:3080/ | grep -o 'dsh-pocket/client.js?rev=[a-f0-9]*' | head -1 | cut -d= -f2)
echo $REV

# 本地打包产物的 sha1 前 12 位
shasum -a 1 client/client.js | cut -c1-12
```

两者一致 = 本地代码已生效。

## 四、换回 GitHub 版本（当前默认安装方式）

```sh
dsh plugin --profile web add github:cup113/dsh-pocket-oauth
```

重装会把软链换成从仓库 main 拉取的正式安装（包名是 `dsh-pocket`，仓库名是 `dsh-pocket-oauth`）：

```sh
ls -l ~/.dsh/profiles/web/node_modules/dsh-pocket      # 真实目录，不再是软链
grep -A2 'dsh-pocket:' ~/.dsh/profiles/web/pnpm-lock.yaml
# specifier: github:cup113/dsh-pocket-oauth
# version: https://codeload.github.com/cup113/dsh-pocket-oauth/tar.gz/<提交>
```

之后重启 dsh web 即可。pnpm 会把结果 pin 在当时的 main 提交上——想跟上新提交，再跑一次上面的命令。

> **从 GitHub 装时会有一次 build-blocked**：pnpm 11 默认拦下依赖脚本，而两个子包正是由根包 `postinstall` 建链接的。命令会以 `ERR_PNPM_IGNORED_BUILDS` 失败一次，按提示在**插件面板**点「允许这些脚本并重试」（等价于把 `allowBuilds` 里的 `dsh-pocket@…` 设为 `true`）即可；放行后重跑同一条 add 命令，`mobile/` 与 `transport/` 那两条 row 就能激活。授权按包名记在该 profile 的 `pnpm-workspace.yaml`，之后升级不用再点。
> 注意：这条授权允许该包以**你的用户权限**执行 `postinstall`，请确认你装的是本仓库（`github:cup113/dsh-pocket-oauth`）。
> 装完可以确认子包链接已在安装物里：`ls ~/.dsh/profiles/web/node_modules/dsh-pocket/node_modules/` 应能看到 `dsh-pocket-mobile` 与 `dsh-pocket-transport`。

> 设置页的「一键更新」会探测安装方式并自动选择正确动作：本地 clone 软链（`link:`）安装执行 `git pull --ff-only`，`github:` 规格安装重跑上面的 add 命令；两者成功后都会自动重启生效。

---

## 注意事项

- **软链期间，你日常用的 dsh web 跑的都是本地仓库代码**（包括未提交的改动），而别人通过 npm 装到的仍是发布版——两边互不影响。
- 本地仓库需要装过依赖（`npm install`），否则 `lib/` 用到的 `cordis` / `cosmokit` 等解析不到，插件会静默加载失败。
- 改完 `client/`、`mobile/client/` 或 `transport/client/` 忘了打包，界面不会变（dsh web 加载的是三份 `client.js` 产物，不是 `.jsx` / `.js` 源码）。
- 电脑重启后自己正常启动 dsh web 即可，软链是持久的，仍然加载本地代码。

## 常见问题

**手机页面没变化**：先确认 dsh web 重启成功（看 `/tmp/dsh-web-dev.log`）；如果改的是 `client/**`、`mobile/client/**` 或 `transport/client/**`，多半是忘了 `npm run build:client`，再刷新页面（客户端产物的进出在下一次页面加载时生效）。

**手机上是桌面排版、没有汉堡按钮**：移动端排版只在窗口宽度 < 1024px 时生效（与 DSH 框架折叠侧边栏的断点一致）。桌面浏览器把窗口缩窄即可复现；手机上先用「插件 → dsh-pocket」卡片确认 `dsh-pocket-mobile` 是开着的。

**代理端口 3081 起不来**：插件没加载成功。检查安装目录/软链路径是否正确、仓库依赖是否装好；也可以 `curl -s http://127.0.0.1:3080/` 看返回的 HTML 里有没有 `dsh-pocket/client.js`。

**那条 `dsh-pocket-mobile` / `dsh-pocket-transport` row 一直 Not running / `failed to import`**：子包链接没建出来。先看 `ls ~/.dsh/profiles/<p>/node_modules/dsh-pocket/node_modules/`——若缺对应目录，说明 `postinstall` 没跑过（多半是那次 `add` 卡在 build-blocked）：在插件面板允许脚本后重跑一次 add 命令，或手动在该包目录里执行 `node scripts/link-subpackages.mjs`。

**端口被占**：`lsof -ti :3080` 或 `lsof -ti :3081` 查占用进程；dsh-pocket 的代理在 3081 被占时会自动顺延到下一个端口。

