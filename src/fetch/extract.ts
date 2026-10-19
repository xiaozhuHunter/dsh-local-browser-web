/**
 * Stage two of the cleaning pipeline: get the *content* out of a rendered page.
 *
 * A DOM scorer picks the densest plausible article container (Readability's core
 * idea, minus its full typography heuristics), and a paragraph-gathering
 * heuristic stands in when a page defeats scoring (Trafilatura-style fallback).
 * Both paths return plain text plus a cleaned HTML fragment, so the Markdown
 * stage does not care which one produced the input.
 *
 * @module dsh-local-browser-web/fetch/extract
 */
import { JSDOM } from 'jsdom'

/** Elements that are chrome rather than content, removed before scoring. */
const STRIPPED_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form',
  'nav', 'header', 'footer', 'aside', 'dialog', 'button',
  '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '[role="search"]', '[role="dialog"]',
]

/** Containers worth scoring, most specific first. */
const CANDIDATE_SELECTORS = ['article', 'main', '[role="main"]', '.post', '.article', '.content', '#content', 'div']

/** A scored candidate. */
interface Candidate {
  node: Element
  score: number
  text: string
}

/** What the extraction produced. */
export interface ExtractedArticle {
  /** Document title, when present. */
  title: string | undefined
  /** Plain text of the extracted content. */
  text: string
  /** Cleaned HTML of the extracted content (the Markdown stage's input). */
  html: string
}

/** Extraction switches, from the pipeline's stage config. */
export interface ExtractOptions {
  /** Run the DOM scorer. */
  readability: boolean
  /** Run the paragraph heuristic when the scorer finds too little. */
  fallback: boolean
}

/** Collapse whitespace the way a reader sees it. */
function normalize(text: string): string {
  return text.replace(/[^\S\n]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Measure how much of a node's text sits inside links (a chrome/nav signal). */
function linkDensity(node: Element, textLength: number): number {
  if (textLength === 0) return 1
  let linked = 0
  for (const anchor of node.querySelectorAll('a')) linked += (anchor.textContent ?? '').length
  return Math.min(linked / textLength, 1)
}

/** Score one candidate container. */
function scoreCandidate(node: Element): Candidate {
  const text = normalize(node.textContent ?? '')
  const paragraphs = node.querySelectorAll('p').length
  const length = text.length
  // Density-weighted: a long node whose text is nearly all links is a menu, not an article.
  const score = length * (1 - linkDensity(node, length)) + paragraphs * 60
  return { node, score, text }
}

/** Remove chrome from a document in place. */
function stripChrome(document: Document): void {
  for (const selector of STRIPPED_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) node.remove()
  }
}

/** Gather paragraph-ish text when scoring finds no single dominant container. */
function gatherParagraphs(document: Document): string {
  const blocks: string[] = []
  for (const node of document.querySelectorAll('p, li, blockquote, pre, h2, h3')) {
    const text = normalize(node.textContent ?? '')
    if (text.length >= 40) blocks.push(text)
  }
  if (blocks.length > 0) return blocks.join('\n\n')
  return normalize(document.body?.textContent ?? '')
}

/**
 * Extract the main content of a rendered page.
 *
 * @param html - the rendered document.
 * @param _url - the document URL (kept for parity with the seam's request and future base-URL use).
 * @param options - which extraction strategies may run.
 * @returns title, plain text, and a cleaned HTML fragment.
 */
export function extractArticle(html: string, _url: string, options: ExtractOptions): ExtractedArticle {
  const dom = new JSDOM(html)
  try {
    const { document } = dom.window
    const title = normalize(document.title ?? '') || undefined
    stripChrome(document)

    let best: Candidate | undefined
    if (options.readability) {
      for (const selector of CANDIDATE_SELECTORS) {
        for (const node of document.querySelectorAll(selector)) {
          const candidate = scoreCandidate(node)
          if (candidate.text.length === 0) continue
          if (best === undefined || candidate.score > best.score) best = candidate
        }
        // A decisive `article`/`main` hit ends the widening search.
        if (best !== undefined && best.score > 1_500) break
      }
    }

    if (best !== undefined && best.text.length >= 200) {
      return { title, text: best.text, html: best.node.innerHTML }
    }
    if (options.fallback) {
      const text = gatherParagraphs(document)
      return { title, text, html: best?.node.innerHTML ?? document.body?.innerHTML ?? '' }
    }
    return { title, text: best?.text ?? '', html: best?.node.innerHTML ?? '' }
  } finally {
    dom.window.close()
  }
}
