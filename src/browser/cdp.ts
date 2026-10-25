/**
 * A minimal Chrome DevTools Protocol client.
 *
 * The plugin connects to an **already-running** Chrome instead of shipping a
 * browser: the default backend points at the user's own Chrome on the
 * remote-debugging port, which keeps the install small and lets a `shared`
 * profile reuse the logins the user already has. A Playwright backend is
 * available as an alternative (see `./playwright.ts`).
 *
 * Only the handful of CDP domains the plugin needs are used: `Target` (create /
 * dispose a page), `Page` (navigate, await load), `Network` (main-response status,
 * UA override), and `Runtime` (read the rendered DOM).
 *
 * Node 22's global `WebSocket` is the transport, so there is no `ws` dependency.
 *
 * @module dsh-local-browser-web/browser/cdp
 */
import { LocalBrowserWebError } from '../errors.ts'
import { shouldBypass } from '../proxy.ts'
import type { ProfileMode } from '../types.ts'

/** One rendered page, as the plugin consumes it. */
export interface RenderedPage {
  /** Final URL after client-side redirects. */
  url: string
  /** Main-document HTTP status (0 when the response was never observed). */
  statusCode: number
  /** `document.documentElement.outerHTML` of the loaded page. */
  html: string
}

/** Connection and rendering options, read from the live config per operation. */
export interface CdpOptions {
  endpoint: string
  userAgent: string
  profileMode: ProfileMode
  /** Per-render budget. */
  timeoutMs: number
  /**
   * Outbound proxy for the rendered page, as `scheme://host:port`.
   *
   * Chrome has no browser-wide proxy command, so this is applied by creating a
   * browser context and passing the proxy to `Target.createBrowserContext` — the
   * same mechanism Playwright uses. A proxied render therefore always runs in a
   * fresh context, even in `shared` mode.
   */
  proxy?: { server: string, bypass: string }
}

/** A JSON-RPC style message from the browser. */
interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string, code?: number }
}

