/**
 * The result-scoring seam: a pluggable stage between "sources collected" and
 * "sources handed to the model".
 *
 * Two kinds share one interface on purpose:
 *
 * - `rerank` reorders candidates by relevance to the query (a cross-encoder,
 *   `bge-reranker-v2-m3` and friends). It returns one score per candidate.
 * - `evidence` extracts structured claims/numbers from the text so a later
 *   stage can compare sources. It may return scores too, but its product is
 *   evidence, not a verdict.
 *
 * The hard rule both obey: **reorder and annotate, never drop.** A scorer that
 * is unreachable, slow, or wrong must leave the result set complete. That is
 * what makes it safe to put a small local model in the path at all.
 *
 * @module dsh-local-browser-web/search/scorers
 */
import type { RankedSource } from '../quality/filter.ts'

/** One candidate as a scorer sees it. */
export interface ScoreCandidate {
  /** Destination URL, also the identity used to align scores back to sources. */
  url: string
  title?: string
  snippet?: string
}

/** One extracted claim; reserved for the evidence kind (e.g. a local 7B). */
export interface ScoreEvidence {
  /** What the source asserts, e.g. "latest release is 4.1". */
  claim: string
  /** The machine-comparable part, e.g. "4.1" or "2026-10-17". */
  value?: string
  /** Which candidate produced it. */
  sourceUrl: string
}

/** What a scorer receives. */
export interface ScoreRequest {
  /** The user's query, verbatim. */
  query: string
  /** Candidates in the order quality ranking produced. */
  candidates: readonly ScoreCandidate[]
}

/** What a scorer returns. */
export interface ScoreResult {
  /** One score per candidate, in candidate order. Higher means more relevant. */
  scores: readonly number[]
  /** Extracted claims, when the scorer is an `evidence` kind. */
  evidence?: readonly ScoreEvidence[]
  /** Free-form note for the operation log (never shown to the model). */
  detail?: string
}

/** A pluggable scoring strategy. */
export interface SearchScorer {
  /** Unique id; the config's `searchScorer` selects by this value. */
  readonly id: string
  /** Display name for diagnostics. */
  readonly label: string
  /** Whether this stage reorders (`rerank`) or only extracts (`evidence`). */
  readonly kind: 'rerank' | 'evidence'
  /** Score (and optionally extract) one batch. May throw; the caller degrades. */
  score(request: ScoreRequest, signal?: AbortSignal): Promise<ScoreResult>
}

/** Id-keyed registry; registration is an addition, never an edit. */
export class ScorerRegistry {
  private readonly scorers = new Map<string, SearchScorer>()

  /**
   * Register a scorer.
   * @param scorer - the strategy.
   * @returns the disposer removing it.
   */
  register(scorer: SearchScorer): () => void {
    this.scorers.set(scorer.id, scorer)
    return () => {
      if (this.scorers.get(scorer.id) === scorer) this.scorers.delete(scorer.id)
    }
  }

  /** Look one up by id. */
  get(id: string): SearchScorer | undefined {
    return this.scorers.get(id)
  }

  /** Every registered id, sorted for stable display. */
  ids(): string[] {
    return [...this.scorers.keys()].sort()
  }
}

/** How much the reranker outranks the built-in quality score when blending. */
export const RERANK_WEIGHT = 0.6

/**
 * Reorder ranked sources by a blend of the scorer's relevance and the quality
 * score, keeping every source.
 *
 * Both inputs are min-max normalised over this batch, because a cross-encoder
 * emits raw logits whose absolute scale is model-specific; blending raw logits
 * with a 0–100 quality score would let whichever happens to have larger units
 * decide the order. When a batch has no spread the two contribute equally
 * neutral values (0.5), which leaves the quality order intact.
 *
 * @param ranked - sources in quality order.
 * @param scores - one relevance score per source, in the same order.
 * @param weight - weight of the relevance score, 0–1.
 * @returns a new array, ordered by the blend; ties keep quality order.
 */
export function blendScores(
  ranked: readonly RankedSource[],
  scores: readonly number[],
  weight: number = RERANK_WEIGHT,
): RankedSource[] {
  if (ranked.length === 0) return []
  const usable = scores.length === ranked.length && scores.every(score => Number.isFinite(score))
  if (!usable) return [...ranked]

  const relevance = normalise(scores)
  const quality = ranked.map(({ quality: verdict }) => verdict.score / 100)
  return ranked
    .map((entry, index) => ({
      entry,
      index,
      combined: weight * (relevance[index] ?? 0.5) + (1 - weight) * (quality[index] ?? 0.5),
    }))
    .sort((left, right) => right.combined - left.combined || left.index - right.index)
    .map(({ entry }) => entry)
}

/** Min-max to 0–1; a flat batch becomes a neutral 0.5 for every member. */
function normalise(values: readonly number[]): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max - min < 1e-9) return values.map(() => 0.5)
  return values.map(value => (value - min) / (max - min))
}

/** Project sources into the candidate shape a scorer reads. */
export function candidatesOf(ranked: readonly RankedSource[]): ScoreCandidate[] {
  return ranked.map(({ source }) => ({
    url: source.url,
    ...source.title === undefined ? {} : { title: source.title },
    ...source.snippet === undefined ? {} : { snippet: source.snippet },
  }))
}
