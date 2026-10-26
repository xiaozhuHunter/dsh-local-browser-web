/**
 * Scorer registry and blend tests.
 *
 * @module dsh-local-browser-web/tests/scorers
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CdpBrowser } from '../src/browser/cdp.ts'
import { PlaywrightBrowser } from '../src/browser/playwright.ts'
import { EngineRegistry } from '../src/engines/registry.ts'
import { ParserRegistry } from '../src/engines/parsers.ts'
import type { RunnerContext } from '../src/engines/runners/context.ts'
import { Diagnostics } from '../src/log.ts'
import { LocalBrowserSearchProvider } from '../src/providers/search.ts'
import type { RankedSource } from '../src/quality/filter.ts'
import {
  blendScores,
  candidatesOf,
  ScorerRegistry,
  type SearchScorer,
} from '../src/search/scorers.ts'
import type { EngineSpec, RawSearchSource } from '../src/types.ts'
import { makeConfig, makeEngine } from './helpers.ts'

/** One ranked source with an explicit quality score. */
function ranked(url: string, score: number): RankedSource {
  return { source: { url, title: url }, quality: { score, flags: [] } }
}

/** A scorer stub that never runs. */
function scorer(id: string, kind: 'rerank' | 'evidence' = 'rerank'): SearchScorer {
  return { id, label: id, kind, score: async () => ({ scores: [] }) }
}

describe('ScorerRegistry', () => {
  it('registers, looks up, and lists', () => {
    const registry = new ScorerRegistry()
    const dispose = registry.register(scorer('a'))
    registry.register(scorer('b'))
    assert.deepEqual(registry.ids(), ['a', 'b'])
    assert.equal(registry.get('a')?.id, 'a')
    dispose()
    assert.deepEqual(registry.ids(), ['b'])
  })

  it('keeps only the current owner when two register the same id', () => {
    const registry = new ScorerRegistry()
    const first = registry.register(scorer('x'))
    registry.register(scorer('x'))
    first()
    assert.deepEqual(registry.ids(), ['x'])
  })
})

describe('blendScores', () => {
  it('reorders by the blend and keeps every source', () => {
    const sources = [ranked('https://a', 90), ranked('https://b', 40), ranked('https://c', 70)]
    // b is the most relevant even though its quality score is the lowest.
    const ordered = blendScores(sources, [0.1, 0.9, 0.4])
    assert.deepEqual(ordered.map(entry => entry.source.url), [
      'https://b', 'https://c', 'https://a',
    ])
    assert.equal(ordered.length, sources.length)
  })

  it('keeps quality order when every relevance score is identical', () => {
    const sources = [ranked('https://a', 90), ranked('https://b', 40)]
    const ordered = blendScores(sources, [0.5, 0.5])
    assert.deepEqual(ordered.map(entry => entry.source.url), ['https://a', 'https://b'])
  })

  it('falls back to the input order on a length mismatch', () => {
    const sources = [ranked('https://a', 90), ranked('https://b', 40)]
    assert.deepEqual(blendScores(sources, [1]), sources)
  })

  it('falls back to the input order on a non-finite score', () => {
    const sources = [ranked('https://a', 90), ranked('https://b', 40)]
    assert.deepEqual(blendScores(sources, [1, Number.NaN]), sources)
  })

  it('handles an empty batch', () => {
    assert.deepEqual(blendScores([], []), [])
  })
})

describe('candidatesOf', () => {
  it('projects url, title, and snippet only', () => {
    const candidates = candidatesOf([
      { source: { url: 'https://a', title: 'A', snippet: 's', publishedAt: '2026-01-01' }, quality: { score: 1, flags: [] } },
      { source: { url: 'https://b' }, quality: { score: 1, flags: [] } },
    ])
    assert.deepEqual(candidates, [
      { url: 'https://a', title: 'A', snippet: 's' },
      { url: 'https://b' },
    ])
  })
})

