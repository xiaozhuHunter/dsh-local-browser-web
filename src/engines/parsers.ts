/**
 * The result-parser registry and the parsers that ship with the plugin.
 *
 * A parser is looked up **by id from a registry**, never through a `switch`, so a
 * third-party plugin adds a strategy (SearXNG JSON, Brave, Serper, a bespoke
 * intranet search) by calling the plugin's public service — no source edit here.
 *
 * Built-ins:
 * - `html-bing`   — Bing's HTML SERP (`li.b_algo`).
 * - `html-ddg`    — DuckDuckGo, both its HTML endpoint and its rendered page.
 * - `html-baidu`  — Baidu's rendered SERP (`#content_left` blocks, `mu` target).
 * - `html-google` — Google's rendered SERP (`#rso` blocks, `h3` title anchors).
 * - `html-so360`  — 360 Search's SERP (`li.res-list`, `data-mdurl` target).
 * - `json-generic`— a JSON API, with field paths taken from the engine's `extraParams`.
 *
 * @module dsh-local-browser-web/engines/parsers
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { LocalBrowserWebError } from '../errors.ts'
import type { EngineSpec, ParserInput, RawSearchSource, ResultParser } from '../types.ts'

/** A parsed-out DOM document. */
interface Dom {
  document: Document
  close: () => void
}

/**
 * Parse one HTML payload into a detached document.
 *
 * A SERP carries megabytes of inlined CSS that jsdom cannot fully parse; those
 * reports are dropped rather than printed, because the plugin's own diagnostics
 * are the channel an operator reads.
 */
function domOf(html: string): Dom {
  const dom = new JSDOM(html, { pretendToBeVisual: false, virtualConsole: new VirtualConsole() })
  return { document: dom.window.document, close: () => { dom.window.close() } }
}

/** Collapse runs of whitespace so snippets read as one line. */
function squash(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined) return undefined
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 0 ? collapsed : undefined
}

/**
 * Normalize a candidate href into an absolute http(s) URL.
 *
 * Engines emit relative hrefs, protocol-relative hrefs, tracking wrappers
 * (`duckduckgo.com/l/?uddg=…`), and `javascript:` placeholders; only real
 * destinations are kept, because a source without a usable URL is not a source.
 *
 * @param href - the raw attribute value.
 * @param base - the engine endpoint used to resolve relatives.
 * @returns the absolute URL, or undefined when there is none.
 */
