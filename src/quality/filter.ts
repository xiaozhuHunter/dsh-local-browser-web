/**
 * The quality-filter layer: what separates this plugin from "just fetch the page".
 *
 * Five rule families run over extracted content:
 *   1. thin content            — too little substance to be a result
 *   2. SEO spam                — keyword stuffing and repeated boilerplate
 *   3. low-quality AIGC        — machine-written filler markers
 *   4. domain reputation       — user-maintained allow/block lists
 *   5. authority signals       — the cheap structural hints a real article carries
 *
 * Two behaviours matter more than the rules themselves:
 *
 * - **Nothing is dropped silently.** The seam's `WebSearchSource` / `WebFetchResult`
 *   shapes are closed (`dsh-web` owns them), so a verdict cannot ride the result
 *   object. Instead every verdict is recorded in the plugin's diagnostics ring
 *   (readable by the `local_search_test` tool) and in the structured log line for
 *   the operation. Results are *ranked* by score, never removed.
 * - **Every rule is individually switchable**, and the whole layer has a master
 *   bypass, because debugging an extraction is impossible when the filter decides
 *   what you may see.
 *
 * @module dsh-local-browser-web/quality/filter
 */
import type { ResolvedConfig } from '../config.ts'
import type { QualityVerdict, RawSearchSource } from '../types.ts'

/** The quality rule set, as resolved from config. */
export type QualityRules = ResolvedConfig['quality']

/** One text to judge. */
export interface QualityInput {
  text: string
  url: string
  title?: string | undefined
}

/** Filler phrases that mark machine-written padding. Lowercased. */
const AIGC_MARKERS = [
  '综上所述', '总而言之', '值得注意的是', '首先，', '其次，', '最后，', '总的来说',
  'in conclusion', 'it is important to note', 'it is worth noting',
  "in today's fast-paced world", 'delve into', 'rich tapestry', 'furthermore, it',
  'when it comes to', 'navigating the complexities',
]

/** Structural hints that a page is a real article rather than an aggregator stub. */
const AUTHORITY_HINTS = ['author', 'byline', 'published', 'updated', 'date', 'citation', 'reference', 'source']

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

/** Count authority hints present in the text. */
function authorityHits(text: string): number {
  const lower = text.toLowerCase()
  return AUTHORITY_HINTS.filter(hint => lower.includes(hint)).length
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

/**
 * Judge one document.
 *
 * @param input - the text, its URL, and its title.
 * @param rules - the resolved quality rules.
 * @returns score (0–100) and the flags that fired, in rule order.
 */
export function evaluateQuality(input: QualityInput, rules: QualityRules): QualityVerdict {
  const flags: string[] = []
  let score = 100
  if (!rules.enabled) return { score, flags }

  const host = hostOf(input.url)
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

  const text = input.text.trim()
  const words = wordsOf(text)
  const paragraphs = paragraphsOf(text)

  if (rules.thinContent.enabled && text.length < rules.thinContent.minChars) {
    flags.push('thin-content')
    score -= 45
  }
  if (rules.seoSpam.enabled && !allowlisted) {
    const density = topWordRatio(words)
    const duplicates = duplicateRatio(paragraphs)
    if (words.length >= 50 && density > rules.seoSpam.maxKeywordDensity) {
      flags.push('seo-keyword-stuffing')
      score -= 30
    }
    if (paragraphs.length >= 4 && duplicates > rules.seoSpam.maxDuplicateRatio) {
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
  if (rules.authority.enabled) {
    const hits = authorityHits(text)
    const authority = Math.min(100, hits * 20 + (input.title !== undefined && input.title.length > 0 ? 20 : 0))
    if (authority < rules.authority.minScore) {
      flags.push('low-authority')
      score -= 20
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
 * still decides equal scores), and every source is kept: `quality_score` /
 * `quality_flags` are reported through diagnostics rather than by deleting rows
 * the caller never learns about.
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
      quality: evaluateQuality({ text: textOf(source), url: source.url, title: source.title }, rules),
      index,
    }))
    .sort((left, right) => right.quality.score - left.quality.score || left.index - right.index)
    .map(({ source, quality }) => ({ source, quality }))
}
