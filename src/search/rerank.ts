/**
 * The built-in reranker: a cross-encoder behind an HTTP endpoint.
 *
 * A dedicated reranker (bge-reranker-v2-m3 is the usual choice) is the cheap half
 * of "judge the results": it is ~0.6B parameters, scores query/candidate pairs in
 * milliseconds on Apple silicon, and is far better at relevance than asking a 7B
 * chat model to reason about it. It does **not** judge truth — that stays with
 * the cloud model, which sees the evidence annotations this plugin attaches.
 *
 * Two response shapes are accepted because the popular servers disagree:
 *
 * - Text Embeddings Inference (`/rerank`): `[{ index, score }]`
 * - Cohere / Jina / Infinity: `{ results: [{ index, relevance_score }] }`
 *
 * A missing `top_n` is treated as "score everything", which is what this stage
 * needs: dropping candidates is the caller's job, and it never does.
 *
 * @module dsh-local-browser-web/search/rerank
 */
import type { ScoreCandidate, ScoreRequest, ScoreResult, SearchScorer } from './scorers.ts'

/** Configuration one reranker instance needs. */
export interface RerankOptions {
  /** Absolute URL of the rerank endpoint, e.g. `http://127.0.0.1:8080/rerank`. */
  endpoint: string
  /** Model id the server knows, e.g. `BAAI/bge-reranker-v2-m3`. */
  model: string
  /** Request budget. */
  timeoutMs: number
  /** Injectable transport for tests. */
  fetchImpl?: typeof fetch
}

/** One score the server returned. */
interface RawScore {
  index: number
  score: number
}

/** HTTP cross-encoder scorer. */
export class HttpRerankScorer implements SearchScorer {
  readonly id = 'rerank-http'
  readonly label = 'HTTP reranker (bge-reranker)'
  readonly kind = 'rerank' as const

  /**
   * @param options - endpoint, model, and budget; a getter keeps them live so a
   *   settings save applies to the next search without reloading the plugin.
   */
  constructor(private readonly options: RerankOptions | (() => RerankOptions)) {}

  /** The options this call should use. */
  private current(): RerankOptions {
    return typeof this.options === 'function' ? this.options() : this.options
  }

  /**
   * Score every candidate against the query.
   * @param request - query plus candidates.
   * @param signal - cancellation from the caller.
   * @returns one score per candidate, aligned by index.
   * @throws when the endpoint is unreachable or answers a shape we cannot read.
   */
  async score(request: ScoreRequest, signal?: AbortSignal): Promise<ScoreResult> {
    const options = this.current()
    const documents = request.candidates.map(textOf)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, options.timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const started = Date.now()
    try {
      const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          query: request.query,
          documents,
          top_n: documents.length,
        }),
        signal: combined,
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const body = await response.json() as unknown
      const scores = align(scoresOf(body), documents.length)
      return {
        scores,
        detail: `${options.model} · ${String(documents.length)} 条 · ${String(Date.now() - started)}ms`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The text a cross-encoder reads for one candidate. */
function textOf(candidate: ScoreCandidate): string {
  const title = candidate.title?.trim() ?? ''
  const snippet = candidate.snippet?.trim() ?? ''
  if (title.length === 0) return snippet
  return snippet.length === 0 ? title : `${title}\n${snippet}`
}

/** Read either supported response shape. */
function scoresOf(body: unknown): RawScore[] {
  const rows = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object'
      ? (body as { results?: unknown }).results
      : undefined
  if (!Array.isArray(rows)) throw new Error('reranker 响应既不是数组，也没有 results 字段')
  const scores: RawScore[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const index = typeof record['index'] === 'number' ? record['index'] : undefined
    const score = typeof record['score'] === 'number'
      ? record['score']
      : typeof record['relevance_score'] === 'number' ? record['relevance_score'] : undefined
    if (index === undefined || score === undefined || !Number.isFinite(score)) continue
    scores.push({ index, score })
  }
  if (scores.length === 0) throw new Error('reranker 响应里没有可用的分数')
  return scores
}

/**
 * Project the server's sparse answer onto the candidate count.
 *
 * A server that honours `top_n` may omit rows entirely; omitted candidates get a
 * score below every returned one, so they sort last but are still delivered.
 */
function align(scores: readonly RawScore[], count: number): number[] {
  const floor = Math.min(...scores.map(row => row.score)) - 1
  const aligned = Array.from({ length: count }, () => floor)
  for (const row of scores) {
    if (row.index >= 0 && row.index < count) aligned[row.index] = row.score
  }
  return aligned
}