function absoluteUrl(href: string | null | undefined, base: string): string | undefined {
  const raw = squash(href)
  if (raw === undefined) return undefined
  if (raw.startsWith('javascript:') || raw.startsWith('#')) return undefined
  let resolved: URL
  try {
    resolved = new URL(raw, base)
  } catch {
    return undefined
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined
  // DuckDuckGo's HTML endpoint wraps every result in /l/?uddg=<encoded target>.
  if (/(^|\.)duckduckgo\.com$/u.test(resolved.hostname) && resolved.pathname === '/l/') {
    const target = resolved.searchParams.get('uddg')
    if (target !== null && target.length > 0) {
      const unwrapped = absoluteUrl(target, base)
      if (unwrapped !== undefined) return unwrapped
    }
  }
  return resolved.toString()
}

/** Read the first non-empty text among a node's descendants matching each selector. */
function firstText(root: Element, selectors: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const node = root.querySelector(selector)
    const text = squash(node?.textContent)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * Resolve the destination of a SERP link, preferring an explicit "real URL"
 * attribute over the click-tracking wrapper.
 *
 * Baidu keeps the true target in `mu` on the result block, 360 in `data-mdurl` on
 * the anchor, and Google in `/url?q=`. Reading them is what stops a source's URL
 * from being the engine's own tracking redirect.
 *
 * @param owner - the result block (attributes are also looked up here).
 * @param anchor - the title anchor.
 * @param attributes - attributes that may already hold the target, in order.
 * @param base - the engine endpoint, used to resolve relatives.
 * @returns the absolute target, or undefined.
 */
function serpUrl(
  owner: Element | null | undefined,
  anchor: Element | null | undefined,
  attributes: readonly string[],
  base: string,
): string | undefined {
  for (const attribute of attributes) {
    const raw = owner?.getAttribute(attribute) ?? anchor?.getAttribute(attribute)
    const url = absoluteUrl(raw, base)
    if (url !== undefined) return unwrapQueryRedirect(url, base)
  }
  const href = absoluteUrl(anchor?.getAttribute('href'), base)
  return href === undefined ? undefined : unwrapQueryRedirect(href, base)
}

/**
 * Unwrap the `/url?q=`-style redirect wrappers the SERPs use for outbound links.
 *
 * @param url - an already-absolute URL.
 * @param base - the engine endpoint, used to resolve the unwrapped target.
 * @returns the target when the wrapper carries one, else the input.
 */
function unwrapQueryRedirect(url: string, base: string): string {
  const parsed = new URL(url)
  const wrapped = parsed.searchParams.get('q')
    ?? parsed.searchParams.get('url')
    ?? parsed.searchParams.get('uddg')
    ?? parsed.searchParams.get('u')
  if (wrapped === null || !wrapped.startsWith('http')) return url
  // Only unwrap when the wrapper is the engine's own redirect path, not a real
  // query string that merely happens to contain a URL.
  if (!/^\/(url|link|search\/url)$|^\/l\/$/u.test(parsed.pathname)) return url
  const target = absoluteUrl(wrapped, base)
  return target ?? url
}

/** Whether a SERP block is a paid placement rather than an organic result. */
function isAd(block: Element): boolean {
  if (block.hasAttribute('data-text-ad') || block.hasAttribute('data-tuiguang')) return true
  const marker = block.getAttribute('class') ?? ''
  if (/ec_ad|ec-tuiguang|ec_tuiguang/u.test(marker)) return true
  if (block.closest('#tads, #bottomads, #tadsb') !== null) return true
  return block.querySelector('[class*="tuiguang"], [data-tuiguang], [data-text-ad], .ad-icon, [aria-label="Ads"]') !== null
}

/** Parse Bing's HTML SERP. */
export const htmlBingParser: ResultParser = (input) => {
  const { document, close } = domOf(input.body)
  try {
    const nodes = [...document.querySelectorAll('li.b_algo, li.b_algo.b_algoBorder, .b_results > li.b_algo')]
    const sources: RawSearchSource[] = []
    for (const node of nodes) {
      const anchor = node.querySelector('h2 a[href], h2 a')
      const url = absoluteUrl(anchor?.getAttribute('href'), input.engine.endpoint)
      if (url === undefined) continue
      sources.push({
        url,
        ...withField('title', squash(anchor?.textContent)),
        ...withField('snippet', firstText(node, ['.b_caption p', '.b_snippet', 'p', '.b_algoSlug'])),
        ...withField('publishedAt', squash(node.querySelector('.news_dt, time')?.textContent)),
      })
    }
    return sources
  } finally {
    close()
  }
}

/** Parse DuckDuckGo: the HTML endpoint's `.result` blocks and the rendered page's test-id markup. */
export const htmlDdgParser: ResultParser = (input) => {
  const { document, close } = domOf(input.body)
  try {
    const blocks = [
      ...document.querySelectorAll('div.result, div.web-result, article[data-testid="result"]'),
    ]
    const sources: RawSearchSource[] = []
    for (const block of blocks) {
      const anchor = block.querySelector('a.result__a[href], a[data-testid="result-title-a"][href], h2 a[href]')
      const url = absoluteUrl(anchor?.getAttribute('href'), input.engine.endpoint)
      if (url === undefined) continue
      sources.push({
        url,
        ...withField('title', squash(anchor?.textContent)),
        ...withField('snippet', firstText(block, [
          'a.result__snippet',
          '[data-result="snippet"]',
          '.result__snippet',
          '.result__body',
        ])),
      })
    }
    // Fallback: some DDG surfaces render plain result links without the wrappers above.
    if (sources.length === 0) {
      for (const anchor of document.querySelectorAll('a[href]')) {
        const url = absoluteUrl(anchor.getAttribute('href'), input.engine.endpoint)
        if (url === undefined) continue
        const title = squash(anchor.textContent)
        if (title === undefined || title.length < 4) continue
        sources.push({ url, title })
      }
    }
    return sources
  } finally {
    close()
  }
}

/**
 * DuckDuckGo's main surface is a React app: the document arrives as a shell and
 * the result list is injected, so the parser waits for the list wrapper.
 */
htmlDdgParser.waitFor = ['article[data-testid="result"]', 'ol.react-results--main', 'div.result']

/**
 * Refuse a SERP that is actually a bot interstitial.
 *
 * Baidu answers a plain or unfamiliar request with a `wappass` captcha page whose
 * HTTP status is still 200, so "0 results" would be a misleading verdict: the
 * engine was never asked. Naming the challenge lets the dispatcher fall through to
 * the next engine, and lets `local_search_test` report the real failure stage.
 *
 * @param input - the payload being parsed.
 * @throws {LocalBrowserWebError} `WEB_FETCH_CHALLENGE` when the page is a gate.
 */
function assertNotSerpChallenge(input: ParserInput): void {
  const head = input.body.slice(0, 6_000)
  if (head.includes('百度安全验证') || head.includes('wappass.baidu.com/static/captcha')) {
    throw new LocalBrowserWebError(
      `local-browser-web: 引擎 "${input.engine.id}" 返回百度人机验证页（需要在浏览器中通过验证，或改用移动端 / 更换网络）`,
      'WEB_FETCH_CHALLENGE',
    )
  }
}

/**
 * Read the real destination out of Baidu's mobile card payload.
 *
 * The mobile SERP keeps it in the `data-log` JSON (`mu`, or
 * `logCommonInfo.exposureInfo.url`) while `href` points at Baidu's own redirect,
 * so the attribute is the only faithful source of a URL.
 *
 * @param block - one mobile result card.
 * @param base - the engine endpoint, used to resolve relatives.
 * @returns the absolute target, or undefined.
 */
function dataLogUrl(block: Element, base: string): string | undefined {
  const raw = block.getAttribute('data-log')
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const at = (path: readonly string[]): unknown => {
      let cursor: unknown = parsed
      for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = Reflect.get(cursor, key)
      }
      return cursor
    }
    const candidate = at(['mu']) ?? at(['logCommonInfo', 'exposureInfo', 'url'])
    return typeof candidate === 'string' ? absoluteUrl(candidate, base) : undefined
  } catch {
    return undefined
  }
}

