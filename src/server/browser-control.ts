/**
 * The settings panel's browser-control endpoint.
 *
 * A third-party plugin cannot add a Typert Remote namespace: `api-remotes` mounts
 * an explicit, build-time list of contributions, so a new namespace would require
 * editing DSH itself. A named route on the composition's own `webServer` is the
 * supported third-party path — the same one `open-in-app` uses for its launch
 * endpoint.
 *
 * Security is delegated, not reimplemented: every request first asks the
 * composition's `connection` service for a rejection (Host/Origin fence plus the
 * login-token cookie), then this module validates method, media type, and body
 * size. The only side effect is spawning Chrome with a plugin-owned data
 * directory; no file, no shell, no user-supplied argument reaches the process
 * command line.
 *
 * @module dsh-local-browser-web/server/browser-control
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ensureBrowserRunning,
  probeCdp,
  type BrowserStatus,
  type CdpProbeResult,
  type LauncherIo,
} from '../browser/launcher.ts'

/** The route the browser half posts to. */
export const BROWSER_CONTROL_PATH = '/local-browser-web/browser'

/** Bodies are one small JSON object; anything larger is hostile. */
const MAX_BODY_BYTES = 4 * 1024

/** The request shape the panel sends. */
interface ControlRequest {
  action: 'status' | 'launch'
}

/** Trust surface consumed here; the connection package owns the full type. */
interface ConnectionFence {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Settings the endpoint reads from the live config, per request. */
export interface BrowserControlSettings {
  endpoint: string
  chromePath: string
  profileDir: string
  launchTimeoutMs: number
}

/** Collaborators the route needs. */
export interface BrowserControlDeps {
  /** One plain config snapshot, taken per request. */
  settings(): BrowserControlSettings
  /** IO seam; tests pass fakes. */
  io?: LauncherIo
  /** Probe seam for the status action; defaults to the real CDP probe. */
  probe?: (endpoint: string, timeoutMs?: number) => Promise<CdpProbeResult>
}

/** Handle one control request; exported for tests. */
export async function handleBrowserControl(
  request: IncomingMessage,
  response: ServerResponse,
  deps: BrowserControlDeps,
): Promise<void> {
  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, 'POST')
    return
  }
  const essence = String(request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    sendJson(response, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'content-type must be application/json' })
    return
  }
  let action: ControlRequest['action']
  try {
    const body = await readBoundedBody(request)
    const parsed = JSON.parse(body) as Partial<ControlRequest>
    if (parsed.action !== 'status' && parsed.action !== 'launch') {
      sendJson(response, 400, { ok: false, code: 'BAD_REQUEST', message: 'action must be "status" or "launch"' })
      return
    }
    action = parsed.action
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'unreadable body',
    })
    return
  }

  const settings = deps.settings()
  if (action === 'status') {
    const probe = await (deps.probe ?? probeCdp)(settings.endpoint)
    const status: BrowserStatus = {
      ok: probe.reachable,
      running: probe.reachable,
      endpoint: settings.endpoint,
      profileDir: settings.profileDir,
      launched: false,
      searched: [],
      ...probe.browser === undefined ? {} : { browser: probe.browser },
      ...probe.reachable ? {} : { code: 'CDP_UNREACHABLE' as const, message: probe.error ?? 'CDP 端点无响应' },
    }
    sendJson(response, 200, status)
    return
  }

  const status = await ensureBrowserRunning({
    endpoint: settings.endpoint,
    chromePath: settings.chromePath,
    profileDir: settings.profileDir,
    timeoutMs: settings.launchTimeoutMs,
  }, deps.io)
  sendJson(response, 200, status)
}

/**
 * Register the control route for as long as the plugin and the web server live.
 * @param ctx - the plugin's context.
 * @param deps - config snapshot and IO seam.
 */
export function registerBrowserControl(ctx: Context, deps: BrowserControlDeps): void {
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: BROWSER_CONTROL_PATH,
      handler: async (request, response) => {
        // `ctx.get`, not `ctx.connection`: the plugin does not declare
        // `connection` as a hard dependency (profiles without a browser host
        // must still load), and reading an undeclared service on the context
        // throws. `get` answers undefined instead.
        const fence = ctx.get('connection') as Partial<ConnectionFence> | undefined
        const rejection = fence?.requestRejection?.({ headers: request.headers })
        if (rejection !== undefined) {
          response.statusCode = rejection
          response.end()
          return
        }
        await handleBrowserControl(request, response, deps)
      },
    }), `local-browser-web: POST ${BROWSER_CONTROL_PATH}`)
  })
}

/** JSON response (no-store: browser state is a live fact). */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(response: ServerResponse, allow: 'POST'): void {
  response.statusCode = 405
  response.setHeader('allow', allow)
  response.end()
}

/** Read the body, refusing anything over the cap rather than buffering it. */
async function readBoundedBody(request: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
