/**
 * Detect and, when asked, start the Chrome that serves the CDP endpoint.
 *
 * The plugin never pretends it can render without a browser: `cdp` fetches and
 * `browser` engines need a Chrome listening on the configured port. This module is
 * what turns that requirement into a one-click action instead of a manual
 * `--remote-debugging-port` command:
 *
 * 1. probe the endpoint (`GET /json/version`) — cheap, safe, idempotent;
 * 2. if absent, resolve a Chrome executable and spawn it detached with a
 *    plugin-owned `--user-data-dir`;
 * 3. poll until the port answers, so the caller gets a verdict rather than a
 *    "started, maybe".
 *
 * Chrome 136+ refuses remote debugging on the default data directory, so the
 * dedicated profile is not a preference — it is the only way the port opens.
 *
 * @module dsh-local-browser-web/browser/launcher
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'

/** Outcome of one CDP probe. */
export interface CdpProbeResult {
  /** Whether `/json/version` answered with a JSON document. */
  reachable: boolean
  /** Reported browser string, e.g. `Chrome/156.0.8078.48`. */
  browser?: string
  /** Reported DevTools protocol version, e.g. `1.3`. */
  protocol?: string
  /** Why the probe failed, when it did. */
  error?: string
  /** Wall time the probe took. */
  elapsedMs: number
}

/** What the settings panel renders after a check or a launch. */
export interface BrowserStatus {
  /** Whether the endpoint is reachable now. */
  ok: boolean
  /** Same as `ok`, spelled for the panel's status pill. */
  running: boolean
  /** The endpoint that was probed. */
  endpoint: string
  /** Browser string reported by CDP, when reachable. */
  browser?: string
  /** Executable the launch resolved, when one was found. */
  chromePath?: string
  /** Profile directory the launch would use (or the running one used). */
  profileDir: string
  /** Whether this call spawned a process. */
  launched: boolean
  /** Machine-readable failure, when `ok` is false. */
  code?: 'CDP_UNREACHABLE' | 'CHROME_NOT_FOUND' | 'LAUNCH_FAILED' | 'ENDPOINT_INVALID'
  /** Human-readable failure detail, already prefixed for display. */
  message?: string
  /** Candidate executables that were checked, so a miss is diagnosable. */
  searched: string[]
}

/** IO the launcher needs, injected so tests never spawn or touch the network. */
export interface LauncherIo {
  /** Whether a path exists. */
  exists(path: string): boolean
  /** Create a directory tree (the profile dir). */
  ensureDir(path: string): void
  /** Start a detached process whose lifetime outlives this plugin. */
  spawnDetached(command: string, args: readonly string[]): void
  /** Probe one endpoint. */
  probe(endpoint: string, timeoutMs: number): Promise<CdpProbeResult>
  /** Wait between probes. */
  sleep(ms: number): Promise<void>
}

/** Default probe budget: a local port answers in milliseconds or not at all. */
const PROBE_TIMEOUT_MS = 4_000
/** Poll interval while waiting for a freshly spawned Chrome. */
const POLL_INTERVAL_MS = 250

/** The real IO: node child_process, fs, and fetch. */
export const defaultLauncherIo: LauncherIo = {
  exists: path => existsSync(path),
  ensureDir: (path) => {
    mkdirSync(path, { recursive: true })
  },
  spawnDetached: (command, args) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.unref()
  },
  probe: (endpoint, timeoutMs) => probeCdp(endpoint, timeoutMs),
  sleep: ms => new Promise(resolve => { setTimeout(resolve, ms) }),
}

