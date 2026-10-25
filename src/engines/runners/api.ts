/**
 * The `api` runner: call a credentialed JSON search API and map its fields.
 *
 * The credential is resolved from the engine's `credentialRef` through the
 * credentials domain and never enters the config, a log line, or a tool result.
 * Field mapping is the `json-generic` parser's job, driven by the engine's
 * `extraParams` paths.
 *
 * @module dsh-local-browser-web/engines/runners/api
 */
import { LocalBrowserWebError } from '../../errors.ts'
import { httpGet } from '../../http.ts'
import { httpProxyOf } from '../../proxy.ts'
import { buildSearchUrl, searchLimits, type EngineRunner } from './context.ts'

/** Query one JSON search API. */
export const apiRunner: EngineRunner = async (engine, query, ctx, signal) => {
  const config = ctx.config()
  const url = buildSearchUrl(engine, query)

  const headers: Record<string, string> = { accept: 'application/json' }
  if (engine.requiresKey) {
    const ref = engine.credentialRef
    const secret = ref === undefined ? undefined : await ctx.resolveCredential(ref)
    if (secret === undefined || secret.length === 0) {
      throw new LocalBrowserWebError(
        `local-browser-web: 引擎 "${engine.id}" 需要凭据 "${ref ?? '(未配置 credentialRef)'}"，但凭据域中没有该值`,
        'ENGINE_TEST_FAILED',
      )
    }
    // Both bearer and header-style APIs are common; `x-api-key` is the widest default.
    headers['authorization'] = `Bearer ${secret}`
    headers['x-api-key'] = secret
  }

  const result = await httpGet({
    url: url.toString(),
    headers,
    limits: searchLimits(config),
    proxy: httpProxyOf(config.proxy),
    ...signal === undefined ? {} : { signal },
  })
  return ctx.parsers.parse(engine.resultParser, {
    engine,
    query,
    body: result.body,
    contentType: result.contentType,
  })
}