/** A provider wired to fixed sources and a real diagnostics ring, with no network. */
function providerWith(
  sources: RawSearchSource[],
  scorers: ScorerRegistry,
  config = makeConfig(),
): { provider: LocalBrowserSearchProvider, diagnostics: Diagnostics } {
  const runner = async (_engine: EngineSpec): Promise<RawSearchSource[]> => sources
  const runnerContext: RunnerContext = {
    config: () => config,
    cdp: new CdpBrowser(() => ({ endpoint: 'http://127.0.0.1:9222', userAgent: 'x', profileMode: 'shared', timeoutMs: 1000 })),
    playwright: new PlaywrightBrowser(() => ({ browserPath: undefined, profileMode: 'shared', userAgent: 'x', timeoutMs: 1000 })),
    parsers: new ParserRegistry(),
    resolveCredential: async () => undefined,
    runners: { 'http-html': runner, browser: runner, api: runner },
  }
  const diagnostics = new Diagnostics(undefined, () => 'silent', () => false)
  const provider = new LocalBrowserSearchProvider({
    config: () => config,
    registry: new EngineRegistry(() => [{ ...makeEngine(), id: 'test' }], () => ['html-bing']),
    runner: runnerContext,
    diagnostics,
    scorers,
  })
  return { provider, diagnostics }
}

describe('scorer wiring in the search provider', () => {
  it('reorders sources through a rerank scorer', async () => {
    const scorers = new ScorerRegistry()
    scorers.register({
      id: 'flip',
      label: 'flip',
      kind: 'rerank',
      // Reverse the incoming order: the last source becomes the most relevant.
      score: async request => ({ scores: request.candidates.map((_c, index) => index) }),
    })
    const { provider } = providerWith(
      [
        { url: 'https://high', title: 'high', snippet: 'high quality body text' },
        { url: 'https://low', title: 'low', snippet: 'low quality body text' },
      ],
      scorers,
      makeConfig({ searchScorer: 'flip' }),
    )
    const result = await provider.search({ query: 'q' })
    assert.deepEqual(result.sources.map(source => source.url), ['https://low', 'https://high'])
  })

  it('never drops a source and keeps its order when the scorer throws', async () => {
    const scorers = new ScorerRegistry()
    scorers.register({
      id: 'boom',
      label: 'boom',
      kind: 'rerank',
      score: async () => {
        throw new Error('endpoint down')
      },
    })
    const { provider, diagnostics } = providerWith(
      [
        { url: 'https://a.example', title: 'a', snippet: 'first result snippet text' },
        { url: 'https://b.example', title: 'b', snippet: 'second result snippet text' },
      ],
      scorers,
      makeConfig({ searchScorer: 'boom' }),
    )
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources.length, 2)
    assert.equal(diagnostics.recent(5, true)[0]?.code, 'SCORER_FAILED')
  })

  it('records evidence without reordering it into the result', async () => {
    const scorers = new ScorerRegistry()
    scorers.register({
      id: 'evidence',
      label: 'evidence',
      kind: 'evidence',
      score: async () => ({
        // A rerank-kind score would flip the order; an evidence scorer must not.
        scores: [1, 0],
        evidence: [{ claim: 'version', value: '2.0', sourceUrl: 'https://b.example' }],
      }),
    })
    const { provider, diagnostics } = providerWith(
      [
        { url: 'https://a.example', title: 'a', snippet: 'first result snippet text' },
        { url: 'https://b.example', title: 'b', snippet: 'second result snippet text' },
      ],
      scorers,
      makeConfig({ searchScorer: 'evidence' }),
    )
    const result = await provider.search({ query: 'q' })
    const record = diagnostics.recent(1)[0]
    // The order is the quality order: an evidence scorer's scores are ignored.
    assert.deepEqual(result.sources.map(source => source.url), ['https://a.example', 'https://b.example'])
    assert.equal(record?.evidence?.[0]?.claim, 'version')
  })

  it('records SCORER_UNAVAILABLE for an unregistered id', async () => {
    const { provider, diagnostics } = providerWith(
      [{ url: 'https://a.example', title: 'a', snippet: 'text' }],
      new ScorerRegistry(),
      makeConfig({ searchScorer: 'ghost' }),
    )
    const result = await provider.search({ query: 'q' })
    assert.equal(result.sources.length, 1)
    assert.equal(diagnostics.recent(5, true)[0]?.code, 'SCORER_UNAVAILABLE')
  })
})
