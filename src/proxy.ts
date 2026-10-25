/**
 * Outbound proxy support for both transports the plugin uses.
 *
 * There are two independent egress paths, and an upstream proxy has to reach both
 * or it is useless in practice (a user who needs a proxy to reach Google needs it
 * for the HTTP engines *and* for the browser renders):
 *
 * - **HTTP** — {@link proxyFetch} speaks to the proxy itself instead of the origin:
 *   absolute-form requests for plain targets, a `CONNECT` tunnel for TLS targets,
 *   and a SOCKS5 handshake for `socks5://`. It answers with a real `Response`, so
 *   `http.ts` keeps one code path for caps, redirects, and content-type checks.
 * - **Browser** — {@link browserProxyOf} produces the `proxyServer` /
 *   `proxyBypassList` pair a browser context accepts. Chrome exposes no
 *   browser-wide proxy command, so a proxied render always runs in a browser
 *   context created for it (see `browser/cdp.ts`).
 *
 * Node's global `fetch` (undici) does not honour `HTTP_PROXY`, and its
 * `ProxyAgent` is not importable from Node's internals, so the HTTP path is built
 * on `node:http` / `node:https` / `node:net` / `node:tls` — no added dependency.
 *
 * @module dsh-local-browser-web/proxy
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { LocalBrowserWebError } from './errors.ts'

/** Proxy schemes the config accepts. `socks5h` and `socks` normalise to `socks5`. */
export type ProxyProtocol = 'http' | 'https' | 'socks5'

/** The `proxy` config group, as a plain snapshot. */
export interface ProxyConfig {
  /** Master switch. Off means every transport connects directly. */
  enabled: boolean
  /** Proxy address: `http://127.0.0.1:7890`, `socks5://127.0.0.1:7891`, or bare `127.0.0.1:7890`. */
  url: string
  /** Comma/space separated hosts that must still connect directly. */
  bypass: string
  /** Apply the proxy to HTTP-kind engines and the `http` fetch backend. */
  http: boolean
  /** Apply the proxy to browser renders (CDP / Playwright). */
  browser: boolean
}

/** One parsed proxy endpoint. */
export interface ProxySpec {
  protocol: ProxyProtocol
  hostname: string
  port: number
  username?: string
  password?: string
  /** Lowercased bypass entries, in config order. */
  bypass: string[]
}

/** Default port per scheme, so `http://proxy` and `socks5://proxy` both work. */
const DEFAULT_PORTS: Record<ProxyProtocol, number> = { http: 80, https: 443, socks5: 1080 }

/** SOCKS5 reply codes, for an error message that names the actual refusal. */
const SOCKS5_REPLIES: Record<number, string> = {
  1: '代理内部错误',
  2: '代理规则不允许该连接',
  3: '网络不可达',
  4: '主机不可达',
  5: '目标拒绝连接',
  6: 'TTL 过期',
  7: '不支持的命令',
  8: '不支持的地址类型',
}

/** Map a config scheme string onto a transport the implementation speaks. */
function protocolOf(raw: string): ProxyProtocol | undefined {
  switch (raw) {
    case 'http:': return 'http'
    case 'https:': return 'https'
    case 'socks:':
    case 'socks5:':
    case 'socks5h:':
    case 'socks4:':
    case 'socks4a:':
      // socks4 is not implemented; naming it socks5 keeps the failure at the
      // handshake (a clear "不支持" from the proxy) rather than at parse time.
      return 'socks5'
    default: return undefined
  }
}

/** Split a bypass string into its entries. */
export function parseBypass(bypass: string): string[] {
  return bypass
    .split(/[\s,]+/u)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0)
}

/**
 * Parse one configured proxy address.
 *
 * A bare `host:port` is accepted and read as HTTP — that is how proxy clients
 * display their address, so requiring a scheme would reject the common input.
 *
 * @param raw - the configured address.
 * @param bypass - the configured bypass list.
 * @returns the parsed endpoint.
 * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` when the address cannot be used.
 */
