/**
 * The quality-filter layer.
 *
 * @module dsh-local-browser-web/tests/quality
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { evaluateQuality, rankSources } from '../src/quality/filter.ts'
import type { ResolvedConfig } from '../src/config.ts'
import type { RawSearchSource } from '../src/types.ts'
import { makeConfig } from './helpers.ts'

/** The default rule set with one override applied. */
function rules(overrides: Partial<ResolvedConfig['quality']> = {}): ResolvedConfig['quality'] {
  return { ...makeConfig().quality, ...overrides }
}

/** A paragraph of `count` filler words. */
function filler(count: number, word = 'word'): string {
  return Array.from({ length: count }, () => word).join(' ')
}

describe('evaluateQuality', () => {
  it('returns a clean verdict for a substantial page', () => {
    // Variety matters: a repeated filler word would legitimately trip the
    // keyword-density rule, so the "clean" fixture must not be repetitive.
    const varied = (offset: number): string =>
      Array.from({ length: 140 }, (_, index) => `term${String((index + offset) % 140)}`).join(' ')
    const text = [
      `By Author Published 2026-01-01 Citation Reference Source. ${varied(0)}`,
      varied(70),
    ].join('\n\n')
    const verdict = evaluateQuality({ text, url: 'https://news.test/story' }, rules())
    assert.deepEqual(verdict.flags, [])
    assert.equal(verdict.score, 100)
  })

  it('bypasses every rule when the master switch is off', () => {
    const verdict = evaluateQuality({ text: 'tiny', url: 'https://spam.test/' }, rules({ enabled: false }))
    assert.deepEqual(verdict, { score: 100, flags: [] })
  })

  it('flags thin content', () => {
    const verdict = evaluateQuality({ text: 'too short', url: 'https://x.test/' }, rules())
    assert.ok(verdict.flags.includes('thin-content'))
    assert.ok(verdict.score < 100)
  })

  it('honours the thin-content threshold', () => {
    const text = filler(30)
    assert.ok(evaluateQuality({ text, url: 'https://x.test/' }, rules({
      thinContent: { enabled: true, minChars: 10 },
    })).flags.includes('thin-content') === false)
    assert.ok(evaluateQuality({ text, url: 'https://x.test/' }, rules({
      thinContent: { enabled: true, minChars: 10_000 },
    })).flags.includes('thin-content'))
  })

  it('flags keyword stuffing', () => {
    const text = `${filler(80, 'cheap')} ${filler(20, 'varied')}`
    const verdict = evaluateQuality({ text, url: 'https://seo.test/' }, rules())
    assert.ok(verdict.flags.includes('seo-keyword-stuffing'))
  })

  it('flags repeated boilerplate', () => {
    const block = filler(120, 'same')
    const text = [block, block, block, block, filler(120, 'other')].join('\n\n')
    const verdict = evaluateQuality({ text, url: 'https://seo.test/' }, rules())
    assert.ok(verdict.flags.includes('seo-duplicate-boilerplate'))
  })

  it('flags AIGC filler markers', () => {
    const text = [
      '综上所述，这是一个结论。',
      '总而言之，我们需要深入探讨。',
      '值得注意的是，这里有很多内容。',
      filler(120, 'body'),
    ].join('\n\n')
    const verdict = evaluateQuality({ text, url: 'https://aigc.test/' }, rules())
    assert.ok(verdict.flags.includes('low-quality-aigc'))
  })

  it('flags a blocklisted domain', () => {
    const verdict = evaluateQuality(
      { text: filler(200), url: 'https://content-farm.test/page' },
      rules({ domainReputation: { enabled: true, blocklist: ['content-farm.test'], allowlist: [] } }),
    )
    assert.ok(verdict.flags.includes('domain-blocklisted'))
  })

  it('matches subdomains against a list entry', () => {
    const verdict = evaluateQuality(
      { text: filler(200), url: 'https://www.content-farm.test/page' },
      rules({ domainReputation: { enabled: true, blocklist: ['content-farm.test'], allowlist: [] } }),
    )
    assert.ok(verdict.flags.includes('domain-blocklisted'))
  })

  it('lets an allowlisted domain skip the spam rules', () => {
    const text = `${filler(80, 'cheap')} ${filler(20, 'varied')}`
    const verdict = evaluateQuality(
      { text, url: 'https://trusted.test/page' },
      rules({ domainReputation: { enabled: true, blocklist: ['trusted.test'], allowlist: ['trusted.test'] } }),
    )
    assert.ok(verdict.flags.includes('domain-allowlisted'))
    assert.equal(verdict.flags.includes('domain-blocklisted'), false)
    assert.equal(verdict.flags.includes('seo-keyword-stuffing'), false)
  })

  it('flags low authority and honours the floor', () => {
    const plain = evaluateQuality({ text: filler(200), url: 'https://x.test/' }, rules())
    assert.ok(plain.flags.includes('low-authority'))
    const strong = evaluateQuality(
      { text: `Author Published Citation Reference Source byline ${filler(200)}`, url: 'https://x.test/', title: 'A title' },
      rules(),
    )
    assert.equal(strong.flags.includes('low-authority'), false)
  })

  it('skips an individual rule when it is switched off', () => {
    const verdict = evaluateQuality({ text: 'tiny', url: 'https://x.test/' }, rules({
      thinContent: { enabled: false, minChars: 200 },
    }))
    assert.equal(verdict.flags.includes('thin-content'), false)
  })

  it('never returns a score outside 0–100', () => {
    const verdict = evaluateQuality(
      { text: 'x', url: 'https://farm.test/' },
      rules({ domainReputation: { enabled: true, blocklist: ['farm.test'], allowlist: [] } }),
    )
    assert.ok(verdict.score >= 0)
    assert.ok(verdict.score <= 100)
  })
})

describe('rankSources', () => {
  const sources: RawSearchSource[] = [
    { url: 'https://thin.test/', snippet: 'tiny' },
    { url: 'https://good.test/', snippet: `${filler(120, 'analysis')}\n\n${filler(120, 'content')}` },
    { url: 'https://blocked.test/', snippet: filler(150) },
  ]

  it('orders best-first and keeps every source', () => {
    const ranked = rankSources(
      sources,
      rules({ domainReputation: { enabled: true, blocklist: ['blocked.test'], allowlist: [] } }),
    )
    assert.equal(ranked.length, 3)
    assert.equal(ranked[0]?.source.url, 'https://good.test/')
    assert.equal(ranked[ranked.length - 1]?.source.url, 'https://blocked.test/')
  })

  it('is stable for equal scores', () => {
    const ranked = rankSources(
      [
        { url: 'https://first.test/', snippet: filler(120) },
        { url: 'https://second.test/', snippet: filler(120, 'alt') },
      ],
      rules(),
    )
    assert.deepEqual(ranked.map(item => item.source.url), ['https://first.test/', 'https://second.test/'])
  })

  it('reports a verdict for every source', () => {
    const ranked = rankSources(sources, rules())
    assert.ok(ranked.every(item => typeof item.quality.score === 'number' && Array.isArray(item.quality.flags)))
  })
})
