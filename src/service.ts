/**
 * The plugin's public surface for other plugins.
 *
 * This is the "third-party extensibility" seam the task asks for: a plugin that
 * ships a SearXNG JSON parser, a Brave engine, or a different renderer registers
 * it here and it joins the running chain — no fork, no edit to this package.
 *
 * Registration goes through a Cordis *service* rather than a module import,
 * because the browser half and the host half of DSH are separate module worlds
 * (`packages/client/tsdown.client.ts`'s purity gate forbids cross-plugin value
 * imports) and because a service's registrations are bound to the caller's fiber:
 * when the contributing plugin unloads, so does its engine.
 *
 * @module dsh-local-browser-web/service
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { EngineRegistry } from './engines/registry.ts'
import type { ParserRegistry } from './engines/parsers.ts'
import type { FetchBackendRegistry } from './fetch/backends.ts'
import type { Diagnostics, OperationRecord } from './log.ts'
import type { SearchScorer, ScorerRegistry } from './search/scorers.ts'
import type { EngineSpec, FetchBackend, ResultParser } from './types.ts'

/** What the service needs from the plugin instance. */
export interface LocalBrowserWebDeps {
  engines: EngineRegistry
  parsers: ParserRegistry
  backends: FetchBackendRegistry
  scorers: ScorerRegistry
  diagnostics: Diagnostics
}

/**
 * The `ctx.localBrowserWeb` service.
 *
 * Every registration returns a disposer; callers should install it with
 * `ctx.effect(() => service.registerEngine(spec), '…')` so their contribution
 * leaves with their own fiber.
 */
export class LocalBrowserWebService extends Service {
  /**
   * @param ctx - the providing plugin's context.
   * @param deps - the registries and diagnostics this plugin owns.
   */
  constructor(ctx: Context, private readonly deps: LocalBrowserWebDeps) {
    super(ctx, 'localBrowserWeb')
  }

  /**
   * Register a result-parsing strategy.
   * @param id - the strategy id engines reference from `resultParser`.
   * @param parser - the strategy.
   * @returns the disposer removing it.
   */
  registerResultParser(id: string, parser: ResultParser): () => void {
    return this.deps.parsers.register(id, parser)
  }

  /**
   * Register an engine at runtime. It joins the configured engines in dispatch order.
   * @param spec - the engine.
   * @returns the disposer removing it.
   * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` when the entry is unusable.
   */
  registerEngine(spec: EngineSpec): () => void {
    return this.deps.engines.register(spec)
  }

  /**
   * Register a fetch backend.
   * @param id - the backend id `fetchBackend` selects.
   * @param backend - the backend.
   * @returns the disposer removing it.
   */
  registerFetchBackend(id: string, backend: FetchBackend): () => void {
    return this.deps.backends.register(id, backend)
  }

  /**
   * Register a result scorer (a reranker, or an evidence extractor such as a
   * local 7B). Selecting it is a config change (`searchScorer`), not a reload.
   * @param scorer - the strategy.
   * @returns the disposer removing it.
   */
  registerScorer(scorer: SearchScorer): () => void {
    return this.deps.scorers.register(scorer)
  }

  /** Every registered scorer id. */
  scorers(): string[] {
    return this.deps.scorers.ids()
  }

  /** Every engine in dispatch order (configured plus runtime-registered). */
  engines(): EngineSpec[] {
    return this.deps.engines.list()
  }

  /** Every registered parser id. */
  resultParsers(): string[] {
    return this.deps.parsers.ids()
  }

  /** Every registered fetch-backend id. */
  fetchBackends(): string[] {
    return this.deps.backends.ids()
  }

  /**
   * The recent operation log this plugin keeps in memory.
   * @param limit - how many records to return.
   * @param onlyFailures - keep only records carrying a failure code.
   * @returns newest-first records.
   */
  recentDiagnostics(limit?: number, onlyFailures?: boolean): OperationRecord[] {
    return this.deps.diagnostics.recent(limit, onlyFailures)
  }
}
