/**
 * Plugin configuration: the Schemastery schema, its defaults, and the structural
 * validation the schema type system cannot express.
 *
 * Every field the settings section edits is declared `.volatile()`, which is what
 * lets DSH's `SettingsForms` project it into a live form and hot-apply edits
 * without remounting the plugin. Fields outside this schema stay ordinary
 * configuration and are NOT editable from a form — that is a platform rule, not
 * a choice (see README "已知限制").
 *
 * @module dsh-local-browser-web/config
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { LocalBrowserWebError } from './errors.ts'
import { parseProxyUrl, type ProxyConfig } from './proxy.ts'
import type {
  DispatchMode,
  EngineExtraParams,
  EngineKind,
  EngineSpec,
  FetchBackendId,
  LogLevel,
  ProfileMode,
} from './types.ts'

/** The search provider id this plugin registers on the `ctx.web` seam. */
export const LOCAL_SEARCH_PROVIDER_ID = 'local-browser-search'
/** The fetch provider id this plugin registers on the `ctx.web` seam. */
export const LOCAL_FETCH_PROVIDER_ID = 'local-browser-fetch'
/** The built-in remote search provider a fallback selects. */
export const UPSTREAM_SEARCH_PROVIDER_ID = 'deepseek-official'
/** The built-in plain-transport fetch provider a fallback selects. */
export const UPSTREAM_FETCH_PROVIDER_ID = 'http'

/** Default CDP endpoint: the local Chrome's remote-debugging port. */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222'

/**
 * An explicit product agent, never a browser disguise. Engines that ask for a
 * browser-like UA override this per engine through `extraParams`, but the plugin
 * never pretends to be Chrome by default.
 */
/**
 * User-Agent the HTTP backend falls back to when the setting is empty.
 *
 * It must look like a real browser: engines answer a self-identifying crawler UA
 * with a degraded, script-less page (Google's "enable JavaScript" shell among
 * them), which then parses to zero results. The browser transports do not use this
 * constant at all — they keep the UA of the Chrome they drive, which is always the
 * right version.
 */
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

/** Built-in search engines. Bing is the light HTTP path; DuckDuckGo needs a real render. */
export const DEFAULT_ENGINES: EngineSpec[] = [
  {
    id: 'bing',
    label: 'Bing',
    kind: 'http-html',
    endpoint: 'https://www.bing.com/search',
    requiresKey: false,
    resultParser: 'html-bing',
    priority: 10,
    enabledByDefault: true,
    enabled: true,
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    // The main surface is a React app that stays blank when its script bundle
    // cannot finish loading over a proxy; the `html/` endpoint answers with the
    // same ten results already server-rendered, so it needs no browser at all.
    kind: 'http-html',
    endpoint: 'https://html.duckduckgo.com/html/?q={query}',
    requiresKey: false,
    resultParser: 'html-ddg',
    priority: 20,
    enabledByDefault: true,
    enabled: true,
  },
  {
    // Baidu answers a plain HTTP GET with its 安全验证 interstitial, so this engine
    // is a `browser` kind: the render carries the cookies and TLS fingerprint a
    // real browser has, which is what the interstitial checks. The mobile surface
    // (`m.baidu.com`) is the one that reliably serves server-rendered results —
    // the desktop `/s` endpoint still gates unfamiliar networks, so it ships as the
    // separate, opt-in `baidu-pc` entry below.
    id: 'baidu',
    label: '百度搜索',
    kind: 'browser',
    endpoint: 'https://m.baidu.com/s?word={query}',
    requiresKey: false,
    resultParser: 'html-baidu',
    priority: 30,
    enabledByDefault: true,
    enabled: true,
  },
  {
    // The canonical desktop SERP. Enabled for networks and browser profiles Baidu
    // already trusts; otherwise it fails as a challenge and dispatch moves on.
    id: 'baidu-pc',
    label: '百度搜索（桌面端）',
    kind: 'browser',
    endpoint: 'https://www.baidu.com/s?wd={query}&ie=utf-8',
    requiresKey: false,
    resultParser: 'html-baidu',
    priority: 35,
    enabledByDefault: false,
    enabled: false,
  },
  {
    // Google renders its SERP client-side and gates plain fetches, so it renders
    // too — and, like any browser-kind engine, needs a reachable CDP endpoint.
    id: 'google',
    label: 'Google 搜索',
    kind: 'browser',
    endpoint: 'https://www.google.com/search?q={query}&num=10',
    requiresKey: false,
    resultParser: 'html-google',
    priority: 40,
    enabledByDefault: true,
    enabled: true,
    // Google publishes `/goto?url=<encrypted token>` instead of the destination,
    // so each result needs one hop resolved before it is a usable URL.
    unwrapRedirect: '^https?://[^/]*\\.google\\.[a-z.]+/(?:goto|url)\\?',
    extraParams: { language: 'zh-CN' },
  },
  {
    // 360 Search (so.com) serves a complete server-rendered SERP, so it stays on
    // the cheap HTTP path: no browser, no JavaScript, and no CDP dependency.
    id: 'so360',
    label: '360 搜索',
    kind: 'http-html',
    endpoint: 'https://www.so.com/s?q={query}&ie=utf-8',
    requiresKey: false,
    resultParser: 'html-so360',
    priority: 50,
    enabledByDefault: true,
    enabled: true,
  },
]

