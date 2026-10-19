/**
 * The `local-browser-search` provider.
 *
 * Its `search()` is the composition of the other modules: registry → dispatch →
 * parser → quality ranking. Nothing here names a concrete engine, so adding one is
 * a config or registration change, never an edit to this file.
 *
 * @module dsh-local-browser-web/providers/search
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { LOCAL_SEARCH_PROVIDER_ID, type ResolvedConfig } from '../config.ts'
import { dispatchSearch } from '../engines/dispatch.ts'
import type { RunnerContext } from '../engines/runners/context.ts'
import type { EngineRegistry } from '../engines/registry.ts'
import { LocalBrowserWebError } from '../errors.ts'
import type { Diagnostics } from '../log.ts'
import { rankSources, type RankedSource } from '../quality/filter.ts'
import type { QualityVerdict, RawSearchSource } from '../types.ts'

/** What the provider reads per operation. */
export interface SearchProviderDeps {
  config: () => ResolvedConfig
  registry: EngineRegistry
  runner: RunnerContext
  diagnostics: Diagnostics
}

/** Union the per-source flags and take the floor score, so one record tells the whole story. */
function aggregateVerdict(ranked: readonly RankedSource[]): QualityVerdict {
  if (ranked.length === 0) return { score: 0, flags: [] }
  const flags = new Set<string>()
  let floor = 100
  for (const { quality } of ranked) {
    for (const flag of quality.flags) flags.add(flag)
    floor = Math.min(floor, quality.score)
  }
  return { score: floor, flags: [...flags] }
}

/** Project a raw source into the seam's shape, omitting absent optionals. */
function toSeamSource(source: RawSearchSource): WebSearchSource {
  return {
    url: source.url,
    ...source.title === undefined ? {} : { title: source.title },
    ...source.snippet === undefined ? {} : { snippet: source.snippet },
    ...source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt },
  }
}

/** Local-browser search over the extensible engine registry. */
export class LocalBrowserSearchProvider implements WebSearchProvider {
  readonly id = LOCAL_SEARCH_PROVIDER_ID

  /**
   * @param deps - live config, the engine registry, the runner context, and diagnostics.
   */
  constructor(private readonly deps: SearchProviderDeps) {}

  /**
   * Cheap, network-free usability check: this provider is selected and at least one
   * engine is enabled. Reachability of a browser-kind engine is discovered at call
   * time, where a failure can name the engine and the code.
   */
  available(): boolean {
    const config = this.deps.config()
    return config.searchProvider === LOCAL_SEARCH_PROVIDER_ID && this.deps.registry.enabled().length > 0
  }

  /**
   * Run one query through the enabled engines.
   * @param request - the query (the seam applies `maxResults` to the result).
   * @param signal - cancellation forwarded to every engine.
   * @returns the merged sources, ranked best-quality first.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const config = this.deps.config()
    const engines = this.deps.registry.enabled()
    const started = Date.now()
    try {
      const outcome = await dispatchSearch(
        engines,
        request.query,
        config.dispatchMode,
        config.parallelMaxEngines,
        this.deps.runner,
        signal,
      )
      const ranked = rankSources(outcome.sources, config.quality)
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'search',
        engine: outcome.served.join('+'),
        target: request.query,
        elapsedMs: Date.now() - started,
        chars: outcome.sources.reduce((sum, source) => sum + (source.snippet?.length ?? 0), 0),
        quality: aggregateVerdict(ranked),
      })
      if (outcome.failures.length > 0) {
        // A partial fallback is worth knowing about even when the call succeeded.
        for (const failure of outcome.failures) {
          this.deps.diagnostics.record({
            at: Date.now(),
            kind: 'search',
            engine: failure.engine,
            target: request.query,
            elapsedMs: Date.now() - started,
            code: failure.code,
            message: failure.message,
          })
        }
      }
      return { sources: ranked.map(({ source }) => toSeamSource(source)), truncated: false }
    } catch (error) {
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'search',
        engine: engines.map(engine => engine.id).join('+'),
        target: request.query,
        elapsedMs: Date.now() - started,
        code: error instanceof LocalBrowserWebError ? error.code : 'ENGINE_TEST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
