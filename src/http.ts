/**
 * Shared HTTP retrieval with the transport-safety guards the cleaning pipeline's
 * first stage promises: an SSRF guard on every hop, a bounded redirect chain, a
 * timeout, a byte cap, and a character cap.
 *
 * Used by the HTTP-kind engine runners and the `http` fetch backend, so all three
 * entry points enforce the same limits.
 *
 * @module dsh-local-browser-web/http
 */
import { LocalBrowserWebError } from './errors.ts'
import { proxyFetch, type ProxySpec } from './proxy.ts'

/** Resource limits applied to one retrieval. */
export interface HttpLimits {
  /** Whole-request budget (connect + redirects + body). */
  timeoutMs: number
  /** Response body byte cap; the body is cut and `truncated` set past it. */
  maxResponseBytes: number
  /** Decoded character cap; the text is cut and `truncated` set past it. */
  maxBodyChars: number
  /** Maximum same-scheme redirect hops. */
  maxRedirects: number
  /** `User-Agent` header. */
  userAgent: string
}

/** One retrieved body. */
export interface HttpResult {
  url: string
  statusCode: number
  body: string
  /** Lowercased content type without parameters (`text/html`). */
  contentType: string
  truncated: boolean
  /** `Location` of an unfollowed redirect; present only with `followRedirects: false`. */
  location?: string
}

/** How the pipeline classifies a content type. */
export type ContentKind = 'html' | 'text' | 'unsupported'

/** IPv4/IPv6 literals that must never be fetched: loopback, link-local, private, and cloud metadata. */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
  'fd00:ec2::254',
])

/** Whether an IPv4 literal falls in a private / loopback / link-local range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(part => Number(part))
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a = 0, b = 0] = octets
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** Whether an IPv6 literal is loopback, link-local, or unique-local. */
function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase()
  return normalized === '::1'
    || normalized.startsWith('fe80')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
}

/**
 * Validate a fetch target before any connection is made.
 *
 * Anything that is not http(s), and anything resolving to a loopback, private,
 * link-local, or cloud-metadata host, is refused — the naive SSRF that turns a
 * "fetch this page" request into a probe of the local network.
 *
 * @param url - the candidate URL.
 * @returns the parsed URL.
 * @throws {LocalBrowserWebError} `UNSUPPORTED_CONTENT_TYPE` for a non-http(s) scheme; a blocked
 *   loopback/private/metadata target is refused as `WEB_FETCH_CHALLENGE`, because the request to
 *   retrieve it is what this guard is refusing.
 */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new LocalBrowserWebError(`local-browser-web: 非法 URL "${url}"`, 'WEB_FETCH_CHALLENGE', { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LocalBrowserWebError(
      `local-browser-web: 仅支持 http/https，拒绝 ${parsed.protocol}//（${url}）`,
      'UNSUPPORTED_CONTENT_TYPE',
    )
  }
  const host = parsed.hostname.toLowerCase()
  const bare = host.replace(/^\[|\]$/gu, '')
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(bare) || isPrivateIpv4(bare) || isPrivateIpv6(bare)) {
    throw new LocalBrowserWebError(
      `local-browser-web: 拒绝访问内网/元数据地址（${host}）`,
      'WEB_FETCH_CHALLENGE',
    )
  }
  return parsed
}

/** Classify a content type into the closed set the seam can represent. */
export function classifyContentType(contentType: string): ContentKind {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === '' || type.startsWith('text/') || type === 'application/json' || type === 'application/xml') return 'text'
  return 'unsupported'
}

/** The charset a `Content-Type` header declares, lower-cased. */
function headerCharset(rawContentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/iu.exec(rawContentType)
  return match?.[1]?.trim().toLowerCase()
}

/**
 * The charset the page declares about itself, for hosts that omit it from the
 * header. Legacy Chinese sites ship `charset=gb2312` in `<meta>` only; decoding
 * those bytes as UTF-8 turns every Chinese character into a replacement mark.
 *
 * @param bytes - the response body (only the head is inspected).
 * @returns the declared label, lower-cased, when the document names one.
 */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4_096)).toLowerCase()
  const direct = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/u.exec(head)
  if (direct?.[1] !== undefined) return direct[1]
  const equiv = /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/u.exec(head)
  return equiv?.[1]
}

/**
 * Decode a response body with its declared charset.
 *
 * The header wins over the document, the document over UTF-8 — the same
 * precedence a browser uses. An unrecognised label falls back to UTF-8 rather
 * than failing the fetch: `fatal: false` never throws on real-world bytes.
 *
 * @param bytes - the capped response body.
 * @param rawContentType - the raw `Content-Type` header, parameters included.
 * @returns the decoded text.
 */
