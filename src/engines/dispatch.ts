/**
 * Search dispatch: the two scheduling modes the settings panel switches between.
 *
 * - `bail`     — walk the enabled engines in priority order; the first engine that
 *                returns sources wins. Cheap, predictable, and the right default.
 * - `parallel` — query the top-N enabled engines at once and merge, round-robin by
 *                rank with URL dedup. Faster wall-clock, at N× the requests.
 *
 * Both modes run the same registered parser per engine and both record per-engine
 * failures, so a fallback chain that silently degraded is visible in diagnostics
 * instead of looking like an engine that simply found nothing.
 *
 * @module dsh-local-browser-web/engines/dispatch
 */
import { LocalBrowserWebError } from '../errors.ts'
import { httpProxyOf } from '../proxy.ts'
import type { DispatchMode, EngineSpec, EngineKind, RawSearchSource } from '../types.ts'
import { apiRunner } from './runners/api.ts'
import { browserRunner } from './runners/browser.ts'
import { httpHtmlRunner } from './runners/http-html.ts'
import { searchLimits, type EngineRunner, type RunnerContext } from './runners/context.ts'
import { unwrapRedirects } from './unwrap.ts'

/** One engine's failure, kept for diagnostics. */
export interface EngineFailure {
  engine: string
  code: string
  message: string
}

/** What one dispatch produced. */
export interface DispatchOutcome {
  /** Merged, deduplicated sources (not yet quality-ranked or result-capped). */
  sources: RawSearchSource[]
  /** Engines that contributed at least one source. */
  served: string[]
  /** Engines that failed, with the code the caller can act on. */
  failures: EngineFailure[]
}

/**
 * The runner for one engine kind, preferring a context-supplied override.
 * @param kind - the engine's execution route.
 * @param ctx - the runner context (its `runners` may replace a built-in).
 * @returns the runner to use.
 */
export function runnerFor(kind: EngineKind, ctx?: RunnerContext): EngineRunner {
  const override = ctx?.runners?.[kind]
  if (override !== undefined) return override
  switch (kind) {
    case 'http-html': return httpHtmlRunner
    case 'browser': return browserRunner
    case 'api': return apiRunner
  }
}

