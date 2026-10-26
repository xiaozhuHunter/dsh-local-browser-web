/**
 * Local-browser `web_search` + `web_fetch` for the DeepSeek Harness `ctx.web` seam.
 *
 * The plugin registers two providers on the seam and composes the pieces around
 * them: an extensible engine registry, a pluggable result-parser map, a
 * `bail`/`parallel` dispatcher, a four-stage fetch cleaning pipeline, a
 * quality-filter layer, and a graphical settings section (the `./client` half).
 *
 * Two design points are worth stating up front, because they are what make the
 * plugin extensible rather than merely configurable:
 *
 * 1. **Engines are data, not code paths.** Bing and DuckDuckGo are just the two
 *    entries a fresh install ships with. `ctx.localBrowserWeb.registerEngine()`
 *    adds more at runtime, and `registerResultParser()` lets a third party teach
 *    the plugin a new SERP or JSON shape without forking it.
 * 2. **Selection is honest about the seam.** `ctx.web` picks ONE provider per
 *    capability, and its selector lives on the `web` row's config — which is not a
 *    volatile schema and therefore not editable from any settings form. So the
 *    panel's provider switch is implemented as a real registration switch here,
 *    and the plugin logs the exact patch line to keep in sync.
 *
 * @module dsh-local-browser-web
 */
import type { Context } from '@deepseek-ai/cordis'
import { CdpBrowser } from './browser/cdp.ts'
import { PlaywrightBrowser } from './browser/playwright.ts'
import {
  Config,
  LOCAL_FETCH_PROVIDER_ID,
  LOCAL_SEARCH_PROVIDER_ID,
  readConfig,
  UPSTREAM_FETCH_PROVIDER_ID,
  UPSTREAM_SEARCH_PROVIDER_ID,
  validateConfig,
  type ResolvedConfig,
} from './config.ts'
import { EngineRegistry } from './engines/registry.ts'
import { ParserRegistry } from './engines/parsers.ts'
import type { RunnerContext } from './engines/runners/context.ts'
import { FetchBackendRegistry, cdpBackend, httpBackend, playwrightBackend } from './fetch/backends.ts'
import { EXTRACT_BODY_CHARS } from './fetch/pipeline.ts'
import type { HttpLimits } from './http.ts'
import { Diagnostics } from './log.ts'
import { browserProxyOf, httpProxyOf } from './proxy.ts'
import { LocalBrowserFetchProvider } from './providers/fetch.ts'
import { LocalBrowserSearchProvider } from './providers/search.ts'
import { LocalBrowserWebService } from './service.ts'
import { registerBrowserControl } from './server/browser-control.ts'
import { HttpRerankScorer } from './search/rerank.ts'
import { ScorerRegistry } from './search/scorers.ts'
import { applyLocalSearchTestTool } from './tools/local-search-test.ts'

import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export { Config, LOCAL_FETCH_PROVIDER_ID, LOCAL_SEARCH_PROVIDER_ID }
export type { Config as LocalBrowserWebConfig } from './config.ts'
export type { EngineSpec, FetchBackend, ResultParser } from './types.ts'
export type { OperationRecord } from './log.ts'
export { LocalBrowserWebService } from './service.ts'
export { LocalBrowserSearchProvider } from './providers/search.ts'
export { LocalBrowserFetchProvider } from './providers/fetch.ts'
export { EngineRegistry } from './engines/registry.ts'
export { FetchBackendRegistry } from './fetch/backends.ts'
export { ScorerRegistry, blendScores } from './search/scorers.ts'
export { HttpRerankScorer } from './search/rerank.ts'
export type {
  SearchScorer,
  ScoreCandidate,
  ScoreEvidence,
  ScoreRequest,
  ScoreResult,
} from './search/scorers.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Third-party registration surface for engines, parsers, and fetch backends. */
    localBrowserWeb: LocalBrowserWebService
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'local-browser-web'

/**
 * Services this plugin needs: the web seam it registers providers into, the tool
 * registry for `local_search_test`, and the system-prompt registry for its
 * guidance section.
 */
export const inject = ['web', 'tools', 'systemPrompt']

/** The profile entry id, used by the settings panel as its config namespace. */
export const ENTRY_ID = 'local-browser-web'

/**
 * Resolve one credential reference through the credentials domain, falling back to
 * the process environment.
 *
 * The literal never leaves this function into a log line, a config file, or a tool
 * result; it is only ever handed to a request header.
 *
 * @param ctx - plugin context.
 * @param ref - the reference name an engine declared.
 * @returns the secret, or undefined when nothing supplies it.
 */
async function resolveCredential(ctx: Context, ref: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const resolved = await credentials.resolve(credentialRef(ref))
    if (resolved !== undefined && resolved.value.length > 0) return resolved.value
  }
  const ambient = process.env[ref]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/**
 * Register the providers, tool, and public service.
 *
 * @param ctx - the plugin's context (its fiber owns every registration made here).
 * @param config - the live config: every editable field is a `Volatile` reference,
 *   read once per operation so a settings save applies to the next call.
 */