export function decodeBody(bytes: Uint8Array, rawContentType: string): string {
  const label = headerCharset(rawContentType) ?? metaCharset(bytes) ?? 'utf-8'
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

/**
 * Detect an anti-bot / challenge interstitial.
 *
 * A challenge is not "empty content": the host answered, but with a gate rather
 * than the resource. Naming it separately is what lets the panel's test-connection
 * report say *why* an engine failed instead of "0 results".
 *
 * @param status - the HTTP status.
 * @param body - the decoded body (a prefix is enough).
 * @returns whether the response looks like a challenge page.
 */
export function looksLikeChallenge(status: number, body: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true
  const head = body.slice(0, 4_000).toLowerCase()
  return head.includes('just a moment')
    || head.includes('cf-challenge')
    || head.includes('attention required')
    || head.includes('enable javascript and cookies to continue')
    || head.includes('/cdn-cgi/challenge-platform')
    || head.includes('captcha')
}

/** One retrieval request. */
export interface HttpRequest {
  url: string
  /** Extra request headers (accept-language, engine-specific). */
  headers?: Record<string, string>
  limits: HttpLimits
  signal?: AbortSignal
  /**
   * Outbound proxy, when one is configured and this path uses it.
   *
   * Absent means a direct connection — which is also what a proxy bypass entry
   * resolves to, since {@link proxyFetch} re-checks the list per target.
   */
  proxy?: ProxySpec
  /**
   * Whether a 3xx is followed to its destination (default true).
   *
   * Set `false` to read one hop's `Location` instead — which is how a click
   * tracker (`google.com/goto?url=…`) is turned back into a real URL without
   * downloading the page it points at.
   */
  followRedirects?: boolean
}

/**
 * Retrieve one URL under the shared limits and guards.
 *
 * @param request - the target, headers, and limits.
 * @returns the decoded body plus its status and content type.
 * @throws {LocalBrowserWebError} `WEB_FETCH_TIMEOUT` / `CONTENT_TOO_LARGE` / `UNSUPPORTED_CONTENT_TYPE`.
 */
export async function httpGet(request: HttpRequest): Promise<HttpResult> {
  const { limits } = request
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, limits.timeoutMs)
  const signal = request.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, request.signal])
  try {
    let target = assertFetchableUrl(request.url)
    const headers: Record<string, string> = {
      'user-agent': limits.userAgent,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...request.headers,
    }
    // One send per hop, so a redirect chain keeps whichever egress it started on.
    // Both branches answer with a `Response`, which is what lets the caps and
    // content-type checks below stay transport-agnostic.
    const send = async (url: URL): Promise<Response> => request.proxy === undefined
      ? await fetch(url, { redirect: 'manual', signal, headers })
      : await proxyFetch(url, { spec: request.proxy, headers, signal })
    let hops = 0
    let response: Response
    for (;;) {
      const attempt = await send(target)
      const location = attempt.headers.get('location')
      if (attempt.status >= 300 && attempt.status < 400 && location !== null) {
        if (request.followRedirects === false) {
          return { url: target.toString(), statusCode: attempt.status, body: '', contentType: '', truncated: false, location }
        }
        if (hops >= limits.maxRedirects) {
          throw new LocalBrowserWebError(
            `local-browser-web: 重定向超过 ${String(limits.maxRedirects)} 跳（${request.url}）`,
            'WEB_FETCH_CHALLENGE',
          )
        }
        hops += 1
        target = assertFetchableUrl(new URL(location, target).toString())
        continue
      }
      response = attempt
      break
    }

    const rawContentType = response.headers.get('content-type') ?? ''
    const contentType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? ''
    if (classifyContentType(contentType) === 'unsupported') {
      throw new LocalBrowserWebError(
        `local-browser-web: 不支持的内容类型 "${contentType}"（${response.url || request.url}）`,
        'UNSUPPORTED_CONTENT_TYPE',
      )
    }

    // A declared body larger than the cap is refused outright rather than
    // partially read: the caller asked for a document, not a fragment.
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
      throw new LocalBrowserWebError(
        `local-browser-web: 响应体 ${String(declared)} 字节超过上限 ${String(limits.maxResponseBytes)}（${request.url}）`,
        'CONTENT_TOO_LARGE',
      )
    }

    const { bytes, truncated: byteTruncated } = await readBounded(response, limits.maxResponseBytes)
    const decoded = decodeBody(bytes, rawContentType)
    const overChars = decoded.length > limits.maxBodyChars
    return {
      // A proxied response is constructed rather than observed, so it reports no
      // URL of its own; `target` is the last hop actually requested either way.
      url: response.url === '' ? target.toString() : response.url,
      statusCode: response.status,
      body: overChars ? decoded.slice(0, limits.maxBodyChars) : decoded,
      contentType,
      truncated: byteTruncated || overChars,
    }
  } catch (error) {
    if (error instanceof LocalBrowserWebError) throw error
    if (signal.aborted && request.signal?.aborted !== true) {
      throw new LocalBrowserWebError(
        `local-browser-web: 请求超时（${String(limits.timeoutMs)}ms，${request.url}）`,
        'WEB_FETCH_TIMEOUT',
        { cause: error },
      )
    }
    throw new LocalBrowserWebError(`local-browser-web: 请求失败（${request.url}）`, 'WEB_FETCH_CHALLENGE', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/** Read a response body up to `maxBytes`, reporting whether it was cut. */
async function readBounded(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array, truncated: boolean }> {
  const body = response.body
  if (body === null) return { bytes: new Uint8Array(), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    const remaining = maxBytes - received
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, remaining))
      truncated = true
      break
    }
    chunks.push(value)
    received += value.byteLength
  }
  // A truncated read stops the transfer; an exhausted one ends it naturally.
  if (truncated) await reader.cancel().catch(() => undefined)
  return { bytes: concat(chunks), truncated }
}

/** Concatenate chunk buffers. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
