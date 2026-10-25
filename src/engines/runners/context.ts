/**
 * Shared plumbing for the engine runners.
 *
 * A runner's whole job is: turn `(engine, query)` into a raw payload, then hand it
 * to the engine's registered parser. Which runner runs is decided by the engine's
 * `kind`, so a new engine never means a new code path — only new metadata.
 *
 * @module dsh-local-browser-web/engines/runners/context
 */
import type { CdpBrowser } from '../../browser/cdp.ts'
import type { PlaywrightBrowser } from '../../browser/playwright.ts'
import type { ResolvedConfig } from '../../config.ts'
import { DEFAULT_USER_AGENT } from '../../config.ts'
import type { ParserRegistry } from '../parsers.ts'
import type { EngineKind, EngineSpec, RawSearchSource } from '../../types.ts'

/** Everything a runner needs, resolved per operation. */
export interface RunnerContext {
  /** The live config snapshot. */
  config: () => ResolvedConfig
  /** The CDP browser (used by `browser`-kind engines). */
  cdp: CdpBrowser
  /** The optional Playwright browser. */
  playwright: PlaywrightBrowser
  /** The parser registry. */
  parsers: ParserRegistry
  /** Resolve a credential reference to its literal value (never logged). */
  resolveCredential: (ref: string) => Promise<string | undefined>
  /**
   * Per-kind runner overrides.
   *
   * Dispatch routes on `kind`; supplying a runner here replaces the built-in one
   * for that kind without registering a new engine. Tests use it to run dispatch
   * against deterministic engines, and a deployment with its own transport (an
   * internal proxy, a fixture recorder) can do the same.
   */
  runners?: Partial<Record<EngineKind, EngineRunner>>
}

/** How a runner produces raw sources for one engine. */
export type EngineRunner = (
  engine: EngineSpec,
  query: string,
  ctx: RunnerContext,
  signal?: AbortSignal,
) => Promise<RawSearchSource[]>

/** Per-engine mapping of the generic region/language/safe-search hints onto real query parameters. */
interface ParamNames {
  region: string
  language: string
  safeSearch: string
  /** safe-search policy → parameter value. */
  safeSearchValues: Record<'off' | 'moderate' | 'strict', string>
}

/** Known engines' parameter names; anything else uses the generic names. */
const PARAM_NAMES: Record<string, ParamNames> = {
  bing: {
    region: 'cc',
    language: 'setlang',
    safeSearch: 'adlt',
    safeSearchValues: { off: 'off', moderate: 'moderate', strict: 'strict' },
  },
  duckduckgo: {
    region: 'kl',
    language: 'kl',
    safeSearch: 'kp',
    safeSearchValues: { off: '-2', moderate: '-1', strict: '1' },
  },
  google: {
    region: 'gl',
    language: 'hl',
    safeSearch: 'safe',
    safeSearchValues: { off: 'off', moderate: 'active', strict: 'active' },
  },
}

/** The generic fallback parameter names. */
const GENERIC_PARAMS: ParamNames = {
  region: 'region',
  language: 'language',
  safeSearch: 'safeSearch',
  safeSearchValues: { off: 'off', moderate: 'moderate', strict: 'strict' },
}

/**
 * Build the request URL for one search.
 *
 * `{query}` in the endpoint is substituted in place (needed by engines whose query
 * is part of the path); otherwise the query is appended under the engine's
 * `queryParam`. Region/language/safe-search hints use each engine's real parameter
 * names where they are known and generic names elsewhere.
 *
 * @param engine - the engine being queried.
 * @param query - the search terms.
 * @returns the absolute request URL.
 */
export function buildSearchUrl(engine: EngineSpec, query: string): URL {
  const params = engine.extraParams ?? {}
  const placeholder = engine.endpoint.includes('{query}')
  const templated = engine.endpoint
    .replaceAll('{query}', encodeURIComponent(query))
    .replaceAll('{region}', encodeURIComponent(params.region ?? ''))
    .replaceAll('{language}', encodeURIComponent(params.language ?? ''))
  const url = new URL(templated)
  const names = PARAM_NAMES[engine.id.toLowerCase()] ?? GENERIC_PARAMS
  if (!placeholder) url.searchParams.set(params.queryParam ?? 'q', query)
  if (params.region !== undefined && params.region.length > 0 && !placeholder) {
    url.searchParams.set(names.region, params.region)
  }
  if (params.language !== undefined && params.language.length > 0 && names.language !== names.region) {
    url.searchParams.set(names.language, params.language)
  }
  if (params.safeSearch !== undefined) {
    url.searchParams.set(names.safeSearch, names.safeSearchValues[params.safeSearch])
  }
  return url
}

/**
 * Ceiling for a SERP body, independent of the document cap.
 *
 * A SERP is not a document: engines ship hundreds of kilobytes of inlined CSS and
 * bootstrap JSON *before* the result list — 360 Search places its first result
 * around 330 KB, and beyond that on other surfaces. Applying the 100 k document cap
 * here silently yields "0 results" for a page that has plenty. The parsed sources
 * are all that leave the runner, so this bound costs memory, not model context.
 */
const SEARCH_BODY_CHARS = 2_000_000

/** The HTTP limits one search uses, derived from the live config. */
export function searchLimits(config: ResolvedConfig): {
  timeoutMs: number
  maxResponseBytes: number
  maxBodyChars: number
  maxRedirects: number
  userAgent: string
} {
  return {
    timeoutMs: config.searchTimeoutMs,
    // Search responses are small; the fetch caps are a safe, generous bound.
    maxResponseBytes: config.maxResponseBytes,
    maxBodyChars: Math.max(config.maxBodyChars, SEARCH_BODY_CHARS),
    maxRedirects: 5,
    // An empty setting means "present as a normal browser", not "send no UA".
    userAgent: config.userAgent.length > 0 ? config.userAgent : DEFAULT_USER_AGENT,
  }
}
