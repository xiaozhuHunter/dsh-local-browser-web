/**
 * Browser-control route tests: wire validation and the two actions.
 *
 * `handleBrowserControl` is exercised directly, so no web server is started.
 *
 * @module dsh-local-browser-web/tests/browser-control
 */
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { handleBrowserControl, type BrowserControlDeps } from '../src/server/browser-control.ts'
import type { LauncherIo } from '../src/browser/launcher.ts'

/** A request with one body chunk. */
function request(method: string, headers: Record<string, string>, body = ''): IncomingMessage {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  } as unknown as IncomingMessage
}

/** A response that records status, headers, and body. */
function response(): { res: ServerResponse, seen: { status: number, headers: Record<string, string>, body: string } } {
  const seen = { status: 200, headers: {} as Record<string, string>, body: '' }
  const res = {
    get statusCode() { return seen.status },
    set statusCode(value: number) { seen.status = value },
    setHeader(name: string, value: string) { seen.headers[name.toLowerCase()] = value },
    end(chunk?: string) { seen.body = chunk ?? '' },
  } as unknown as ServerResponse
  return { res, seen }
}

/** Settings the route reads. */
const settings = {
  endpoint: 'http://127.0.0.1:9222',
  chromePath: '',
  profileDir: '/tmp/profile',
  launchTimeoutMs: 3_000,
}

/** IO that finds no Chrome, for the launch path. */
const io: LauncherIo = {
  exists: () => false,
  ensureDir: () => {},
  spawnDetached: () => {},
  probe: async () => ({ reachable: false, elapsedMs: 1, error: 'ECONNREFUSED' }),
  sleep: async () => {},
}

/** Deps with a stubbed probe. */
function deps(reachable: boolean): BrowserControlDeps {
  return {
    settings: () => settings,
    io,
    probe: async () => reachable
      ? { reachable: true, elapsedMs: 1, browser: 'Chrome/156' }
      : { reachable: false, elapsedMs: 1, error: 'ECONNREFUSED' },
  }
}

describe('handleBrowserControl', () => {
  it('refuses a non-POST request', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('GET', {}), res, deps(true))
    assert.equal(seen.status, 405)
    assert.equal(seen.headers['allow'], 'POST')
  })

  it('refuses a non-JSON media type', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('POST', { 'content-type': 'text/plain' }, '{}'), res, deps(true))
    assert.equal(seen.status, 415)
  })

  it('refuses an unknown action', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('POST', { 'content-type': 'application/json' }, '{"action":"reboot"}'), res, deps(true))
    assert.equal(seen.status, 400)
  })

  it('answers status from the probe', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('POST', { 'content-type': 'application/json' }, '{"action":"status"}'), res, deps(true))
    assert.equal(seen.status, 200)
    const body = JSON.parse(seen.body) as { running: boolean, browser?: string, endpoint: string }
    assert.equal(body.running, true)
    assert.equal(body.browser, 'Chrome/156')
    assert.equal(body.endpoint, settings.endpoint)
    assert.equal(seen.headers['cache-control'], 'no-store')
  })

  it('reports an unreachable endpoint with a code', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('POST', { 'content-type': 'application/json' }, '{"action":"status"}'), res, deps(false))
    const body = JSON.parse(seen.body) as { running: boolean, code?: string }
    assert.equal(body.running, false)
    assert.equal(body.code, 'CDP_UNREACHABLE')
  })

  it('launches through the same verdict shape', async () => {
    const { res, seen } = response()
    await handleBrowserControl(request('POST', { 'content-type': 'application/json' }, '{"action":"launch"}'), res, deps(false))
    const body = JSON.parse(seen.body) as { ok: boolean, running: boolean, code?: string, searched: string[] }
    assert.equal(body.ok, false)
    assert.equal(body.code, 'CHROME_NOT_FOUND')
    assert.ok(Array.isArray(body.searched))
  })
})
