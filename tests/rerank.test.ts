/**
 * HTTP reranker tests: request shape and the two response dialects.
 *
 * @module dsh-local-browser-web/tests/rerank
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HttpRerankScorer } from '../src/search/rerank.ts'
import type { ScoreRequest } from '../src/search/scorers.ts'

/** Two candidates plus the query. */
const request: ScoreRequest = {
  query: 'deepseek 官网',
  candidates: [
    { url: 'https://a', title: 'A', snippet: 'alpha' },
    { url: 'https://b', title: 'B', snippet: 'beta' },
  ],
}

/** A fetch stub returning one JSON body and recording the call. */
function stub(body: unknown, status = 200): { fetchImpl: typeof fetch, calls: { url: string, body: unknown }[] } {
  const calls: { url: string, body: unknown }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as unknown })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** An options object the scorer reads. */
function options(fetchImpl: typeof fetch): {
  endpoint: string
  model: string
  timeoutMs: number
  fetchImpl: typeof fetch
} {
  return { endpoint: 'http://127.0.0.1:8080/rerank', model: 'BAAI/bge-reranker-v2-m3', timeoutMs: 1_000, fetchImpl }
}

describe('HttpRerankScorer', () => {
  it('reads the TEI array shape', async () => {
    const { fetchImpl, calls } = stub([
      { index: 0, score: -2.5 },
      { index: 1, score: 4.25 },
    ])
    const result = await new HttpRerankScorer(options(fetchImpl)).score(request)
    assert.deepEqual(result.scores, [-2.5, 4.25])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.body, {
      model: 'BAAI/bge-reranker-v2-m3',
      query: 'deepseek 官网',
      documents: ['A\nalpha', 'B\nbeta'],
      top_n: 2,
    })
  })

  it('reads the Cohere / Jina results shape', async () => {
    const { fetchImpl } = stub({
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.12 },
      ],
    })
    const result = await new HttpRerankScorer(options(fetchImpl)).score(request)
    assert.deepEqual(result.scores, [0.12, 0.91])
  })

  it('ranks omitted candidates last without dropping them', async () => {
    // A server honouring top_n answers with one row; the other still gets a score.
    const { fetchImpl } = stub([{ index: 0, score: 0.8 }])
    const result = await new HttpRerankScorer(options(fetchImpl)).score(request)
    assert.equal(result.scores.length, 2)
    assert.equal(result.scores[0], 0.8)
    assert.ok((result.scores[1] ?? 0) < 0.8)
  })

  it('throws on a non-2xx status', async () => {
    const { fetchImpl } = stub({ error: 'nope' }, 503)
    await assert.rejects(
      async () => await new HttpRerankScorer(options(fetchImpl)).score(request),
      /HTTP 503/u,
    )
  })

  it('throws on an unreadable shape', async () => {
    const { fetchImpl } = stub({ scores: [1, 2] })
    await assert.rejects(
      async () => await new HttpRerankScorer(options(fetchImpl)).score(request),
      /results/u,
    )
  })
})
