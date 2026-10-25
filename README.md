# dsh-local-browser-web

一个 DeepSeek Harness（DSH）插件：用**本机浏览器**（CDP，可选 Playwright）为 `ctx.web` 能力接缝提供 搜索`web_search` 与 抓取`web_fetch` provider，并补齐内置远程 API 之外的**可扩展引擎注册表**、**四阶段清洗管线**、**质量过滤层**与**图形化设置页**。

- 搜索 provider id：`local-browser-search`
- 抓取 provider id：`local-browser-fetch`
- profile 条目 id（也是设置命名空间）：`local-browser-web`
- 包名：`dsh-local-browser-web`（插件的浏览器半侧挂在**根行**上，见下文「挂载」）

---

## 目录

- [能力总览](#能力总览)
- [内置引擎](#内置引擎)
- [出网代理](#出网代理)
- [安装](#安装)
- [GUI 入口与界面操作](#gui-入口与界面操作)
- [在界面中添加自定义引擎](#在界面中添加自定义引擎)
- [设置字段含义与默认值](#设置字段含义与默认值)
- [手动编辑 cordis.patch.yml](#手动编辑-cordispatchyml)
- [回退到 deepseek-official](#回退到-deepseek-official)
- [本地浏览器依赖与 CDP 连接](#本地浏览器依赖与-cdp-连接)
- [第三方扩展 API](#第三方扩展-api)
- [错误码](#错误码)
- [开发：构建与测试](#开发构建与测试)
- [与提示词的功能点变更记录](#与提示词的功能点变更记录)
- [已知限制](#已知限制)

---

## 能力总览

| 层 | 做什么 |
| --- | --- |
| **搜索 Provider** | `ctx.web.registerSearchProvider` 注册 `local-browser-search`。执行链：引擎注册表 → `bail`/`parallel` 调度 → 可注册解析策略 → 质量排序。 |
| **引擎注册表** | Bing、DuckDuckGo、百度、百度桌面端、Google、360 都只是**默认条目的数据**，不是代码路径。同一张表里可增删启停、调顺序、改 endpoint、换解析策略。 |
| **解析策略注册表** | 内置 `html-bing` / `html-ddg` / `html-baidu` / `html-google` / `html-so360` / `json-generic`；第三方可通过公开 service 注册更多，零改本包源码。 |
| **抓取 Provider** | `ctx.web.registerFetchProvider` 注册 `local-browser-fetch`。执行链：四阶段清洗管线。 |
| **抓取后端注册表** | `cdp`（默认，连本机 Chrome）/ `playwright`（可选）/ `http`（纯传输）；可注册新后端。 |
| **质量过滤** | 来源分层（政府/学术/官方项目/媒体/参考/社区/聚合站）+ 一手性 + 时效 + 伪装检测 + 薄内容 / SEO 垃圾 / 低质 AIGC / 域名信誉，逐条可开关、阈值可调、总有总开关。 |
| **来源标注与冲突并排** | 把来源性质、一手/二手、发布日期、与其他来源的数值分歧写进结果 `summary`，模型直接可见。 |
| **设置页** | 挂在 `settings.section` 槽位的独立导航页，覆盖全部可调项；保存经 `form.mutate` 写入 profile 条目 `config` 并由 volatile HMR 热更新。 |
| **Agent 工具** | `local_search_test`：真实测试每个引擎并报告失败阶段；也可只读最近的操作诊断。 |

---

## 内置引擎

新装默认带六条引擎条目，全部只是 `engines` 表里的数据（界面里可增删启停）：

| id | 显示名 | kind | 端点 | 解析策略 | 默认 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `bing` | Bing | `http-html` | `https://www.bing.com/search` | `html-bing` | 启用 | 服务端渲染，无需浏览器。 |
| `duckduckgo` | DuckDuckGo | `http-html` | `https://html.duckduckgo.com/html/?q={query}` | `html-ddg` | 启用 | 走纯 HTML 端点：主站是 React 应用，代理下脚本包加载不全时整页渲染成空白（实测 `body` 文本长度为 0），而 `html/` 端点把同样十条结果服务端渲染好，不需要浏览器。 |
| `baidu` | 百度搜索 | `browser` | `https://m.baidu.com/s?word={query}` | `html-baidu` | 启用 | 百度对纯 HTTP 请求直接返回「百度安全验证」，所以走浏览器；默认用**移动端** SERP，因为桌面端 `/s` 对陌⽣网络与新建 profile 仍会拦截。 |
| `baidu-pc` | 百度搜索（桌面端） | `browser` | `https://www.baidu.com/s?wd={query}&ie=utf-8` | `html-baidu` | **停用** | 规范桌面 SERP；当浏览器 profile 已被百度信任（有 cookie / 可信网络）时，在设置页把它打开即可。 |
| `google` | Google 搜索 | `browser` | `https://www.google.com/search?q={query}&num=10` | `html-google` | 启用 | 需要能直连 Google 的网络，或在设置页「代理」里配一个能出网的代理（见下文）；结果链接是加密的 `/goto?url=` 跳转链，由引擎的 `unwrapRedirect` 换回真实地址。 |
| `so360` | 360 搜索 | `http-html` | `https://www.so.com/s?q={query}` | `html-so360` | 启用 | 服务端渲染的完整 SERP，走最便宜的 HTTP 路径，不依赖浏览器/CDP。 |

三个新解析策略各自的要点：

- `html-baidu` — 同时认**桌面端**（`#content_left` 里的 `.result` / `.c-container`，真实地址在 `mu` 属性）与**移动端**（`div.c-result`，真实地址在 `data-log` JSON 的 `mu` / `logCommonInfo.exposureInfo.url`）两种 DOM；命中「百度安全验证 / wappass」时抛 `WEB_FETCH_CHALLENGE` 而不是返回 0 条，`bail` 调度据此继续回退。
- `html-google` — 只取 `#rso` 下的 `div.MjjYud`（避免 `div.g` 嵌套导致同一条结果被读两次），标题锚点取 `h3` 所在链接，`/url?q=` 包装会被解包，Google 自家页面（cache / preferences 等）与 `[data-text-ad]` 广告块被丢弃。
- `html-so360` — `ul.result > li.res-list`，真实地址优先 `data-mdurl`；丢弃 `ec_ad` 推广块，以及指回 360 自身 SERP 的「大家都在搜」建议链接。

> **SERP 正文上限与文档上限是分开的**：搜索引擎页面会在结果列表**之前**塞进几百 KB 的内联 CSS 与启动 JSON（360 的首条结果在 330 KB 左右），所以搜索路径把正文上限抬到 `SEARCH_BODY_CHARS = 2 000 000`，不受 `maxBodyChars`（默认 100 000，用于抓取文档）截断——否则页面明明有结果也会被判成 0 条。

### 就绪条件：解析策略自己声明「页面什么时候算渲染好」

`loadEventFired` 并不可信。Google 的首个文档是个**空壳**（`body` 文本只有 17 个字符），结果列表在 2.5 秒后才由脚本注入 `#rso`；代理线路慢一点，事件与列表之间能差好几秒。谁在事件触发时立刻读 DOM，谁就拿到 0 条。

所以「等什么」由**解析策略**声明，而不是写进某个执行分支：

```ts
export const htmlGoogleParser: ResultParser = (input) => { /* … */ }
htmlGoogleParser.waitFor = ['#rso']        // 任一选择器命中即开工
```

- 渲染后端（CDP / Playwright）在 `loadEventFired` 之后等这些选择器，最多 8 秒，**超时也照读**（慢页面不该被丢掉）；
- `loadEventFired` 自身也有 8 秒软上限：代理下某个第三方资源挂住会让 `readyState` 永远是 `loading`，等满整个 60 秒预算等于白扔一个已经能读的页面；
- `browser` 类引擎若声明了就绪条件却解析出 0 条，会**自动重渲染一次**（脚本包掉链子、注入抢跑都靠这次兜回来）；没有声明条件的引擎不重试，空就是空。

### 跳转解包：`/goto?url=` 这类跳转链

Google 不再在 DOM 里给出目标地址，`#rso` 里的链接全是 `/goto?url=<加密 token>`（旧式的 `/url?q=` 已经见不到），token 只有 Google 服务端能解。唯一的出路是问一次跳转器再读它 302 的 `Location`。

这同样是**引擎条目上的一个数据字段**，靠它声明自己的跳转链长什么样：

```yaml
- id: google
  unwrapRedirect: '^https?://[^/]*\.google\.[a-z.]+/(?:goto|url)\?'
```

命中的结果会各发一次 **HEAD**（不下载目标页），并发 6 条，失败就保留原跳转链——可点的跳转链仍然能用，比丢掉这条结果划算。实测一条 `/goto?url=` 只要一次 302 就能拿到 `Location: https://github.com/deepseek-ai/deepseek-harness`，10 条结果总共多花约 1 秒。

---

## 出网代理

插件有**两条独立的出网通道**，代理必须能同时覆盖它们才有意义 —— 需要代理才能访问 Google 的人，同样需要它给 `http-html` 引擎和浏览器渲染一起用：

| 通道 | 覆盖对象 | 实现 |
| --- | --- | --- |
| HTTP | `http-html` / `api` 类引擎（Bing、360 …）与 `http` 抓取后端 | 直接与代理对话：明文目标走 absolute-form 请求，TLS 目标走 `CONNECT` 隧道，`socks5://` 走 SOCKS5 握手 |
| 浏览器 | `browser` 类引擎（百度、Google …）与 CDP / Playwright 抓取 | 把 `proxyServer` / `proxyBypassList` 交给浏览器上下文（`Target.createBrowserContext`） |

设置页「代理」页签对应的配置：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `proxy.enabled` | `false` | 总开关。关闭时两条通道都直连。 |
| `proxy.url` | 空 | 代理地址。接受 `http://127.0.0.1:7890`、`https://…`、`socks5://127.0.0.1:7891`，也接受省略协议的 `127.0.0.1:7890`（按 HTTP 处理，这是代理客户端最常见的展示形式）；HTTP 代理支持 `http://user:pass@host:port`。 |
| `proxy.bypass` | `localhost,127.0.0.1,::1` | 直连名单，逗号/空格分隔。`example.com` 覆盖其子域，`*` 表示全部直连。CDP 端点就在本机，所以回环默认在名单里。**国内引擎请写进这里**（见下）。 |
| `proxy.http` | `true` | HTTP 通道是否走代理。 |
| `proxy.browser` | `true` | 浏览器渲染是否走代理。 |

要点：

- **改完即生效**，下一次搜索/抓取就读到新值；不需要重载插件（只有 Provider 切换需要重载）。
- **保存即校验**：地址无法解析、协议不支持（`ftp://` 等）、端口非法都会让 Host 拒绝保存。
- **直连名单按目标判定**：命中的目标连代理都不连（`proxyFetch` 在发请求前先查名单），而不是「连了代理再说」。
- **重定向仍走同一出口**：`httpGet` 的重定向循环把每个 hop 都交给同一个 `send`，所以代理下的 3xx 不会掉回直连。实测 360 的验证页跳转（`qcaptcha.so.com`）在代理日志里也是经代理取回的。

### 国内站点写进直连名单（实测关键）

代理多半是为了出海（Google / DuckDuckGo），但**同一个代理会把国内引擎也带出境**，而百度、360 对境外 IP 的处置是直接回人机验证页（HTTP 200 + `wappass` / `qcaptcha`），看起来就是「引擎坏了」。实测对照：

| 配置 | bing | baidu | baidu-pc | so360 |
| --- | --- | --- | --- | --- |
| 全部走代理 | 请求失败 | 人机验证 | 人机验证 | 时通时拦 |
| 国内域名直连 | 10 条 / 0.5s | 11 条 | 10 条 | 6 条 |

所以建议这样填：

```yaml
proxy:
  enabled: true
  url: 192.168.3.74:7897
  bypass: localhost,127.0.0.1,::1,baidu.com,so.com,bing.com,qq.com,zhihu.com,csdn.net,163.com
```

直连名单还会改变浏览器的上下文策略：命中名单的目标**不建代理上下文**，因此仍使用 `shared` profile（保留登录态与 cookie）。否则一份"代理开着但目标直连"的配置会白白丢掉登录态。

### 浏览器侧的两个前提
1. **代理按上下文生效，因此开了浏览器代理就一定会新建上下文**，即使是 `shared` 模式 —— 那个上下文里没有你默认 profile 的登录态。需要「代理 + 登录态」时，二者目前无法同时满足（Chrome 没有浏览器级、可运行时修改的代理开关）。
2. **浏览器侧不使用地址里的用户名密码**：`Target.createBrowserContext` 的 `proxyServer` 只接受 `scheme://host:port`，带 userinfo 会被忽略而不是认证。需要认证的代理请用 HTTP 通道，或在本机起一个免认证的中转。

### 自测代理是否真的生效

仓库外带一个最小转发代理（只做 absolute-form 与 `CONNECT`，逐条打印），用来「从代理那一侧」确认流量确实改道：

```bash
node E:/dsh-plugins/local-forward-proxy.mjs 7899     # 或任意端口
DSH_PROXY_URL=http://127.0.0.1:7899 node E:/dsh-plugins/verify-engines.mjs "deepseek"
```

代理日志里应出现 `CONNECT www.bing.com:443`、`CONNECT m.baidu.com:443`（浏览器渲染）、以及明文目标的 `REQ GET http://…` —— 三条分别对应 HTTP 通道、浏览器通道与重定向 hop。

---

## 安装

> **研发期提示**：本仓库在开发期间**不会**把插件安装进正在运行的 DSH。`~/.dsh/profiles/web` 及 `cordis.patch.yml` 保持干净；只有在研发完成并得到许可后，才执行下面的安装步骤。

### 1. 准备依赖链接

插件通过 symlink 从 DSH 检出与已安装 profile 借用 `@deepseek-ai/*`、react、jsdom、turndown 与构建工具（不复制、不写入 DSH）：

```bash
node scripts/setup-links.mjs
```

### 2. 构建

```bash
node node_modules/typescript/bin/tsc -p tsconfig.build.json   # 宿主半侧 → lib/
node node_modules/tsdown/dist/run.mjs                         # 浏览器半侧 → lib/client.js
```

（等价于 `pnpm build`；需要 Node 22，见「开发：构建与测试」。）

### 3. 让 DSH 能解析该包

DSH 的 loader 以 **profile 目录**为解析根（`ctx.baseUrl`），因此把本插件挂进 profile 的 `node_modules` 即可：

```bash
ln -sfn /Users/wangshuai/traeWorkSpace/dsh_plugin \
  ~/.dsh/profiles/<profile>/node_modules/dsh-local-browser-web
```

> **为什么不用 `dsh plugin add`**：官方入口 `dsh plugin --profile <name> <pnpm-args>` 会把参数转发给 profile 目录里的 pnpm。如果该 profile 的 `node_modules` 是由**不同大版本**的 pnpm 安装的（本机 profile 来自 pnpm v10 store，而当前 pnpm 想要 v11 store），它会以 `ERR_PNPM_UNEXPECTED_STORE` 直接失败。**不要为装插件而重装 profile**——那会动到正在运行的 DSH；上面的 symlink 与 pnpm 的 `link:` 结果等价。
>
> **注意**：日后在该 profile 里执行任何 `pnpm add/remove` 会把这个「多余」的 symlink 清掉，重跑上面的 `ln` 即可。

### 4. 挂载（用一次性 profile 试跑，勿先写现网）

```bash
dsh web --profile local-browser-web-dev --patch <本目录>/cordis.patch.yml
```

`cordis.patch.yml` 做两件事：`insert` 本插件行，并把 `web` 行固定到本地 provider（见下一节「手动编辑」）。

### 5. 启动本机 Chrome 的调试端口

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### Windows 安装补充

`scripts/setup-links.mjs` 里的检出 / profile 路径是作者 macOS 上的绝对路径。Windows 上按下面三处等价替换即可（本机实际安装即按此完成）：

1. **依赖链接**：把 `REPO` 指向本机 DSH 检出、`PROFILE` 指向 `~/.dsh/profiles`，并用 **junction**（无需管理员权限）代替 symlink —— Node 的模块解析会穿透 junction，等价于 pnpm 的 `link:`。脚本见 `E:\dsh-plugins\setup-links.win.mjs`。
2. **构建**：与 macOS 相同，`tsc -p tsconfig.build.json` 出宿主半侧，`tsdown`（经 `node node_modules/tsdown/dist/run.mjs`）出浏览器半侧。
3. **挂进 profile**：把插件目录 junction 到 `<DSH_HOME>\profiles\<profile>\node_modules\dsh-local-browser-web`，再把 `cordis.patch.yml` 的两段（`insert` 与 `id: web`）追加到该 profile 的补丁层。

调试端口在 Windows 上同样要独立 `--user-data-dir`（Chrome 136 起默认数据目录不再接受 `--remote-debugging-port`），登录态只存在那个目录里：

```text
chrome.exe --remote-debugging-port=9222 --user-data-dir=E:\dsh-plugins\.chrome-cdp
```

---

## GUI 入口与界面操作

设置页挂在官方 **`settings.section`** 槽位，因此它在 DSH 设置里是**独立导航页**，而不是「设置 → 插件」分区里的一个标签页：

```
设置（侧栏齿轮 / 设置快捷键）
└── 左侧导航：本地浏览器 Web        ← 本插件设置页
    ├── 搜索   （搜索设置 + 引擎注册表编辑器 + 测试方式说明）
    ├── 抓取   （抓取设置）
    ├── 清洗   （四阶段开关）
    ├── 质量过滤（规则开关 / 阈值 / 域名列表）
    └── 通用   （日志 + 配置导出/导入）
```

页面内所有控件都是**暂存式**：改动先进入草稿，点「保存」才作为**一次原子写**提交。保存成功后草稿清空并从 Host 回读。

| 想做的事 | 操作位置 |
| --- | --- |
| 调调度模式 / 并发上限 / 超时 | 搜索 → 搜索设置 |
| 增删改引擎、调顺序、启停 | 搜索 → 搜索引擎注册表 |
| 为引擎录入 API key | 搜索引擎注册表 → 该引擎行 → 「引擎凭据」 |
| 测试某个引擎 | 搜索引擎注册表 → 该引擎行 → 「测试连接」（见下） |
| 选抓取后端 / CDP 端点 / 无头 / profile | 抓取 → 抓取设置 |
| 逐项开关四阶段清洗 | 清洗 |
| 调质量阈值 / 改域名黑白名单 / 一键旁路 | 质量过滤 |
| 日志级别 / 导出导入配置 | 通用 |

### 引擎「测试连接」怎么用

设置面板运行在**浏览器**里，无法执行 Host 代码：DSH 的 `ctx.remote` 端点需要 typert 代码生成管线，独立仓库的插件无法接入。因此该按钮不做真实网络请求，而是给出**可直接在会话里运行的 agent 工具调用**并支持一键复制：

```
local_search_test engine="bing"
```

它会返回可达性、耗时、结果条数、首条标题，失败时给出**失败阶段**（`dns` / `http` / `parse` / `credential`）。不带 `engine` 参数则批量测试所有已启用引擎；`recent: true` 只返回最近诊断，不发请求。

---

## 在界面中添加自定义引擎

「搜索 → 搜索引擎注册表 → 添加自定义引擎」展开内联表单：

| 字段 | 说明 |
| --- | --- |
| **引擎 id** | 唯一标识；与默认条目同 id 会覆盖它。 |
| **显示名称** | 界面显示名。 |
| **执行方式（kind）** | `http-html`：轻量 HTTP 取 HTML（不执行 JS）；`browser`：浏览器渲染后取 DOM；`api`：带凭据请求 JSON。 |
| **搜索端点** | 完整 URL。`browser`/`api` 可用 `{query}`（另支持 `{region}` / `{language}`）占位；不带占位时按 `extraParams.queryParam`（默认 `q`）附加查询词。 |
| **结果解析策略** | 内置：`html-bing`、`html-ddg`、`html-baidu`、`html-google`、`html-so360`、`json-generic`。第三方注册的策略会出现在同一处。 |
| **需要凭据 / 凭据引用名** | 打开后填**引用名**（如 `MY_SEARCH_KEY`）——配置里只存引用名，**不存明文**。 |
| **引擎凭据（配置名对应行）** | 粘贴 key 值，保存时经**凭据域**写入（`ctx.remote.credentials.set`），值不进入配置文档、不进表单响应、不进日志。 |
| **顺序** | 新建引擎默认排到末尾；创建后用行内的「上移 / 下移」调整，保存会重写 `priority`。 |

`json-generic` 的字段映射通过引擎的 `extraParams` 暴露：`itemsPath`（结果数组路径，默认 `results`）、`urlPath`/`titlePath`/`snippetPath`/`publishedAtPath`（默认 `url`/`title`/`snippet`/`publishedAt`）。区域/语言/安全搜索按引擎自动映射到真实参数名（Bing：`cc`/`setlang`/`adlt`；DuckDuckGo：`kl`/`kp`；其他：`region`/`language`/`safeSearch`）。

### 调整顺序、启停、调度、清洗与阈值

- **顺序 / 启停**：引擎行内「上移 / 下移」与「启用」开关，保存后立即参与调度。
- **调度模式**：搜索 → `bail`（按优先级顺序回退，首个有结果者胜出）/ `parallel`（并发查询前 N 个引擎，按 rank 轮转合并并按 URL 去重）。
- **清洗开关**：清洗 → 四阶段逐项开关。
- **质量阈值 / 域名名单 / 总开关**：质量过滤。
- **一键旁路质量过滤**：质量过滤 → 「质量过滤总开关」关掉，或清洗 → 「阶段四：质量过滤」关掉。

---

## 设置字段含义与默认值

### 搜索

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `searchProvider` | `local-browser-search` | 注册本插件的本地搜索；选 `deepseek-official` 则**不注册**，回退到内置远程搜索（需重载插件生效，见「回退」）。 |
| `dispatchMode` | `bail` | `bail` / `parallel`。 |
| `parallelMaxEngines` | `3` | 仅 `parallel` 生效，1–8，且不得超过已启用引擎数。 |
| `searchTimeoutMs` | `20000` | 单引擎单次搜索预算，1000–120000 ms。 |
| `engines` | Bing、DuckDuckGo、百度、百度桌面端（默认停用）、Google、360 | 引擎注册表内容。 |

### 抓取

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `fetchProvider` | `local-browser-fetch` | 注册本插件的本地抓取；选 `http` 则不注册，回退到内置纯传输抓取。 |
| `fetchBackend` | `cdp` | `cdp`（默认，连本机 Chrome）/ `playwright`（可选本地浏览器）/ `http`（纯传输，不执行 JS）。 |
| `cdpEndpoint` | `http://127.0.0.1:9222` | CDP 端点；`fetchBackend=cdp` 时必须为合法 URL。 |
| `browserPath` | 空 | 仅 Playwright 后端使用；留空由 Playwright 自行解析。 |
| `headless` | `true` | 仅 Playwright 后端；CDP 后端沿用你启动 Chrome 的方式。 |
| `profileMode` | `shared` | `shared` 复用同一浏览器 profile（带登录态）/ `isolated` 每次新建隔离上下文。 |
| `fetchTimeoutMs` | `45000` | 单次抓取（含渲染）预算。 |
| `maxConcurrency` | `2` | 并发抓取上限，1–8。 |
| `maxResponseBytes` | `5000000` | 响应体字节上限；超过直接报 `CONTENT_TOO_LARGE`，不做部分读取。 |
| `maxBodyChars` | `100000` | 解码后字符上限；超出截断并标记 `truncated`。 |
| `userAgent` | `deepseek-harness-local-browser/0.1.0` | HTTP 请求与 `http-html` 引擎使用的 UA（产品标识，非浏览器伪装）。 |

### 代理

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `proxy.enabled` | `false` | 代理总开关。 |
| `proxy.url` | 空 | 代理地址；支持 `http` / `https` / `socks5`，可省略协议，HTTP 代理支持 `user:pass@`。 |
| `proxy.bypass` | `localhost,127.0.0.1,::1` | 直连名单；后缀匹配子域，`*` 全部直连。 |
| `proxy.http` | `true` | HTTP 通道（`http-html` / `api` 引擎与 `http` 抓取后端）走代理。 |
| `proxy.browser` | `true` | 浏览器渲染（CDP / Playwright）走代理；开启后每次渲染使用独立上下文。 |

### 清洗管线（四阶段）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `clean.transport.enabled` | `true` | 阶段一开关。**URL 协议校验与 SSRF 守卫始终生效**；此开关控制字节/字符/重定向上限与人机验证识别。 |
| `clean.render.enabled` | `true` | 阶段二：浏览器渲染。关闭后改用纯传输读取（`fetchBackend` 被强制为 `http`）。 |
| `clean.extract.enabled` | `true` | 阶段二：Readability 式 DOM 打分提取正文。 |
| `clean.extract.fallback` | `true` | 阶段二：打分不足时启用 Trafilatura 式段落启发式。 |
| `clean.markdown.enabled` | `true` | 阶段三：turndown 转 Markdown，规则与内置 `dsh-tool-web` 对齐（GFM 表格 / 删除线 / 剔除隐藏元素）。关闭则把 HTML 交给 `dsh-tool-web` 自行转换。 |
| `clean.quality.enabled` | `true` | 阶段四：质量过滤。 |

### 与内置 provider 的清洗对照

同一条 URL 分别走「内置 `web-fetch-http` + `dsh-tool-web`」与「本插件四阶段管线」，逐项对照：

| 能力 | 内置 `web-fetch-http` + `dsh-tool-web` | 本插件 |
| --- | --- | --- |
| 协议 / 凭据 / URL 长度校验 | 有 | 有 |
| 内网与云元数据地址 | **不拦**（实测 `http://127.0.0.1:<port>/` 能取回内容） | 拦（IPv4/IPv6 私网段 + `localhost` / 元数据主机名） |
| 重定向 | 只跟同源，跨源报 `WEB_REDIRECT_BLOCKED`（`http→https` 也算跨源） | 跟最多 5 跳，每跳重新过守卫 |
| 字符集 | 按 `Content-Type` 的 `charset` 解码 | 同上，外加 `<meta charset>` / `http-equiv` 回退（GBK、GB2312 老站） |
| 渲染 JavaScript | 无 | CDP / Playwright |
| 正文提取 | 无（整页转 Markdown） | DOM 打分 + 段落启发式回退 |
| HTML→Markdown | turndown + GFM（表格、删除线）、剔除隐藏元素 | 已对齐到同一行为 |
| 病态嵌套防护 | 512 层上限，超限输出省略标记 | 512 层上限，超限退化为纯文本（不再把 markup 交给转换器） |
| 文档上限 | 100 k 字符，**先截断再做转换** | 200 万字符供提取，`maxBodyChars` 只截断**清洗后的输出** |
| 质量评估 | 无 | 五族规则打分（只排序与记录，不静默丢弃） |

**能取代的部分**：抓取「把一篇文章变成干净 Markdown」这件事，本插件是内置 provider 的超集——守卫更严、多一次渲染、多一次正文提取，且 Markdown 输出已与 `dsh-tool-web` 对齐（同一条 HTML 现在产出同样的表格行与同样的隐藏元素剔除，见 `tests/clean-parity.test.ts`）。

**不能取代的部分**：

- **无浏览器环境**：内置 provider 只依赖 `undici`，本插件默认要一个可达的 CDP/Playwright。需要纯 HTTP 时把 `clean.render` 关掉即可退回 `http` 后端。
- **内网与本地服务**：本插件拒绝私网地址（这是刻意的 SSRF 守卫），所以抓不了 `127.0.0.1` 上的 dev server、内网 wiki。内置 provider 反而能（但它没有这层防护，不该靠它当护栏）。
- **内存占用**：提取需要完整 DOM，单页最多 200 万字符，比内置 provider 的 100 k 高；这是「提取准确率换内存」的取舍，不是免费收益。
- **判断力**：质量过滤判定的是「来源可不可信」——发布者层级、是否一手、是否过时、是否有伪装的域名、是否与其他来源矛盾。它**不做事实核查**：判断一句话真假需要外部证据与推理，那是模型的工作，规则层给不出。它也不替代检索排序本身。

一次实测（`compare-clean.mjs` / `compare-offline.mjs`，同一份 HTML 喂给两侧，网络因素已排除）：

| 页面 | 内置 provider | 本插件 |
| --- | --- | --- |
| 维基百科条目（562 KB） | 25 971 字符、14 处站点导航词、29 行重复、3 行表格 | 69 282 字符、1 处、0 行重复、39 行表格 |
| nodejs.org/about（49 KB） | 8 981 字符、8 处导航词、27 行重复 | 5 072 字符、0 处、15 行重复（内容重合 90%） |
| 维基「编辑器比较」（704 KB，整页是表格） | 26 229 字符、24 行表格（受 100 k 截断） | 100 655 字符、120 行表格、0 行重复 |
| 5 000 层嵌套炸弹 | 0 ms，输出省略标记 | 修复前 8.2 s 后 `RangeError`；修复后 1 ms，退化为纯文本 |

> 对照前提：内置 provider 的 100 k 字符上限作用在 HTML 上，大页面会先被切掉，所以最后两行的差距里有一部分是「截断位置」而不是「清洗算法」。要等价比，看前两行——那里两侧拿到的 HTML 是完整的。

### 质量过滤

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `quality.enabled` | `true` | 质量过滤总开关（调试可一键旁路）。 |
| `quality.thinContent.enabled` / `minChars` | `true` / `200` | 正文字符数低于阈值命中 `thin-content`。 |
| `quality.seoSpam.enabled` / `maxKeywordDensity` / `maxDuplicateRatio` | `true` / `0.12` / `0.5` | 最高频词占比超限命中 `seo-keyword-stuffing`；重复段落占比超限命中 `seo-duplicate-boilerplate`。 |
| `quality.lowQualityAigc.enabled` / `maxAigcMarkerRatio` | `true` / `0.05` | 含套话标记的句子占比超限命中 `low-quality-aigc`。 |
| `quality.domainReputation.enabled` / `blocklist` / `allowlist` | `true` / 空 / 空 | 每行一个域名；黑名单命中降权 `domain-blocklisted`，白名单命中豁免 `domain-allowlisted`。 |
| `quality.snippetMinChars` | `40` | **搜索摘要**的字符下限；摘要天然比正文短，套用 200 会把每条结果都判成薄内容。 |
| `quality.authority.enabled` / `minScore` | `true` / `30` | 权威度 = 来源分层基础分 + 一手性 ±6 + 时效 ±8；低于下限命中 `low-authority`。不再统计文内英文关键词。 |
| `quality.freshness.enabled` / `staleDays` | `true` / `365` | ≤30 天 +8（`fresh`），超期 −8（`stale`）；抓取的文章缺日期 −4（`undated`），摘要缺日期不扣。 |
| `quality.conflict.enabled` | `true` | 同题不同源给出不同版本号/日期/比例/金额时并排标注。 |
| `quality.annotate.enabled` | `true` | 把 `〔项目官方·一手·2026-03-01·与 x.com 分歧：A vs B〕` 写进 `summary`。 |

### 通用

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `logLevel` | `info` | `silent`/`error`/`warn`/`info`/`debug`；每次搜索/抓取都会产出结构化日志行。 |
| `structuredLog` | `false` | 开启后每行输出一条 JSON 记录。 |

---

## 手动编辑 cordis.patch.yml

**界面保存与手动编辑通往同一处。** 界面上的每一次保存，都是通过 DSH 的配置表单服务 `ctx.configForms.get('local-browser-web')` → `form.mutate(ops, revision)` 提交，最终落到当前 profile 的 `cordis.patch.yml` 中本插件条目的 `config`，再由 volatile HMR 热更新到插件实例（无需重启）。因此：

- 手改 `cordis.patch.yml` 依旧有效，但**不再是首选路径**；
- 两者混用时以配置文件为最终文档，界面只写它声明的 volatile 字段；
- 清单与界面一致：所有可调项都在 `Config` schema 里标了 `.volatile()`，非 volatile 字段**不可能**从任何表单编辑（DSH 的硬性规则）。

`cordis.patch.yml` 示例：

```yaml
- insert:
    - id: local-browser-web
      name: 'dsh-local-browser-web'
      config:
        searchProvider: local-browser-search
        fetchProvider: local-browser-fetch
        dispatchMode: bail
        fetchBackend: cdp
        cdpEndpoint: 'http://127.0.0.1:9222'

- id: web            # 把 ctx.web 接缝固定到本地 provider
  config:
    searchProvider: local-browser-search
    fetchProvider: local-browser-fetch
```

> **为什么 `web` 行必须显式固定**：`ctx.web` 每个能力只选一个 provider，选择项在 `web` 行的 `config` 上。**本地 provider 一旦注册，与其并存的 `deepseek-official`/`http` 就会让接缝抛 `WEB_PROVIDER_AMBIGUOUS`**，除非显式指定。插件启动时会把需要补的那几行原样打进日志，照抄即可。

---

## 回退到 deepseek-official

DSH 的 `web` 行 schema **没有** `.volatile()` 字段，因此 `SettingsForms` 会拒绝任何表单对其写入（`volatileForm()` 返回 undefined → *"has no volatile fields"*）。**没有任何设置面板能改它。** 本插件的做法是把「Provider 选择」实现成**真实的注册开关**：

1. **通用界面路径**：把 搜索 →「默认搜索 Provider」选成 `deepseek-official`、抓取 →「默认抓取 Provider」选成 `http`，保存后**重载插件**（`/reload` 或重启 DSH）。插件随之不再注册本地 provider，接缝回退到内置 provider。
2. **同时把固定的那一行移除或改回**：若 `cordis.patch.yml` 里仍把 `web.searchProvider` 固定为 `local-browser-search`，而本地 provider 已不注册，接缝会抛 `WEB_PROVIDER_CONFIGURED_MISSING`。因此请把该行一起改回内置值，或整行删掉（删掉后：仅注册内置 provider → 自动选择）。

> 这也是唯一一处「界面无法独立完成」的动作：`web` 行不在表单可编辑范围内，必须动一次 profile 补丁。插件在启动日志里会明确写出当前该保留/调整哪些行。

---

## 本地浏览器依赖与 CDP 连接

- **默认不需要安装任何浏览器**：`fetchBackend: cdp` 连接**你已经在跑的 Chrome**。
- **启动 Chrome 带调试端口**：`--remote-debugging-port=9222`，端点默认 `http://127.0.0.1:9222`。插件用 `/json/version` 探活，随后建页、导航、读渲染后的 DOM。
- **profileMode** 语义：`shared` 直接用你那个 Chrome（含登录态）；`isolated` 通过 `Target.createBrowserContext` 为每次请求开隔离上下文并在结束时销毁。
- **Playwright 是可选依赖**：插件**不**声明它。要用 `fetchBackend: playwright` 时自行 `npm i playwright`；未安装时该后端 `available()` 为 false，调用会以 `BROWSER_UNAVAILABLE` 明确报错，不影响其它后端。
- **CDP 传输用的是 Node 22 内置的全局 `WebSocket`**，所以插件没有 `ws` 依赖。

---

## 第三方扩展 API

插件注册了 cordis service `ctx.localBrowserWeb`：

```ts
// 新增解析策略（例如 SearXNG JSON / Brave / Serper / 内网搜索）
ctx.effect(() => ctx.localBrowserWeb.registerResultParser('json-searxng', parser), 'acme-search: parser')

// 运行时新增引擎（不入用户配置，随本插件 fiber 一起卸载）
ctx.effect(() => ctx.localBrowserWeb.registerEngine({ ...spec, id: 'searxng-custom' }), 'acme-search: engine')

// 新增抓取后端
ctx.effect(() => ctx.localBrowserWeb.registerFetchBackend('my-renderer', backend), 'acme-search: backend')
```

只读面：`engines()` / `resultParsers()` / `fetchBackends()` / `recentDiagnostics(limit?, onlyFailures?)`。

`RunnerContext.runners` 也允许按 `kind` 替换执行器（自带传输、录制回放的部署可用）。

---

## 错误码

与 `ctx.web` 共用一套码空间（消费方必须容忍 provider 私有码）：

| 码 | 何时抛出 |
| --- | --- |
| `BROWSER_UNAVAILABLE` | CDP 端点不可达 / 未安装 Playwright |
| `WEB_FETCH_TIMEOUT` | 渲染或请求超时 |
| `WEB_FETCH_CHALLENGE` | 人机验证/拦截页；或访问被 SSRF 守卫拒绝的内网/元数据地址 |
| `EXTRACTION_FAILED` | 渲染成功但提不出正文 |
| `CONTENT_TOO_LARGE` | 响应体超过字节上限 |
| `UNSUPPORTED_CONTENT_TYPE` | 非 html/text 的内容类型；或非 http(s) 协议 |
| `ENGINE_CONFIG_INVALID` | 自定义引擎元数据不合法（缺字段、endpoint 不可解析、解析策略未注册、id 重复） |
| `ENGINE_TEST_FAILED` | 测试连接失败（含 `dns`/`http`/`parse`/`credential` 阶段归类） |
| `NO_ENABLED_ENGINE` | 所有引擎被禁用，无可执行引擎 |
| `FORM_REVISION_CONFLICT` | 面板保存命中版本冲突（内部为 Host 的 `SETTINGS_CONFLICT`，面板以界面语义码提示并保留草稿） |

---

## 开发：构建与测试

```bash
node scripts/setup-links.mjs                                   # 建立依赖 symlink
node node_modules/typescript/bin/tsc -p tsconfig.json          # 类型检查（宿主 + 客户端）
node node_modules/typescript/bin/tsc -p tsconfig.build.json    # 宿主构建 → lib/
node node_modules/tsdown/dist/run.mjs                          # 客户端 bundle → lib/client.js
node --experimental-transform-types --test tests/*.test.ts     # 单测
```

需要 **Node 22**（`nvm use 22`）：仓库要求 `^22.19 || >=24`；测试用到构造器参数属性，因此要 `--experimental-transform-types`（仅剥类型的 `--experimental-strip-types` 不支持）。

测试覆盖（217 例，全绿）：**schema/面板字段双射**（`schema 的 volatile 叶子 == 面板字段路径 + {engines}`，见 D8）、config 校验分支、引擎注册表增删改排序、三个内置解析器（含 URL 归一化、DDG 跳转解包、Google `/goto?` 放行、百度推广位过滤）、解析策略就绪条件声明、`browser` runner 的重试次数（恰好一次）、`bail`/`parallel` 调度与去重、质量规则（来源分层梯度、一手/二手、时效、伪装、摘要与正文双阈值）与排序稳定性、跨源冲突检测的「该报」与「不该报」两侧、来源标注的可见契约（含长摘要不挤掉标注）、传输层守卫（SSRF / 协议 / 内容类型 / 人机验证）、正文提取与 Markdown、**与内置渲染路径的清洗一致性**（字符集解码、GFM 表格 / 删除线 / 隐藏元素、嵌套深度防护）、四阶段管线各开关与失败码（含「上限作用在清洗后的输出」与「提取拒绝 markup 后继续走文本」），以及**客户端 bundle 冒烟测试**（加载 `lib/client.js`，校验 Lazy-CJS factory 契约、`settings.section` 注册、注入面字段表覆盖）。

---

## 与提示词的功能点变更记录

实现期间按实际 DSH API 做了以下调整（功能点变更，均记录于此）：

| # | 提示词表述 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| D1 | 跨字段校验用 `.check()` | `validateConfig()`（`apply()` 时执行）+ 面板侧即时反馈 | 本仓库 Schemastery 构建**没有** `.check()`；DSH 官方插件同样用 `apply()` 内显式断言。 |
| D2 | 面板写 `ctx.settings` | 客户端用 `ctx.configForms.get(ns)` / `whileServed`；Host 侧才叫 `ctx.settings` | 提示词此处把两侧服务名混用了，按真实 API 对齐。 |
| D3 | 错误码 `FORM_REVISION_CONFLICT` | 内部 Host 抛 `SETTINGS_CONFLICT`，面板映射为界面语义码 `FORM_REVISION_CONFLICT` | 实际冲突码是 `SETTINGS_CONFLICT`；保留提示词要求的界面码并做映射。 |
| D4 | **界面切换搜索/抓取 Provider**，`configForms.get('web')` | 改为**注册开关**（选中本地值才注册本地 provider）+ 启动日志给出必需的 `web` 行补丁 | `web` 行 schema 非 volatile，`SettingsForms` 会拒绝一切表单写入（`volatileForm()` 为 undefined）；该行只能通过 profile 补丁修改。 |
| D5 | 抓取/清洗阶段逐项关闭 | 四阶段均可关；但**协议校验与 SSRF 守卫始终生效**，`clean.transport` 只关字节/字符/重定向上限与人机验证识别 | 把「禁止探测内网」做成可关的调试开关等于开漏洞；这条按安全优先偏离提示词。 |
| D6 | 同时向 `plugins.detail.section` 贡献配置摘要 | 未实现（只挂 `settings.section`） | 该槽位需额外依赖 `dsh-client-ui-plugin-manager/client` 且贡献形态受限；`settings.section` 已提供独立导航入口，故不做次要重复面。 |
| D7 | 结果携带 `quality_score` / `quality_flags` 元数据 | 不塞进 seam 的结果对象；改为**结构化日志行 + 诊断环**（`localBrowserWeb.recentDiagnostics()` / `local_search_test recent:true`），结果只做排序不静默丢弃 | `WebSearchSource` 与 `WebFetchResult` 是 `dsh-web` 持有的**封闭形状**，provider 无法附加字段；`dsh-tool-web` 的投影也只复制固定字段。 |
| D8 | （提示词要求"所有界面可编辑字段用 `.volatile()`"） | 一次真实装载暴露出漏洞：嵌套的 `clean.*` / `quality.*` 叶子**漏标** `.volatile()`，导致运行期 section 里是普通布尔值，插件以 `config.clean.transport.enabled.get is not a function` 激活失败。已补齐这些叶子并新增 `tests/schema.test.ts` | 面板的字段表在**浏览器半侧**、schema 在**宿主半侧**，两侧无法互相引用，缺一个机器可校验的不变式。新测试断言二者构成**双射**：`schema 的 volatile 叶子 == 面板字段路径 + {engines}`。 |
| D9 | （未提及） | 安装走 **symlink**，而非 `dsh plugin add` | 官方入口会转发 pnpm，本机 profile 与当前 pnpm 的 store 大版本不一致（`ERR_PNPM_UNEXPECTED_STORE`）；重装 profile 会危及运行中的 DSH。 |
| D11 | （追加需求）可配置代理服务入口 | 新增 `proxy` 配置组（enabled / url / bypass / http / browser）与设置页「代理」页签；HTTP 通道在 `src/proxy.ts` 里自行实现 absolute-form、`CONNECT` 与 SOCKS5（Node 的 `fetch` 不认 `HTTP_PROXY`，且 `undici` 的 `ProxyAgent` 无法从 Node 内部导入，所以不引依赖自己实现）；浏览器通道用 `Target.createBrowserContext` 的 `proxyServer` / `proxyBypassList` | 关键约束：两条通道必须分别可控（只有 HTTP 代理不够，需要代理的引擎往往要渲染）；直连名单必须在发请求前判定；浏览器代理按上下文生效 → 必然放弃默认 profile 登录态，这条要写进文档而不是藏起来。 |
| D10 | （追加需求）新增百度 / Google / 360 搜索 | 三家作为**引擎条目 + 解析策略**加入，而不是新增代码路径：`html-baidu` / `html-google` / `html-so360` 进解析器注册表，引擎只是 `DEFAULT_ENGINES` 的条目；另加 `SEARCH_BODY_CHARS` 与「SERP 命中人机验证即抛 `WEB_FETCH_CHALLENGE`」两条修正 | 计划里「引擎是数据不是代码路径」这条约束必须继续成立；同时实测暴露两个必须修的缺陷：360 的结果在 330 KB 之后（被 `maxBodyChars` 截断成 0 条），百度桌面端把验证页当 200 返回（会被误报成「0 条结果」）。 |
| D12 | （装好代理后首次实跑，Google 10 条结果解析为 0） | 查出四个独立缺陷，全部按「数据/策略声明」修，不新增执行分支：① **UA** 默认值原本是插件标识 `deepseek-harness-local-browser/0.1.0`，浏览器渲染也用它覆盖 → 引擎判定为爬虫，Google 回「需启用 JavaScript」降级页（87 KB，`#rso` 不存在）。改为：浏览器通道**不再覆盖 UA**（用本机 Chrome 真身），HTTP 通道留空时回落到真实桌面 Chrome UA。② **就绪条件**：`loadEventFired` 会早于结果注入触发（实测空壳 `body` 仅 17 字符，`#rso` 在 2.5s 后才出现），给 `ResultParser` 加 `waitFor` 声明，渲染后端据此等待（8s 上限，超时照读）；`loadEventFired` 自身也加 8s 软上限（代理下挂住的第三方资源会让它永不到来）。③ **跳转解包**：Google 的 href 全变成 `/goto?url=<加密 token>`，真实地址不在 DOM 里；给 `EngineSpec` 加 `unwrapRedirect` 正则，命中的结果各发一次 HEAD 读 302 的 `Location`（并发 4、单条 6s、失败重试一次）。④ **DuckDuckGo** 主站在代理下渲染成空白（`body` 文本长度 0），改走 `html.duckduckgo.com/html/` 服务端渲染端点，`kind` 降为 `http-html` | 这四条都属于「引擎是数据、策略自带知识」的边界内：等待什么由解析策略声明，哪种链接需要解包由引擎条目声明。顺带修掉两个实测缺陷：`proxy.bypass` 命中时仍会建代理上下文（白白丢掉登录态，百度因此一直人机验证）、百度移动端把 `recommend_list` / `ubs` 推广位当结果收进来。 |
| D13 | （要求「检查清洗功能能否取代官方」） | 逐项对照内置 `web-fetch-http` + `dsh-tool-web` 后补掉四处真实差距：① Markdown 规则与官方对齐（GFM 表格、删除线，剔除 `display:none` / `[hidden]` / `aria-hidden`）——原先整张表格被拆成一行一个单元格；② 字符集改为按 `Content-Type` 的 charset 解码并回退 `<meta charset>`——原先硬编码 UTF-8，GBK 页面整页替换字符；③ DOM 解析加 512 层嵌套上限，超限退化为纯文本——原先 5 000 层嵌套会阻塞事件循环 8.2 秒后 `RangeError`；④ 提取预算抬到 200 万字符、`maxBodyChars` 改为截断清洗后的输出——原先 562 KB 的维基页在 100 k 处被切，容器丢失后只抽出 1 905 字符（完整 HTML 下是 29 922） | 结论不是读代码得出的：把同一份 HTML 同时喂给真实的内置 provider/tool 渲染与插件管线（`compare-clean.mjs`、`compare-offline.mjs`），四条差距都是量出来的。新版新增 `tests/clean-parity.test.ts` 钉住前三条，管线测试钉住第四条。 |
| D14 | （要求「质量层能否甄别搜索结果的权威性与真伪」） | 实测证伪旧的 `authority` 规则后整体重做：① 权威度改为**来源分层**（政府 95 / 学术 88 / 项目官方 80 / 媒体 72 / 参考 66 / 社区 45 / 聚合站 25）+ 一手性 ±6，删除英文词表计数；② 接入 `publishedAt` 时效（原先该字段完全没参与打分）；③ 新增伪装检测（品牌被他人注册域借用 −40、明文 HTTP −5、短链 −3）；④ 搜索摘要改用独立的 `snippetMinChars`（原先把正文 200 字下限套在 50–120 字的摘要上，10/10 恒中 `thin-content`）；⑤ 新增跨源冲突检测与 `summary` 来源标注，把「来源性质 + 一手性 + 日期 + 与谁分歧」直接交给模型 | 旧规则三条硬伤都是量出来的：10 条真实结果只产出 **2 种判定**（9 条并列）；`candidate` 因含 `date` 被判有权威、`source source source updated date reference citation` 拿满分；中文权威正文（世卫报告句）被判 `low-authority`，因为 8 个提示词全是英文。修复后同一份 SERP 按真实发布者分成 3 层且语义正确，中文官方页拿 95 分。新增 `tests/source-tiers.test.ts`、`tests/conflict.test.ts` 钉住分层与「不误报冲突」。 |

---

## 已知限制

- **L1 面板不能直接测试引擎**：DSH 的 `ctx.remote` 端点要 typert 代码生成，独立仓库插件接不进去。因此「测试连接」给的是可复制的 `local_search_test` 调用（见上文）。
- **L2 Provider 切换需重载插件**：`searchProvider` / `fetchProvider` 是**注册期**开关，volatile 热更新只改值不会重注册 provider。
- **L3 `web` 行不由任何表单承载**：见「回退到 deepseek-official」。
- **L4 只有 `settings.section` 一个界面入口**：未向 `plugins.detail.section` 贡献摘要（D6）。
- **L5 渲染后端的字节上限**：`maxResponseBytes` 对 HTTP 后端是「超限即失败」，对 CDP/Playwright 是「截断」，因为渲染结果已经是一整份 DOM 字符串。
- **L6 质量判定的文本来源**：搜索结果按 `snippet` 判定（seam 的 source 只带标题/摘要/链接），抓取结果按提取后的正文判定。
- **L7 `browser` 类引擎依赖 CDP**：`baidu` / `baidu-pc` / `google` / `duckduckgo` 都要渲染，必须有一个可达的 `cdpEndpoint`（默认 `http://127.0.0.1:9222`）。Chrome 136 起，`--remote-debugging-port` 对默认数据目录不再生效，所以要用独立 `--user-data-dir`；那个 profile 的登录态与 cookie 会随实例保留。
- **L8 百度桌面端的人机验证**：`baidu-pc` 默认停用。百度会对陌生网络与新建浏览器 profile 返回 `wappass` 图形验证（HTTP 200），这类请求一律报 `WEB_FETCH_CHALLENGE`；在该 Chrome 里过一次验证或换成可信网络后再启用即可。`baidu`（移动端）不受此影响。
- **L9 Google 需要可达网络**：`google` 条目已内置，但网络不可直连 Google 时（即使配了代理，代理自己也出不去）会以 `net::ERR_CONNECTION_TIMED_OUT` / `ERR_EMPTY_RESPONSE` 失败。
- **L10 浏览器代理与登录态基本不可兼得**：Chrome 没有可运行时修改的浏览器级代理，代理只能按上下文给，所以真正需要走代理的渲染一定是新上下文（`shared` 也一样），默认 profile 的 cookie 不参与。**例外是直连名单**：目标命中 `proxy.bypass` 时根本不需要代理上下文，于是仍用 `shared` profile（保留登录态）——所以把常用站点写进名单，既省代理也保住登录态。
- **L11 浏览器侧不接受代理凭据**：`proxyServer` 只吃 `scheme://host:port`，`http://user:pass@host:port` 里的用户名密码在浏览器通道被忽略（HTTP 通道则正常使用）。需要认证代理时，要么只用 `proxy.http`，要么在本机起一个免认证中转。
- **L12 国内引擎的风控按频率触发**：百度（`wappass`）、360（`qcaptcha`）在短时间内被同一出口连打十几次后会开始回验证页，HTTP 200，本插件报 `WEB_FETCH_CHALLENGE`。这是出口信誉问题，不是解析问题：真实使用一次搜索只碰 1–2 个引擎，不会触发；连续压测（或把国内站点放进代理）才会。`bail` 调度下换一个引擎即可继续。
- **L13 代理质量决定 Google 可用性**：`google` 需要代理真正到得了 Google，且线路要能连续完成一次页面渲染（主文档 + 脚本包 + `#rso` 注入）。实测同一个代理对 `www.google.com` 的 8 次探测里有 2 次失败、延迟在 0.8–5.4 秒之间抖动，对应表现就是 `ERR_CONNECTION_CLOSED` 或偶尔 0 条。插件已做「空结果重试一次」，但线路本身不可用时无法补偿。
- **L14 Google 结果仍需一跳解包**：`/goto?url=` 是加密 token，只能问一次跳转器。跳转链解析失败时该条结果会**保留跳转链**（点开仍能到达目标），不会丢结果；成功率取决于代理对 `www.google.com` 的稳定性。
- **L15 提取只做到「够用」**：正文打分按文字量与链接密度，没有 Readability 的完整排版启发式。以表格或列表为主体的页面（维基「比较」类条目、目录页）会把参考列表、脚注一并带上，输出比人工阅读所需更长；这类页面适合关掉 `clean.extract` 直接用整页 HTML。
- **L16 字符集回退有边界**：`<meta charset>` 只读响应体前 4 KB，且仅在 `Content-Type` 未声明 charset 时生效；真正要按声明解码的页面（GBK 政府/院校老站）不受影响。
- **L17 分层只看域名，不看页面归属**：`github.com/xxx/awesome-list` 属于第三方整理，但 `github.com` 整域按「项目官方」计入一手。同理 `*.gov.cn` 上转载的第三方内容也按官方计。判断「这条 repo 是不是项目官方」需要 owner 级规则，当前不做。
- **L18 冲突检测只比标题里的数值**：同一话题的两个来源若把版本号/日期/比例写在摘要而非标题里，检测不到（宁可不报也不误报）。跨语言、跨单位（`1.5 万` vs `15000`）也不做归一。
