/**
 * The fetch-backend registry.
 *
 * Retrieval is split from cleaning: a backend's only job is "give me the bytes
 * (possibly after running the page's JavaScript)". The four-stage pipeline then
 * cleans whatever it gets, so a new transport — a different browser, a remote
 * renderer, an authenticated intranet proxy — is a registration, not an edit.
 *
 * Three backends ship:
 * - `cdp`       — connects to an already-running Chrome (default; no download).
 * - `playwright`— optional, lazily imported; unusable unless installed.
 * - `http`      — plain transport, no JavaScript; also the fallback when the
 *                 rendering stage is switched off.
 *
 * @module dsh-local-browser-web/fetch/backends
 */
import { CdpBrowser } from '../browser/cdp.ts'
import { PlaywrightBrowser } from '../browser/playwright.ts'
import { LocalBrowserWebError } from '../errors.ts'
import { httpGet, looksLikeChallenge } from '../http.ts'
import type { HttpLimits } from '../http.ts'
import type { ProxySpec } from '../proxy.ts'
import type { BackendFetchRequest, BackendFetchResult, FetchBackend } from '../types.ts'

/** Holds the backends `fetchBackend` may select, and any third-party additions. */
export class FetchBackendRegistry {
  private readonly backends = new Map<string, FetchBackend>()

  /**
   * Add or replace a backend.
   * @param id - the id `fetchBackend` selects.
   * @param backend - the backend.
   * @returns the disposer removing it again.
   */
  register(id: string, backend: FetchBackend): () => void {
    const previous = this.backends.get(id)
    this.backends.set(id, backend)
    return () => {
      if (this.backends.get(id) === backend) {
        if (previous === undefined) this.backends.delete(id)
        else this.backends.set(id, previous)
      }
    }
  }

  /** Whether a backend id is registered. */
  has(id: string): boolean {
    return this.backends.has(id)
  }

  /** Every registered backend id, sorted. */
  ids(): string[] {
    return [...this.backends.keys()].sort()
  }

  /**
   * Resolve one backend.
   * @param id - the backend id.
   * @returns the backend.
   * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` when the id is unknown.
   */
  get(id: string): FetchBackend {
    const backend = this.backends.get(id)
    if (backend === undefined) {
      throw new LocalBrowserWebError(
        `local-browser-web: 未注册抓取后端 "${id}"（已注册：${this.ids().join(', ') || '无'}）`,
        'ENGINE_CONFIG_INVALID',
      )
    }
    return backend
  }
}

/** The plain-transport backend. Never runs JavaScript, so `render` is ignored. */
export function httpBackend(
  limits: () => HttpLimits,
  proxy: () => ProxySpec | undefined = () => undefined,
): FetchBackend {
  return {
    id: 'http',
    available: () => true,
    async fetch(request: BackendFetchRequest): Promise<BackendFetchResult> {
      const result = await httpGet({
        url: request.url,
        limits: { ...limits(), timeoutMs: request.timeoutMs },
        proxy: proxy(),
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
      return {
        url: result.url,
        statusCode: result.statusCode,
        body: result.body,
        contentType: result.contentType,
        truncated: result.truncated,
      }
    },
  }
}

/** The CDP backend: renders through the user's own Chrome. */
export function cdpBackend(browser: CdpBrowser): FetchBackend {
  return {
    id: 'cdp',
    // Optimistic until a background probe has actually failed; a real
    // unreachable endpoint surfaces per call as BROWSER_UNAVAILABLE.
    available: () => browser.cachedReachable() ?? true,
    async fetch(request: BackendFetchRequest): Promise<BackendFetchResult> {
      const page = await browser.render(request.url, request.signal, request.waitFor)
      if (looksLikeChallenge(page.statusCode, page.html)) {
        throw new LocalBrowserWebError(
          `local-browser-web: 页面返回人机验证/拦截页（HTTP ${String(page.statusCode)}，${request.url}）`,
          'WEB_FETCH_CHALLENGE',
        )
      }
      const cut = cutToBytes(page.html, request.maxBytes)
      return {
        url: page.url,
        statusCode: page.statusCode,
        body: cut.body,
        contentType: sniffContentType(page.html),
        truncated: cut.truncated,
      }
    },
  }
}

/** The Playwright backend: renders through an optional local browser. */
export function playwrightBackend(browser: PlaywrightBrowser): FetchBackend {
  return {
    id: 'playwright',
    available: () => true,
    async fetch(request: BackendFetchRequest): Promise<BackendFetchResult> {
      const page = await browser.render(request.url, request.signal, request.waitFor)
      if (looksLikeChallenge(page.statusCode, page.html)) {
        throw new LocalBrowserWebError(
          `local-browser-web: 页面返回人机验证/拦截页（HTTP ${String(page.statusCode)}，${request.url}）`,
          'WEB_FETCH_CHALLENGE',
        )
      }
      const cut = cutToBytes(page.html, request.maxBytes)
      return {
        url: page.url,
        statusCode: page.statusCode,
        body: cut.body,
        contentType: sniffContentType(page.html),
        truncated: cut.truncated,
      }
    },
  }
}

/** A rendered page is HTML unless the markup itself says otherwise. */
function sniffContentType(html: string): string {
  const head = html.slice(0, 2_000).toLowerCase()
  if (head.includes('<html') || head.includes('<!doctype html') || head.includes('<body')) return 'text/html'
  return 'text/plain'
}

/** Cut a rendered body to the byte cap without splitting a UTF-8 code point. */
function cutToBytes(body: string, maxBytes: number): { body: string, truncated: boolean } {
  const bytes = new TextEncoder().encode(body)
  if (bytes.byteLength <= maxBytes) return { body, truncated: false }
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return { body: decoder.decode(bytes.subarray(0, maxBytes)), truncated: true }
}
