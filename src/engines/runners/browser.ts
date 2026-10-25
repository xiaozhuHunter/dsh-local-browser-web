/**
 * The `browser` runner: render a search endpoint in a real browser, then parse the DOM.
 *
 * Needed by engines that build their result list client-side (Google's SERP, most
 * SPAs) and by engines that reject a plain fetch.
 *
 * @module dsh-local-browser-web/engines/runners/browser
 */
import type { CdpBrowser } from '../../browser/cdp.ts'
import { LocalBrowserWebError } from '../../errors.ts'
import { looksLikeChallenge } from '../../http.ts'
import type { RawSearchSource } from '../../types.ts'
import { buildSearchUrl, type EngineRunner } from './context.ts'

/** Render and parse one engine's SERP. */
export const browserRunner: EngineRunner = async (engine, query, ctx, signal) => {
  const config = ctx.config()
  const url = buildSearchUrl(engine, query)
  // The strategy knows what a ready document looks like; the runner only relays it.
  const waitFor = ctx.parsers.waiters(engine.resultParser)
  const browser: Pick<CdpBrowser, 'render'> = config.fetchBackend === 'playwright' ? ctx.playwright : ctx.cdp

  const attempt = async (): Promise<RawSearchSource[]> => {
    const page = await browser.render(url.toString(), signal, waitFor)
    if (looksLikeChallenge(page.statusCode, page.html)) {
      throw new LocalBrowserWebError(
        `local-browser-web: 引擎 "${engine.id}" 返回人机验证/拦截页（HTTP ${String(page.statusCode)}）`,
        'WEB_FETCH_CHALLENGE',
      )
    }
    return ctx.parsers.parse(engine.resultParser, {
      engine,
      query,
      body: page.html,
      contentType: 'text/html',
    })
  }

  const sources = await attempt()
  if (sources.length > 0 || waitFor.length === 0) return sources
  // An engine that declared a readiness selector yet parsed nothing most likely
  // raced the injection or lost a script chunk on a slow egress. One retry costs
  // seconds; reporting "0 results" for a page that has ten costs the whole search.
  return await attempt()
}
