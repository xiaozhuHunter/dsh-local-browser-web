/**
 * The reader-facing annotation — the only part of the quality layer the model sees.
 *
 * The score orders results; the annotation tells the model *why*. These tests pin
 * the visible contract: the publisher class appears, the primary/secondary
 * judgement appears, the date appears, a contradiction names the other host, and
 * nothing is invented for a host the tier table does not know.
 *
 * @module dsh-local-browser-web/tests/annotation
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { annotationOf, withAnnotation } from '../src/providers/search.ts'
import type { QualityVerdict, RawSearchSource } from '../src/types.ts'

/** A verdict carrying only the flags a test cares about. */
function verdict(...flags: string[]): QualityVerdict {
  return { score: 80, flags }
}

/** A source with only the fields the annotation reads. */
function source(overrides: Partial<RawSearchSource> = {}): RawSearchSource {
  return { url: 'https://www.gov.cn/zhengce/notice', snippet: '一段摘要。', ...overrides }
}

describe('annotationOf', () => {
  it('names the publisher tier and the first-hand judgement', () => {
    const text = annotationOf(source(), verdict('primary-source'), undefined)
    assert.ok(text?.includes('官方/政府'))
    assert.ok(text?.includes('一手'))
  })

  it('marks a relaying page as secondary', () => {
    const text = annotationOf(source(), verdict('secondary-source'), undefined)
    assert.ok(text?.includes('二手'))
    assert.equal(text?.includes('一手'), false)
  })

  it('includes the publication date', () => {
    const text = annotationOf(source({ publishedAt: '2026-10-17' }), verdict('primary-source'), undefined)
    assert.ok(text?.includes('2026-10-17'))
  })

  it('converts an epoch-millis date to an ISO day', () => {
    const millis = String(Date.UTC(2026, 9, 17))
    const text = annotationOf(source({ publishedAt: millis }), verdict(), undefined)
    assert.ok(text?.includes('2026-10-17'))
  })

  it('names the other host and both values in a contradiction', () => {
    const text = annotationOf(source(), verdict('primary-source'), {
      kind: '版本',
      otherHost: 'example.com',
      mine: '2.1',
      theirs: '3.0',
    })
    assert.ok(text?.includes('example.com'))
    assert.ok(text?.includes('2.1'))
    assert.ok(text?.includes('3.0'))
  })

  it('stays silent when it knows nothing worth saying', () => {
    // Unknown host, no tier label, no primary/secondary call, no date, no conflict.
    const text = annotationOf(source({ url: 'https://unknown-host.example/x' }), verdict(), undefined)
    assert.equal(text, undefined)
  })
})

describe('withAnnotation', () => {
  it('appends the annotation to the snippet', () => {
    const text = withAnnotation(source(), '〔官方/政府·一手〕')
    assert.equal(text, '一段摘要。 〔官方/政府·一手〕')
  })

  it('returns no summary when there is no annotation, so the snippet renders unchanged', () => {
    assert.equal(withAnnotation(source(), undefined), undefined)
  })

  it('uses the annotation alone when the source has no snippet', () => {
    assert.equal(withAnnotation(source({ snippet: undefined }), '〔学术〕'), '〔学术〕')
  })

  it('bounds a long snippet so the annotation survives the consumer cap', () => {
    const long = 'x'.repeat(2_000)
    const text = withAnnotation(source({ snippet: long }), '〔媒体·二手〕')
    assert.ok(text !== undefined)
    assert.ok(text.length < 800, `summary is ${String(text.length)} chars; the consumer caps at 800`)
    assert.ok(text.endsWith('〔媒体·二手〕'))
  })
})
