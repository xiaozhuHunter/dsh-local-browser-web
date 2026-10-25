/**
 * The quality-filter layer.
 *
 * The assertions here encode the two regressions that motivated the redesign, so
 * they are the most important tests in this file: `candidate` must not count as
 * an authority signal (it only ever matched `date` as a substring), and a Chinese
 * page on an official host must not be flagged low-authority merely because the
 * text has no English byline words.
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

/** A publication date `days` in the past, as the ISO day a provider would send. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/** Non-repetitive prose, so the spam rules stay quiet. */
function variedProse(sentences = 40): string {
  return Array.from({ length: sentences }, (_, index) => `analysis${String(index)} of the subject`).join(' ')
}

describe('evaluateQuality: publisher tiers', () => {
  it('scores an official notice above a community post', () => {
    const text = variedProse()
    const official = evaluateQuality({ text, url: 'https://www.gov.cn/zhengce/notice', publishedAt: daysAgo(3) }, rules())
    const community = evaluateQuality({ text, url: 'https://zhuanlan.zhihu.com/p/1', publishedAt: daysAgo(3) }, rules())
    assert.ok(official.score > community.score, `${official.score} should beat ${community.score}`)
    assert.equal(official.flags.includes('low-authority'), false)
  })

  it('does not reward English byline words (the old substring bug)', () => {
    // `candidate` contains `date`; the old rule counted that as a date signal.
    const decoy = evaluateQuality({ text: 'This candidate list is long enough to pass the floor.', url: 'https://x.test/a', context: 'search' }, rules())
    assert.equal(decoy.flags.includes('primary-source'), false)
    const stuffed = evaluateQuality({ text: 'source source source updated date reference citation', url: 'https://x.test/b', context: 'search' }, rules())
    assert.equal(stuffed.flags.includes('low-authority'), false, 'unknown hosts are neutral, not authoritative')
    assert.ok(stuffed.score <= 60, 'keyword stuffing in the snippet must not raise the score')
  })

  it('marks a Chinese official page as primary despite having no English hints', () => {
    // Long enough to clear the article floor, with no English byline words at all:
    // the old hint list could not see authority here and flagged it instead.
    const body = Array.from({ length: 40 }, (_, index) => `第${String(index)}项指标为${String(index * 7)}个单位，同比变化${String(index % 9)}个百分点。`).join('')
    // The generated body is character-repetitive, so the spam rules are switched
    // off here: this assertion is about authority, not about prose variety.
    const verdict = evaluateQuality(
      { text: body, url: 'https://www.stats.gov.cn/sj/zxfb/', publishedAt: daysAgo(5) },
      rules({ seoSpam: { enabled: false, maxKeywordDensity: 0.12, maxDuplicateRatio: 0.5 } }),
    )
    assert.ok(verdict.flags.includes('primary-source'))
    assert.equal(verdict.flags.includes('low-authority'), false)
    assert.ok(verdict.score >= 95, `expected a high score, got ${verdict.score}`)
  })

  it('flags a relaying page as secondary', () => {
    const verdict = evaluateQuality(
      { text: '本文转自某某日报，原文链接见文末。', url: 'https://www.reuters.com/x' },
      rules(),
    )
    assert.ok(verdict.flags.includes('secondary-source'))
  })

  it('flags a low tier below the authority floor', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'https://bulk-articles.top/page' }, rules())
    assert.ok(verdict.flags.includes('low-authority'))
  })
})

describe('evaluateQuality: deception signals', () => {
  it('flags a plaintext URL', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'http://example.com/x' }, rules())
    assert.ok(verdict.flags.includes('insecure'))
  })

  it('flags a short link', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'https://t.cn/abc' }, rules())
    assert.ok(verdict.flags.includes('shortlink'))
  })

  it('flags a brand impersonating host', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'https://paypal.com.secure-login.cn/x' }, rules())
    assert.ok(verdict.flags.includes('possible-spoof'))
    assert.ok(verdict.score < 40)
  })

  it('does not flag the brand\'s own host', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'https://www.paypal.com/x' }, rules())
    assert.equal(verdict.flags.includes('possible-spoof'), false)
  })
})