/** Time a promise settles, aborting it on timeout or caller cancellation. */async function within<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
  onTimeout: () => LocalBrowserWebError,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(onTimeout()) }, timeoutMs)
  const signals = outer === undefined ? [controller.signal] : [controller.signal, outer]
  try {
    return await run(AbortSignal.any(signals))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How long a render waits for `loadEventFired` before reading what is already there.
 *
 * A proxied page can keep a third-party asset open forever, so `readyState` stays
 * `loading` and the event never arrives; spending the whole per-render budget on it
 * would throw away a document that is already readable.
 */
const PAGE_LOAD_GRACE_MS = 8_000

/** How long a render waits for a parser-declared selector before giving up and reading anyway. */
const SELECTOR_READY_MS = 8_000

/** Poll interval while waiting for that selector. */
const SELECTOR_POLL_MS = 200

/** Resolve `true` when `promise` settles first, `false` when the timer wins. */
async function settlesFirst(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, ms)
  })
  try {
    return await Promise.race([promise.then(() => true, () => true), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** One WebSocket speaking CDP, with a pending-request table. */class CdpConnection {
  private next = 1
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void }>()
  private readonly listeners = new Set<(message: CdpMessage) => void>()
  private socket: WebSocket | undefined

  private constructor(private readonly url: string) {}

  /** Open a connection to one CDP WebSocket URL. */
  static async open(url: string, signal: AbortSignal): Promise<CdpConnection> {
    const connection = new CdpConnection(url)
    await connection.connect(signal)
    return connection
  }

  private connect(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      this.socket = socket
      const onAbort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('open', () => { signal.removeEventListener('abort', onAbort); resolve() }, { once: true })
      socket.addEventListener('error', () => {
        signal.removeEventListener('abort', onAbort)
        reject(new LocalBrowserWebError(`local-browser-web: 无法连接 CDP ${this.url}`, 'BROWSER_UNAVAILABLE'))
      }, { once: true })
      socket.addEventListener('message', (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as CdpMessage
        if (message.id === undefined) {
          for (const listener of this.listeners) listener(message)
          return
        }
        const waiter = this.pending.get(message.id)
        if (waiter === undefined) return
        this.pending.delete(message.id)
        if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP error'))
        else waiter.resolve(message.result ?? {})
      })
    })
  }

  /** Send one CDP command and await its result. */
  send(method: string, params: Record<string, unknown> = {}, signal: AbortSignal): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) {
      return Promise.reject(new LocalBrowserWebError('local-browser-web: CDP 连接已关闭', 'BROWSER_UNAVAILABLE'))
    }
    const id = this.next++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const onAbort = (): void => {
        this.pending.delete(id)
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Await one event by method name. */
  once(method: string, signal: AbortSignal): Promise<CdpMessage> {
    return new Promise<CdpMessage>((resolve, reject) => {
      const listener = (message: CdpMessage): void => {
        if (message.method !== method) return
        this.listeners.delete(listener)
        signal.removeEventListener('abort', onAbort)
        resolve(message)
      }
      const onAbort = (): void => {
        this.listeners.delete(listener)
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      this.listeners.add(listener)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Subscribe to every event; returns the disposer. */
  on(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Close the socket. */
  close(): void {
    this.socket?.close()
    this.socket = undefined
  }
}

/** The CDP backend the fetch provider and the `browser` engines both render through. */
export class CdpBrowser {
  /** Result of the last availability probe, so `available()` stays cheap. */
  private probe: { at: number, ok: boolean } | undefined

  /** @param options - the live connection/rendering options. */
  constructor(private readonly options: () => CdpOptions) {}

  /**
   * Cheap local usability check: probe `/json/version` with a short budget and
   * cache the answer, so a search call does not pay for it twice.
   * @returns whether a CDP endpoint answers.
   */
  async reachable(): Promise<boolean> {
    const cached = this.probe
    const now = Date.now()
    if (cached !== undefined && now - cached.at < 5_000) return cached.ok
    const { endpoint } = this.options()
    const ok = await this.probeEndpoint(endpoint)
    this.probe = { at: now, ok }
    return ok
  }

  /**
   * The last probe's verdict, without probing.
   *
   * The seam's `available()` must not make network calls, so it reads this cache
   * (optimistic until a probe has run and failed) while {@link reachable} warms
   * it in the background.
   * @returns the cached verdict, or undefined before the first probe.
   */
  cachedReachable(): boolean | undefined {
    return this.probe?.ok
  }

  private async probeEndpoint(endpoint: string): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 2_000)
    try {
      const response = await fetch(new URL('/json/version', ensureTrailingSlash(endpoint)), { signal: controller.signal })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Render one URL in the browser and read its DOM.
   * @param url - the page to load.
   * @param signal - caller cancellation.
   * @param waitFor - selectors a parser needs before the DOM is read (any match wins).
   * @returns final URL, main-document status, and rendered HTML.
   * @throws {LocalBrowserWebError} `BROWSER_UNAVAILABLE` / `WEB_FETCH_TIMEOUT`.
   */
  async render(url: string, signal?: AbortSignal, waitFor?: readonly string[]): Promise<RenderedPage> {
    const options = this.options()
    const endpoint = options.endpoint
    const browserVersion = await this.resolveVersion(endpoint, signal)

    return await within(async (inner) => {
      const browser = await CdpConnection.open(browserVersion, inner)
      let contextId: string | undefined
      let targetId: string | undefined
      try {
        // A proxy is per-context, so it forces a context even in `shared` mode.
        // Cookies do not survive that, which is the trade-off the panel documents:
        // a proxied render starts logged out. A target on the bypass list is *not*
        // proxied, so it keeps the shared profile — and the logins in it — instead
        // of paying that cost for nothing.
        const proxied = options.proxy !== undefined
          && !shouldBypass(new URL(url).hostname, options.proxy.bypass.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0))
        if (options.profileMode === 'isolated' || proxied) {
          const created = await browser.send('Target.createBrowserContext', options.proxy === undefined || !proxied
            ? {}
            : { proxyServer: options.proxy.server, proxyBypassList: options.proxy.bypass }, inner)
          contextId = typeof created['browserContextId'] === 'string' ? created['browserContextId'] : undefined
        }
        const created = await browser.send('Target.createTarget', {
          url: 'about:blank',
          ...contextId === undefined ? {} : { browserContextId: contextId },
        }, inner)
        targetId = typeof created['targetId'] === 'string' ? created['targetId'] : undefined
        if (targetId === undefined) throw new LocalBrowserWebError('local-browser-web: CDP 未返回 targetId', 'BROWSER_UNAVAILABLE')

        const page = await CdpConnection.open(pageSocketUrl(browserVersion, targetId), inner)
        try {
          await page.send('Page.enable', {}, inner)
          await page.send('Network.enable', {}, inner)
          // No override by default: the driven Chrome already presents the UA that
          // matches its own version, and an unfamiliar UA makes engines serve a
          // degraded, script-less page that renders to zero results.
          if (options.userAgent.length > 0) {
            await page.send('Network.setUserAgentOverride', { userAgent: options.userAgent }, inner)
          }

          let statusCode = 0
          const seen = page.on((message) => {
            if (message.method !== 'Network.responseReceived') return
            const type = Reflect.get(message.params ?? {}, 'type')
            const response = Reflect.get(message.params ?? {}, 'response')
            if (type !== 'Document' || response === null || typeof response !== 'object') return
            const status = Reflect.get(response, 'status')
            if (typeof status === 'number') statusCode = status
          })

          const loaded = page.once('Page.loadEventFired', inner)
          const navigation = await page.send('Page.navigate', { url }, inner)
          const frameId = Reflect.get(navigation, 'frameId')
          if (typeof Reflect.get(navigation, 'errorText') === 'string') {
            throw new LocalBrowserWebError(
              `local-browser-web: 导航失败 ${String(Reflect.get(navigation, 'errorText'))}（${url}）`,
              'WEB_FETCH_CHALLENGE',
            )
          }
          void frameId
          // Bound the load wait, then let the parser's own selectors decide when the
          // document is worth reading: a client-rendered SERP injects its list after
          // `loadEventFired`, so reading on the event alone yields an empty shell.
          await settlesFirst(loaded, PAGE_LOAD_GRACE_MS)
          if (waitFor !== undefined && waitFor.length > 0) await this.waitForSelectors(page, waitFor, inner)
          // Reading the DOM after load catches client-rendered result lists.
          await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, inner)
          const evaluated = await page.send('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
          }, inner)
          seen()
          const value = Reflect.get(Reflect.get(evaluated, 'result') ?? {}, 'value')
          const html = typeof value === 'string' ? value : ''
          const finalUrl = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, inner)
          const href = Reflect.get(Reflect.get(finalUrl, 'result') ?? {}, 'value')
          return { url: typeof href === 'string' ? href : url, statusCode, html }
        } finally {
          page.close()
        }
      } finally {
        if (targetId !== undefined) await browser.send('Target.closeTarget', { targetId }, inner).catch(() => undefined)
        if (contextId !== undefined) await browser.send('Target.disposeBrowserContext', { browserContextId: contextId }, inner).catch(() => undefined)
        browser.close()
      }
    }, options.timeoutMs, signal, () => new LocalBrowserWebError(
      `local-browser-web: CDP 渲染超时（${String(options.timeoutMs)}ms，${url}）`,
      'WEB_FETCH_TIMEOUT',
    ))
  }

  /**
   * Poll the live document until one of `selectors` matches.
   *
   * Waiting is best-effort: on timeout the caller reads whatever the DOM holds,
   * because a page that rendered slowly is still worth parsing.
   */
  private async waitForSelectors(page: CdpConnection, selectors: readonly string[], signal: AbortSignal): Promise<void> {
    const expression = `${JSON.stringify(selectors)}.some((selector) => document.querySelector(selector) !== null)`
    const deadline = Date.now() + SELECTOR_READY_MS
    while (Date.now() < deadline) {
      try {
        const probe = await page.send('Runtime.evaluate', { expression, returnByValue: true }, signal)
        if (Reflect.get(Reflect.get(probe, 'result') ?? {}, 'value') === true) return
      } catch (error) {
        if (signal.aborted) throw error
      }
      await new Promise((resolve) => { setTimeout(resolve, SELECTOR_POLL_MS) })
    }
  }

  /** Resolve the browser-level WebSocket URL from `/json/version`. */
  private async resolveVersion(endpoint: string, signal: AbortSignal | undefined): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 5_000)
    try {
      const response = await fetch(new URL('/json/version', ensureTrailingSlash(endpoint)), {
        signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
      })
      if (!response.ok) {
        throw new LocalBrowserWebError(
          `local-browser-web: CDP 端点返回 ${String(response.status)}（${endpoint}）`,
          'BROWSER_UNAVAILABLE',
        )
      }
      const body = await response.json() as { webSocketDebuggerUrl?: unknown }
      const socket = body.webSocketDebuggerUrl
      if (typeof socket !== 'string' || socket.length === 0) {
        throw new LocalBrowserWebError(`local-browser-web: CDP 未提供 webSocketDebuggerUrl（${endpoint}）`, 'BROWSER_UNAVAILABLE')
      }
      return socket
    } catch (error) {
      if (error instanceof LocalBrowserWebError) throw error
      throw new LocalBrowserWebError(
        `local-browser-web: 无法访问 CDP 端点 ${endpoint}，请以 --remote-debugging-port 启动 Chrome`,
        'BROWSER_UNAVAILABLE',
        { cause: error },
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Ensure an endpoint URL has a trailing slash so `new URL('/json/version', …)` composes cleanly. */
export function ensureTrailingSlash(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`
}

/** Derive a page-level WebSocket from the browser-level one. */
export function pageSocketUrl(browserSocket: string, targetId: string): string {
  const url = new URL(browserSocket)
  url.pathname = `/devtools/page/${targetId}`
  return url.toString()
}
