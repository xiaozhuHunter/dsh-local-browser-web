/**
 * Proxy parsing, bypass matching, and the two proxied transports.
 *
 * The transport tests do not touch the network: each one starts a stand-in proxy
 * (an HTTP server for absolute-form and a TCP server speaking SOCKS5) and asserts
 * what that proxy actually received. That is the point — "did the request go
 * through the proxy" is only answerable from the proxy's side.
 *
 * @module dsh-local-browser-web/tests/proxy
 */
import { strict as assert } from 'node:assert'
import http from 'node:http'
import net from 'node:net'
import { after, describe, it } from 'node:test'
import { validateConfig } from '../src/config.ts'
import { LocalBrowserWebError } from '../src/errors.ts'
import { httpGet } from '../src/http.ts'
import {
  browserProxyOf,
  httpProxyOf,
  parseBypass,
  parseProxyUrl,
  proxyFetch,
  shouldBypass,
} from '../src/proxy.ts'
import { makeConfig, rejection, thrown } from './helpers.ts'

/** Parse and require success, so a failed expectation surfaces as a test failure. */
function parsed(raw: string, bypass = ''): ReturnType<typeof parseProxyUrl> {
  return parseProxyUrl(raw, bypass)
}

/** The error a call threw, narrowed to the plugin's own type. */
function proxyError(raw: string): LocalBrowserWebError {
  const error = thrown(() => parseProxyUrl(raw))
  assert.ok(error instanceof LocalBrowserWebError, 'expected a LocalBrowserWebError')
  return error
}

describe('parseProxyUrl', () => {
  it('reads an explicit http proxy', () => {
    const spec = parsed('http://127.0.0.1:7890')
    assert.equal(spec.protocol, 'http')
    assert.equal(spec.hostname, '127.0.0.1')
    assert.equal(spec.port, 7890)
  })

  it('reads a bare host:port as HTTP', () => {
    // Proxy clients display their address without a scheme; rejecting that input
    // would make the field unusable for the common case.
    const spec = parsed('127.0.0.1:10809')
    assert.equal(spec.protocol, 'http')
    assert.equal(spec.port, 10809)
  })

  it('reads socks5 and its aliases', () => {
    assert.equal(parsed('socks5://127.0.0.1:7891').protocol, 'socks5')
    assert.equal(parsed('socks5h://127.0.0.1:7891').protocol, 'socks5')
    assert.equal(parsed('socks://127.0.0.1:7891').protocol, 'socks5')
  })

  it('falls back to the scheme default port', () => {
    assert.equal(parsed('http://proxy.local').port, 80)
    assert.equal(parsed('https://proxy.local').port, 443)
    assert.equal(parsed('socks5://proxy.local').port, 1080)
  })

  it('decodes credentials', () => {
    const spec = parsed('http://user%40name:p%40ss@127.0.0.1:7890')
    assert.equal(spec.username, 'user@name')
    assert.equal(spec.password, 'p@ss')
  })

  it('keeps the bypass list lowercased', () => {
    assert.deepEqual(parsed('127.0.0.1:7890', 'LocalHost, EXAMPLE.com').bypass, ['localhost', 'example.com'])
  })

  it('refuses an empty address', () => {
    assert.match(proxyError('').message, /url 为空/u)
  })

  it('refuses an unsupported scheme', () => {
    assert.match(proxyError('ftp://127.0.0.1:21').message, /不支持的代理协议/u)
  })

  it('refuses an unparsable address', () => {
    assert.equal(proxyError('http://').code, 'ENGINE_CONFIG_INVALID')
  })
})

describe('bypass matching', () => {
  it('splits on commas and whitespace', () => {
    assert.deepEqual(parseBypass(' a.com, b.com  c.com '), ['a.com', 'b.com', 'c.com'])
  })

  it('covers subdomains from a bare domain', () => {
    const list = parseBypass('example.com')
    assert.equal(shouldBypass('example.com', list), true)
    assert.equal(shouldBypass('www.example.com', list), true)
    assert.equal(shouldBypass('notexample.com', list), false)
  })

  it('accepts the wildcard and dot prefixes', () => {
    assert.equal(shouldBypass('anything.test', ['*']), true)
    assert.equal(shouldBypass('a.test', ['.test']), true)
    assert.equal(shouldBypass('a.test', ['*.test']), true)
  })

  it('matches loopback and IPv6 literals', () => {
    const list = parseBypass('localhost,127.0.0.1,::1')
    assert.equal(shouldBypass('127.0.0.1', list), true)
    assert.equal(shouldBypass('[::1]', list), true)
    assert.equal(shouldBypass('example.com', list), false)
  })
})