describe('evaluateQuality: freshness', () => {
  it('rewards a recent publication', () => {
    const verdict = evaluateQuality({ text: variedProse(), url: 'https://www.reuters.com/x', publishedAt: daysAgo(2) }, rules())
    assert.ok(verdict.flags.includes('fresh'))
  })

  it('penalises a stale publication', () => {
    const stale = evaluateQuality({ text: variedProse(), url: 'https://www.reuters.com/x', publishedAt: '2019-01-01' }, rules())
    const fresh = evaluateQuality({ text: variedProse(), url: 'https://www.reuters.com/x', publishedAt: daysAgo(2) }, rules())
    assert.ok(stale.flags.includes('stale'))
    assert.ok(stale.score < fresh.score)
  })

  it('only penalises a missing date for articles, never for snippets', () => {
    const article = evaluateQuality({ text: variedProse(), url: 'https://www.reuters.com/x' }, rules())
    const snippet = evaluateQuality({ text: variedProse(), url: 'https://www.reuters.com/x', context: 'search' }, rules())
    assert.ok(article.flags.includes('undated'))
    assert.equal(snippet.flags.includes('undated'), false)
    assert.equal(article.score < snippet.score, true)
  })

  it('skips freshness entirely when switched off', () => {
    const verdict = evaluateQuality(
      { text: variedProse(), url: 'https://www.reuters.com/x' },
      rules({ freshness: { enabled: false, staleDays: 365 } }),
    )
    assert.equal(verdict.flags.includes('undated'), false)
  })
})

describe('evaluateQuality: content shape', () => {
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
    assert.equal(evaluateQuality({ text, url: 'https://x.test/' }, rules({
      thinContent: { enabled: true, minChars: 10 },
    })).flags.includes('thin-content'), false)
    assert.ok(evaluateQuality({ text, url: 'https://x.test/' }, rules({
      thinContent: { enabled: true, minChars: 10_000 },
    })).flags.includes('thin-content'))
  })

  it('judges a snippet against the snippet floor, not the article floor', () => {
    // 120 characters: a complete snippet, a thin article.
    const snippetText = variedProse(6).slice(0, 120)
    const asSnippet = evaluateQuality({ text: snippetText, url: 'https://x.test/', context: 'search' }, rules())
    const asArticle = evaluateQuality({ text: snippetText, url: 'https://x.test/', context: 'fetch' }, rules())
    assert.equal(asSnippet.flags.includes('thin-content'), false)
    assert.ok(asArticle.flags.includes('thin-content'))
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

  it('skips an individual rule when it is switched off', () => {
    const verdict = evaluateQuality({ text: 'tiny', url: 'https://x.test/' }, rules({
      thinContent: { enabled: false, minChars: 200 },
    }))
    assert.equal(verdict.flags.includes('thin-content'), false)
  })

  it('never returns a score outside 0–100', () => {
    const verdict = evaluateQuality(
      { text: 'x', url: 'https://paypal.com.evil.top/' },
      rules({ domainReputation: { enabled: true, blocklist: ['evil.top'], allowlist: [] } }),
    )
    assert.ok(verdict.score >= 0)
    assert.ok(verdict.score <= 100)
  })
})

describe('evaluateQuality: domain reputation', () => {
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
})

describe('rankSources', () => {
  it('orders by publisher tier, keeps every source, and stays stable on ties', () => {
    const sources: RawSearchSource[] = [
      { url: 'https://zhuanlan.zhihu.com/p/1', snippet: variedProse(8).slice(0, 160), title: 'community post' },
      { url: 'https://www.gov.cn/zhengce/notice', snippet: variedProse(8).slice(0, 160), title: 'official notice' },
      { url: 'https://bulk-articles.top/page', snippet: variedProse(8).slice(0, 160), title: 'content farm' },
    ]
    const ranked = rankSources(sources, rules())
    assert.equal(ranked.length, 3)
    assert.equal(ranked[0]?.source.url, 'https://www.gov.cn/zhengce/notice')
    assert.equal(ranked[ranked.length - 1]?.source.url, 'https://bulk-articles.top/page')
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
    const ranked = rankSources([{ url: 'https://x.test/', snippet: 'tiny' }], rules())
    assert.ok(ranked.every(item => typeof item.quality.score === 'number' && Array.isArray(item.quality.flags)))
  })
})