/** Baidu's own placement hosts: recommendation slots and the "no url" interstitial. */
const BAIDU_PLACEMENT = /(^|\.)(?:recommend_list|ubs)\.baidu\.com$/iu

/** Parse Baidu's SERP — the desktop `#content_left` blocks and the mobile `c-result` cards. */
export const htmlBaiduParser: ResultParser = (input) => {
  assertNotSerpChallenge(input)
  const { document, close } = domOf(input.body)
  try {
    const sources: RawSearchSource[] = []
    const seen = new Set<string>()
    const push = (source: RawSearchSource | undefined): void => {
      if (source === undefined || seen.has(source.url)) return
      // Baidu mixes placement slots in with the results; those hosts answer with
      // redirects to its own products and carry no title, so they are not sources.
      if (BAIDU_PLACEMENT.test(new URL(source.url).hostname)) return
      seen.add(source.url)
      sources.push(source)
    }
    // Desktop: the real target is in `mu` on the result block.
    for (const block of document.querySelectorAll('#content_left > div.result, #content_left > div.result-op, div.result.c-container, div.c-container[mu]')) {
      if (isAd(block)) continue
      const anchor = block.querySelector('h3 a[href], h3 a, a[href]')
      const url = serpUrl(block, anchor, ['mu', 'data-landurl'], input.engine.endpoint)
      if (url === undefined) continue
      push({
        url,
        ...withField('title', squash(anchor?.textContent)),
        ...withField('snippet', firstText(block, [
          '.c-abstract',
          '[class*="content-right"]',
          '[class*="c-line-clamp"]',
          '.c-span-last',
          '[class*="summary"]',
        ])),
        ...withField('publishedAt', firstText(block, [
          '[class*="c-color-gray2"]',
          'span.c-color-gray',
          '[class*="c-showurl"] span',
        ])),
      })
    }
    // Mobile (m.baidu.com): SSR cards, real target inside `data-log`.
    for (const block of document.querySelectorAll('div.c-result')) {
      if (isAd(block)) continue
      const anchor = block.querySelector('h3 a[href], h3.cosc-title, h3, a[href]')
      const url = dataLogUrl(block, input.engine.endpoint)
        ?? serpUrl(block, anchor, ['mu', 'rl-link-href', 'data-landurl'], input.engine.endpoint)
      if (url === undefined) continue
      push({
        url,
        ...withField('title', firstText(block, ['h3.cosc-title', '[data-module="title"] h3', 'h3'])),
        ...withField('snippet', firstText(block, [
          '[data-module="summary"]',
          '.cosc-summary',
          '.c-abstract',
          '.cos-line-clamp-2',
          '[class*="summary"]',
        ])),
      })
    }
    return sources
  } finally {
    close()
  }
}

