/**
 * Dump the raw payload each engine hands to its parser, so a selector mismatch
 * can be diagnosed against the real markup instead of a guess.
 *
 *   node E:/dsh-plugins/dump-engine.mjs baidu deepseek
 */
import { writeFileSync } from 'node:fs'
import { CdpBrowser } from './dsh-local-browser-web/lib/browser/cdp.js'
import { DEFAULT_ENGINES } from './dsh-local-browser-web/lib/config.js'
import { buildSearchUrl } from './dsh-local-browser-web/lib/engines/runners/context.js'
import { httpGet } from './dsh-local-browser-web/lib/http.js'

const [id = 'baidu', query = 'deepseek'] = process.argv.slice(2)
const engine = DEFAULT_ENGINES.find(candidate => candidate.id === id)
if (engine === undefined) throw new Error(`no engine ${id}`)

const url = buildSearchUrl(engine, query).toString()
console.log(`engine=${engine.id} kind=${engine.kind}\nurl=${url}`)

if (engine.kind === 'browser') {
  const cdp = new CdpBrowser(() => ({
    endpoint: 'http://127.0.0.1:9222',
    userAgent: 'deepseek-harness-local-browser/0.1.0',
    profileMode: 'shared',
    timeoutMs: 30_000,
  }))
  const page = await cdp.render(url)
  console.log(`final=${page.url} status=${page.statusCode} html=${page.html.length}`)
  writeFileSync(`E:/dsh-plugins/dump-${id}.html`, page.html, 'utf8')
} else {
  const result = await httpGet({
    url,
    limits: {
      timeoutMs: 25_000,
      maxResponseBytes: 5_000_000,
      maxBodyChars: 100_000,
      maxRedirects: 5,
      userAgent: 'deepseek-harness-local-browser/0.1.0',
    },
  })
  console.log(`final=${result.url} status=${result.statusCode} type=${result.contentType} html=${result.body.length}`)
  writeFileSync(`E:/dsh-plugins/dump-${id}.html`, result.body, 'utf8')
}
