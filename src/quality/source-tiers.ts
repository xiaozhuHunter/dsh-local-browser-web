/**
 * Source tiers: the deterministic backbone of "is this source worth believing".
 *
 * The previous authority signal counted English words (`author`, `date`,
 * `citation`) inside the text. Measured on a real SERP that approach was noise:
 * `candidate` contains `date`, a keyword-stuffed page scored full marks, and no
 * Chinese page could ever reach the floor because every hint was English. So
 * authority is now a property of **where the text came from**, not of which words
 * happen to appear in it:
 *
 *   tier base score  +  primary/secondary adjustment  -  deception penalties
 *
 * Every rule here is a readable domain suffix, ordered most specific first, so a
 * surprising verdict can always be traced to one line. There is no scoring model,
 * no word list, and no network call.
 *
 * @module dsh-local-browser-web/quality/source-tiers
 */

/** What kind of publisher a host is. */
export type SourceTier =
  /** Government bodies, international organisations, standards bodies. */
  | 'official'
  /** Universities and academic publishers. */
  | 'academic'
  /** Open-source projects and vendor documentation. */
  | 'project'
  /** Wire services and established newsrooms. */
  | 'press'
  /** Encyclopedias and technical Q&A that cite their sources. */
  | 'reference'
  /** User-generated platforms: forums, blogs, video, social. */
  | 'community'
  /** Aggregators, content farms, and throwaway bulk domains. */
  | 'aggregator'
  /** No rule matched. Neutral by design, never rewarded. */
  | 'unknown'

/** One ordered rule: a tier's base score plus the suffixes that select it. */
interface TierRule {
  tier: SourceTier
  base: number
  suffixes: readonly string[]
}

/**
 * Base scores per tier. The spread is deliberately wide: the point of the layer
 * is to separate a ministry's original notice from a reposted summary, and a
 * narrow spread cannot do that.
 */
export const TIER_BASE: Readonly<Record<SourceTier, number>> = {
  official: 95,
  academic: 88,
  project: 80,
  press: 72,
  reference: 66,
  community: 45,
  aggregator: 25,
  unknown: 50,
}

/** Short labels used in the annotation the model reads. */
export const TIER_LABELS: Readonly<Record<SourceTier, string>> = {
  official: '官方/政府',
  academic: '学术',
  project: '项目官方',
  press: '媒体',
  reference: '参考',
  community: '社区',
  aggregator: '聚合站',
  unknown: '',
}

/**
 * Ordered rules; the first suffix match wins.
 *
 * Ordering is a correctness concern, not a style one: `developer.mozilla.org`
 * must reach `project` before `mozilla.org` could send it to `reference`, and
 * any `*.gov.cn` must never fall through to the generic `.cn` aggregator rule.
 */
