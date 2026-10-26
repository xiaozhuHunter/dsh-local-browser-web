/**
 * Launcher unit tests: detection, probing, and the launch verdict.
 *
 * Every test injects IO, so nothing here spawns a process or opens a socket.
 *
 * @module dsh-local-browser-web/tests/launcher
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chromeCandidates,
  defaultChromeProfileDir,
  ensureBrowserRunning,
  launchArgs,
  portOfEndpoint,
  probeCdp,
  type CdpProbeResult,
  type LauncherIo,
} from '../src/browser/launcher.ts'

/** One probe verdict. */
function verdict(reachable: boolean, browser?: string): CdpProbeResult {
  return reachable
    ? { reachable: true, elapsedMs: 1, ...browser === undefined ? {} : { browser } }
    : { reachable: false, elapsedMs: 1, error: 'ECONNREFUSED' }
}

/** IO that records spawns and replays a probe sequence (last entry repeats). */
function fakeIo(results: readonly CdpProbeResult[], paths: readonly string[] = []): LauncherIo & {
  spawns: { command: string, args: readonly string[] }[]
  dirs: string[]
} {
  const spawns: { command: string, args: readonly string[] }[] = []
  const dirs: string[] = []
  let index = 0
  return {
    spawns,
    dirs,
    exists: path => paths.includes(path),
    ensureDir: (path) => { dirs.push(path) },
    spawnDetached: (command, args) => { spawns.push({ command, args }) },
    probe: async () => {
      const next = results[Math.min(index, results.length - 1)]
      index += 1
      return next ?? verdict(false)
    },
    sleep: async () => {},
  }
}

describe('portOfEndpoint', () => {
  it('reads the explicit port', () => {
    assert.equal(portOfEndpoint('http://127.0.0.1:9222'), 9222)
    assert.equal(portOfEndpoint('http://127.0.0.1:9333/json/version'), 9333)
  })

  it('falls back to the scheme default', () => {
    assert.equal(portOfEndpoint('http://127.0.0.1'), 80)
    assert.equal(portOfEndpoint('https://127.0.0.1'), 443)
  })
})

