/**
 * Optional Playwright rendering backend.
 *
 * Playwright is deliberately NOT a dependency: the plugin loads it lazily, so a
 * deployment that only uses the CDP backend installs nothing extra and the
 * missing module degrades to "backend unavailable" instead of failing startup.
 *
 * Mirror of the CDP backend's contract: same options in, same `RenderedPage` out,
 * so the fetch pipeline never learns which one rendered the page.
 *
 * @module dsh-local-browser-web/browser/playwright
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBrowserWebError } from '../errors.ts'
import type { RenderedPage } from './cdp.ts'
import type { ProfileMode } from '../types.ts'

/** Options the Playwright backend needs, on top of the shared rendering options. */
export interface PlaywrightOptions {
  /** Explicit executable; empty lets Playwright pick its own bundled browser. */
  browserPath: string | undefined
  profileMode: ProfileMode
  userAgent: string
  timeoutMs: number
}

/** The slice of Playwright's API this backend uses, declared structurally so no types are required. */
interface PlaywrightPage {
  goto(url: string, options: { timeout: number, waitUntil: string }): Promise<{ status(): number } | null>
  content(): Promise<string>
  url(): string
  close(): Promise<void>
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  close(): Promise<void>
}

interface PlaywrightBrowserInstance {
  newContext(options: { userAgent: string }): Promise<PlaywrightContext>
  close(): Promise<void>
}

interface PlaywrightChromium {
  launch(options: { executablePath?: string, headless: boolean }): Promise<PlaywrightBrowserInstance>
  launchPersistentContext(userDataDir: string, options: { executablePath?: string, headless: boolean, userAgent: string }): Promise<PlaywrightContext>
}

interface PlaywrightModule {
  chromium: PlaywrightChromium
}

/** Derive the profile-dir name Playwright's persistent context reuses between runs. */
function profileDirOf(mode: ProfileMode): string {
  return join(tmpdir(), `dsh-local-browser-web-${mode}`)
}

/** Playwright rendering backend. Registered in the fetch-backend registry as `playwright`. */
export class PlaywrightBrowser {
  private loaded: PlaywrightModule | undefined
  private loadFailed = false

  /** @param options - the live rendering options (browser path, profile mode, UA, timeout). */
  constructor(private readonly options: () => PlaywrightOptions) {}

  /**
   * Cheap usability check: whether Playwright can be imported at all.
   * Cached, because a failed import is not worth retrying on every operation.
   * @returns whether the module resolved.
   */
  async available(): Promise<boolean> {
    if (this.loaded !== undefined) return true
    if (this.loadFailed) return false
    this.loaded = await this.load()
    return this.loaded !== undefined
  }

  private async load(): Promise<PlaywrightModule | undefined> {
    // The specifier is held in a variable so the compiler does not require the
    // module's types: Playwright is an optional peer, present only where used.
    const specifier = 'playwright'
    try {
      const module = await import(specifier) as unknown as PlaywrightModule
      if (module.chromium === undefined) {
        this.loadFailed = true
        return undefined
      }
      return module
    } catch {
      this.loadFailed = true
      return undefined
    }
  }

  /**
   * Render one URL with Playwright.
   * @param url - the page to load.
   * @param signal - caller cancellation.
   * @returns final URL, HTTP status, and rendered HTML.
   * @throws {LocalBrowserWebError} `BROWSER_UNAVAILABLE` / `WEB_FETCH_TIMEOUT`.
   */
  async render(url: string, signal?: AbortSignal): Promise<RenderedPage> {
    const module = this.loaded ?? await this.load()
    if (module === undefined) {
      throw new LocalBrowserWebError(
        'local-browser-web: Playwright 后端不可用（未安装 playwright；npm i playwright 或改用 cdp 后端）',
        'BROWSER_UNAVAILABLE',
      )
    }
    const options = this.options()
    const launch = { headless: true, ...options.browserPath === undefined ? {} : { executablePath: options.browserPath } }
    let context: PlaywrightContext | undefined
    let browser: PlaywrightBrowserInstance | undefined
    let emitContext = false
    try {
      if (options.profileMode === 'shared') {
        context = await module.chromium.launchPersistentContext(profileDirOf(options.profileMode), {
          ...launch,
          userAgent: options.userAgent,
        })
      } else {
        browser = await module.chromium.launch(launch)
        context = await browser.newContext({ userAgent: options.userAgent })
        emitContext = true
      }
      const page = await context.newPage()
      const abort = (): Promise<never> => {
        void page.close()
        return Promise.reject(new LocalBrowserWebError(
          `local-browser-web: Playwright 渲染超时（${String(options.timeoutMs)}ms，${url}）`,
          'WEB_FETCH_TIMEOUT',
        ))
      }
      if (signal?.aborted === true) return await abort()
      const timer = setTimeout(() => { void abort() }, options.timeoutMs)
      try {
        const response = await page.goto(url, { timeout: options.timeoutMs, waitUntil: 'domcontentloaded' })
        const html = await page.content()
        return {
          url: page.url(),
          statusCode: response === null ? 0 : response.status(),
          html,
        }
      } finally {
        clearTimeout(timer)
        await page.close().catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof LocalBrowserWebError) throw error
      throw new LocalBrowserWebError(
        `local-browser-web: Playwright 渲染失败（${url}）`,
        'BROWSER_UNAVAILABLE',
        { cause: error },
      )
    } finally {
      if (emitContext) await context?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
    }
  }
}
