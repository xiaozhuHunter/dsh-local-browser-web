/**
 * Extraction, Markdown conversion, and the four-stage fetch pipeline.
 *
 * @module dsh-local-browser-web/tests/pipeline
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LocalBrowserWebError } from '../src/errors.ts'
import { extractArticle } from '../src/fetch/extract.ts'
import { FetchBackendRegistry } from '../src/fetch/backends.ts'
import { runFetchPipeline } from '../src/fetch/pipeline.ts'
import { htmlToMarkdown } from '../src/markdown.ts'
import type { BackendFetchResult, FetchBackend } from '../src/types.ts'
import { makeConfig, rejection } from './helpers.ts'

/** One long paragraph of filler, so extraction has something to pick. */
const PARA = Array.from({ length: 60 }, (_, index) => `sentence${String(index)} about the topic`).join(' ')

const ARTICLE_HTML = `
<html><head><title>An Article</title></head><body>
  <nav>menu menu menu</nav>
  <article>
    <h1>An Article</h1>
    <p>${PARA}</p>
    <p>${PARA}</p>
  </article>
  <footer>footer</footer>
</body></html>`

/** A backend that answers with a canned body. */
function stubBackend(id: string, result: BackendFetchResult | (() => Promise<never>)): FetchBackend {
  return {
    id,
    available: () => true,
    async fetch() {
      if (typeof result === 'function') return await result()
      return result
    },
  }
}

/** A registry with one stub backend registered under `id`. */
function registryWith(id: string, result: BackendFetchResult | (() => Promise<never>)): FetchBackendRegistry {
  const registry = new FetchBackendRegistry()
  registry.register(id, stubBackend(id, result))
  return registry
}

describe('extractArticle', () => {
  it('lifts the article and drops the chrome', () => {
    const extracted = extractArticle(ARTICLE_HTML, 'https://news.test/story', { readability: true, fallback: true })
    assert.equal(extracted.title, 'An Article')
    assert.match(extracted.text, /sentence0 about the topic/u)
    assert.equal(extracted.text.includes('menu menu menu'), false)
    assert.equal(extracted.text.includes('footer'), false)
  })

  it('falls back to paragraph gathering when scoring finds too little', () => {
    const thin = `<html><body><div><p>${PARA}</p></div></body></html>`
    const scored = extractArticle(thin, 'https://x.test/', { readability: true, fallback: false })
    const gathered = extractArticle(thin, 'https://x.test/', { readability: true, fallback: true })
    assert.ok(gathered.text.length >= scored.text.length)
  })

  it('returns an empty text when both strategies are switched off', () => {
    const extracted = extractArticle(ARTICLE_HTML, 'https://x.test/', { readability: false, fallback: false })
    assert.equal(extracted.text, '')
  })
})

describe('htmlToMarkdown', () => {
  it('converts headings and paragraphs', () => {
    const markdown = htmlToMarkdown('<h1>Title</h1><p>Body text</p>')
    assert.match(markdown, /^# Title/u)
    assert.match(markdown, /Body text/u)
  })

  it('drops empty anchors', () => {
    assert.equal(htmlToMarkdown('<p>a <a href="https://x.test/"></a>b</p>').includes('x.test'), false)
  })
})

describe('runFetchPipeline', () => {
  const htmlResult: BackendFetchResult = {
    url: 'https://news.test/story',
    statusCode: 200,
    body: ARTICLE_HTML,
    contentType: 'text/html',
    truncated: false,
  }

  it('cleans an HTML page down to Markdown text', async () => {
    const outcome = await runFetchPipeline(
      'https://news.test/story',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', htmlResult),
    )
    assert.equal(outcome.backend, 'cdp')
    assert.equal(outcome.statusCode, 200)
    assert.equal(outcome.body.kind, 'text')
    assert.match(outcome.body.content, /sentence0 about the topic/u)
    assert.equal(outcome.body.content.includes('<p>'), false)
    assert.ok(typeof outcome.quality.score === 'number')
  })

  it('hands back HTML when the Markdown stage is switched off', async () => {
    const config = makeConfig({ fetchBackend: 'cdp' })
    config.clean.markdown = false
    const outcome = await runFetchPipeline('https://news.test/story', config, registryWith('cdp', htmlResult))
    assert.equal(outcome.body.kind, 'html')
    // The extraction stage returns the chosen container's inner HTML, so the
    // fragment carries the article's own markup rather than a wrapper element.
    assert.match(outcome.body.content, /<h1>An Article<\/h1>/u)
  })

  it('falls back to plain transport when rendering is switched off', async () => {
    const config = makeConfig({ fetchBackend: 'cdp' })
    config.clean.render = false
    const outcome = await runFetchPipeline('https://news.test/story', config, registryWith('http', htmlResult))
    assert.equal(outcome.backend, 'http')
  })

  it('bypasses the quality layer when its stage is switched off', async () => {
    const config = makeConfig({ fetchBackend: 'cdp' })
    config.clean.quality = false
    const outcome = await runFetchPipeline('https://news.test/story', config, registryWith('cdp', htmlResult))
    assert.deepEqual(outcome.quality, { score: 100, flags: [] })
  })

  it('reports WEB_FETCH_CHALLENGE on a gate page', async () => {
    const error = await rejection(() => runFetchPipeline(
      'https://news.test/story',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', {
        url: 'https://news.test/story',
        statusCode: 403,
        body: '<html><title>Just a moment...</title></html>',
        contentType: 'text/html',
        truncated: false,
      }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
  })

  it('reports UNSUPPORTED_CONTENT_TYPE for an image', async () => {
    const error = await rejection(() => runFetchPipeline(
      'https://news.test/image.png',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', {
        url: 'https://news.test/image.png',
        statusCode: 200,
        body: 'binary',
        contentType: 'image/png',
        truncated: false,
      }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'UNSUPPORTED_CONTENT_TYPE')
  })

  it('reports EXTRACTION_FAILED when a page yields no text', async () => {
    const error = await rejection(() => runFetchPipeline(
      'https://news.test/empty',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', {
        url: 'https://news.test/empty',
        statusCode: 200,
        body: '<html><body><div></div></body></html>',
        contentType: 'text/html',
        truncated: false,
      }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'EXTRACTION_FAILED')
  })

  it('refuses a blocked host before calling any backend', async () => {
    const error = await rejection(() => runFetchPipeline(
      'http://127.0.0.1:9222/',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', () => Promise.reject(new Error('must not be called'))),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
  })

  it('carries a non-2xx status through as a result', async () => {
    const outcome = await runFetchPipeline(
      'https://news.test/gone',
      makeConfig({ fetchBackend: 'cdp' }),
      registryWith('cdp', { ...htmlResult, url: 'https://news.test/gone', statusCode: 404 }),
    )
    assert.equal(outcome.statusCode, 404)
  })

  it('reports an unknown backend as a config error', async () => {
    const config = makeConfig()
    config.fetchBackend = 'playwright'
    const error = await rejection(() => runFetchPipeline('https://news.test/', config, registryWith('cdp', htmlResult)))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
  })
})
