/**
 * Source-tier classification: the deterministic replacement for the old
 * English-word authority counter.
 *
 * @module dsh-local-browser-web/tests/source-tiers
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  daysSince,
  hostOf,
  isShortLink,
  looksLikeSpoof,
  looksSecondary,
  registeredDomainOf,
  tierOf,
} from '../src/quality/source-tiers.ts'

describe('tierOf', () => {
  const cases: [string, string, string][] = [
    ['https://www.gov.cn/zhengce/notice', 'official', 'a ministry'],
    ['https://www.stats.gov.cn/sj/', 'official', 'the statistics bureau'],
    ['https://www.who.int/news', 'official', 'an international body'],
    ['https://www.w3.org/TR/', 'official', 'a standards body'],
    ['https://www.tsinghua.edu.cn/x', 'academic', 'a university'],
    ['https://arxiv.org/abs/1', 'academic', 'a preprint server'],
    ['https://github.com/org/repo', 'project', 'a repository'],
    ['https://nodejs.org/en/about', 'project', 'a project site'],
    ['https://www.reuters.com/world', 'press', 'a wire service'],
    ['https://www.thepaper.cn/news', 'press', 'a newsroom'],
    ['https://en.wikipedia.org/wiki/X', 'reference', 'an encyclopedia'],
    ['https://stackoverflow.com/q/1', 'reference', 'a Q&A site'],
    ['https://zhuanlan.zhihu.com/p/1', 'community', 'a community platform'],
    ['https://www.reddit.com/r/x', 'community', 'a forum'],
    ['https://bulk-articles.top/page', 'aggregator', 'a throwaway TLD'],
    ['https://some-unknown-host.example/x', 'unknown', 'an unmatched host'],
  ]
  for (const [url, tier, why] of cases) {
    it(`classifies ${why} as ${tier}`, () => {
      assert.equal(tierOf(url).tier, tier)
    })
  }

  it('sends a documentation subdomain to project, not to its parent tier', () => {
    // `mozilla.org` is not listed, but `developer.mozilla.org` is — order matters.
    assert.equal(tierOf('https://developer.mozilla.org/en-US/docs').tier, 'project')
    assert.equal(tierOf('https://docs.example.com/guide').tier, 'project')
  })

  it('keeps the base scores ordered from official to aggregator', () => {
    const order = [
      'https://www.gov.cn/x',
      'https://www.tsinghua.edu.cn/x',
      'https://github.com/x/y',
      'https://www.reuters.com/x',
      'https://en.wikipedia.org/x',
      'https://zhihu.com/x',
      'https://bulk.top/x',
    ]
    const scores = order.map(url => tierOf(url).base)
    for (let index = 1; index < scores.length; index += 1) {
      assert.ok((scores[index] ?? 0) < (scores[index - 1] ?? 0), `tier ${index} is not strictly lower`)
    }
  })
})

describe('registeredDomainOf', () => {
  it('keeps a two-label public suffix intact', () => {
    assert.equal(registeredDomainOf('www.stats.gov.cn'), 'stats.gov.cn')
    assert.equal(registeredDomainOf('news.bbc.co.uk'), 'bbc.co.uk')
  })

  it('reduces an ordinary host to its registrable domain', () => {
    assert.equal(registeredDomainOf('a.b.example.com'), 'example.com')
  })
})

describe('hostOf', () => {
  it('returns an empty string for an unparseable URL', () => {
    assert.equal(hostOf('not a url'), '')
  })
})

describe('looksLikeSpoof', () => {
  it('detects a brand borrowed by another registrant', () => {
    assert.equal(looksLikeSpoof('https://paypal.com.secure-login.cn/x'), true)
    assert.equal(looksLikeSpoof('https://apple.verify-account.top/x'), true)
  })

  it('leaves the brand owner alone', () => {
    assert.equal(looksLikeSpoof('https://www.paypal.com/signin'), false)
    assert.equal(looksLikeSpoof('https://accounts.google.com/'), false)
  })

  it('does not treat a brand-prefixed name as impersonation', () => {
    assert.equal(looksLikeSpoof('https://notpaypal.com/'), false)
  })
})

describe('isShortLink', () => {
  it('recognises redirect hosts', () => {
    assert.equal(isShortLink('https://t.cn/A6xyz'), true)
    assert.equal(isShortLink('https://bit.ly/abc'), true)
  })

  it('leaves a normal host alone', () => {
    assert.equal(isShortLink('https://www.gov.cn/x'), false)
  })
})

describe('looksSecondary', () => {
  it('recognises relaying markers in both languages', () => {
    assert.equal(looksSecondary('本文转自某某日报'), true)
    assert.equal(looksSecondary('据新华社报道，会议决定…'), true)
    assert.equal(looksSecondary('originally published at example.com'), true)
  })

  it('leaves an original report alone', () => {
    assert.equal(looksSecondary('国家统计局今日发布数据。'), false)
  })
})

describe('daysSince', () => {
  const now = Date.UTC(2026, 9, 25)

  it('parses the formats providers actually send', () => {
    assert.equal(daysSince('2026-10-20', now), 5)
    assert.equal(daysSince('2026/10/20', now), 5)
    assert.equal(daysSince('2026年10月20日', now), 5)
    assert.equal(daysSince('Oct 20, 2026', now), 5)
    assert.equal(daysSince('3 days ago', now), 3)
    assert.equal(daysSince('2 hours ago', now), 0)
  })

  it('treats a month-only date as the first of that month', () => {
    assert.equal(daysSince('2026-09', now), 54)
  })

  it('returns undefined rather than guessing', () => {
    assert.equal(daysSince(undefined, now), undefined)
    assert.equal(daysSince('   ', now), undefined)
    assert.equal(daysSince('last tuesday', now), undefined)
  })

  it('clamps a future date to zero', () => {
    assert.equal(daysSince('2027-01-01', now), 0)
  })
})
