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
import type { ConflictNote } from '../quality/conflict.ts'
import { detectConflicts } from '../quality/conflict.ts'
import { rankSources, type RankedSource } from '../quality/filter.ts'
import { TIER_LABELS, tierOf } from '../quality/source-tiers.ts'
import { blendScores, candidatesOf, type ScorerRegistry, type ScoreEvidence } from '../search/scorers.ts'
import type { QualityVerdict, RawSearchSource } from '../types.ts'

/** What the provider reads per operation. */
export interface SearchProviderDeps {
  config: () => ResolvedConfig
  registry: EngineRegistry
  runner: RunnerContext
  diagnostics: Diagnostics
  scorers: ScorerRegistry
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
function toSeamSource(source: RawSearchSource, summary: string | undefined): WebSearchSource {
  return {
    url: source.url,
    ...source.title === undefined ? {} : { title: source.title },
    ...source.snippet === undefined ? {} : { snippet: source.snippet },
    ...summary === undefined ? {} : { summary },
    ...source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt },
  }
}

/** A provider date short enough to read: epoch millis become an ISO day. */
function dateLabelOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  if (/^\d{10}$/u.test(text) || /^\d{13}$/u.test(text)) {
    const millis = text.length === 10 ? Number(text) * 1000 : Number(text)
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
  }
  return text.length <= 24 ? text : text.slice(0, 24)
}

/**
 * Build the reader-facing annotation for one source.
 *
 * This is the "备料" half of source vetting: the seam's source shape is closed, so
 * the evidence about *where* the text came from rides `summary`, which
 * `dsh-tool-web` renders in preference to the raw snippet. The model then sees
 * the publisher class, whether the page is first-hand, how old it is, and any
 * contradiction with a sibling source — without a second model, and without
 * spending a token to compute it.
 *
 * @param source - the source being annotated.
 * @param quality - its verdict, whose flags carry the primary/fresh labels.
 * @param conflict - a contradiction found against another source, when any.
 * @returns the annotation text, or `undefined` when there is nothing to say.
 */
export function annotationOf(
  source: RawSearchSource,
  quality: QualityVerdict,
  conflict: ConflictNote | undefined,
): string | undefined {
  const parts: string[] = []
  const label = TIER_LABELS[tierOf(source.url).tier]
  if (label.length > 0) parts.push(label)
  if (quality.flags.includes('primary-source')) parts.push('一手')
  else if (quality.flags.includes('secondary-source')) parts.push('二手')
  const date = dateLabelOf(source.publishedAt)
  if (date !== undefined && date.length > 0) parts.push(date)
  if (conflict !== undefined) parts.push(`与 ${conflict.otherHost} 分歧：${conflict.mine} vs ${conflict.theirs}`)
  return parts.length === 0 ? undefined : `〔${parts.join('·')}〕`
}

/**
 * `dsh-tool-web` caps a summary at 800 characters. That cap is outside this
 * plugin, so the snippet is bounded here first — otherwise a long snippet would
 * push the annotation past the cap and the evidence would be silently dropped,
 * which is the one thing this annotation exists to prevent.
 */
const SNIPPET_HEAD_CHARS = 600

/** Attach the annotation to the snippet the model will read. */
export function withAnnotation(source: RawSearchSource, annotation: string | undefined): string | undefined {
  if (annotation === undefined) return undefined
  const snippet = source.snippet?.trim() ?? ''
  if (snippet.length === 0) return annotation
  const head = snippet.length <= SNIPPET_HEAD_CHARS ? snippet : `${snippet.slice(0, SNIPPET_HEAD_CHARS)}…`
  return `${head} ${annotation}`
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
   * Run the configured scorer, if one is selected.
   *
   * A scorer is an enrichment, never a gate: an unregistered id, an unreachable
   * endpoint, or a malformed answer all leave the quality ordering untouched and
   * the full result set intact. The failure goes to the diagnostics ring, where
   * `local_search_test recent:true` can show it without a log dive.
   *
   * @param config - one resolved config snapshot.
   * @param ranked - sources in quality order.
   * @param query - the query being answered.
   * @param signal - caller cancellation.
   * @param started - when the search began, for the diagnostic record.
   * @returns the final order plus any claims an evidence scorer extracted.
   */
  private async applyScorer(
    config: ResolvedConfig,
    ranked: RankedSource[],
    query: string,
    signal: AbortSignal | undefined,
    started: number,
  ): Promise<{ ordered: RankedSource[], evidence?: readonly ScoreEvidence[] }> {
    const id = config.searchScorer.trim()
    if (id.length === 0 || ranked.length === 0) return { ordered: ranked }
    const scorer = this.deps.scorers.get(id)
    if (scorer === undefined) {
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'search',
        target: query,
        elapsedMs: Date.now() - started,
        code: 'SCORER_UNAVAILABLE',
        message: `未注册的评分器：${id}`,
      })
      return { ordered: ranked }
    }
    try {
      const result = await scorer.score({ query, candidates: candidatesOf(ranked) }, signal)
      // An `evidence` scorer (a local extractor) deliberately does not reorder:
      // its output is material for a later comparison stage, not a verdict.
      const ordered = scorer.kind === 'rerank' ? blendScores(ranked, result.scores) : ranked
      return result.evidence === undefined ? { ordered } : { ordered, evidence: result.evidence }
    } catch (error) {
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'search',
        target: query,
        elapsedMs: Date.now() - started,
        code: 'SCORER_FAILED',
        message: `${scorer.label}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return { ordered: ranked }
    }
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
      const applied = await this.applyScorer(config, ranked, request.query, signal, started)
      const ordered = applied.ordered
      const conflicts = config.quality.conflict.enabled
        ? detectConflicts(outcome.sources)
        : new Map<string, ConflictNote>()
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'search',
        engine: outcome.served.join('+'),
        target: request.query,
        elapsedMs: Date.now() - started,
        chars: outcome.sources.reduce((sum, source) => sum + (source.snippet?.length ?? 0), 0),
        quality: aggregateVerdict(ordered),
        ...applied.evidence === undefined ? {} : { evidence: applied.evidence },
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
      return {
        sources: ordered.map(({ source, quality }) => toSeamSource(
          source,
          config.quality.annotate.enabled
            ? withAnnotation(source, annotationOf(source, quality, conflicts.get(source.url)))
            : undefined,
        )),
        truncated: false,
      }
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
