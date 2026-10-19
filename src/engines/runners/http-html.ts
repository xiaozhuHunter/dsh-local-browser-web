/**
 * The `http-html` runner: fetch a search endpoint's HTML and parse it.
 *
 * This is the cheap path — no browser, no JavaScript — and it is what an engine
 * with a server-rendered SERP should use (Bing, most self-hosted engines).
 *
 * @module dsh-local-browser-web/engines/runners/http-html
 */
import { LocalBrowserWebError } from '../../errors.ts'
import { httpGet, looksLikeChallenge } from '../../http.ts'
import { buildSearchUrl, searchLimits, type EngineRunner } from './context.ts'

/** Retrieve and parse one engine's HTML SERP. */
export const httpHtmlRunner: EngineRunner = async (engine, query, ctx, signal) => {
  const config = ctx.config()
  const url = buildSearchUrl(engine, query)
  const result = await httpGet({
    url: url.toString(),
    headers: engine.extraParams?.language === undefined
      ? {}
      : { 'accept-language': `${engine.extraParams.language};q=0.9` },
    limits: searchLimits(config),
    ...signal === undefined ? {} : { signal },
  })
  if (looksLikeChallenge(result.statusCode, result.body)) {
    throw new LocalBrowserWebError(
      `local-browser-web: 引擎 "${engine.id}" 返回人机验证/拦截页（HTTP ${String(result.statusCode)}）`,
      'WEB_FETCH_CHALLENGE',
    )
  }
  return ctx.parsers.parse(engine.resultParser, {
    engine,
    query,
    body: result.body,
    contentType: result.contentType,
  })
}
