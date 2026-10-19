# dsh-local-browser-web

一个 DeepSeek Harness（DSH）插件：用**本机浏览器**（CDP，可选 Playwright）为 `ctx.web` 能力接缝提供 搜索`web_search` 与 抓取`web_fetch` provider，并补齐内置远程 API 之外的**可扩展引擎注册表**、**四阶段清洗管线**、**质量过滤层**与**图形化设置页**。

- 搜索 provider id：`local-browser-search`
- 抓取 provider id：`local-browser-fetch`
- profile 条目 id（也是设置命名空间）：`local-browser-web`
- 包名：`dsh-local-browser-web`（插件的浏览器半侧挂在**根行**上，见下文「挂载」）

---

## 目录

- [能力总览](#能力总览)
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
| **引擎注册表** | Bing（HTTP）与 DuckDuckGo（浏览器）只是**默认条目的数据**，不是代码路径。同一张表里可增删启停、调顺序、改 endpoint、换解析策略。 |
| **解析策略注册表** | 内置 `html-bing` / `html-ddg` / `json-generic`；第三方可通过公开 service 注册更多，零改本包源码。 |
| **抓取 Provider** | `ctx.web.registerFetchProvider` 注册 `local-browser-fetch`。执行链：四阶段清洗管线。 |
| **抓取后端注册表** | `cdp`（默认，连本机 Chrome）/ `playwright`（可选）/ `http`（纯传输）；可注册新后端。 |
| **质量过滤** | 薄内容 / SEO 垃圾 / 低质 AIGC / 域名信誉 / 权威度，五族规则逐条可开关、阈值可调、总有总开关。 |
| **设置页** | 挂在 `settings.section` 槽位的独立导航页，覆盖全部可调项；保存经 `form.mutate` 写入 profile 条目 `config` 并由 volatile HMR 热更新。 |
| **Agent 工具** | `local_search_test`：真实测试每个引擎并报告失败阶段；也可只读最近的操作诊断。 |

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
| **结果解析策略** | 内置：`html-bing`、`html-ddg`、`json-generic`。第三方注册的策略会出现在同一处。 |
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
| `engines` | Bing + DuckDuckGo | 引擎注册表内容。 |

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

### 清洗管线（四阶段）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `clean.transport.enabled` | `true` | 阶段一开关。**URL 协议校验与 SSRF 守卫始终生效**；此开关控制字节/字符/重定向上限与人机验证识别。 |
| `clean.render.enabled` | `true` | 阶段二：浏览器渲染。关闭后改用纯传输读取（`fetchBackend` 被强制为 `http`）。 |
| `clean.extract.enabled` | `true` | 阶段二：Readability 式 DOM 打分提取正文。 |
| `clean.extract.fallback` | `true` | 阶段二：打分不足时启用 Trafilatura 式段落启发式。 |
| `clean.markdown.enabled` | `true` | 阶段三：turndown 转 Markdown。关闭则把 HTML 交给 `dsh-tool-web` 自行转换。 |
| `clean.quality.enabled` | `true` | 阶段四：质量过滤。 |

### 质量过滤

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `quality.enabled` | `true` | 质量过滤总开关（调试可一键旁路）。 |
| `quality.thinContent.enabled` / `minChars` | `true` / `200` | 正文字符数低于阈值命中 `thin-content`。 |
| `quality.seoSpam.enabled` / `maxKeywordDensity` / `maxDuplicateRatio` | `true` / `0.12` / `0.5` | 最高频词占比超限命中 `seo-keyword-stuffing`；重复段落占比超限命中 `seo-duplicate-boilerplate`。 |
| `quality.lowQualityAigc.enabled` / `maxAigcMarkerRatio` | `true` / `0.05` | 含套话标记的句子占比超限命中 `low-quality-aigc`。 |
| `quality.domainReputation.enabled` / `blocklist` / `allowlist` | `true` / 空 / 空 | 每行一个域名；黑名单命中降权 `domain-blocklisted`，白名单命中豁免 `domain-allowlisted`。 |
| `quality.authority.enabled` / `minScore` | `true` / `30` | 权威度低于下限命中 `low-authority`。 |

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

测试覆盖（103 例，全绿）：**schema/面板字段双射**（`schema 的 volatile 叶子 == 面板字段路径 + {engines}`，见 D8）、config 校验分支、引擎注册表增删改排序、三个内置解析器（含 URL 归一化与 DDG 跳转解包）、`bail`/`parallel` 调度与去重、质量五族规则与排序稳定性、传输层守卫（SSRF / 协议 / 内容类型 / 人机验证）、正文提取与 Markdown、四阶段管线各开关与失败码，以及**客户端 bundle 冒烟测试**（加载 `lib/client.js`，校验 Lazy-CJS factory 契约、`settings.section` 注册、注入面字段表覆盖）。

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

---

## 已知限制

- **L1 面板不能直接测试引擎**：DSH 的 `ctx.remote` 端点要 typert 代码生成，独立仓库插件接不进去。因此「测试连接」给的是可复制的 `local_search_test` 调用（见上文）。
- **L2 Provider 切换需重载插件**：`searchProvider` / `fetchProvider` 是**注册期**开关，volatile 热更新只改值不会重注册 provider。
- **L3 `web` 行不由任何表单承载**：见「回退到 deepseek-official」。
- **L4 只有 `settings.section` 一个界面入口**：未向 `plugins.detail.section` 贡献摘要（D6）。
- **L5 渲染后端的字节上限**：`maxResponseBytes` 对 HTTP 后端是「超限即失败」，对 CDP/Playwright 是「截断」，因为渲染结果已经是一整份 DOM 字符串。
- **L6 质量判定的文本来源**：搜索结果按 `snippet` 判定（seam 的 source 只带标题/摘要/链接），抓取结果按提取后的正文判定。