/** Result-parser ids that ship with the plugin. */
export const BUILT_IN_PARSERS = ['html-bing', 'html-ddg', 'html-baidu', 'html-google', 'html-so360', 'json-generic'] as const

/** Engine execution routes the schema accepts. */
const ENGINE_KINDS: readonly EngineKind[] = ['http-html', 'browser', 'api']
/** Safe-search hints the schema accepts. */
const SAFE_SEARCH = ['off', 'moderate', 'strict'] as const

/** Engine-specific parameters. Declared explicitly (not a free-form dict) so the panel can render them. */
const engineExtraParamsSchema = z.object({
  queryParam: z.string().comment('HTTP/api：承载查询词的参数名（默认 q）'),
  region: z.string().comment('区域/市场提示，如 cn-zh / us-en'),
  language: z.string().comment('结果语言提示，如 zh / en'),
  safeSearch: z.union([...SAFE_SEARCH]).comment('安全搜索策略'),
  itemsPath: z.string().comment('api：结果数组的点分路径，如 results 或 data.items'),
  urlPath: z.string().comment('api：单条结果的 URL 字段路径'),
  titlePath: z.string().comment('api：单条结果的标题字段路径'),
  snippetPath: z.string().comment('api：单条结果的摘要字段路径'),
  publishedAtPath: z.string().comment('api：单条结果的发布时间字段路径'),
})

/** One engine entry as stored in the config. */
const engineSchema = z.object({
  id: z.string().required().comment('唯一引擎 id'),
  label: z.string().default('').comment('界面显示名称'),
  kind: z.union([...ENGINE_KINDS]).default('http-html').comment('执行方式：http-html / browser / api'),
  endpoint: z.string().default('').comment('搜索端点 URL（browser 可用 {query} 占位）'),
  requiresKey: z.boolean().default(false).comment('是否需要 API key'),
  credentialRef: z.string().comment('凭据引用名（需要 key 时）；明文值写入凭据域，不进配置'),
  resultParser: z.string().default('html-bing').comment('结果解析策略 id'),
  priority: z.number().step(1).default(100).comment('回退顺序，越小越先'),
  enabledByDefault: z.boolean().default(false).comment('新装默认是否启用'),
  enabled: z.boolean().default(true).comment('当前是否参与调度'),
  unwrapRedirect: z.string().comment('跳转链正则：命中的结果 URL 会跟随一跳解析真实地址（如 Google 的 /goto?url=）；留空表示解析结果已是目标地址'),
  extraParams: engineExtraParamsSchema.comment('引擎专属参数'),
})