const TIER_RULES: readonly TierRule[] = [
  {
    tier: 'official',
    base: TIER_BASE.official,
    suffixes: [
      'gov.cn', 'gov.uk', 'gov.au', 'gov.br', 'go.jp', 'gov', 'mil', 'int',
      'europa.eu', 'un.org', 'who.int', 'worldbank.org', 'imf.org', 'oecd.org',
      'stats.gov.cn', 'cnnic.net.cn', 'caict.ac.cn', 'nhc.gov.cn', 'mof.gov.cn',
      'w3.org', 'ietf.org', 'rfc-editor.org', 'ieee.org', 'iso.org', 'unicode.org',
      'ecma-international.org', 'opengroup.org', 'whatwg.org',
    ],
  },
  {
    tier: 'academic',
    base: TIER_BASE.academic,
    suffixes: [
      'edu.cn', 'edu', 'ac.cn', 'ac.uk', 'ac.jp', 'cnki.net', 'arxiv.org',
      'nature.com', 'science.org', 'springer.com', 'sciencedirect.com',
      'wiley.com', 'tandfonline.com', 'pubmed.ncbi.nlm.nih.gov', 'doi.org',
      'openreview.net', 'aclweb.org',
    ],
  },
  {
    tier: 'project',
    base: TIER_BASE.project,
    suffixes: [
      'github.com', 'gitlab.com', 'nodejs.org', 'python.org', 'rust-lang.org',
      'golang.org', 'go.dev', 'kernel.org', 'developer.mozilla.org', 'npmjs.com',
      'pypi.org', 'crates.io', 'docker.com', 'kubernetes.io', 'postgresql.org',
      'sqlite.org', 'redis.io', 'nginx.org', 'apache.org', 'openssl.org',
      'deepseek.com', 'deepseek.ai', 'anthropic.com', 'openai.com',
    ],
  },
  {
    tier: 'press',
    base: TIER_BASE.press,
    suffixes: [
      'reuters.com', 'apnews.com', 'afp.com', 'bloomberg.com', 'ft.com',
      'wsj.com', 'nytimes.com', 'theguardian.com', 'bbc.com', 'bbc.co.uk',
      'cnn.com', 'economist.com', 'xinhuanet.com', 'news.cn', 'people.com.cn',
      'cctv.com', 'chinanews.com.cn', 'chinadaily.com.cn', 'caixin.com',
      'thepaper.cn', 'yicai.com', 'jiemian.com', '36kr.com', 'ithome.com',
      'solidot.org',
    ],
  },
  {
    tier: 'reference',
    base: TIER_BASE.reference,
    suffixes: [
      'wikipedia.org', 'wikimedia.org', 'stackoverflow.com', 'stackexchange.com',
      'baike.baidu.com', 'britannica.com',
    ],
  },
  {
    tier: 'community',
    base: TIER_BASE.community,
    suffixes: [
      'zhihu.com', 'csdn.net', 'juejin.cn', 'cnblogs.com', 'segmentfault.com',
      'v2ex.com', 'reddit.com', 'medium.com', 'substack.com', 'dev.to',
      'jianshu.com', 'douban.com', 'bilibili.com', 'youtube.com', 'twitter.com',
      'x.com', 'weibo.com', 'tieba.baidu.com', 'quora.com', 'ycombinator.com',
    ],
  },
  {
    tier: 'aggregator',
    base: TIER_BASE.aggregator,
    suffixes: ['top', 'xyz', 'buzz', 'click'],
  },
]

/**
 * Host labels that mark a vendor's documentation surface. Suffix rules cannot
 * express "starts with `docs.`", so this small list closes that gap.
 */
const DOC_LABELS = new Set(['docs', 'doc', 'developer', 'developers', 'api', 'help', 'support', 'learn'])

/**
 * Second-level public suffixes that need three labels to reach the registered
 * domain (`stats.gov.cn` is one registrant, not one host under `gov.cn`).
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk', 'me.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'com.tw', 'com.hk', 'com.sg', 'com.mx', 'co.kr', 'co.in', 'com.tr',
])

/** The hostname of a URL, or empty when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Whether `host` is `suffix` or a subdomain of it. */
function matchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * The registrable domain of a host: the part a publisher actually owns.
 * @param host - a lowercase hostname.
 * @returns the registrable domain (`stats.gov.cn`, `github.com`), or the input when too short.
 */
export function registeredDomainOf(host: string): string {
  const labels = host.toLowerCase().split('.').filter(label => label.length > 0)
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.')
  return lastTwo
}

/**
 * Classify a URL's publisher.
 * @param url - the result URL.
 * @returns the tier and its base score.
 */
export function tierOf(url: string): { tier: SourceTier, base: number } {
  const host = hostOf(url)
  if (host.length === 0) return { tier: 'unknown', base: TIER_BASE.unknown }
  for (const rule of TIER_RULES) {
    if (rule.suffixes.some(suffix => matchesSuffix(host, suffix))) {
      return { tier: rule.tier, base: rule.base }
    }
  }
  const firstLabel = host.split('.')[0] ?? ''
  if (DOC_LABELS.has(firstLabel)) return { tier: 'project', base: TIER_BASE.project }
  return { tier: 'unknown', base: TIER_BASE.unknown }
}

