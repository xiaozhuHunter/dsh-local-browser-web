/**
 * The `browser` runner: render a search endpoint in a real browser, then parse the DOM.
 *
 * Needed by engines that build their result list client-side (DuckDuckGo's main
 * surface, most SPAs) and by engines that reject a plain fetch.
 *
 * @module dsh-local-browser-web/engines/runners/browser
 */
import type { CdpBrowser } from '../../browser/cdp.ts'
import { LocalBrowserWebError } from '../../errors.ts'
import { looksLikeChallenge } from '../../http.ts'
import { buildSearchUrl, type EngineRunner } from './context.ts'

/** Render and parse one engine's SERP. */
export const browserRunner: EngineRunner = async (engine, query, ctx, signal) => {
  const config = ctx.config()
  const url = buildSearchUrl(engine, query)
  const render = async (browser: Pick<CdpBrowser, 'render'>, label: string): Promise<{ url: string, statusCode: number, html: string }> => {
    const page = await browser.render(url.toString(), signal)
    if (looksLikeChallenge(page.statusCode, page.html)) {
      throw new LocalBrowserWebError(
        `local-browser-web: 引擎 "${engine.id}" 返回人机验证/拦截页（HTTP ${String(page.statusCode)}）`,
        'WEB_FETCH_CHALLENGE',
      )
    }
    void label
    return page
  }
  const page = config.fetchBackend === 'playwright'
    ? await render(ctx.playwright, 'playwright')
    : await render(ctx.cdp, 'cdp')
  return ctx.parsers.parse(engine.resultParser, {
    engine,
    query,
    body: page.html,
    contentType: 'text/html',
  })
}