/** The quality-filter rule set. Each rule is independently switchable. */
const qualitySchema = z.object({
  enabled: z.boolean().default(true).volatile().comment('质量过滤总开关（调试可一键旁路）'),
  thinContent: z.object({
    enabled: z.boolean().default(true).volatile().comment('薄内容检测'),
    minChars: z.number().step(1).min(0).default(200).volatile().comment('正文字符数下限，低于即判薄内容'),
  }),
  snippetMinChars: z.number().step(1).min(0).default(40).volatile()
    .comment('搜索摘要的字符数下限（摘要天然比正文短，不能套用正文字数）'),
  seoSpam: z.object({
    enabled: z.boolean().default(true).volatile().comment('SEO 垃圾特征检测'),
    maxKeywordDensity: z.number().min(0).max(1).default(0.12).volatile().comment('关键词密度上限（0-1）'),
    maxDuplicateRatio: z.number().min(0).max(1).default(0.5).volatile().comment('重复段落比例上限（0-1）'),
  }),
  lowQualityAigc: z.object({
    enabled: z.boolean().default(true).volatile().comment('低质 AIGC 特征检测'),
    maxAigcMarkerRatio: z.number().min(0).max(1).default(0.05).volatile().comment('AIGC 套话标记占比上限（0-1）'),
  }),
  domainReputation: z.object({
    enabled: z.boolean().default(true).volatile().comment('域名信誉检测'),
    blocklist: z.array(z.string()).default([]).volatile().comment('域名黑名单（命中即降权）'),
    allowlist: z.array(z.string()).default([]).volatile().comment('域名白名单（命中即豁免黑名单与部分规则）'),
  }),
  authority: z.object({
    enabled: z.boolean().default(true).volatile().comment('权威度评估（来源分层 + 一手性 + 时效）'),
    minScore: z.number().min(0).max(100).default(30).volatile().comment('权威度得分下限，低于即在结果中降权'),
  }),
  freshness: z.object({
    enabled: z.boolean().default(true).volatile().comment('时效性评估（旧闻降权、缺日期扣分）'),
    staleDays: z.number().step(1).min(0).default(365).volatile().comment('超过该天数的内容判为陈旧'),
  }),
  conflict: z.object({
    enabled: z.boolean().default(true).volatile().comment('跨源冲突检测（同题不同源数值分歧并排标注）'),
  }),
  annotate: z.object({
    enabled: z.boolean().default(true).volatile().comment('把来源性质写进摘要，供模型直接看到'),
  }),
})

/**
 * The outbound-proxy group.
 *
 * Two egress switches rather than one, because the two transports fail
 * differently: an HTTP proxy is enough for `http-html` engines, while a search
 * engine that must be rendered needs the browser to send its traffic through the
 * proxy too. Keeping them separate lets a local proxy that only relays TLS
 * (e.g. a CONNECT-only relay) serve the browser while HTTP engines stay direct.
 */
const proxySchema = z.object({
  enabled: z.boolean().default(false).volatile().comment('代理总开关（关闭时所有通道直连）'),
  url: z.string().default('').volatile()
    .comment('代理地址：http://127.0.0.1:7890、socks5://127.0.0.1:7891，或省略协议的 127.0.0.1:7890'),
  bypass: z.string().default('localhost,127.0.0.1,::1').volatile()
    .comment('直连名单（逗号分隔，支持 example.com 后缀匹配与 *）'),
  http: z.boolean().default(true).volatile().comment('HTTP 通道走代理：http-html / api 引擎与 http 抓取后端'),
  browser: z.boolean().default(true).volatile().comment('浏览器渲染走代理：CDP / Playwright 抓取与 browser 类引擎'),
})

/** The four-stage cleaning pipeline's per-stage switches. */const cleanSchema = z.object({
  transport: z.object({
    enabled: z.boolean().default(true).volatile().comment('阶段一：传输层安全（SSRF 守卫/重定向/超时/体积/类型）'),
  }),
  render: z.object({
    enabled: z.boolean().default(true).volatile().comment('阶段二：浏览器渲染后再提取正文'),
  }),
  extract: z.object({
    enabled: z.boolean().default(true).volatile().comment('阶段二：正文提取（Readability 算法）'),
    fallback: z.boolean().default(true).volatile().comment('提取失败时启用 Trafilatura 风格启发式回退'),
  }),
  markdown: z.object({
    enabled: z.boolean().default(true).volatile().comment('阶段三：HTML 转 Markdown（turndown）'),
  }),
  quality: z.object({
    enabled: z.boolean().default(true).volatile().comment('阶段四：内容质量过滤'),
  }),
})