export function apply(ctx: Context, config: Config): void {
  /** One plain config snapshot, taken per operation. */
  const getConfig = (): ResolvedConfig => readConfig(config)

  const parsers = new ParserRegistry()
  const engines = new EngineRegistry(() => getConfig().engines, () => parsers.ids())

  const cdp = new CdpBrowser(() => {
    const current = getConfig()
    const proxy = browserProxyOf(current.proxy)
    return {
      endpoint: current.cdpEndpoint,
      userAgent: current.userAgent,
      profileMode: current.profileMode,
      timeoutMs: current.fetchTimeoutMs,
      ...proxy === undefined ? {} : { proxy },
    }
  })
  const playwright = new PlaywrightBrowser(() => {
    const current = getConfig()
    const proxy = browserProxyOf(current.proxy)
    return {
      browserPath: current.browserPath,
      profileMode: current.profileMode,
      userAgent: current.userAgent,
      timeoutMs: current.fetchTimeoutMs,
      ...proxy === undefined ? {} : { proxy },
    }
  })

  const backends = new FetchBackendRegistry()
  const httpLimits = (): HttpLimits => {
    const current = getConfig()
    return {
      timeoutMs: current.fetchTimeoutMs,
      maxResponseBytes: current.maxResponseBytes,
      // The extractor needs the whole document; the user-facing cap is applied
      // to the cleaned output inside the pipeline (see EXTRACT_BODY_CHARS).
      maxBodyChars: Math.max(current.maxBodyChars, EXTRACT_BODY_CHARS),
      maxRedirects: 5,
      userAgent: current.userAgent,
    }
  }
  backends.register('http', httpBackend(httpLimits, () => httpProxyOf(getConfig().proxy)))
  backends.register('cdp', cdpBackend(cdp))
  backends.register('playwright', playwrightBackend(playwright))

  const diagnostics = new Diagnostics(
    ctx.logger,
    () => getConfig().logLevel,
    () => getConfig().structuredLog,
  )

  // The built-in reranker is registered unconditionally: `searchScorer` selects
  // it, and a selection is a volatile config change — making registration
  // conditional would require a reload to turn it on.
  const scorers = new ScorerRegistry()
  scorers.register(new HttpRerankScorer(() => {
    const current = getConfig()
    return {
      endpoint: current.rerankEndpoint,
      model: current.rerankModel,
      timeoutMs: current.rerankTimeoutMs,
    }
  }))

  const runner: RunnerContext = {
    config: getConfig,
    cdp,
    playwright,
    parsers,
    resolveCredential: async ref => await resolveCredential(ctx, ref),
  }

  // The Host is the authority on structural validity; the panel mirrors these
  // rules for immediate feedback, but only this call can fail a bad save.
  validateConfig(getConfig(), parsers.ids())

  // Warm the CDP availability cache in the background so `available()` — which
  // must not make network calls — has a real verdict to read.
  void cdp.reachable().catch(() => undefined)

  const localSearch = config.searchProvider.get() === LOCAL_SEARCH_PROVIDER_ID
  const localFetch = config.fetchProvider.get() === LOCAL_FETCH_PROVIDER_ID

  // Registration is the provider switch: an unregistered provider cannot make the
  // seam ambiguous, which is what lets the panel fall back to the built-in
  // provider without editing the `web` row's config. A toggle takes effect on the
  // next plugin (re)load — see README "已知限制".
  if (localSearch) {
    ctx.web.registerSearchProvider(new LocalBrowserSearchProvider({ config: getConfig, registry: engines, runner, diagnostics, scorers }))
  }
  if (localFetch) {
    ctx.web.registerFetchProvider(new LocalBrowserFetchProvider({ config: getConfig, backends, diagnostics }))
  }

  applyLocalSearchTestTool(ctx, { registry: engines, runner, diagnostics })

  new LocalBrowserWebService(ctx, { engines, parsers, backends, scorers, diagnostics })

  // The panel's "detect and start" button: a named route on the web server, which
  // is the supported path for a third-party plugin (a new Typert remote namespace
  // would require editing DSH's client assembly). Profiles without a web server
  // simply never get the route; the plugin and its providers still work.
  registerBrowserControl(ctx, {
    settings: () => {
      const current = getConfig()
      return {
        endpoint: current.cdpEndpoint,
        chromePath: current.chromePath,
        profileDir: current.chromeProfileDir,
        launchTimeoutMs: current.launchTimeoutMs,
      }
    },
  })

  // The seam selects exactly one provider per capability, and a second usable
  // provider with no pin makes it throw WEB_PROVIDER_AMBIGUOUS. The `web` row's
  // schema is not volatile, so no form can pin it — say exactly what to add.
  if (localSearch || localFetch) {
    const lines = [
      'local-browser-web: 已注册本地 provider。ctx.web 每个能力只选一个 provider，',
      '请在 profile 的 cordis.patch.yml 中固定（否则会出现 WEB_PROVIDER_AMBIGUOUS）：',
    ]
    if (localSearch) lines.push(`  - id: web\n    config: { searchProvider: ${LOCAL_SEARCH_PROVIDER_ID} }`)
    if (localFetch) lines.push(`  - id: web\n    config: { fetchProvider: ${LOCAL_FETCH_PROVIDER_ID} }`)
    lines.push(`回退到内置 provider：把设置面板的 Provider 选成 ${UPSTREAM_SEARCH_PROVIDER_ID} / ${UPSTREAM_FETCH_PROVIDER_ID} 并重载插件。`)
    ctx.logger.info(lines.join('\n'))
  }
}