describe('transport selection', () => {
  const base = { enabled: true, url: 'http://127.0.0.1:7890', bypass: '', http: true, browser: true }

  it('returns nothing while disabled', () => {
    assert.equal(httpProxyOf({ ...base, enabled: false }), undefined)
    assert.equal(browserProxyOf({ ...base, enabled: false }), undefined)
  })

  it('honours the per-transport switches', () => {
    assert.equal(httpProxyOf({ ...base, http: false }), undefined)
    assert.notEqual(httpProxyOf({ ...base, browser: false }), undefined)
    assert.equal(browserProxyOf({ ...base, browser: false }), undefined)
    assert.notEqual(browserProxyOf({ ...base, http: false }), undefined)
  })

  it('returns nothing for an empty url even when enabled', () => {
    assert.equal(httpProxyOf({ ...base, url: '  ' }), undefined)
    assert.equal(browserProxyOf({ ...base, url: '  ' }), undefined)
  })

  it('builds the browser server string and drops credentials', () => {
    const proxy = browserProxyOf({ ...base, url: 'socks5://user:pass@127.0.0.1:7891', bypass: 'localhost' })
    assert.deepEqual(proxy, { server: 'socks5://127.0.0.1:7891', bypass: 'localhost' })
  })
})

describe('config validation', () => {
  // Every shipped engine's parser must be registered, or validation reports the
  // engine before it ever reaches the proxy check.
  const parsers = ['html-bing', 'html-ddg', 'html-baidu', 'html-google', 'html-so360', 'json-generic']

  it('accepts a usable proxy', () => {
    const config = makeConfig({
      proxy: { enabled: true, url: 'socks5://127.0.0.1:7891', bypass: 'localhost', http: true, browser: true },
    })
    assert.doesNotThrow(() => { validateConfig(config, parsers) })
  })

  it('refuses an unusable proxy at save time', () => {
    const config = makeConfig({
      proxy: { enabled: true, url: 'ftp://127.0.0.1:21', bypass: '', http: true, browser: true },
    })
    const error = thrown(() => { validateConfig(config, parsers) })
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
    assert.match(error.message, /代理配置无效/u)
  })
})

