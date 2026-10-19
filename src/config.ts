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
import { LocalBrowserWebError } from './errors.ts'
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
export const DEFAULT_USER_AGENT = 'deepseek-harness-local-browser/0.1.0'

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
    kind: 'browser',
    endpoint: 'https://duckduckgo.com/?q={query}',
    requiresKey: false,
    resultParser: 'html-ddg',
    priority: 20,
    enabledByDefault: true,
    enabled: true,
  },
]

/** Result-parser ids that ship with the plugin. */
export const BUILT_IN_PARSERS = ['html-bing', 'html-ddg', 'json-generic'] as const

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
  extraParams: engineExtraParamsSchema.comment('引擎专属参数'),
})

/** The quality-filter rule set. Each rule is independently switchable. */
const qualitySchema = z.object({
  enabled: z.boolean().default(true).volatile().comment('质量过滤总开关（调试可一键旁路）'),
  thinContent: z.object({
    enabled: z.boolean().default(true).volatile().comment('薄内容检测'),
    minChars: z.number().step(1).min(0).default(200).volatile().comment('正文字符数下限，低于即判薄内容'),
  }),
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
    enabled: z.boolean().default(true).volatile().comment('权威度信号检测'),
    minScore: z.number().min(0).max(100).default(30).volatile().comment('权威度得分下限，低于即在结果中降权'),
  }),
})

/** The four-stage cleaning pipeline's per-stage switches. */
const cleanSchema = z.object({
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
  /** Upper bound on concurrent fetches. */
  maxConcurrency: Volatile<number>
  /** Response size cap, in bytes. */
  maxResponseBytes: Volatile<number>
  /** Decoded body length cap, in characters. */
  maxBodyChars: Volatile<number>
  /** `User-Agent` sent by the HTTP backend and by HTTP-kind engines. */
  userAgent: Volatile<string>
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
  maxConcurrency: z.number().step(1).min(1).max(8).default(2).volatile()
    .comment('并发抓取上限'),
  maxResponseBytes: z.number().step(1).min(1_024).default(5_000_000).volatile()
    .comment('响应体字节上限'),
  maxBodyChars: z.number().step(1).min(256).default(100_000).volatile()
    .comment('正文解码后字符上限'),
  userAgent: z.string().default(DEFAULT_USER_AGENT).volatile().comment('HTTP 请求使用的 User-Agent'),

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
  fetchProvider: string
  fetchBackend: FetchBackendId
  browserPath: string | undefined
  cdpEndpoint: string
  headless: boolean
  profileMode: ProfileMode
  fetchTimeoutMs: number
  maxConcurrency: number
  maxResponseBytes: number
  maxBodyChars: number
  userAgent: string
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
    seoSpam: { enabled: boolean, maxKeywordDensity: number, maxDuplicateRatio: number }
    lowQualityAigc: { enabled: boolean, maxAigcMarkerRatio: number }
    domainReputation: { enabled: boolean, blocklist: string[], allowlist: string[] }
    authority: { enabled: boolean, minScore: number }
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
    fetchProvider: config.fetchProvider.get(),
    fetchBackend: config.fetchBackend.get(),
    browserPath: config.browserPath.get(),
    cdpEndpoint: config.cdpEndpoint.get(),
    headless: config.headless.get(),
    profileMode: config.profileMode.get(),
    fetchTimeoutMs: config.fetchTimeoutMs.get(),
    maxConcurrency: config.maxConcurrency.get(),
    maxResponseBytes: config.maxResponseBytes.get(),
    maxBodyChars: config.maxBodyChars.get(),
    userAgent: config.userAgent.get(),
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
