/**
 * Cross-source numeric conflict detection — the "备料" half of source vetting.
 *
 * When several engines answer the same query, the useful thing a searcher can
 * hand a reader is not a verdict but a **contradiction**: one source says the
 * release was 2025-03, another says 2026-01. That is deterministic to compute
 * and it is exactly the material a model needs to judge for itself.
 *
 * The hard part is not finding numbers, it is knowing that two numbers talk about
 * the same thing. Linking entities properly needs a model, so this module uses a
 * cheap proxy: two titles are about the same subject when their token sets
 * overlap enough. Latin words contribute word tokens, CJK contributes character
 * bigrams (which behave like words without a segmenter). Below the threshold,
 * numbers are ignored — a quiet miss is much better than a false alarm.
 *
 * @module dsh-local-browser-web/quality/conflict
 */

import type { RawSearchSource } from '../types.ts'
import { hostOf } from './source-tiers.ts'

/** One contradiction worth showing next to a source. */
export interface ConflictNote {
  /** The claim kind that disagreed (`版本`, `日期`, `比例`, `金额`). */
  kind: string
  /** The host holding the other value. */
  otherHost: string
  /** This source's value, as it appeared. */
  mine: string
  /** The other source's value, as it appeared. */
  theirs: string
}

/** A numeric claim found in one title. */
interface Claim {
  kind: string
  /** Normalised value, used for comparison. */
  value: string
  /** The value as the page wrote it. */
  raw: string
}

/** How much two titles must share before their numbers are compared. */
const SAME_SUBJECT_THRESHOLD = 0.34

/** Kinds whose extraction is reliable enough to act on. */
const CLAIM_PATTERNS: readonly { kind: string, pattern: RegExp, normalise: (match: RegExpExecArray) => string }[] = [
  {
    kind: '版本',
    // A bare `2.5` is usually a quantity ("2.5 倍"), so a version must be
    // signalled by `v`/`版本`, or carry three dot-separated parts.
    pattern: /\bv(\d+\.\d+(?:\.\d+)?)\b|版本\s*(\d+\.\d+(?:\.\d+)?)|\b(\d+\.\d+\.\d+)\b/giu,
    normalise: match => match[1] ?? match[2] ?? match[3] ?? '',
  },
  {
    kind: '比例',
    pattern: /(\d+(?:\.\d+)?)\s*%/gu,
    normalise: match => `${match[1] ?? ''}%`,
  },
  {
    kind: '金额',
    pattern: /(\d+(?:\.\d+)?)\s*(亿元|万元|亿美元|万美元|美元|元)/gu,
    normalise: match => `${match[1] ?? ''}${match[2] ?? ''}`,
  },
]

/** Month-level dates, which is the granularity two articles can meaningfully disagree on. */
const DATE_PATTERN = /(20\d{2})\s*[-/年]\s*(\d{1,2})/gu
const MONTH_PATTERN = /\b(20\d{2})-(\d{2})\b/gu

/** Latin word tokens and CJK bigrams, kept apart because they mean different things. */
interface TitleTokens {
  latin: Set<string>
  cjk: Set<string>
}

/** Latin words plus CJK bigrams: a segmenter-free similarity proxy. */
function tokensOf(text: string): TitleTokens {
  const latin = new Set<string>()
  const cjk = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/gu) ?? []) latin.add(word)
  const han = text.match(/\p{Script=Han}+/gu) ?? []
  for (const run of han) {
    const chars = [...run]
    if (chars.length === 1) cjk.add(chars[0] as string)
    for (let index = 0; index + 1 < chars.length; index += 1) {
      cjk.add(`${chars[index] ?? ''}${chars[index + 1] ?? ''}`)
    }
  }
  return { latin, cjk }
}

/** How many members of `left` appear in `right`. */
function shared(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const token of left) if (right.has(token)) count += 1
  return count
}

/**
 * Whether two titles plausibly discuss the same subject.
 *
 * The cheap overlap ratio alone is not enough: two different products' release
 * notes share the boilerplate around them ("发布 … 版本"), which reads as strong
 * overlap while the subjects are unrelated. So a Latin entity must be shared
 * whenever both titles have one; for two Chinese titles the shared bigram count
 * has to clear a higher bar than the boilerplate provides.
 */
function sameSubject(left: TitleTokens, right: TitleTokens): boolean {
  const latinShared = shared(left.latin, right.latin)
  const cjkShared = shared(left.cjk, right.cjk)
  if (left.latin.size > 0 && right.latin.size > 0) {
    if (latinShared === 0) return false
    const unionLeft = left.latin.size + left.cjk.size
    const unionRight = right.latin.size + right.cjk.size
    return (latinShared + cjkShared) / Math.min(unionLeft, unionRight) >= SAME_SUBJECT_THRESHOLD
  }
  return cjkShared >= 3
}

/** Extract the numeric claims from one title. */
function claimsOf(title: string): Claim[] {
  const claims: Claim[] = []
  for (const { kind, pattern, normalise } of CLAIM_PATTERNS) {
    pattern.lastIndex = 0
    for (let match = pattern.exec(title); match !== null; match = pattern.exec(title)) {
      const value = normalise(match)
      if (value.length > 0) claims.push({ kind, value, raw: value })
    }
  }
  // Dates are compared at month granularity; a full day would flag every pair.
  DATE_PATTERN.lastIndex = 0
  for (let match = DATE_PATTERN.exec(title); match !== null; match = DATE_PATTERN.exec(title)) {
    const month = String(Number(match[2])).padStart(2, '0')
    const raw = `${match[1] ?? ''}-${month}`
    claims.push({ kind: '日期', value: raw, raw })
  }
  MONTH_PATTERN.lastIndex = 0
  for (let match = MONTH_PATTERN.exec(title); match !== null; match = MONTH_PATTERN.exec(title)) {
    const raw = `${match[1] ?? ''}-${match[2] ?? ''}`
    claims.push({ kind: '日期', value: raw, raw })
  }
  return claims
}

/**
 * Find the single most informative contradiction per source.
 *
 * Only titles are compared (a snippet's numbers belong to a sentence, not to the
 * subject), and only sources whose titles overlap enough are treated as talking
 * about the same thing.
 *
 * @param sources - the merged sources for one query.
 * @returns per-source notes, keyed by URL; absent URLs have no contradiction.
 */
export function detectConflicts(sources: readonly RawSearchSource[]): Map<string, ConflictNote> {
  const notes = new Map<string, ConflictNote>()
  const entries = sources.map((source) => {
    const title = source.title ?? ''
    return { source, host: hostOf(source.url), claims: claimsOf(title), tokens: tokensOf(title) }
  })

  for (const entry of entries) {
    if (entry.claims.length === 0) continue
    for (const claim of entry.claims) {
      let best: { other: typeof entry, otherClaim: Claim } | undefined
      for (const other of entries) {
        if (other.source.url === entry.source.url || other.host === entry.host) continue
        if (!sameSubject(entry.tokens, other.tokens)) continue
        const otherClaim = other.claims.find(candidate => candidate.kind === claim.kind && candidate.value !== claim.value)
        if (otherClaim === undefined) continue
        if (best === undefined) best = { other, otherClaim }
      }
      if (best === undefined) continue
      notes.set(entry.source.url, {
        kind: claim.kind,
        otherHost: best.other.host,
        mine: claim.raw,
        theirs: best.otherClaim.raw,
      })
      break
    }
  }
  return notes
}