/** Google's click trackers: the destination lives inside the token, not the href. */
const GOOGLE_TRACKER = /^https?:\/\/[^/]*google\.[a-z.]+\/(?:goto|url)\?/iu

/** Parse a rendered Google SERP (`#rso` blocks, `h3` inside the title anchor). */
export const htmlGoogleParser: ResultParser = (input) => {
  const { document, close } = domOf(input.body)
  try {
    // Google nests `div.g` inside `div.MjjYud`; pick ONE granularity so a result is
    // not read twice, and fall back to the older single-wrapper markup.
    const wrappers = [...document.querySelectorAll('#rso div.MjjYud')]
    const blocks = wrappers.length > 0 ? wrappers : [...document.querySelectorAll('div.g, div.tF2Cxc')]
    const sources: RawSearchSource[] = []
    const seen = new Set<string>()
    for (const block of blocks) {
      if (isAd(block)) continue
      const heading = block.querySelector('h3')
      const anchor = heading?.closest('a') ?? block.querySelector('a[href] h3')?.closest('a') ?? block.querySelector('a[href]')
      const url = serpUrl(block, anchor, [], input.engine.endpoint)
      if (url === undefined || seen.has(url)) continue
      // Google's own surfaces (cache, policy pages, "more results") are not sources.
      // Its click trackers are the exception: `/goto?url=` and `/url?` do carry the
      // destination, which the engine's `unwrapRedirect` resolves into a real URL.
      if (!GOOGLE_TRACKER.test(url) && /(^|\.)google\.[a-z.]+$/u.test(new URL(url).hostname)) continue
      seen.add(url)
      sources.push({
        url,
        ...withField('title', squash(heading?.textContent) ?? squash(anchor?.textContent)),
        ...withField('snippet', firstText(block, [
          '.VwiC3b',
          'div.IsZvec',
          'span.aCOpRe',
          '.aCOpRe',
          '[data-sncf]',
        ])),
        ...withField('publishedAt', firstText(block, ['span.MUxGbd span', '.LEwnzc span', 'span.r0bn4c'])),
      })
    }
    return sources
  } finally {
    close()
  }
}

/**
 * Google answers a plain fetch with an "enable JavaScript" shell and only builds
 * `#rso` client-side, so the rendered DOM is empty until that node exists.
 */
htmlGoogleParser.waitFor = ['#rso']

/** Parse 360 Search's SERP (`ul.result > li.res-list`, real URL in `data-mdurl`). */
export const htmlSo360Parser: ResultParser = (input) => {
  const { document, close } = domOf(input.body)
  try {
    const blocks = [...document.querySelectorAll('ul.result > li.res-list, li.res-list')]
    const sources: RawSearchSource[] = []
    const engineHost = new URL(input.engine.endpoint).hostname.toLowerCase()
    for (const block of blocks) {
      if (isAd(block)) continue
      const anchor = block.querySelector('h3.res-title a[href], h3 a[href], a[href]')
      const url = serpUrl(block, anchor, ['data-mdurl'], input.engine.endpoint)
      if (url === undefined) continue
      // "大家都在搜" blocks link back to another 360 SERP; that is a suggestion
      // surface, not a source.
      const resolved = new URL(url)
      if (resolved.hostname.toLowerCase() === engineHost && /^\/s\/?$/u.test(resolved.pathname)) continue
      sources.push({
        url,
        ...withField('title', squash(anchor?.textContent)),
        ...withField('snippet', firstText(block, [
          '.res-list-summary',
          '[data-result-summary]',
          'p.res-desc',
          '.res-desc',
          '.res-comm-con p',
        ])),
        ...withField('publishedAt', firstText(block, ['span.gray', '.res-date', '[class*="date"]'])),
      })
    }
    return sources
  } finally {
    close()
  }
}

/** Read a dotted path (`data.items`) out of a parsed JSON value. */
function atPath(value: unknown, path: string): unknown {
  if (path.trim().length === 0) return value
  let cursor: unknown = value
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = Reflect.get(cursor, segment)
  }
  return cursor
}