export function parseProxyUrl(raw: string, bypass = ''): ProxySpec {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new LocalBrowserWebError('local-browser-web: 代理已启用但 url 为空', 'ENGINE_CONFIG_INVALID')
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch (error) {
    throw new LocalBrowserWebError(`local-browser-web: 代理地址无法解析（${raw}）`, 'ENGINE_CONFIG_INVALID', { cause: error })
  }
  const protocol = protocolOf(url.protocol)
  if (protocol === undefined) {
    throw new LocalBrowserWebError(
      `local-browser-web: 不支持的代理协议 ${url.protocol}//（仅 http / https / socks5）`,
      'ENGINE_CONFIG_INVALID',
    )
  }
  if (url.hostname.length === 0) {
    throw new LocalBrowserWebError(`local-browser-web: 代理地址缺少主机名（${raw}）`, 'ENGINE_CONFIG_INVALID')
  }
  const explicitPort = url.port.length > 0 ? Number(url.port) : undefined
  const port = explicitPort ?? DEFAULT_PORTS[protocol]
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new LocalBrowserWebError(`local-browser-web: 代理端口非法（${raw}）`, 'ENGINE_CONFIG_INVALID')
  }
  const username = url.username.length > 0 ? decodeURIComponent(url.username) : undefined
  const password = url.password.length > 0 ? decodeURIComponent(url.password) : undefined
  return {
    protocol,
    hostname: url.hostname.replace(/^\[|\]$/gu, ''),
    port,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    bypass: parseBypass(bypass),
  }
}

/**
 * Whether a host must bypass the proxy.
 *
 * Matching is suffix-based so `example.com` covers `www.example.com`, which is how
 * every proxy client's no-proxy list behaves. `*` bypasses everything, and the
 * loopback names the plugin itself talks to (CDP, local relays) are matched
 * literally.
 *
 * @param hostname - the target host.
 * @param bypass - bypass entries from {@link parseBypass}.
 * @returns whether to connect directly.
 */
export function shouldBypass(hostname: string, bypass: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  for (const entry of bypass) {
    if (entry === '*') return true
    const bare = entry.replace(/^\*?\./u, '')
    if (host === bare || host.endsWith(`.${bare}`)) return true
  }
  return false
}

/** The proxy an HTTP request uses, or undefined when the `http` flag is off. */
export function httpProxyOf(config: ProxyConfig): ProxySpec | undefined {
  if (!config.enabled || !config.http || config.url.trim().length === 0) return undefined
  return parseProxyUrl(config.url, config.bypass)
}

/**
 * The proxy a browser context uses, or undefined when the `browser` flag is off.
 *
 * Credentials are deliberately dropped: Chrome's per-context proxy takes a bare
 * `scheme://host:port`, and passing userinfo in it is silently ignored rather than
 * authenticated. The panel and README say so instead of pretending otherwise.
 *
 * @param config - the proxy config group.
 * @returns the `proxyServer` / `proxyBypassList` pair, or undefined.
 */
export function browserProxyOf(config: ProxyConfig): { server: string, bypass: string } | undefined {
  if (!config.enabled || !config.browser || config.url.trim().length === 0) return undefined
  const spec = parseProxyUrl(config.url, config.bypass)
  const scheme = spec.protocol === 'https' ? 'https' : spec.protocol === 'socks5' ? 'socks5' : 'http'
  return { server: `${scheme}://${spec.hostname}:${String(spec.port)}`, bypass: spec.bypass.join(',') }
}

/** What {@link proxyFetch} needs from the caller. */
export interface ProxyFetchInit {
  /** The parsed proxy endpoint. */
  spec: ProxySpec
  /** Request headers; `host` is set by this module. */
  headers?: Record<string, string>
  /** Caller cancellation plus the caller's own timeout. */
  signal?: AbortSignal
}

/** Raised when an abort arrives, so the caller's timeout/abort mapping is preserved. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('aborted')
}

/** Settle a promise that must also fail on abort. */
async function guard<T>(promise: Promise<T>, signal: AbortSignal | undefined, cleanup: () => void): Promise<T> {
  if (signal === undefined) return await promise
  if (signal.aborted) {
    cleanup()
    throw abortReason(signal)
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(abortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Read the proxy's handshake replies without disturbing what follows.
 *
 * The reader works on a **paused** socket and pulls with `read(n)`, so bytes that
 * arrive after the handshake (a proxy may send the origin's first bytes in the
 * same packet) stay in the socket's own buffer and are still there when
 * `http.request` takes the socket over. Consuming with `on('data')` and then
 * pushing the surplus back would race the request that follows.
 */
class SocketReader {
  constructor(private readonly socket: net.Socket) {
    socket.pause()
  }

  /** Await more bytes, or fail on end/error/abort. */
  private waitForData(signal: AbortSignal | undefined): Promise<void> {
    const arrival = new Promise<void>((resolve, reject) => {
      const onReadable = (): void => { cleanup(); resolve() }
      const onEnd = (): void => { cleanup(); reject(new Error('proxy closed the connection')) }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        this.socket.off('readable', onReadable)
        this.socket.off('end', onEnd)
        this.socket.off('error', onError)
      }
      this.socket.on('readable', onReadable)
      this.socket.once('end', onEnd)
      this.socket.once('error', onError)
    })
    return guard(arrival, signal, () => { this.socket.destroy() })
  }

  /** Take exactly `count` bytes off the stream. */
  async take(count: number, signal: AbortSignal | undefined): Promise<Buffer> {
    for (;;) {
      if (this.socket.readableLength >= count) {
        const taken = this.socket.read(count) as Buffer | null
        if (taken !== null) return taken
      }
      await this.waitForData(signal)
    }
  }

  /** Leave the socket paused; whatever it still buffers belongs to the request. */
  release(): void {
    this.socket.pause()
  }
}

/** Connect a plain TCP socket to the proxy. */
async function connectToProxy(spec: ProxySpec, signal: AbortSignal | undefined): Promise<net.Socket> {
  const socket = net.connect({ host: spec.hostname, port: spec.port })
  await guard(new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => { socket.off('connect', onConnect); socket.off('error', onError) }
    const onConnect = (): void => { cleanup(); resolve() }
    socket.once('connect', onConnect)
    socket.once('error', onError)
  }), signal, () => { socket.destroy() })
  socket.setNoDelay(true)
  return socket
}