/** A stand-in HTTP proxy answering absolute-form requests with a canned page. */
async function startHttpProxy(): Promise<{ port: number, seen: string[], close: () => Promise<void> }> {
  const seen: string[] = []
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body>through the proxy</body></html>')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    seen,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/** A stand-in SOCKS5 server: greeting, optional auth, then a canned HTTP reply. */
async function startSocks5(options: { auth?: { user: string, pass: string }, reply?: number } = {}): Promise<{
  port: number
  requests: { host: string, port: number, user?: string, pass?: string }[]
  close: () => Promise<void>
}> {
  const requests: { host: string, port: number, user?: string, pass?: string }[] = []
  const server = net.createServer((socket) => {
    let stage: 'greeting' | 'auth' | 'request' | 'done' = 'greeting'
    let authUser: string | undefined
    socket.on('error', () => { socket.destroy() })
    socket.on('data', (chunk) => {
      if (stage === 'greeting') {
        const wantsAuth = options.auth !== undefined
        socket.write(Buffer.from([0x05, wantsAuth ? 0x02 : 0x00]))
        stage = wantsAuth ? 'auth' : 'request'
        return
      }
      if (stage === 'auth') {
        const userLength = chunk[1] ?? 0
        authUser = chunk.subarray(2, 2 + userLength).toString('utf8')
        const passLength = chunk[2 + userLength] ?? 0
        const pass = chunk.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8')
        requests.push({ host: '', port: 0, user: authUser, pass })
        socket.write(Buffer.from([0x01, 0x00]))
        stage = 'request'
        return
      }
      if (stage === 'request') {
        const hostLength = chunk[4] ?? 0
        const host = chunk.subarray(5, 5 + hostLength).toString('utf8')
        const port = ((chunk[5 + hostLength] ?? 0) << 8) | (chunk[6 + hostLength] ?? 0)
        requests.push({ host, port, ...authUser === undefined ? {} : { user: authUser } })
        socket.write(Buffer.from([0x05, options.reply ?? 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        if ((options.reply ?? 0x00) === 0x00) {
          const body = 'through socks'
          socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${String(body.length)}\r\nConnection: close\r\n\r\n${body}`)
        }
        stage = 'done'
      }
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    requests,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

describe('proxyFetch', () => {
  it('sends an absolute-form request through an HTTP proxy', async () => {
    const proxy = await startHttpProxy()
    after(async () => { await proxy.close() })
    const spec = parsed(`http://127.0.0.1:${String(proxy.port)}`)
    const response = await proxyFetch(new URL('http://example.com/search?q=1'), { spec })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /through the proxy/u)
    // The proxy saw the absolute target, which is what proves the egress changed.
    assert.deepEqual(proxy.seen, ['http://example.com/search?q=1'])
  })

  it('tunnels a plain HTTP target through SOCKS5', async () => {
    const socks = await startSocks5()
    after(async () => { await socks.close() })
    const spec = parsed(`socks5://127.0.0.1:${String(socks.port)}`)
    const response = await proxyFetch(new URL('http://example.com/x'), { spec })
    assert.match(await response.text(), /through socks/u)
    assert.deepEqual(socks.requests.map(entry => `${entry.host}:${String(entry.port)}`), ['example.com:80'])
  })

  it('authenticates a SOCKS5 proxy when credentials are configured', async () => {
    const socks = await startSocks5({ auth: { user: 'u', pass: 'p' } })
    after(async () => { await socks.close() })
    const spec = parsed(`socks5://u:p@127.0.0.1:${String(socks.port)}`)
    const response = await proxyFetch(new URL('http://example.com/x'), { spec })
    assert.equal(response.status, 200)
    assert.ok(socks.requests.some(entry => entry.user === 'u' && entry.pass === 'p'))
  })

  it('reports a SOCKS5 refusal instead of a generic failure', async () => {
    const socks = await startSocks5({ reply: 0x05 })
    after(async () => { await socks.close() })
    const spec = parsed(`socks5://127.0.0.1:${String(socks.port)}`)
    const error = await rejection(async () => await proxyFetch(new URL('http://example.com/x'), { spec }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
    assert.match(error.message, /目标拒绝连接/u)
  })

  it('connects directly for a bypassed host', async () => {
    // A bypassed target must not touch the proxy at all: the proxy list stays empty.
    const proxy = await startHttpProxy()
    after(async () => { await proxy.close() })
    const origin = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('direct hit')
    })
    await new Promise<void>(resolve => { origin.listen(0, '127.0.0.1', resolve) })
    after(async () => { await new Promise<void>(resolve => { origin.close(() => { resolve() }) }) })
    const address = origin.address()
    const originPort = typeof address === 'object' && address !== null ? address.port : 0
    const spec = parsed(`http://127.0.0.1:${String(proxy.port)}`, '127.0.0.1')
    const response = await proxyFetch(new URL(`http://127.0.0.1:${String(originPort)}/`), { spec })
    assert.match(await response.text(), /direct hit/u)
    assert.deepEqual(proxy.seen, [])
  })

  it('carries the proxy into httpGet, caps included', async () => {
    const proxy = await startHttpProxy()
    after(async () => { await proxy.close() })
    const result = await httpGet({
      url: 'http://example.com/page',
      limits: { timeoutMs: 5_000, maxResponseBytes: 100_000, maxBodyChars: 100_000, maxRedirects: 2, userAgent: 'test' },
      proxy: parsed(`http://127.0.0.1:${String(proxy.port)}`),
    })
    assert.equal(result.statusCode, 200)
    assert.match(result.body, /through the proxy/u)
    // A constructed response reports no URL, so httpGet falls back to the target.
    assert.equal(result.url, 'http://example.com/page')
    assert.deepEqual(proxy.seen, ['http://example.com/page'])
  })

  it('maps an unreachable proxy to a fetch failure', async () => {
    const spec = parsed('http://127.0.0.1:1')
    const error = await rejection(async () => await proxyFetch(new URL('http://example.com/x'), { spec }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
  })
})
