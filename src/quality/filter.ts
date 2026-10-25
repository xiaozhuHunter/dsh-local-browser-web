/**
 * The quality-filter layer: what separates this plugin from "just fetch the page".
 *
 * The score is built from evidence about the **publisher**, not from words that
 * happen to appear in the text:
 *
 *   tier base  +  primary/secondary  +  freshness  -  deception  -  content spam
 *
 * Why the redesign: the previous version counted English authority words
 * (`author`, `byline`, `citation`). Measured against a real SERP it produced two
 * distinct scores for ten results, awarded full marks to a keyword-stuffed
 * sentence (`source source source …`), and flagged every Chinese article as
 * low-authority because the hint list was English-only. See
 * `quality/source-tiers.ts` for the replacement.
 *
 * Three behaviours matter more than the rules themselves:
 *
 * - **Nothing is dropped silently.** The seam's `WebSearchSource` /
 *   `WebFetchResult` shapes are closed (`dsh-web` owns them), so a verdict cannot
 *   ride the result object. Verdicts go to the diagnostics ring (readable by
 *   `local_search_test`) and to the structured log line; ranking is the only
 *   thing the score changes. The reader-facing material is separate and lives in
 *   the `summary` annotation (see `providers/search.ts`).
 * - **Every rule is individually switchable**, and the whole layer has a master
 *   bypass, because debugging an extraction is impossible when the filter
 *   decides what you may see.
 * - **The context decides the thresholds.** A 120-character search snippet is a
 *   complete value, not thin content; a 120-character article is not.
 *
 * @module dsh-local-browser-web/quality/filter
 */
import type { ResolvedConfig } from '../config.ts'
import type { QualityVerdict, RawSearchSource } from '../types.ts'
import {
  daysSince,
  isShortLink,
  looksLikeSpoof,
  looksSecondary,
  tierOf,
} from './source-tiers.ts'

/** The quality rule set, as resolved from config. */
export type QualityRules = ResolvedConfig['quality']

/** Which surface is being judged — it selects the thin-content floor. */
export type QualityContext = 'search' | 'fetch'

/** One text to judge. */
export interface QualityInput {
  text: string
  url: string
  title?: string | undefined
  /** Provider-supplied publication date, when the engine gave one. */
  publishedAt?: string | undefined
  /** `search` for a snippet, `fetch` for an extracted article. Defaults to `fetch`. */
  context?: QualityContext
}

/** Filler phrases that mark machine-written padding. Lowercased. */
const AIGC_MARKERS = [
  '综上所述', '总而言之', '值得注意的是', '首先，', '其次，', '最后，', '总的来说',
  'in conclusion', 'it is important to note', 'it is worth noting',
  "in today's fast-paced world", 'delve into', 'rich tapestry', 'furthermore, it',
  'when it comes to', 'navigating the complexities',
]

/** Split text into non-empty paragraphs. */
function paragraphsOf(text: string): string[] {
  return text.split(/\n{2,}/u).map(block => block.trim()).filter(block => block.length > 0)
}

/** Split text into word-ish tokens (CJK characters count individually). */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}']+/gu) ?? []
}

/** Ratio of the most frequent word to the total word count. */
function topWordRatio(words: readonly string[]): number {
  if (words.length === 0) return 0
  const counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  let top = 0
  for (const count of counts.values()) if (count > top) top = count
  return top / words.length
}

/** Fraction of paragraphs that repeat an earlier paragraph. */
function duplicateRatio(paragraphs: readonly string[]): number {
  if (paragraphs.length === 0) return 0
  const seen = new Set<string>()
  let duplicates = 0
  for (const paragraph of paragraphs) {
    if (seen.has(paragraph)) duplicates += 1
    else seen.add(paragraph)
  }
  return duplicates / paragraphs.length
}

/** Fraction of sentences carrying an AIGC filler marker. */
function aigcMarkerRatio(text: string): number {
  const sentences = text.split(/[。．.!?！？\n]+/u).map(line => line.trim()).filter(line => line.length > 0)
  if (sentences.length === 0) return 0
  const lower = sentences.map(sentence => sentence.toLowerCase())
  let marked = 0
  for (const sentence of lower) {
    if (AIGC_MARKERS.some(marker => sentence.includes(marker))) marked += 1
  }
  return marked / sentences.length
}

/** The hostname of a URL, or empty when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Whether a host matches an entry, treating an entry as a suffix (`example.com` matches `www.example.com`). */
function hostMatches(host: string, entry: string): boolean {
  const needle = entry.trim().toLowerCase().replace(/^\./u, '')
  if (needle.length === 0) return false
  return host === needle || host.endsWith(`.${needle}`)
}

/** The scheme of a URL, lowercase, without the colon. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol.replace(':', '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Judge one document.
 *
 * @param input - the text, its URL, title, publication date, and which surface asked.
 * @param rules - the resolved quality rules.
 * @returns score (0–100) and the flags that fired, in rule order.
 */
