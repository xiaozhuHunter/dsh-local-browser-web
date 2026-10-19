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
  const convert = isHtml && config.clean.markdown
  const content = convert ? htmlToMarkdown(extracted.html.length > 0 ? extracted.html : retrieved.body) : extracted.text
  const body: FetchPipelineOutcome['body'] = isHtml && !convert
    ? { kind: 'html', content: extracted.html.length > 0 ? extracted.html : retrieved.body }
    : { kind: 'text', content }

  // ── stage 4: quality filter ─────────────────────────────────────────────
  const judged = config.clean.quality
    ? evaluateQuality({ text: content, url: retrieved.url, title: extracted.title }, config.quality)
    : NEUTRAL_VERDICT

  return {
    url: retrieved.url,
    statusCode: retrieved.statusCode,
    body,
    truncated: retrieved.truncated,
    backend: backendId,
    chars: content.length,
    quality: judged,
  }
}
