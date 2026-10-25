/**
 * The four-stage fetch cleaning pipeline.
 *
 *   1. transport safety   — URL scheme + SSRF guard, bounded redirects, timeout, size caps, challenge detection
 *   2. render & extract   — render (or plain transport), then pull the main content out of the DOM
 *   3. Markdown           — HTML to Markdown, matching `dsh-tool-web`'s own conversion
 *   4. quality filter     — thin content, SEO spam, low-quality AIGC, domain reputation, authority
 *
 * Each stage is switchable from the settings panel. One exception is called out
 * deliberately: the **scheme check and SSRF guard are never disabled**. A toggle
 * that turns "don't probe the local network" off is not a debugging convenience,
 * it is a vulnerability switch, so stage one gates the *caps* (bytes, characters,
 * redirects) and challenge detection instead. See README "已知限制".
 *
 * @module dsh-local-browser-web/fetch/pipeline
 */
import type { ResolvedConfig } from '../config.ts'
import { LocalBrowserWebError } from '../errors.ts'
import { assertFetchableUrl, classifyContentType, looksLikeChallenge } from '../http.ts'
import { htmlToMarkdown } from '../markdown.ts'
import { evaluateQuality } from '../quality/filter.ts'
import type { QualityVerdict } from '../types.ts'
import type { FetchBackendRegistry } from './backends.ts'
import { extractArticle } from './extract.ts'

/** What the pipeline produced, in the seam's own vocabulary plus its own annotations. */
export interface FetchPipelineOutcome {
  /** Final URL after redirects. */
  url: string
  /** Main-document status. */
  statusCode: number
  /** The decoded body the seam's `WebFetchResult` carries. */
  body: { kind: 'html', content: string } | { kind: 'text', content: string }
  /** Whether any cap cut the content. */
  truncated: boolean
  /** The backend that served the retrieval. */
  backend: string
  /** Characters of content produced. */
  chars: number
  /** The quality verdict, or a neutral one when the layer was bypassed. */
  quality: QualityVerdict
}

/** A verdict that fired nothing — used when the quality layer is switched off. */
const NEUTRAL_VERDICT: QualityVerdict = { score: 100, flags: [] }

/**
 * Character budget the *transport* gets when the extraction stage will run.
 *
 * Extraction scores containers over the whole document, so cutting the markup at
 * the document cap is not a smaller version of the same result — it can delete
 * the container that holds the article, and the scorer then falls back to a
 * fragment (measured: a 562 KB Wikipedia page cut to 100 k yielded 1 905
 * characters instead of 29 922). The user-facing cap is applied to the *output*
 * further down; this one only bounds what one page may cost in memory.
 */
export const EXTRACT_BODY_CHARS = 2_000_000

/**
 * Convert HTML to Markdown, degrading to plain text rather than failing.
 *
 * The converter walks the DOM recursively, so markup that survives extraction
 * can still exhaust the stack. Slightly worse text beats a tool call that
 * throws — the same trade the built-in renderer makes.
 *
 * @param html - the cleaned HTML fragment.
 * @param fallback - the plain text to use if conversion fails.
 * @returns Markdown, or the fallback.
 */
function toMarkdownSafely(html: string, fallback: string): string {
  try {
    return htmlToMarkdown(html)
  } catch {
    return fallback
  }
}

/**
 * Run one retrieval through all four stages.
 *
 * @param url - the URL to retrieve.
 * @param config - one plain config snapshot.
 * @param backends - the backend registry.
 * @param signal - caller cancellation.
 * @returns the cleaned body plus its verdict.
 * @throws {LocalBrowserWebError} depending on the failing stage.
 */
export async function runFetchPipeline(
  url: string,
  config: ResolvedConfig,
  backends: FetchBackendRegistry,
  signal?: AbortSignal,
): Promise<FetchPipelineOutcome> {
  // ── stage 1: transport safety ────────────────────────────────────────────
  assertFetchableUrl(url)
  // Rendering off means the page must be readable without JavaScript: fall back
  // to plain transport rather than silently rendering anyway.
  const backendId = config.clean.render ? config.fetchBackend : 'http'
  const backend = backends.get(backendId)
  const retrieved = await backend.fetch({
    url,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.clean.transport ? config.maxResponseBytes : Number.MAX_SAFE_INTEGER,
    render: config.clean.render,
    ...signal === undefined ? {} : { signal },
  })

  if (config.clean.transport && looksLikeChallenge(retrieved.statusCode, retrieved.body)) {
    throw new LocalBrowserWebError(
      `local-browser-web: 页面返回人机验证/拦截页（HTTP ${String(retrieved.statusCode)}，${url}）`,
      'WEB_FETCH_CHALLENGE',
    )
  }

  const kind = classifyContentType(retrieved.contentType)
  if (kind === 'unsupported') {
    throw new LocalBrowserWebError(
      `local-browser-web: 不支持的内容类型 "${retrieved.contentType}"（${url}）`,
      'UNSUPPORTED_CONTENT_TYPE',
    )
  }

  // ── stage 2: render & extract ────────────────────────────────────────────
  const isHtml = kind === 'html'
  const extracted = isHtml && config.clean.extract
    ? extractArticle(retrieved.body, retrieved.url, {
      readability: true,
      fallback: config.clean.extractFallback,
    })
    : { title: undefined, text: retrieved.body, html: retrieved.body }

  if (isHtml && config.clean.extract && extracted.text.trim().length === 0) {
    throw new LocalBrowserWebError(
      `local-browser-web: 未能从页面提取正文（${retrieved.url}）`,
      'EXTRACTION_FAILED',
    )
  }

  // ── stage 3: Markdown ───────────────────────────────────────────────────
  // Converting here means the tool layer receives finished text; keeping it off
  // hands the raw HTML over so the tool's own conversion applies instead.
  //
  // Extraction that *declines* the markup (see `MAX_DOM_DEPTH` in ./extract.ts)
  // answers with text and no fragment. That refusal must be honoured here too:
  // handing the same hostile markup to the converter just moves the crash one
  // stage later, so the degraded text is what continues down the pipeline.
  const declined = isHtml && config.clean.extract && extracted.html.length === 0
  const cleaned = declined ? extracted.text : extracted.html.length > 0 ? extracted.html : retrieved.body
  const convert = isHtml && config.clean.markdown && !declined
  const converted = convert ? toMarkdownSafely(cleaned, extracted.text) : cleaned
  // The document cap is a context budget, so it lands on the cleaned output —
  // not on the markup the extractor still needs whole (see EXTRACT_BODY_CHARS).
  const overChars = converted.length > config.maxBodyChars
  const content = overChars ? converted.slice(0, config.maxBodyChars) : converted
  const passesHtml = isHtml && !convert && !declined
  const body: FetchPipelineOutcome['body'] = passesHtml
    ? { kind: 'html', content }
    : { kind: 'text', content }

  // ── stage 4: quality filter ─────────────────────────────────────────────
  // Judged on plain text either way: markup attributes are not prose signals.
  // `context: 'fetch'` selects the article floor for thin content — a snippet
  // would be wrongly condemned by it, and an article is what this path has.
  const judged = config.clean.quality
    ? evaluateQuality(
        { text: convert ? content : extracted.text, url: retrieved.url, title: extracted.title, context: 'fetch' },
        config.quality,
      )
    : NEUTRAL_VERDICT

  return {
    url: retrieved.url,
    statusCode: retrieved.statusCode,
    body,
    truncated: retrieved.truncated || overChars,
    backend: backendId,
    chars: content.length,
    quality: judged,
  }
}