/** Run one engine, converting any thrown value into a readable failure. */
async function runEngine(
  engine: EngineSpec,
  query: string,
  ctx: RunnerContext,
  signal: AbortSignal | undefined,
): Promise<{ sources: RawSearchSource[] } | { failure: EngineFailure }> {
  try {
    const sources = await runnerFor(engine.kind, ctx)(engine, query, ctx, signal)
    // A tracker URL is not a destination: engines that say so get one redirect hop
    // resolved here, before ranking and dedupe ever see the URL.
    if (engine.unwrapRedirect === undefined) return { sources }
    const config = ctx.config()
    const proxy = httpProxyOf(config.proxy)
    const unwrapped = await unwrapRedirects(sources, {
      pattern: engine.unwrapRedirect,
      limits: searchLimits(config),
      ...proxy === undefined ? {} : { proxy },
      ...signal === undefined ? {} : { signal },
    })
    return { sources: unwrapped }
  } catch (error) {
    const code = error instanceof LocalBrowserWebError ? error.code : 'ENGINE_TEST_FAILED'
    return {
      failure: {
        engine: engine.id,
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Query one engine and parse its results. Used by the settings panel's
 * "test connection" path and by `local_search_test`.
 *
 * @param engine - the engine to test.
 * @param query - the probe query.
 * @param ctx - runner dependencies.
 * @param signal - cancellation.
 * @returns sources on success.
 * @throws {LocalBrowserWebError} `ENGINE_TEST_FAILED`, carrying the failing engine.
 */
export async function queryEngine(
  engine: EngineSpec,
  query: string,
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<RawSearchSource[]> {
  const outcome = await runEngine(engine, query, ctx, signal)
  if ('failure' in outcome) {
    throw new LocalBrowserWebError(outcome.failure.message, 'ENGINE_TEST_FAILED')
  }
  return outcome.sources
}

/** Merge engine result lists round-robin by rank, deduplicating by URL. */
export function mergeRoundRobin(perEngine: readonly (readonly RawSearchSource[])[]): RawSearchSource[] {
  const seen = new Set<string>()
  const merged: RawSearchSource[] = []
  const deepest = perEngine.reduce((max, list) => Math.max(max, list.length), 0)
  for (let rank = 0; rank < deepest; rank += 1) {
    for (const list of perEngine) {
      const source = list[rank]
      if (source === undefined || seen.has(source.url)) continue
      seen.add(source.url)
      merged.push(source)
    }
  }
  return merged
}

/**
 * Run a search across the enabled engines.
 *
 * @param engines - the enabled engines, already in dispatch order.
 * @param query - the search terms.
 * @param mode - `bail` or `parallel`.
 * @param parallelMax - how many engines `parallel` uses.
 * @param ctx - runner dependencies.
 * @param signal - cancellation.
 * @returns merged sources plus per-engine outcomes.
 * @throws {LocalBrowserWebError} `NO_ENABLED_ENGINE` when nothing can run, or the first
 *   engine failure when every engine in the chain failed.
 */
export async function dispatchSearch(
  engines: readonly EngineSpec[],
  query: string,
  mode: DispatchMode,
  parallelMax: number,
  ctx: RunnerContext,
  signal?: AbortSignal,
): Promise<DispatchOutcome> {
  if (engines.length === 0) {
    throw new LocalBrowserWebError(
      'local-browser-web: 所有搜索引擎均被禁用或未被过滤后无可选引擎（NO_ENABLED_ENGINE）',
      'NO_ENABLED_ENGINE',
    )
  }

  if (mode === 'bail') {
    const failures: EngineFailure[] = []
    const served: string[] = []
    for (const engine of engines) {
      const outcome = await runEngine(engine, query, ctx, signal)
      if ('failure' in outcome) {
        failures.push(outcome.failure)
        continue
      }
      if (outcome.sources.length === 0) {
        failures.push({ engine: engine.id, code: 'ENGINE_TEST_FAILED', message: '返回 0 条结果' })
        continue
      }
      served.push(engine.id)
      return { sources: outcome.sources, served, failures }
    }
    throw failureOrNoEngine(failures)
  }

  const chosen = engines.slice(0, Math.max(1, parallelMax))
  const settled = await Promise.all(chosen.map(async engine => await runEngine(engine, query, ctx, signal)))
  const failures: EngineFailure[] = []
  const lists: RawSearchSource[][] = []
  const served: string[] = []
  settled.forEach((outcome, index) => {
    if ('failure' in outcome) {
      failures.push(outcome.failure)
      return
    }
    if (outcome.sources.length === 0) {
      failures.push({ engine: chosen[index]?.id ?? '?', code: 'ENGINE_TEST_FAILED', message: '返回 0 条结果' })
      return
    }
    served.push(chosen[index]?.id ?? '?')
    lists.push(outcome.sources)
  })
  if (lists.length === 0) throw failureOrNoEngine(failures)
  return { sources: mergeRoundRobin(lists), served, failures }
}

/** Build the error a fully-failed dispatch reports. */
function failureOrNoEngine(failures: readonly EngineFailure[]): LocalBrowserWebError {
  if (failures.length === 0) {
    return new LocalBrowserWebError('local-browser-web: 无可用引擎', 'NO_ENABLED_ENGINE')
  }
  const first = failures[0] as EngineFailure
  const detail = failures.map(failure => `${failure.engine}:${failure.code}`).join(', ')
  return new LocalBrowserWebError(
    `local-browser-web: 所有引擎失败（${detail}）；首个失败：${first.message}`,
    first.code === 'ENGINE_CONFIG_INVALID' ? 'ENGINE_CONFIG_INVALID' : 'ENGINE_TEST_FAILED',
  )
}