/** Short-link hosts: the visible domain says nothing about the destination. */
const SHORTLINK_HOSTS = new Set([
  't.cn', 'bit.ly', 'dwz.cn', 'url.cn', 'tinyurl.com', 'goo.gl', 'ow.ly',
  'is.gd', 'suo.im', 't.co', 'buff.ly', 'rb.gy',
])

/** Whether a URL hides its destination behind a short-link redirect. */
export function isShortLink(url: string): boolean {
  const host = hostOf(url)
  return SHORTLINK_HOSTS.has(host) || SHORTLINK_HOSTS.has(registeredDomainOf(host))
}

/**
 * Brand names worth protecting from lookalike hosts. Kept short on purpose: a
 * huge list invites false positives, and the high-value targets are few.
 */
const BRANDS = [
  'google', 'apple', 'microsoft', 'paypal', 'amazon', 'netflix', 'facebook',
  'instagram', 'whatsapp', 'github', 'deepseek', 'openai', 'tencent', 'alibaba',
  'taobao', 'alipay', 'wechat', 'binance', 'icbc', 'abchina', 'bankofchina',
]

/**
 * Whether a host borrows a brand it does not own — `paypal.com.evil.cn` has the
 * brand in a label but the registrable domain belongs to someone else.
 * @param url - the result URL.
 * @returns true when the host looks like a brand impersonation.
 */
export function looksLikeSpoof(url: string): boolean {
  const host = hostOf(url)
  if (host.length === 0) return false
  const registrable = registeredDomainOf(host)
  if (registrable.length === 0) return false
  const ownerLabel = registrable.split('.')[0] ?? ''
  if (BRANDS.includes(ownerLabel)) return false
  const borrowed = host.split('.').some(label => BRANDS.includes(label))
  return borrowed
}

/** Secondary-reporting markers: the page relays someone else's reporting. */
const SECONDARY_MARKERS = /转载|转自|本文摘自|据.{0,8}报道|原文链接|reposted from|according to reports|originally published at/iu

/**
 * Whether the text presents itself as relaying another publisher's work.
 * @param text - the snippet or article body.
 */
export function looksSecondary(text: string): boolean {
  return SECONDARY_MARKERS.test(text)
}

/**
 * Parse a provider-supplied date into a UTC day count.
 *
 * SERPs hand back wildly different formats (`Aug 12, 2025`, `2025-08-12`,
 * `2025年8月12日`, `2 days ago`), so this accepts the common shapes and returns
 * `undefined` for anything else rather than guessing.
 *
 * @param value - the raw `publishedAt` string.
 * @param now - the reference instant, for relative phrasings.
 * @returns whole days since publication, or `undefined` when unparseable.
 */
export function daysSince(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  if (text.length === 0) return undefined

  const relative = /^(\d+)\s*(day|hour|minute)s?\s+ago$/iu.exec(text)
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = relative[2]?.toLowerCase() ?? 'day'
    // Anything under a day is "today" — the layer only reasons in whole days.
    if (unit !== 'day') return 0
    return Number.isFinite(amount) ? amount : undefined
  }

  const iso = /^(20\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/u.exec(text)
  const cjk = /^(20\d{2})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/u.exec(text)
  const american = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})/u.exec(text)
  const monthFirst = american === null ? undefined : monthIndex(american[1] ?? '')

  let year: number
  let month: number
  let day: number
  if (iso !== null) {
    year = Number(iso[1])
    month = Number(iso[2]) - 1
    day = Number(iso[3] ?? '1')
  } else if (cjk !== null) {
    year = Number(cjk[1])
    month = Number(cjk[2]) - 1
    day = Number(cjk[3] ?? '1')
  } else if (american !== null && monthFirst !== undefined) {
    year = Number(american[3])
    month = monthFirst
    day = Number(american[2])
  } else {
    return undefined
  }
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  const published = Date.UTC(year, month, day)
  if (Number.isNaN(published)) return undefined
  const days = Math.floor((now - published) / 86_400_000)
  return days < 0 ? 0 : days
}

/** Month index from an English month name or abbreviation. */
function monthIndex(name: string): number | undefined {
  const key = name.slice(0, 3).toLowerCase()
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const index = months.indexOf(key)
  return index === -1 ? undefined : index
}