/** Plugin config interface: every field the settings section edits, as a `Volatile` reference. */
export interface Config {
  /** Which search provider the plugin registers: its own, or none (fallback to the upstream provider). */
  searchProvider: Volatile<string>
  /** `bail` (sequential fallback) or `parallel` (concurrent merge). */
  dispatchMode: Volatile<DispatchMode>
  /** Upper bound on engines queried concurrently in `parallel` mode. */
  parallelMaxEngines: Volatile<number>
  /** The engine registry's contents. */
  engines: Volatile<EngineSpec[]>
  /** Per-engine search budget. */
  searchTimeoutMs: Volatile<number>
  /** Id of the result scorer to run after quality ranking; empty = none. */
  searchScorer: Volatile<string>
  /** Endpoint of the built-in HTTP reranker. */
  rerankEndpoint: Volatile<string>
  /** Model id the reranker server knows. */
  rerankModel: Volatile<string>
  /** Reranker request budget. */
  rerankTimeoutMs: Volatile<number>
  /** Which fetch provider the plugin registers: its own, or none (fallback to the upstream provider). */
  fetchProvider: Volatile<string>
  /** Which retrieval backend the fetch provider uses. */
  fetchBackend: Volatile<FetchBackendId>
  /** Explicit browser executable path (Playwright backend); empty = Playwright's own resolution. */
  browserPath: Volatile<string | undefined>
  /** CDP endpoint the default backend connects to. */
  cdpEndpoint: Volatile<string>
  /** Whether rendered pages run headless. */
  headless: Volatile<boolean>
  /** Reuse one browser profile (cookies, logins) or isolate each request. */
  profileMode: Volatile<ProfileMode>
  /** Per-fetch budget. */
  fetchTimeoutMs: Volatile<number>
  /** Explicit Chrome executable for the panel's launch action; empty = auto-detect. */
  chromePath: Volatile<string>
  /** Data directory the panel's launch action uses; empty = plugin-owned default. */
  chromeProfileDir: Volatile<string>
  /** How long a launch waits for the CDP port to answer. */
  launchTimeoutMs: Volatile<number>
  /** Upper bound on concurrent fetches. */
  maxConcurrency: Volatile<number>
  /** Response size cap, in bytes. */
  maxResponseBytes: Volatile<number>
  /** Decoded body length cap, in characters. */
  maxBodyChars: Volatile<number>
  /** `User-Agent` sent by the HTTP backend and by HTTP-kind engines. */
  userAgent: Volatile<string>
  /** Outbound proxy for the HTTP and browser transports. */
  proxy: {
    enabled: Volatile<boolean>
    url: Volatile<string>
    bypass: Volatile<string>
    http: Volatile<boolean>
    browser: Volatile<boolean>
  }
  /** Four-stage cleaning pipeline switches. */
  clean: {
    transport: { enabled: Volatile<boolean> }
    render: { enabled: Volatile<boolean> }
    extract: { enabled: Volatile<boolean>, fallback: Volatile<boolean> }
    markdown: { enabled: Volatile<boolean> }
    quality: { enabled: Volatile<boolean> }
  }
  /** Quality-filter rules, thresholds, and domain lists. */
  quality: {
    enabled: Volatile<boolean>
    thinContent: { enabled: Volatile<boolean>, minChars: Volatile<number> }
    snippetMinChars: Volatile<number>
    seoSpam: {
      enabled: Volatile<boolean>
      maxKeywordDensity: Volatile<number>
      maxDuplicateRatio: Volatile<number>
    }
    lowQualityAigc: { enabled: Volatile<boolean>, maxAigcMarkerRatio: Volatile<number> }
    domainReputation: {
      enabled: Volatile<boolean>
      blocklist: Volatile<string[]>
      allowlist: Volatile<string[]>
    }
    authority: { enabled: Volatile<boolean>, minScore: Volatile<number> }
    freshness: { enabled: Volatile<boolean>, staleDays: Volatile<number> }
    conflict: { enabled: Volatile<boolean> }
    annotate: { enabled: Volatile<boolean> }
  }
  /** Structured-log verbosity. */
  logLevel: Volatile<LogLevel>
  /** Emit one structured JSON log line per search/fetch instead of prose. */
  structuredLog: Volatile<boolean>
}

