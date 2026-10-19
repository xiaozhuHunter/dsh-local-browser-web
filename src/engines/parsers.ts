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
 * - `json-generic`— a JSON API, with field paths taken from the engine's `extraParams`.
 *
 * @module dsh-local-browser-web/engines/parsers
 */
import { JSDOM } from 'jsdom'
import { LocalBrowserWebError } from '../errors.ts'
import type { EngineSpec, ParserInput, RawSearchSource, ResultParser } from '../types.ts'

/** A parsed-out DOM document. */
interface Dom {
  document: Document
  close: () => void
}

/** Parse one HTML payload into a detached document. */
function domOf(html: string): Dom {
  const dom = new JSDOM(html, { pretendToBeVisual: false })
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
