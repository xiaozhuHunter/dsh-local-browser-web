/**
 * Transport-safety guards and content classification.
 *
 * @module dsh-local-browser-web/tests/http
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LocalBrowserWebError } from '../src/errors.ts'
import { assertFetchableUrl, classifyContentType, httpGet, looksLikeChallenge } from '../src/http.ts'
import { rejection, thrown } from './helpers.ts'

const limits = {
  timeoutMs: 1_000,
  maxResponseBytes: 1_000,
  maxBodyChars: 1_000,
  maxRedirects: 2,
  userAgent: 'test',
}

describe('assertFetchableUrl', () => {
  it('accepts http and https', () => {
    assert.equal(assertFetchableUrl('https://example.com/a').hostname, 'example.com')
    assert.equal(assertFetchableUrl('http://example.com/a').protocol, 'http:')
  })

  it('refuses a non-http scheme', () => {
    const error = thrown(() => assertFetchableUrl('file:///etc/passwd'))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'UNSUPPORTED_CONTENT_TYPE')
  })

  it('refuses an unparsable URL', () => {
    assert.throws(() => assertFetchableUrl('not a url'))
  })

  it('refuses loopback, private, link-local, and metadata hosts', () => {
    for (const url of [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      'http://[::1]/',
    ]) {
      const error = thrown(() => assertFetchableUrl(url))
      assert.ok(error instanceof LocalBrowserWebError)
      assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
    }
  })

  it('allows a public host', () => {
    assert.doesNotThrow(() => assertFetchableUrl('https://203.0.113.10/'))
  })
})

describe('classifyContentType', () => {
  it('splits html, text, and unsupported', () => {
    assert.equal(classifyContentType('text/html; charset=utf-8'), 'html')
    assert.equal(classifyContentType('application/xhtml+xml'), 'html')
    assert.equal(classifyContentType('text/plain'), 'text')
    assert.equal(classifyContentType('application/json'), 'text')
    assert.equal(classifyContentType(''), 'text')
    assert.equal(classifyContentType('image/png'), 'unsupported')
    assert.equal(classifyContentType('application/octet-stream'), 'unsupported')
  })
})

describe('looksLikeChallenge', () => {
  it('treats gate statuses as challenges', () => {
    assert.equal(looksLikeChallenge(403, 'anything'), true)
    assert.equal(looksLikeChallenge(429, 'anything'), true)
    assert.equal(looksLikeChallenge(503, 'anything'), true)
  })

  it('detects interstitial markers', () => {
    assert.equal(looksLikeChallenge(200, '<title>Just a moment...</title>'), true)
    assert.equal(looksLikeChallenge(200, '<div class="cf-challenge">'), true)
    assert.equal(looksLikeChallenge(200, 'Please complete the captcha'), true)
  })

  it('passes an ordinary page', () => {
    assert.equal(looksLikeChallenge(200, '<html><body>hello</body></html>'), false)
  })
})

describe('httpGet guards', () => {
  it('refuses a blocked host before opening a connection', async () => {
    const error = await rejection(() => httpGet({ url: 'http://127.0.0.1:9/', limits }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'WEB_FETCH_CHALLENGE')
  })

  it('refuses a non-http scheme', async () => {
    const error = await rejection(() => httpGet({ url: 'file:///tmp/x', limits }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'UNSUPPORTED_CONTENT_TYPE')
  })
})
