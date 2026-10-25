/**
 * Seam-level verification: load the REAL `ctx.web` seam plus this plugin into a
 * bare Cordis context and call `web.search` / `web.fetch` through the seam.
 *
 * This is what proves the integration contract (provider registration, provider
 * selection, and the seam's result shapes) without needing a full agent turn. It
 * runs from inside the package, so `@deepseek-ai/*` resolves through the same
 * junctions the host uses.
 *
 *   node scripts/verify-seam.mjs "deepseek 官网"
 *
 * Environment, so a specific egress/engine combination can be checked in isolation:
 *   DSH_PROXY_URL=http://192.168.3.74:7897   turn the proxy on for both transports
 *   DSH_PROXY_BYPASS=…                       direct-connect list (comma separated)
 *   DSH_ONLY_ENGINES=google,baidu            restrict the registry to these ids
 */
import { Context } from '@deepseek-ai/cordis'
import webPlugin from '@deepseek-ai/dsh-web'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import * as localBrowserWeb from '../lib/index.js'
import { DEFAULT_ENGINES } from '../lib/config.js'

const query = process.argv[2] ?? 'deepseek'
const proxyUrl = process.env.DSH_PROXY_URL ?? ''
const proxyBypass = process.env.DSH_PROXY_BYPASS ?? 'localhost,127.0.0.1,::1'
const only = (process.env.DSH_ONLY_ENGINES ?? '').split(',').map(id => id.trim()).filter(id => id.length > 0)

const ctx = new Context()
// 1) The seam, with this plugin's providers pinned (exactly what the profile patch does).
await ctx.plugin(webPlugin, { searchProvider: 'local-browser-search', fetchProvider: 'local-browser-fetch' })
// 2) The two services this plugin injects.
await ctx.plugin(systemPromptPlugin)
await ctx.plugin(toolsPlugin)
// 3) The plugin itself, mounted the way the loader mounts a profile row.
await ctx.plugin({
  name: localBrowserWeb.name,
  // `Config` is what turns the plain object below into the live Volatile-bearing
  // config the plugin reads — the same resolution the loader performs for a row.
  Config: localBrowserWeb.Config,
  inject: localBrowserWeb.inject,
  apply: localBrowserWeb.apply,
}, {
  searchProvider: 'local-browser-search',
  fetchProvider: 'local-browser-fetch',
  dispatchMode: 'bail',
  fetchBackend: 'cdp',
  cdpEndpoint: 'http://127.0.0.1:9222',
  ...proxyUrl.length === 0 ? {} : {
    proxy: { enabled: true, url: proxyUrl, bypass: proxyBypass, http: true, browser: true },
  },
  ...only.length === 0 ? {} : {
    engines: DEFAULT_ENGINES
      .filter(engine => only.includes(engine.id))
      .map(engine => ({ ...engine, enabled: true })),
  },
})

console.log(`proxy: ${proxyUrl.length === 0 ? 'off' : `${proxyUrl} (bypass: ${proxyBypass})`}`)
console.log(`engines in registry: ${only.length === 0 ? '(all defaults)' : only.join(', ')}\n`)

const result = await ctx.web.search({ query })
console.log(`ctx.web.search("${query}") → ${String(result.sources.length)} sources, truncated=${String(result.truncated)}`)
for (const source of result.sources.slice(0, 5)) {
  console.log(`  - ${String(source.title ?? '(untitled)').slice(0, 60)} — ${String(source.url).slice(0, 90)}`)
  // The annotation rides `summary`, which is what the model reads.
  if (source.summary !== undefined && source.summary.length > 0) {
    console.log(`      summary: ${String(source.summary).slice(0, 160)}`)
  }
}

const page = await ctx.web.fetch({ url: 'https://example.com/' })
const body = page.body.kind === 'html' ? page.body.content : page.body.content
console.log(`\nctx.web.fetch("https://example.com/") → ${String(page.statusCode)} ${page.body.kind}, ${String(body.length)} chars`)
console.log(`  ${String(body).replace(/\s+/gu, ' ').slice(0, 140)}`)

// The extensibility surface: engines / parsers / backends readable at runtime.
console.log('\nparsers:', ctx.localBrowserWeb.resultParsers().join(', '))
console.log('engines:', ctx.localBrowserWeb.engines().map(engine => `${engine.id}(${engine.kind}${engine.enabled ? '' : ',off'})`).join(', '))
console.log('fetch backends:', ctx.localBrowserWeb.fetchBackends().join(', '))