export function evaluateQuality(input: QualityInput, rules: QualityRules): QualityVerdict {
  if (!rules.enabled) return { score: 100, flags: [] }

  const flags: string[] = []
  const context: QualityContext = input.context ?? 'fetch'
  const host = hostOf(input.url)
  const { tier, base } = tierOf(input.url)
  let score = base

  // ── publisher reputation ────────────────────────────────────────────────
  const allowlisted = rules.domainReputation.enabled
    && rules.domainReputation.allowlist.some(entry => hostMatches(host, entry))
  if (rules.domainReputation.enabled && !allowlisted) {
    if (rules.domainReputation.blocklist.some(entry => hostMatches(host, entry))) {
      flags.push('domain-blocklisted')
      score -= 60
    }
  }
  if (allowlisted) {
    flags.push('domain-allowlisted')
    score += 5
  }

  // ── primary vs secondary ────────────────────────────────────────────────
  // A government notice is first-hand by default; the same tier relayed from
  // someone else's report is not, and an anonymous page can never be primary.
  const primaryTier = tier === 'official' || tier === 'academic' || tier === 'project' || tier === 'press'
  const secondary = looksSecondary(input.text)
  let authority = base
  if (primaryTier) {
    if (secondary) {
      authority -= 6
      flags.push('secondary-source')
    } else {
      authority += 6
      flags.push('primary-source')
    }
  } else if (secondary) {
    authority -= 6
    flags.push('secondary-source')
  }

  // ── freshness ───────────────────────────────────────────────────────────
  if (rules.freshness.enabled) {
    const age = daysSince(input.publishedAt)
    if (age === undefined) {
      // A snippet legitimately carries no date; an article without one is a gap.
      if (context === 'fetch') {
        authority -= 4
        flags.push('undated')
      }
    } else if (age > rules.freshness.staleDays) {
      authority -= 8
      flags.push('stale')
    } else if (age <= 30) {
      authority += 8
      flags.push('fresh')
    } else if (age <= 180) {
      authority += 2
    }
  }

  // ── deception signals ───────────────────────────────────────────────────
  const scheme = schemeOf(input.url)
  if (scheme.length > 0 && scheme !== 'https') {
    score -= 5
    flags.push('insecure')
  }
  if (isShortLink(input.url)) {
    score -= 3
    flags.push('shortlink')
  }
  if (looksLikeSpoof(input.url)) {
    score -= 40
    flags.push('possible-spoof')
  }

  if (rules.authority.enabled && authority < rules.authority.minScore) {
    flags.push('low-authority')
    score -= 20
  }
  score += authority - base

  // ── content shape ───────────────────────────────────────────────────────
  const text = input.text.trim()
  const floor = context === 'search' ? rules.snippetMinChars : rules.thinContent.minChars
  if (rules.thinContent.enabled && text.length < floor) {
    flags.push('thin-content')
    score -= 45
  }
  if (rules.seoSpam.enabled && !allowlisted) {
    const words = wordsOf(text)
    const paragraphs = paragraphsOf(text)
    if (words.length >= 50 && topWordRatio(words) > rules.seoSpam.maxKeywordDensity) {
      flags.push('seo-keyword-stuffing')
      score -= 30
    }
    if (paragraphs.length >= 4 && duplicateRatio(paragraphs) > rules.seoSpam.maxDuplicateRatio) {
      flags.push('seo-duplicate-boilerplate')
      score -= 25
    }
  }
  if (rules.lowQualityAigc.enabled && !allowlisted) {
    if (aigcMarkerRatio(text) > rules.lowQualityAigc.maxAigcMarkerRatio) {
      flags.push('low-quality-aigc')
      score -= 25
    }
  }

  return { score: Math.max(0, Math.min(100, score)), flags }
}

/** A source plus its verdict and rank order. */
export interface RankedSource {
  source: RawSearchSource
  quality: QualityVerdict
}

/**
 * Judge and order search sources.
 *
 * Sources are ordered by descending score (stable for ties, so engine ordering
 * still decides equal scores), and every source is kept: the score orders what
 * the reader sees, it never deletes a row they would never learn about.
 *
 * @param sources - the merged sources from dispatch.
 * @param rules - the resolved quality rules.
 * @param textOf - reads the text a source is judged on (its snippet, by default).
 * @returns the sources with their verdicts, best first.
 */
export function rankSources(
  sources: readonly RawSearchSource[],
  rules: QualityRules,
  textOf: (source: RawSearchSource) => string = source => source.snippet ?? '',
): RankedSource[] {
  return sources
    .map((source, index) => ({
      source,
      quality: evaluateQuality(
        {
          text: textOf(source),
          url: source.url,
          title: source.title,
          publishedAt: source.publishedAt,
          context: 'search',
        },
        rules,
      ),
      index,
    }))
    .sort((left, right) => right.quality.score - left.quality.score || left.index - right.index)
    .map(({ source, quality }) => ({ source, quality }))
}