describe('chromeCandidates', () => {
  it('lists the macOS app bundle first', () => {
    const candidates = chromeCandidates('darwin', {}, '/Users/me')
    assert.equal(candidates[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    assert.ok(candidates.includes('/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
  })

  it('walks the Windows install roots', () => {
    const candidates = chromeCandidates('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    }, 'C:\\Users\\me')
    assert.equal(candidates.length, 3)
    assert.ok(candidates.every(path => path.endsWith('Google\\Chrome\\Application\\chrome.exe')))
  })

  it('covers the common Linux launchers', () => {
    assert.ok(chromeCandidates('linux', {}, '/home/me').includes('/usr/bin/google-chrome-stable'))
  })
})

describe('defaultChromeProfileDir', () => {
  it('uses DSH_HOME when set', () => {
    assert.equal(
      defaultChromeProfileDir('darwin', { DSH_HOME: '/tmp/dsh-home' }, '/Users/me'),
      '/tmp/dsh-home/local-browser-web/chrome-profile',
    )
  })

  it('falls back to ~/.dsh', () => {
    assert.equal(
      defaultChromeProfileDir('darwin', {}, '/Users/me'),
      '/Users/me/.dsh/local-browser-web/chrome-profile',
    )
  })

  it('uses LOCALAPPDATA on Windows', () => {
    assert.equal(
      defaultChromeProfileDir('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me'),
      'C:\\Users\\me\\AppData\\Local\\dsh\\local-browser-web\\chrome-profile',
    )
  })
})

describe('launchArgs', () => {
  it('opens the port on a dedicated profile', () => {
    assert.deepEqual(launchArgs(9222, '/tmp/profile'), [
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/profile',
      '--no-first-run',
      '--no-default-browser-check',
    ])
  })
})

describe('probeCdp', () => {
  it('reads the version document', async () => {
    const fetcher = async (): Promise<Response> => new Response(JSON.stringify({
      Browser: 'Chrome/156.0.8078.48',
      'Protocol-Version': '1.3',
    }), { status: 200 })
    const result = await probeCdp('http://127.0.0.1:9222', 1_000, fetcher as typeof fetch)
    assert.equal(result.reachable, true)
    assert.equal(result.browser, 'Chrome/156.0.8078.48')
    assert.equal(result.protocol, '1.3')
  })

  it('reports an HTTP status without throwing', async () => {
    const fetcher = async (): Promise<Response> => new Response('nope', { status: 502 })
    const result = await probeCdp('http://127.0.0.1:9222', 1_000, fetcher as typeof fetch)
    assert.equal(result.reachable, false)
    assert.match(result.error ?? '', /502/u)
  })

  it('rejects an unparsable endpoint', async () => {
    const result = await probeCdp('not a url', 1_000, (async () => new Response('')) as typeof fetch)
    assert.equal(result.reachable, false)
    assert.match(result.error ?? '', /合法 URL/u)
  })
})

describe('ensureBrowserRunning', () => {
  it('reports an already-running Chrome without spawning', async () => {
    const io = fakeIo([verdict(true, 'Chrome/156')])
    const status = await ensureBrowserRunning({ endpoint: 'http://127.0.0.1:9222', timeoutMs: 3_000 }, io)
    assert.equal(status.running, true)
    assert.equal(status.launched, false)
    assert.equal(status.browser, 'Chrome/156')
    assert.equal(io.spawns.length, 0)
  })

  it('explains a miss with the paths it tried', async () => {
    const io = fakeIo([verdict(false)])
    const status = await ensureBrowserRunning({
      endpoint: 'http://127.0.0.1:9222',
      timeoutMs: 3_000,
      platform: 'linux',
    }, io)
    assert.equal(status.ok, false)
    assert.equal(status.code, 'CHROME_NOT_FOUND')
    assert.ok(status.searched.includes('/usr/bin/google-chrome'))
    assert.equal(io.spawns.length, 0)
  })

  it('spawns the resolved Chrome and waits for the port', async () => {
    const io = fakeIo([verdict(false), verdict(false), verdict(true, 'Chrome/156')], ['/usr/bin/google-chrome'])
    const status = await ensureBrowserRunning({
      endpoint: 'http://127.0.0.1:9222',
      timeoutMs: 5_000,
      platform: 'linux',
      profileDir: '/tmp/plugin-profile',
    }, io)
    assert.equal(status.running, true)
    assert.equal(status.launched, true)
    assert.equal(status.chromePath, '/usr/bin/google-chrome')
    assert.equal(io.spawns.length, 1)
    assert.equal(io.spawns[0]?.command, '/usr/bin/google-chrome')
    assert.deepEqual(io.spawns[0]?.args, launchArgs(9222, '/tmp/plugin-profile'))
    assert.deepEqual(io.dirs, ['/tmp/plugin-profile'])
  })

  it('prefers the configured executable', async () => {
    const io = fakeIo([verdict(false), verdict(true)], ['/opt/chrome', '/usr/bin/google-chrome'])
    const status = await ensureBrowserRunning({
      endpoint: 'http://127.0.0.1:9222',
      timeoutMs: 5_000,
      platform: 'linux',
      chromePath: '/opt/chrome',
      profileDir: '/tmp/p',
    }, io)
    assert.equal(status.chromePath, '/opt/chrome')
  })

  it('turns a spawn failure into a verdict', async () => {
    const io: LauncherIo = {
      ...fakeIo([verdict(false)], ['/usr/bin/google-chrome']),
      spawnDetached: () => { throw new Error('EACCES') },
    }
    const status = await ensureBrowserRunning({
      endpoint: 'http://127.0.0.1:9222',
      timeoutMs: 3_000,
      platform: 'linux',
      profileDir: '/tmp/p',
    }, io)
    assert.equal(status.ok, false)
    assert.equal(status.code, 'LAUNCH_FAILED')
    assert.match(status.message ?? '', /EACCES/u)
  })
})