/** Probe `GET <endpoint>/json/version`. Never throws. */
export async function probeCdp(
  endpoint: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): Promise<CdpProbeResult> {
  const started = Date.now()
  let versionUrl: string
  try {
    versionUrl = new URL('/json/version', ensureTrailingSlash(endpoint)).toString()
  } catch {
    return { reachable: false, error: `CDP 端点不是合法 URL：${endpoint}`, elapsedMs: Date.now() - started }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetcher(versionUrl, { signal: controller.signal })
    if (!response.ok) {
      return { reachable: false, error: `HTTP ${String(response.status)}`, elapsedMs: Date.now() - started }
    }
    const body = await response.json() as { Browser?: unknown, 'Protocol-Version'?: unknown }
    if (typeof body !== 'object' || body === null) {
      return { reachable: false, error: '响应不是 DevTools 版本对象', elapsedMs: Date.now() - started }
    }
    return {
      reachable: true,
      ...typeof body.Browser === 'string' ? { browser: body.Browser } : {},
      ...typeof body['Protocol-Version'] === 'string' ? { protocol: body['Protocol-Version'] } : {},
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      reachable: false,
      error: aborted ? `探测超时（${String(timeoutMs)}ms）` : error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The port a CDP endpoint names; 9222 when the URL omits one. */
export function portOfEndpoint(endpoint: string): number {
  const url = new URL(endpoint)
  if (url.port.length > 0) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * Chrome executables to try, in order, for one platform.
 *
 * Only well-known install locations are listed. A user whose Chrome lives
 * elsewhere sets `chromePath` in the panel, which is tried before this list.
 */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]
      .filter((root): root is string => root !== undefined && root.length > 0)
    // `win32.join` keeps the separators right even when this runs on a POSIX host
    // (tests do exactly that); on Windows it is the same result as `join`.
    return roots.map(root => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

/**
 * The profile directory the launched Chrome uses.
 *
 * Plugin-owned on purpose: Chrome 136+ ignores `--remote-debugging-port` on the
 * default profile, and reusing the everyday profile would also fight a running
 * Chrome for the same lock.
 */
export function defaultChromeProfileDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dshHome = env['DSH_HOME'] ?? join(home, '.dsh')
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] ?? win32.join(home, 'AppData', 'Local')
    return win32.join(base, 'dsh', 'local-browser-web', 'chrome-profile')
  }
  return join(dshHome, 'local-browser-web', 'chrome-profile')
}

/** Arguments a one-click launch passes to Chrome. */
export function launchArgs(port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
}

/** Inputs one ensure call needs. */
export interface EnsureOptions {
  /** The configured CDP endpoint. */
  endpoint: string
  /** Explicit executable from the panel; empty means "detect". */
  chromePath?: string
  /** Explicit profile dir from the panel; empty means "plugin-owned default". */
  profileDir?: string
  /** How long to wait for a spawned Chrome to answer. */
  timeoutMs: number
  /** Platform, environment, and home for detection (overridable in tests). */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

/**
 * Report the endpoint's state, and start Chrome when it is absent.
 *
 * @param options - endpoint, overrides, and the wait budget.
 * @param io - IO seam (real by default).
 * @returns the post-action status; never throws for an expected failure.
 */
export async function ensureBrowserRunning(
  options: EnsureOptions,
  io: LauncherIo = defaultLauncherIo,
): Promise<BrowserStatus> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const profileDir = options.profileDir !== undefined && options.profileDir.trim().length > 0
    ? options.profileDir.trim()
    : defaultChromeProfileDir(platform, env, home)
  const base = { endpoint: options.endpoint, profileDir, launched: false, searched: [] as string[] }

  const first = await io.probe(options.endpoint, PROBE_TIMEOUT_MS)
  if (first.reachable) {
    return {
      ...base,
      ok: true,
      running: true,
      ...first.browser === undefined ? {} : { browser: first.browser },
      ...options.chromePath !== undefined && options.chromePath.trim().length > 0
        ? { chromePath: options.chromePath.trim() }
        : {},
    }
  }

  let port: number
  try {
    port = portOfEndpoint(options.endpoint)
  } catch {
    return { ...base, ok: false, running: false, code: 'ENDPOINT_INVALID', message: `CDP 端点不是合法 URL：${options.endpoint}` }
  }

  const explicit = options.chromePath?.trim()
  const candidates = explicit !== undefined && explicit.length > 0
    ? [explicit, ...chromeCandidates(platform, env, home).filter(path => path !== explicit)]
    : chromeCandidates(platform, env, home)
  const found = candidates.find(path => io.exists(path))
  if (found === undefined) {
    return {
      ...base,
      ok: false,
      running: false,
      code: 'CHROME_NOT_FOUND',
      message: '未找到 Google Chrome；请在下方填写 Chrome 可执行文件路径，或自行启动带调试端口的 Chrome。',
      searched: candidates,
    }
  }

  try {
    io.ensureDir(profileDir)
    io.spawnDetached(found, launchArgs(port, profileDir))
  } catch (error) {
    return {
      ...base,
      ok: false,
      running: false,
      chromePath: found,
      code: 'LAUNCH_FAILED',
      message: `启动 Chrome 失败：${error instanceof Error ? error.message : String(error)}`,
      searched: candidates,
    }
  }

  const deadline = Date.now() + Math.max(options.timeoutMs, PROBE_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await io.sleep(POLL_INTERVAL_MS)
    const probe = await io.probe(options.endpoint, PROBE_TIMEOUT_MS)
    if (probe.reachable) {
      return {
        ...base,
        ok: true,
        running: true,
        launched: true,
        chromePath: found,
        ...probe.browser === undefined ? {} : { browser: probe.browser },
      }
    }
  }

  return {
    ...base,
    ok: false,
    running: false,
    launched: true,
    chromePath: found,
    code: 'LAUNCH_FAILED',
    message: '已启动 Chrome，但调试端口未在预算时间内响应。若同一数据目录已有 Chrome 在运行，请先完全退出它再重试。',
    searched: candidates,
  }
}

/** Whether a configured path is usable as an absolute executable path. */
export function isAbsoluteExecutablePath(path: string): boolean {
  return path.trim().length > 0 && isAbsolute(path.trim())
}

/** Append the separator `new URL('/json/version', base)` expects. */
function ensureTrailingSlash(endpoint: string): string {
  return endpoint.endsWith('/') ? endpoint : `${endpoint}/`
}