/** Loader configuration schema. Every editable field is `.volatile()`. */
export const Config = z.object({
  searchProvider: z.string().default(LOCAL_SEARCH_PROVIDER_ID).volatile()
    .comment('搜索 Provider：local-browser-search 注册本插件的本地搜索；其他值则不注册（回退到内置 Provider）'),
  dispatchMode: z.union(['bail', 'parallel']).default('bail').volatile()
    .comment('调度模式：bail 顺序回退 / parallel 并发合并'),
  parallelMaxEngines: z.number().step(1).min(1).max(8).default(3).volatile()
    .comment('parallel 模式下并发查询的引擎数上限'),
  engines: z.array(engineSchema).default([...DEFAULT_ENGINES]).volatile()
    .comment('搜索引擎注册表'),
  searchTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(20_000).volatile()
    .comment('单引擎搜索超时（毫秒）'),
  searchScorer: z.string().default('').volatile()
    .comment('结果评分器 id：空 = 不评分；rerank-http = 内置重排；其他值 = 第三方通过 registerScorer 注册的 id'),
  rerankEndpoint: z.string().default('http://127.0.0.1:8080/rerank').volatile()
    .comment('内置重排器的 HTTP 端点（TEI 的 /rerank 或 Cohere/Jina 风格均可）'),
  rerankModel: z.string().default('BAAI/bge-reranker-v2-m3').volatile()
    .comment('重排模型 id（由该端点识别）'),
  rerankTimeoutMs: z.number().step(1).min(500).max(30_000).default(4_000).volatile()
    .comment('重排请求超时（毫秒）；超时后保留原有排序，不影响结果完整性'),

  fetchProvider: z.string().default(LOCAL_FETCH_PROVIDER_ID).volatile()
    .comment('抓取 Provider：local-browser-fetch 注册本插件的本地抓取；其他值则不注册'),
  fetchBackend: z.union(['cdp', 'playwright', 'http']).default('cdp').volatile()
    .comment('抓取后端：cdp 连接本机 Chrome / playwright 本地浏览器 / http 纯传输'),
  browserPath: z.string().volatile().comment('Playwright 浏览器可执行文件路径（留空由 Playwright 解析）'),
  cdpEndpoint: z.string().default(DEFAULT_CDP_ENDPOINT).volatile()
    .comment('CDP 端点（Chrome --remote-debugging-port=9222）'),
  headless: z.boolean().default(true).volatile().comment('无头模式'),
  profileMode: z.union(['isolated', 'shared']).default('shared').volatile()
    .comment('isolated 每次新建上下文 / shared 复用同一浏览器 profile（可带登录态）'),
  fetchTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(45_000).volatile()
    .comment('单次抓取超时（毫秒）'),
  chromePath: z.string().default('').volatile()
    .comment('一键启动所用的 Chrome 可执行文件路径；留空自动检测常见安装位置'),
  chromeProfileDir: z.string().default('').volatile()
    .comment('一键启动所用的 Chrome 数据目录；留空使用插件自有目录（Chrome 136+ 不允许默认目录开调试端口）'),
  launchTimeoutMs: z.number().step(1).min(3_000).max(60_000).default(15_000).volatile()
    .comment('一键启动后等待调试端口响应的预算（毫秒）'),
  maxConcurrency: z.number().step(1).min(1).max(8).default(2).volatile()
    .comment('并发抓取上限'),
  maxResponseBytes: z.number().step(1).min(1_024).default(5_000_000).volatile()
    .comment('响应体字节上限'),
  maxBodyChars: z.number().step(1).min(256).default(100_000).volatile()
    .comment('正文解码后字符上限'),
  userAgent: z.string().default('').volatile()
    .comment('HTTP 请求的 User-Agent；留空则使用内置的桌面 Chrome UA，浏览器渲染始终使用本机 Chrome 自身 UA'),

  proxy: proxySchema,

  clean: cleanSchema,
  quality: qualitySchema,

  logLevel: z.union(['silent', 'error', 'warn', 'info', 'debug']).default('info').volatile()
    .comment('日志级别'),
  structuredLog: z.boolean().default(false).volatile().comment('结构化日志（每行一条 JSON）'),
})

