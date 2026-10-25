/**
 * Cleaning parity with the built-in fetch path.
 *
 * Each case here pins one behaviour the built-in renderer (`dsh-tool-web` +
 * `web-fetch-http`) already has, and that a naive turndown/jsdom pipeline
 * silently loses. They exist so "the plugin cleans as well as the built-in
 * provider" stays true instead of being a claim in the README.
 *
 * @module dsh-local-browser-web/tests/clean-parity
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractArticle } from '../src/fetch/extract.ts'
import { decodeBody } from '../src/http.ts'
import { htmlToMarkdown } from '../src/markdown.ts'

describe('charset decoding', () => {
  const GBK_ZHONG_WEN = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4])

  it('uses the charset the header declares', () => {
    assert.equal(decodeBody(GBK_ZHONG_WEN, 'text/html; charset=gbk'), '中文')
  })

  it('falls back to the document meta charset when the header omits one', () => {
    const html = new TextEncoder().encode('<html><head><meta charset="gb2312"></head><body>')
    const body = Uint8Array.from([...html, ...GBK_ZHONG_WEN])
    assert.ok(decodeBody(body, 'text/html').endsWith('中文'))
  })

  it('reads the http-equiv form too', () => {
    const html = new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=gbk">')
    const body = Uint8Array.from([...html, ...GBK_ZHONG_WEN])
    assert.ok(decodeBody(body, '').endsWith('中文'))
  })

  it('decodes UTF-8 when nothing is declared', () => {
    assert.equal(decodeBody(new TextEncoder().encode('中文'), 'text/html'), '中文')
  })

  it('falls back to UTF-8 for an unknown label instead of throwing', () => {
    assert.equal(decodeBody(new TextEncoder().encode('ok'), 'text/html; charset=bogus-8'), 'ok')
  })
})

describe('markdown parity', () => {
  it('keeps a GFM table, including its heading separator', () => {
    const markdown = htmlToMarkdown(
      '<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>'
      + '<tbody><tr><td>Free</td><td>$0</td></tr></tbody></table>',
    )
    assert.match(markdown, /\| Plan \| Price \|/u)
    assert.match(markdown, /\| --- \| --- \|/u)
    assert.match(markdown, /\| Free \| \$0\s+\|/u)
  })

  it('renders strikethrough', () => {
    assert.match(htmlToMarkdown('<p>a <del>gone</del> b</p>'), /~~gone~~/u)
  })

  it('drops content a reader never sees', () => {
    const markdown = htmlToMarkdown(
      '<div><nav style="display:none">HIDDEN</nav><p hidden>ALSO-HIDDEN</p>'
      + '<p aria-hidden="true">ARIA-HIDDEN</p><p>visible</p></div>',
    )
    assert.doesNotMatch(markdown, /HIDDEN/u)
    assert.match(markdown, /visible/u)
  })
})

describe('extraction robustness', () => {
  it('refuses a document that nests deeper than the ceiling', () => {
    const depth = 2_000
    const html = `<body>${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}</body>`
    const started = Date.now()
    const extracted = extractArticle(html, 'https://fixture.test/', { readability: true, fallback: true })
    assert.equal(extracted.html, '', 'no fragment, so no converter can be handed the markup')
    assert.equal(extracted.text, 'deep')
    assert.ok(Date.now() - started < 1_000, 'the guard must not parse the document')
  })

  it('keeps ordinary nesting', () => {
    const html = `<article><h1>Title</h1><p>${'body '.repeat(80)}</p></article>`
    const extracted = extractArticle(html, 'https://fixture.test/', { readability: true, fallback: true })
    assert.ok(extracted.html.includes('<h1>Title</h1>'))
    assert.ok(extracted.text.length > 200)
  })
})
