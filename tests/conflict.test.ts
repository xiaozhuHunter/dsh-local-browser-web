/**
 * Cross-source conflict detection.
 *
 * The risk this suite guards is false alarms: a contradiction shown to the model
 * that is not a contradiction is worse than no annotation at all, because it
 * invites a correction of something that was never wrong. So most of these cases
 * assert that nothing is reported.
 *
 * @module dsh-local-browser-web/tests/conflict
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { detectConflicts } from '../src/quality/conflict.ts'
import type { RawSearchSource } from '../src/types.ts'

/** A source with only the fields this module reads. */
function source(url: string, title: string): RawSearchSource {
  return { url, title, snippet: '' }
}

describe('detectConflicts', () => {
  it('reports a version disagreement on the same subject', () => {
    const notes = detectConflicts([
      source('https://a.example/news', 'DeepSeek Harness 正式发布 v2.1 版本'),
      source('https://b.example/news', 'DeepSeek Harness 正式发布 v3.0 版本'),
    ])
    const note = notes.get('https://a.example/news')
    assert.ok(note !== undefined, 'expected a conflict note')
    assert.equal(note?.kind, '版本')
    assert.equal(note?.otherHost, 'b.example')
    assert.notEqual(note?.mine, note?.theirs)
  })

  it('reports a month disagreement', () => {
    const notes = detectConflicts([
      source('https://a.example/x', 'DeepSeek Harness 2.0 发布日期确认为 2025-03'),
      source('https://b.example/y', 'DeepSeek Harness 2.0 发布日期确认为 2026-01'),
    ])
    assert.equal(notes.get('https://a.example/x')?.kind, '日期')
  })

  it('stays silent across different subjects', () => {
    const notes = detectConflicts([
      source('https://a.example/x', 'Node.js 发布 v20.1 版本'),
      source('https://b.example/y', 'Rust 发布 v1.80 版本'),
    ])
    assert.equal(notes.size, 0)
  })

  it('never compares two sources on the same host', () => {
    const notes = detectConflicts([
      source('https://a.example/one', 'DeepSeek Harness 发布 v2.1 版本'),
      source('https://a.example/two', 'DeepSeek Harness 发布 v3.0 版本'),
    ])
    assert.equal(notes.size, 0)
  })

  it('stays silent when the sources agree', () => {
    const notes = detectConflicts([
      source('https://a.example/x', 'DeepSeek Harness 发布 v2.1 版本'),
      source('https://b.example/y', 'DeepSeek Harness 发布 v2.1 版本'),
    ])
    assert.equal(notes.size, 0)
  })

  it('ignores a bare decimal that is not a version', () => {
    // `2.5` in a quantity is not a version, so the two must not "disagree".
    const notes = detectConflicts([
      source('https://a.example/x', 'DeepSeek Harness 性能提升 2.5 倍'),
      source('https://b.example/y', 'DeepSeek Harness 性能提升 3.5 倍'),
    ])
    assert.equal(notes.size, 0)
  })

  it('reports at most one contradiction per source', () => {
    const notes = detectConflicts([
      source('https://a.example/x', 'DeepSeek Harness 发布 v2.1 版本，性能提升 30%'),
      source('https://b.example/y', 'DeepSeek Harness 发布 v3.0 版本，性能提升 45%'),
      source('https://c.example/z', 'DeepSeek Harness 发布 v4.0 版本'),
    ])
    assert.equal(notes.size, 3)
    for (const note of notes.values()) assert.equal(typeof note.kind, 'string')
  })

  it('handles an empty source list', () => {
    assert.equal(detectConflicts([]).size, 0)
  })
})
