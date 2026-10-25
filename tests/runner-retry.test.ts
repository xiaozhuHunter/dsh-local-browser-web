/**
 * The `browser` runner's retry contract.
 *
 * An engine whose parser declares a readiness selector can still come back empty
 * — a slow egress drops one script chunk and the result list never appears. One
 * retry is what keeps that from being reported as "this engine has no results".
 * These tests pin the retry to exactly one attempt and keep engines without a
 * declared selector at a single render.
 *
 * @module dsh-local-browser-web/tests/runner-retry
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ParserRegistry } from '../src/engines/parsers.ts'
import { browserRunner } from '../src/engines/runners/browser.ts'
import type { RunnerContext } from '../src/engines/runners/context.ts'
import { makeConfig, makeEngine } from './helpers.ts'

/** A rendered page, in the shape the backend returns. */
const page = (html: string): { url: string, statusCode: number, html: string } =>
  ({ url: 'https://www.google.com/search?q=q', statusCode: 200, html })

/** A SERP shell: the document loaded but the result list was never injected. */
const SHELL = '<html><body><div id="main">跳到主要内容</div></body></html>'

/** The same SERP once the list exists: one real result and one internal link. */
const RENDERED = `
<html><body><div id="rso">
  <div class="MjjYud"><div class="g">
    <a href="/goto?url=CAESabc"><h3>Real Result</h3></a>
    <div class="VwiC3b">A snippet.</div>
  </div></div>
</div></body></html>`

/**
 * A runner context whose CDP backend answers with a scripted sequence of pages.
 * @param pages - the HTML of each successive render.
 * @returns the context plus a getter for the number of renders performed.
 */
function scriptedContext(pages: readonly string[]): { ctx: RunnerContext, renders: () => number } {
  let count = 0
  const ctx: RunnerContext = {
    config: () => makeConfig(),
    cdp: {
      render: async () => {
        const html = pages[Math.min(count, pages.length - 1)] ?? SHELL
        count += 1
        return page(html)
      },
    } as unknown as RunnerContext['cdp'],
    playwright: {} as RunnerContext['playwright'],
    parsers: new ParserRegistry(),
    resolveCredential: async () => undefined,
  }
  return { ctx, renders: () => count }
}

const googleEngine = makeEngine({
  id: 'google',
  kind: 'browser',
  endpoint: 'https://www.google.com/search?q={query}',
  resultParser: 'html-google',
})

/** An engine whose parser declares no readiness selector. */
const bingEngine = makeEngine({
  id: 'bing',
  kind: 'browser',
  endpoint: 'https://www.bing.com/search?q={query}',
  resultParser: 'html-bing',
})

describe('browser runner retry', () => {
  it('renders once more when a readiness-declaring engine comes back empty', async () => {
    const { ctx, renders } = scriptedContext([SHELL, RENDERED])
    const sources = await browserRunner(googleEngine, 'q', ctx)
    assert.equal(renders(), 2)
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.title, 'Real Result')
  })

  it('does not retry an engine that already produced results', async () => {
    const { ctx, renders } = scriptedContext([RENDERED, RENDERED])
    const sources = await browserRunner(googleEngine, 'q', ctx)
    assert.equal(renders(), 1)
    assert.equal(sources.length, 1)
  })

  it('gives up after exactly one retry', async () => {
    const { ctx, renders } = scriptedContext([SHELL, SHELL, RENDERED])
    const sources = await browserRunner(googleEngine, 'q', ctx)
    assert.equal(renders(), 2)
    assert.deepEqual(sources, [])
  })

  it('never retries an engine with no declared readiness selector', async () => {
    // Bing serves a complete document, so an empty parse means an empty result
    // set — retrying would only add latency.
    const { ctx, renders } = scriptedContext([SHELL, RENDERED])
    const sources = await browserRunner(bingEngine, 'q', ctx)
    assert.equal(renders(), 1)
    assert.deepEqual(sources, [])
  })
})