/** Perform the SOCKS5 greeting, optional username/password auth, and CONNECT. */
async function socks5Tunnel(spec: ProxySpec, host: string, port: number, signal: AbortSignal | undefined): Promise<net.Socket> {
  const socket = await connectToProxy(spec, signal)
  const reader = new SocketReader(socket)
  const wantsAuth = spec.username !== undefined
  const fail = (message: string): never => {
    socket.destroy()
    throw new LocalBrowserWebError(`local-browser-web: ${message}（socks5 ${spec.hostname}:${String(spec.port)}）`, 'WEB_FETCH_CHALLENGE')
  }
  socket.write(Buffer.from([0x05, wantsAuth ? 0x02 : 0x01, 0x00, ...wantsAuth ? [0x02] : []]))
  const greeting = await reader.take(2, signal)
  if (greeting[0] !== 0x05) fail('代理不是 SOCKS5')
  const method = greeting[1]
  if (method === 0xff) fail('代理拒绝可用的认证方式')
  if (method === 0x02) {
    const username = Buffer.from(spec.username ?? '', 'utf8')
    const password = Buffer.from(spec.password ?? '', 'utf8')
    socket.write(Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]))
    const auth = await reader.take(2, signal)
    if (auth[1] !== 0x00) fail('代理认证失败（用户名/密码）')
  }
  // Address type 0x03 (domain) lets the proxy resolve, which is what a proxied
  // egress usually wants and the only form that works for names resolvable
  // nowhere else.
  const name = Buffer.from(host, 'utf8')
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]))
  const head = await reader.take(4, signal)
  const reply = head[1] ?? -1
  if (reply !== 0x00) fail(`代理拒绝连接：${SOCKS5_REPLIES[reply] ?? `错误码 ${String(reply)}`}`)
  const addressType = head[3]
  const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : (await reader.take(1, signal))[0] ?? 0
  await reader.take(addressLength + 2, signal)
  reader.release()
  return socket
}

/** Open a tunnelled raw socket to `host:port` through an HTTP(S) proxy. */
async function httpTunnel(spec: ProxySpec, host: string, port: number, signal: AbortSignal | undefined): Promise<net.Socket> {
  const transport = spec.protocol === 'https' ? https : http
  const authority = `${host}:${String(port)}`
  const request = transport.request({
    host: spec.hostname,
    port: spec.port,
    method: 'CONNECT',
    path: authority,
    headers: {
      host: authority,
      ...spec.username === undefined
        ? {}
        : { 'proxy-authorization': `Basic ${Buffer.from(`${spec.username}:${spec.password ?? ''}`).toString('base64')}` },
    },
  })
  return await guard(new Promise<net.Socket>((resolve, reject) => {
    request.once('connect', (response, tunnel) => {
      if (response.statusCode !== 200) {
        tunnel.destroy()
        reject(new LocalBrowserWebError(
          `local-browser-web: 代理拒绝 CONNECT ${authority}（HTTP ${String(response.statusCode ?? 0)}）`,
          'WEB_FETCH_CHALLENGE',
        ))
        return
      }
      tunnel.setNoDelay(true)
      resolve(tunnel)
    })
    request.once('error', reject)
    request.end()
  }), signal, () => { request.destroy() })
}

/** Build the `Headers` a proxied response carries. */
function headersOf(response: http.IncomingMessage): Headers {
  const headers = new Headers()
  const raw = response.rawHeaders
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (name === undefined || value === undefined) continue
    headers.append(name, value)
  }
  return headers
}