/** Plain, fully-resolved configuration: one volatile-free snapshot per read. */
export interface ResolvedConfig {
  searchProvider: string
  dispatchMode: DispatchMode
  parallelMaxEngines: number
  engines: EngineSpec[]
  searchTimeoutMs: number
  searchScorer: string
  rerankEndpoint: string
  rerankModel: string
  rerankTimeoutMs: number
  fetchProvider: string
  fetchBackend: FetchBackendId
  browserPath: string | undefined
  cdpEndpoint: string
  headless: boolean
  profileMode: ProfileMode
  fetchTimeoutMs: number
  chromePath: string
  chromeProfileDir: string
  launchTimeoutMs: number
  maxConcurrency: number
  maxResponseBytes: number
  maxBodyChars: number
  userAgent: string
  proxy: ProxyConfig
  clean: {
    transport: boolean
    render: boolean
    extract: boolean
    extractFallback: boolean
    markdown: boolean
    quality: boolean
  }
  quality: {
    enabled: boolean
    thinContent: { enabled: boolean, minChars: number }
    snippetMinChars: number
    seoSpam: { enabled: boolean, maxKeywordDensity: number, maxDuplicateRatio: number }
    lowQualityAigc: { enabled: boolean, maxAigcMarkerRatio: number }
    domainReputation: { enabled: boolean, blocklist: string[], allowlist: string[] }
    authority: { enabled: boolean, minScore: number }
    freshness: { enabled: boolean, staleDays: number }
    conflict: { enabled: boolean }
    annotate: { enabled: boolean }
  }
  logLevel: LogLevel
  structuredLog: boolean
}

/**
 * Read every volatile reference once, producing the plain snapshot an operation
 * works from.
 *
 * Each operation takes its own snapshot, so a save from the settings panel is
 * picked up by the very next search or fetch. Fields are read here rather than
 * stored, because a stored copy would freeze at the values the plugin mounted
 * with.
 *
 * @param config - the plugin's live config.
 * @returns one consistent plain snapshot.
 */
