/**
 * Shared vocabulary for the local-browser web plugin: the engine registry's
 * entry shape, the dispatch modes, and the fetch-backend identity. These types
 * describe "what" a backend is; the runner layer decides "how" to execute it
 * from `kind`.
 *
 * @module dsh-local-browser-web/types
 */

/** How an engine is executed. The registry stores this; the dispatch layer routes on it. */
export type EngineKind =
  /** Lightweight HTTP fetch, then DOM parsing (no JS execution). */
  | 'http-html'
  /** Full browser render (CDP / Playwright), then DOM parsing. */
  | 'browser'
  /** Credentialed JSON request, then generic field-path mapping. */
  | 'api'

/** Search scheduling strategy, mirroring the `web-search-setup` dispatcher vocabulary. */
export type DispatchMode =
  /** Try enabled engines in priority order; first non-empty result wins. */
  | 'bail'
  /** Query the top-N enabled engines concurrently and merge, deduplicating by URL. */
  | 'parallel'

/** A fetch backend id. `http` is the plain-transport fallback; the rest render. */
export type FetchBackendId = 'cdp' | 'playwright' | 'http'

/** Whether rendered pages reuse one browser profile (cookies, logins) or a fresh one each time. */
export type ProfileMode = 'isolated' | 'shared'

/** Structured log verbosity. */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

/**
 * One search engine, as stored in the plugin config and consumed by the registry.
 *
 * The registry never hardcodes Bing or DuckDuckGo: both ship as ordinary entries
 * with sensible defaults, and a user (or a third-party plugin) can add more by
 * appending an entry — or calling the public registration API — without any
 * source change.
 */
export interface EngineSpec {
  /** Unique engine id, e.g. `bing`, `duckduckgo`, `searxng-custom`. */
  id: string
  /** Display name shown in the settings panel. */
  label: string
  /** Execution route: HTTP DOM fetch, full browser render, or credentialed JSON. */
  kind: EngineKind
  /** Search endpoint (a full URL, or a base URL with `{query}` for `api` kinds). */
  endpoint: string
  /** Whether the engine needs an API key / token. */
  requiresKey: boolean
  /** Credential reference name resolved when `requiresKey`; never a literal key. */
  credentialRef?: string
  /** Result-parsing strategy id; must exist in the parser registry. */
  resultParser: string
  /** Default fallback order; lower runs first. */
  priority: number
  /** Whether a fresh install enables this engine out of the box. */
  enabledByDefault: boolean
  /** Whether the engine currently participates in dispatch. */
  enabled: boolean
  /**
   * Regex source matching result URLs that are click trackers, not destinations.
   *
   * Google stopped exposing real hrefs (`/goto?url=<opaque token>`), so the only
   * way back to the destination is to follow one redirect hop. An engine that
   * declares this pattern gets that hop resolved per result; leaving it out means
   * "every URL the parser produces is already the destination".
   */
  unwrapRedirect?: string
  /** Engine-specific parameters (region, language, safe search, JSON field paths). */
  extraParams?: EngineExtraParams
}

/** Engine-specific knobs the settings panel exposes; absent keys use the runner's defaults. */
export interface EngineExtraParams {
  /** HTTP: query parameter name carrying the search terms (default `q`). */
  queryParam?: string
  /** Region / market hint sent to the engine. */
  region?: string
  /** Result language hint. */
  language?: string
  /** Safe-search policy hint. */
  safeSearch?: 'off' | 'moderate' | 'strict'
  /** `api` parsers: dotted path to the array of result items (e.g. `results` or `data.items`). */
  itemsPath?: string
  /** `api` parsers: dotted path to each item's URL field. */
  urlPath?: string
  /** `api` parsers: dotted path to each item's title field. */
  titlePath?: string
  /** `api` parsers: dotted path to each item's snippet field. */
  snippetPath?: string
  /** `api` parsers: dotted path to each item's publication timestamp field. */
  publishedAtPath?: string
}

/** One parsed search hit. Mirrors the seam's `WebSearchSource`. */
export interface RawSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** What the raw HTML / JSON loader hands to a parser. */
export interface ParserInput {
  /** The engine entry the payload came from (supplies `extraParams`). */
  engine: EngineSpec
  /** The query that produced this payload, for parser-side diagnostics. */
  query: string
  /** The untouched response body. */
  body: string
  /** Response content type, when the runner knows it. */
  contentType?: string
}

/**
 * A result parser: raw payload in, normalized sources out.
 *
 * Parsers are looked up by id from a registry (never a `switch`), so third-party
 * plugins register more strategies through the plugin's public service instead of
 * editing this package.
 */
export type ResultParser = ((input: ParserInput) => RawSearchSource[]) & {
  /**
   * Selectors the strategy needs before the DOM is worth reading.
   *
   * A client-rendered SERP (Google, DuckDuckGo) ships an empty shell first and
   * injects the result list a beat later, so `loadEventFired` can fire while
   * `#rso` still has zero children. Declaring the selector here keeps that
   * knowledge with the strategy that depends on it — the runners stay generic and
   * no new execution path appears. A rendered backend waits for **any** of these
   * to match, then proceeds regardless on timeout.
   */
  waitFor?: readonly string[]
}

/** A raw retrieval handed back by a fetch backend. */
export interface BackendFetchResult {
  /** Final URL after redirects. */
  url: string
  /** HTTP status of the final response. */
  statusCode: number
  /** Response body text (already decoded). */
  body: string
  /** Response content type, lowercased, without parameters. */
  contentType: string
  /** True when the backend capped the body. */
  truncated: boolean
}

/** What a fetch backend is asked for. */
export interface BackendFetchRequest {
  url: string
  timeoutMs: number
  /** Body byte cap; a rendered backend must cut its own output to it. */
  maxBytes: number
  /** Whether the backend should execute the page's JavaScript before reading the DOM. */
  render: boolean
  /** Selectors a rendering backend waits for before reading the DOM; first match wins. */
  waitFor?: readonly string[]
  signal?: AbortSignal
}

/**
 * A fetch backend: transport plus optional rendering.
 *
 * Registered by id in a registry, so a new backend (a different browser, a
 * remote renderer) is an addition rather than an edit.
 */
export interface FetchBackend {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Retrieve one URL, honoring `signal`. */
  fetch(request: BackendFetchRequest): Promise<BackendFetchResult>
}

/** Per-document quality verdict. Never used to silently drop a result. */
export interface QualityVerdict {
  /** 0–100; higher is better. */
  score: number
  /** Names of the rules that fired, in a stable order. */
  flags: string[]
}