/** Project a Node response into the wintertc `Response` the HTTP path consumes. */
function toResponse(response: http.IncomingMessage): Response {
  const status = response.statusCode ?? 0
  const headers = headersOf(response)
  if (status === 204 || status === 205 || status === 304) {
    response.resume()
    return new Response(null, { status, headers })
  }
  const body = Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

/**
 * Run one GET through the proxy.
 *
 * @param target - the absolute target URL (already SSRF-checked by the caller).
 * @param init - proxy endpoint, extra headers, and cancellation.
 * @returns a `Response` whose body is the proxied origin's body.
 * @throws {LocalBrowserWebError} `WEB_FETCH_CHALLENGE` when the proxy refuses or is unreachable.
 */
export async function proxyFetch(target: URL, init: ProxyFetchInit): Promise<Response> {
  const { spec, signal } = init
  if (shouldBypass(target.hostname, spec.bypass)) {
    return await fetch(target, {
      redirect: 'manual',
      ...signal === undefined ? {} : { signal },
      ...init.headers === undefined ? {} : { headers: init.headers },
    })
  }

  const host = target.hostname.replace(/^\[|\]$/gu, '')
  const port = target.port.length > 0 ? Number(target.port) : target.protocol === 'https:' ? 443 : 80
  const headers: Record<string, string> = { ...init.headers, host: target.host }
  const path = `${target.pathname}${target.search}`

  // Case 1: plain HTTP through an HTTP(S) proxy — absolute-form request, no tunnel,
  // which is what every proxy implementation accepts for cleartext traffic.
  if (target.protocol === 'http:' && spec.protocol !== 'socks5') {
    const transport = spec.protocol === 'https' ? https : http
    const request = transport.request({
      host: spec.hostname,
      port: spec.port,
      method: 'GET',
      path: target.href,
      headers: {
        ...headers,
        ...spec.username === undefined
          ? {}
          : { 'proxy-authorization': `Basic ${Buffer.from(`${spec.username}:${spec.password ?? ''}`).toString('base64')}` },
      },
      ...signal === undefined ? {} : { signal },
    })
    return await responseOf(request, signal)
  }

  // Case 2/3: TLS through any proxy (CONNECT or SOCKS5), and any target through
  // SOCKS5. Both end as a raw duplex socket toward the origin.
  const tunnel = spec.protocol === 'socks5'
    ? await socks5Tunnel(spec, host, port, signal)
    : await httpTunnel(spec, host, port, signal)
  const stream = target.protocol === 'https:'
    ? await guard(new Promise<tls.TLSSocket>((resolve, reject) => {
      const secured = tls.connect({ socket: tunnel, servername: host, ALPNProtocols: ['http/1.1'] }, () => { resolve(secured) })
      secured.once('error', reject)
    }), signal, () => { tunnel.destroy() })
    : tunnel

  // `http.request` is used for both schemes: it writes the request onto whatever
  // duplex it is given, so a TLSSocket needs no separate client. The agent is
  // created per request because the socket *is* the tunnel — a reused agent would
  // hand a second request the same, already-consumed stream. `createConnection`
  // must also invoke the callback: the agent waits for it even when a socket is
  // already returned.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = ((_options: unknown, callback: (error: Error | null, socket?: net.Socket) => void) => {
    callback(null, stream as net.Socket)
    return stream as net.Socket
  }) as typeof agent.createConnection
  const request = http.request({
    host,
    port,
    method: 'GET',
    path,
    headers,
    agent,
    ...signal === undefined ? {} : { signal },
  })
  request.once('close', () => { agent.destroy() })
  // The tunnel socket is paused (the handshake read it in paused mode) and a
  // socket handed to the client in that state never flows: Node attaches its
  // parser but does not resume. Resuming on the next tick lets the client attach
  // first, so bytes the proxy already buffered are parsed, not lost.
  process.nextTick(() => {
    if (!stream.destroyed) stream.resume()
  })
  return await responseOf(request, signal)
}

/** Send a request and project its response, destroying the socket on abort. */
async function responseOf(request: http.ClientRequest, signal: AbortSignal | undefined): Promise<Response> {
  const onAbort = (): void => { request.destroy(abortReason(signal)) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request.once('response', resolve)
      request.once('error', (error: Error) => {
        reject(error instanceof LocalBrowserWebError
          ? error
          : new LocalBrowserWebError(`local-browser-web: 代理请求失败（${error.message}）`, 'WEB_FETCH_CHALLENGE', { cause: error }))
      })
      request.end()
    })
    return toResponse(response)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