export function readConfig(config: Config): ResolvedConfig {
  return {
    searchProvider: config.searchProvider.get(),
    dispatchMode: config.dispatchMode.get(),
    parallelMaxEngines: config.parallelMaxEngines.get(),
    engines: [...config.engines.get()],
    searchTimeoutMs: config.searchTimeoutMs.get(),
    searchScorer: config.searchScorer.get(),
    rerankEndpoint: config.rerankEndpoint.get(),
    rerankModel: config.rerankModel.get(),
    rerankTimeoutMs: config.rerankTimeoutMs.get(),
    fetchProvider: config.fetchProvider.get(),
    fetchBackend: config.fetchBackend.get(),
    browserPath: config.browserPath.get(),
    cdpEndpoint: config.cdpEndpoint.get(),
    headless: config.headless.get(),
    profileMode: config.profileMode.get(),
    fetchTimeoutMs: config.fetchTimeoutMs.get(),
    chromePath: config.chromePath.get(),
    chromeProfileDir: config.chromeProfileDir.get(),
    launchTimeoutMs: config.launchTimeoutMs.get(),
    maxConcurrency: config.maxConcurrency.get(),
    maxResponseBytes: config.maxResponseBytes.get(),
    maxBodyChars: config.maxBodyChars.get(),
    userAgent: config.userAgent.get(),
    proxy: {
      enabled: config.proxy.enabled.get(),
      url: config.proxy.url.get(),
      bypass: config.proxy.bypass.get(),
      http: config.proxy.http.get(),
      browser: config.proxy.browser.get(),
    },
    clean: {
      transport: config.clean.transport.enabled.get(),
      render: config.clean.render.enabled.get(),
      extract: config.clean.extract.enabled.get(),
      extractFallback: config.clean.extract.fallback.get(),
      markdown: config.clean.markdown.enabled.get(),
      quality: config.clean.quality.enabled.get(),
    },
    quality: {
      enabled: config.quality.enabled.get(),
      thinContent: {
        enabled: config.quality.thinContent.enabled.get(),
        minChars: config.quality.thinContent.minChars.get(),
      },
      snippetMinChars: config.quality.snippetMinChars.get(),
      seoSpam: {
        enabled: config.quality.seoSpam.enabled.get(),
        maxKeywordDensity: config.quality.seoSpam.maxKeywordDensity.get(),
        maxDuplicateRatio: config.quality.seoSpam.maxDuplicateRatio.get(),
      },
      lowQualityAigc: {
        enabled: config.quality.lowQualityAigc.enabled.get(),
        maxAigcMarkerRatio: config.quality.lowQualityAigc.maxAigcMarkerRatio.get(),
      },
      domainReputation: {
        enabled: config.quality.domainReputation.enabled.get(),
        blocklist: [...config.quality.domainReputation.blocklist.get()],
        allowlist: [...config.quality.domainReputation.allowlist.get()],
      },
      authority: {
        enabled: config.quality.authority.enabled.get(),
        minScore: config.quality.authority.minScore.get(),
      },
      freshness: {
        enabled: config.quality.freshness.enabled.get(),
        staleDays: config.quality.freshness.staleDays.get(),
      },
      conflict: {
        enabled: config.quality.conflict.enabled.get(),
      },
      annotate: {
        enabled: config.quality.annotate.enabled.get(),
      },
    },
    logLevel: config.logLevel.get(),
    structuredLog: config.structuredLog.get(),
  }
}

/** Whether one engine entry is structurally usable. */
export function engineProblems(engine: EngineSpec, parsedIds: readonly string[]): string[] {
  const problems: string[] = []
  if (engine.id.trim().length === 0) problems.push('缺少 id')
  if (engine.endpoint.trim().length === 0) problems.push('缺少 endpoint')
  else if (!isParsableEndpoint(engine.endpoint)) problems.push(`endpoint 无法解析为 URL：${engine.endpoint}`)
  if (engine.requiresKey && (engine.credentialRef ?? '').trim().length === 0) {
    problems.push('requiresKey 为真但未填写 credentialRef')
  }
  if (engine.resultParser.trim().length === 0) problems.push('缺少 resultParser')
  else if (!parsedIds.includes(engine.resultParser)) problems.push(`未知解析策略：${engine.resultParser}`)
  return problems
}