/** Coerce a JSON field to a non-empty string, or undefined. */
function stringField(value: unknown): string | undefined {
  if (typeof value === 'string') return squash(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * Map a JSON search API's payload onto sources using the engine's declared field
 * paths. Every path has a widely-used default, so a typical API needs no tuning.
 */
export const jsonGenericParser: ResultParser = (input) => {
  const params = input.engine.extraParams ?? {}
  let payload: unknown
  try {
    payload = JSON.parse(input.body)
  } catch (error) {
    throw new LocalBrowserWebError(
      `local-browser-web: 引擎 "${input.engine.id}" 返回的不是合法 JSON`,
      'ENGINE_TEST_FAILED',
      { cause: error },
    )
  }
  const items = atPath(payload, params.itemsPath ?? 'results')
  if (!Array.isArray(items)) {
    // `data.items` and a bare top-level array are common enough to try before failing.
    const alternative = atPath(payload, 'data.items') ?? payload
    if (!Array.isArray(alternative)) {
      throw new LocalBrowserWebError(
        `local-browser-web: 引擎 "${input.engine.id}" 的 itemsPath（${params.itemsPath ?? 'results'}）未指向数组`,
        'ENGINE_CONFIG_INVALID',
      )
    }
    return mapJsonItems(alternative, params, input.engine)
  }
  return mapJsonItems(items, params, input.engine)
}

/** Project JSON items into sources. */
function mapJsonItems(
  items: readonly unknown[],
  params: NonNullable<EngineSpec['extraParams']>,
  engine: EngineSpec,
): RawSearchSource[] {
  const sources: RawSearchSource[] = []
  for (const item of items) {
    const url = absoluteUrl(stringField(atPath(item, params.urlPath ?? 'url')), engine.endpoint)
    if (url === undefined) continue
    sources.push({
      url,
      ...withField('title', stringField(atPath(item, params.titlePath ?? 'title'))),
      ...withField('snippet', stringField(atPath(item, params.snippetPath ?? 'snippet'))),
      ...withField('publishedAt', stringField(atPath(item, params.publishedAtPath ?? 'publishedAt'))),
    })
  }
  return sources
}

/** Spread a field only when it carries a value, so absent optionals stay absent. */
function withField<K extends 'title' | 'snippet' | 'publishedAt'>(
  key: K,
  value: string | undefined,
): Pick<RawSearchSource, K> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Pick<RawSearchSource, K>
}

/**
 * The plugin's parser registry.
 *
 * Registration returns a disposer so a third-party plugin's parser disappears
 * with the fiber that added it, mirroring how `ctx.web` unregisters providers.
 */
export class ParserRegistry {
  private readonly parsers = new Map<string, ResultParser>()

  constructor() {
    this.parsers.set('html-bing', htmlBingParser)
    this.parsers.set('html-ddg', htmlDdgParser)
    this.parsers.set('html-baidu', htmlBaiduParser)
    this.parsers.set('html-google', htmlGoogleParser)
    this.parsers.set('html-so360', htmlSo360Parser)
    this.parsers.set('json-generic', jsonGenericParser)
  }

  /**
   * Add or replace a parser.
   * @param id - the strategy id engines reference from `resultParser`.
   * @param parser - the strategy.
   * @returns the disposer removing it again.
   */
  register(id: string, parser: ResultParser): () => void {
    const previous = this.parsers.get(id)
    this.parsers.set(id, parser)
    return () => {
      if (this.parsers.get(id) === parser) {
        if (previous === undefined) this.parsers.delete(id)
        else this.parsers.set(id, previous)
      }
    }
  }

  /** Whether a strategy id is registered. */
  has(id: string): boolean {
    return this.parsers.has(id)
  }

  /**
   * Selectors a strategy needs before its document is worth reading.
   *
   * Runners relay this to the rendering backend; an unknown id yields `[]` so a
   * later `parse` call is what reports the missing strategy.
   * @param id - the strategy id.
   * @returns the declared selectors, empty when there are none.
   */
  waiters(id: string): readonly string[] {
    return this.parsers.get(id)?.waitFor ?? []
  }

  /** Every registered strategy id, sorted for stable diagnostics. */
  ids(): string[] {
    return [...this.parsers.keys()].sort()
  }

  /**
   * Run one strategy.
   * @param id - the strategy id.
   * @param input - the raw payload and its engine.
   * @returns normalized sources.
   * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` when the id is unknown.
   */
  parse(id: string, input: ParserInput): RawSearchSource[] {
    const parser = this.parsers.get(id)
    if (parser === undefined) {
      throw new LocalBrowserWebError(
        `local-browser-web: 未注册解析策略 "${id}"（已注册：${this.ids().join(', ') || '无'}）`,
        'ENGINE_CONFIG_INVALID',
      )
    }
    return parser(input)
  }
}
