/**
 * The browser half's carrier for the host's browser-control route.
 *
 * The panel cannot call host code directly and a third-party plugin cannot add a
 * Typert remote namespace, so it posts to the named route the host half registers
 * on the web server. The connection service's fence runs on that route, which is
 * why a plain same-origin `fetch` with the session cookie is enough — no token is
 * invented here.
 *
 * @module dsh-local-browser-web/client/browserControl
 */
import type { BrowserStatusView } from './controller.ts'

/** The route the host half serves (spelled here; the halves never share code). */
export const BROWSER_CONTROL_PATH = '/local-browser-web/browser'

/** One request's outcome, including the unreachable case the panel must render. */
export type BrowserControlResult = BrowserStatusView

/** Minimal fetch shape, injectable so a test never touches the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Posts one control action and normalises every failure into a status view. */
export class BrowserControl {
  /**
   * @param fetcher - same-origin carrier; defaults to the browser's `fetch`.
   */
  constructor(private readonly fetcher: FetchLike = (input, init) => fetch(input, init)) {}

  /** Probe the endpoint without spawning anything. */
  async status(): Promise<BrowserControlResult> {
    return await this.post('status')
  }

  /** Probe, and start Chrome when the endpoint is absent. */
  async launch(): Promise<BrowserControlResult> {
    return await this.post('launch')
  }

  private async post(action: 'status' | 'launch'): Promise<BrowserControlResult> {
    try {
      const response = await this.fetcher(BROWSER_CONTROL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
        credentials: 'same-origin',
      })
      if (!response.ok) {
        return unavailable(`HTTP ${String(response.status)}`)
      }
      const body = await response.json() as Partial<BrowserControlResult>
      if (typeof body.endpoint !== 'string' || typeof body.running !== 'boolean') {
        return unavailable('响应格式不正确')
      }
      return {
        ok: body.ok === true,
        running: body.running,
        endpoint: body.endpoint,
        profileDir: typeof body.profileDir === 'string' ? body.profileDir : '',
        launched: body.launched === true,
        searched: Array.isArray(body.searched) ? body.searched.filter((item): item is string => typeof item === 'string') : [],
        ...typeof body.browser === 'string' ? { browser: body.browser } : {},
        ...typeof body.chromePath === 'string' ? { chromePath: body.chromePath } : {},
        ...typeof body.code === 'string' ? { code: body.code } : {},
        ...typeof body.message === 'string' ? { message: body.message } : {},
      }
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }
}

/** A status for "the route itself is not answering" (old profile, no web server). */
function unavailable(message: string): BrowserControlResult {
  return {
    ok: false,
    running: false,
    endpoint: '',
    profileDir: '',
    launched: false,
    searched: [],
    code: 'UNAVAILABLE',
    message,
  }
}