/** Whether an engine endpoint is an absolute URL (query templates are allowed to contain `{query}`). */
function isParsableEndpoint(endpoint: string): boolean {
  const probe = endpoint.replaceAll('{query}', 'probe').replaceAll('{region}', 'probe').replaceAll('{language}', 'probe')
  try {
    const url = new URL(probe)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Structural configuration validation.
 *
 * DSH's Schemastery build has no `.check()`, so cross-field rules are enforced
 * here, at `apply()` time — the same place the first-party providers validate
 * (`as ResolvedConfig` plus explicit asserts). The settings panel mirrors these
 * rules for immediate feedback, but the Host remains the authority.
 *
 * @param resolved - one plain config snapshot.
 * @param parsedIds - ids of the result parsers currently registered.
 * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` on the first violation.
 */
export function validateConfig(resolved: ResolvedConfig, parsedIds: readonly string[]): void {
  const fail = (message: string): never => {
    throw new LocalBrowserWebError(`local-browser-web: ${message}`, 'ENGINE_CONFIG_INVALID')
  }
  if (!Number.isFinite(resolved.fetchTimeoutMs) || resolved.fetchTimeoutMs <= 0) fail('fetchTimeoutMs 必须为正数')
  if (!Number.isFinite(resolved.searchTimeoutMs) || resolved.searchTimeoutMs <= 0) fail('searchTimeoutMs 必须为正数')
  if (!Number.isInteger(resolved.maxConcurrency) || resolved.maxConcurrency < 1) fail('maxConcurrency 必须为正整数')
  if (!Number.isFinite(resolved.launchTimeoutMs) || resolved.launchTimeoutMs < 3_000) {
    fail('launchTimeoutMs 必须不小于 3000')
  }
  if (resolved.searchScorer.trim() === 'rerank-http') {
    let rerankUrl: URL | undefined
    try {
      rerankUrl = new URL(resolved.rerankEndpoint.trim())
    } catch {
      rerankUrl = undefined
    }
    if (rerankUrl === undefined) fail(`rerankEndpoint 不是合法 URL：${resolved.rerankEndpoint}`)
    const protocol = rerankUrl?.protocol ?? ''
    if (protocol !== 'http:' && protocol !== 'https:') {
      fail(`rerankEndpoint 协议不支持：${protocol}`)
    }
    if (!Number.isFinite(resolved.rerankTimeoutMs) || resolved.rerankTimeoutMs < 500) {
      fail('rerankTimeoutMs 必须不小于 500')
    }
  }
  if (resolved.chromePath.trim().length > 0 && !isAbsolute(resolved.chromePath.trim())) {
    fail('chromePath 必须是绝对路径')
  }
  if (resolved.chromeProfileDir.trim().length > 0 && !isAbsolute(resolved.chromeProfileDir.trim())) {
    fail('chromeProfileDir 必须是绝对路径')
  }

  if (resolved.proxy.enabled) {
    try {
      parseProxyUrl(resolved.proxy.url, resolved.proxy.bypass)
    } catch (error) {
      // `parseProxyUrl` already names the offending part; only the wrapper is
      // rewritten so the message is not prefixed twice.
      const detail = error instanceof Error
        ? error.message.replace(/^local-browser-web:\s*/u, '')
        : String(error)
      fail(`代理配置无效：${detail}`)
    }
  }

  const seen = new Set<string>()
  for (const engine of resolved.engines) {
    for (const problem of engineProblems(engine, parsedIds)) {
      fail(`引擎 "${engine.id || '(未命名)'}" 配置无效：${problem}`)
    }
    if (seen.has(engine.id)) fail(`引擎 id 重复：${engine.id}`)
    seen.add(engine.id)
  }

  const enabled = resolved.engines.filter(engine => engine.enabled)
  if (resolved.searchProvider === LOCAL_SEARCH_PROVIDER_ID && enabled.length === 0) {
    fail('至少需要启用一个引擎，否则本地搜索无可用引擎')
  }
  if (resolved.dispatchMode === 'parallel' && resolved.parallelMaxEngines > enabled.length) {
    fail(`parallel 并发数（${String(resolved.parallelMaxEngines)}）不得超过已启用引擎数（${String(enabled.length)}）`)
  }
  if (resolved.fetchBackend === 'cdp') {
    const endpoint = resolved.cdpEndpoint.trim()
    if (endpoint.length === 0) fail('fetchBackend 为 cdp 时 cdpEndpoint 不得为空')
    try {
      new URL(endpoint)
    } catch {
      fail(`cdpEndpoint 不是合法 URL：${endpoint}`)
    }
  }
  for (const [name, list] of [['blocklist', resolved.quality.domainReputation.blocklist], ['allowlist', resolved.quality.domainReputation.allowlist]] as const) {
    for (const domain of list) {
      if (domain.trim().length === 0) fail(`域名${name} 含空条目`)
    }
  }
}

/** Additional helpers used by `apply` for engine params. */

/** Resolve one engine's effective query parameter name. */
export function queryParamOf(engine: EngineSpec): string {
  const param = (engine.extraParams satisfies EngineExtraParams | undefined)?.queryParam
  return param !== undefined && param.trim().length > 0 ? param : 'q'
}

/** Build the fully-resolved engine list the registry consumes. */
export function resolvedEngines(config: Config): EngineSpec[] {
  const engines = config.engines.get()
  return engines.map(engine => ({ ...engine }))
}

/** Context type re-export so consumers of this module need not import cordis directly. */
export type { Context }
