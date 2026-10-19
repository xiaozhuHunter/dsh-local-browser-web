/**
 * Search dispatch: the two scheduling modes, the fallback chain, and dedup.
 *
 * Dispatch routes on `kind`, and the test harness supplies a per-kind runner, so
 * these cases exercise the real scheduling logic without a network.
 *
 * @module dsh-local-browser-web/tests/dispatch
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { CdpBrowser } from '../src/browser/cdp.ts'
import { PlaywrightBrowser } from '../src/browser/playwright.ts'
import { dispatchSearch, mergeRoundRobin, runnerFor } from '../src/engines/dispatch.ts'
import { ParserRegistry } from '../src/engines/parsers.ts'
import type { RunnerContext } from '../src/engines/runners/context.ts'
import { LocalBrowserWebError } from '../src/errors.ts'
import type { EngineSpec, RawSearchSource } from '../src/types.ts'
import { makeConfig, makeEngine, rejection } from './helpers.ts'

/** Sources a fake runner returns, keyed by engine id. */
type Plan = Record<string, RawSearchSource[] | Error>

/** Build a runner context whose single runner answers from a plan. */
function fakeContext(plan: Plan): RunnerContext {
  const config = makeConfig()
  const runner = async (engine: EngineSpec): Promise<RawSearchSource[]> => {
    const outcome = plan[engine.id]
    if (outcome === undefined) return []
    if (outcome instanceof Error) throw outcome
    return outcome
  }
  return {
    config: () => config,
    cdp: new CdpBrowser(() => ({ endpoint: 'http://127.0.0.1:9222', userAgent: 'x', profileMode: 'shared', timeoutMs: 1000 })),
    playwright: new PlaywrightBrowser(() => ({ browserPath: undefined, profileMode: 'shared', userAgent: 'x', timeoutMs: 1000 })),
    parsers: new ParserRegistry(),
    resolveCredential: async () => undefined,
    runners: { 'http-html': runner, browser: runner, api: runner },
  }
}

const source = (url: string, title = url): RawSearchSource => ({ url, title })

describe('mergeRoundRobin', () => {
  it('interleaves by rank and deduplicates by URL', () => {
    const merged = mergeRoundRobin([
      [source('a1'), source('shared'), source('a3')],
      [source('b1'), source('shared2')],
    ])
    assert.deepEqual(merged.map(item => item.url), ['a1', 'b1', 'shared', 'shared2', 'a3'])
  })

  it('handles an empty list set', () => {
    assert.deepEqual(mergeRoundRobin([]), [])
  })
})

describe('bail mode', () => {
  it('returns the first engine with results and records the earlier failure', async () => {
    const outcome = await dispatchSearch(
      [makeEngine({ id: 'first' }), makeEngine({ id: 'second' })],
      'q',
      'bail',
      2,
      fakeContext({ first: new Error('boom'), second: [source('https://b.test/1')] }),
    )
    assert.deepEqual(outcome.sources.map(item => item.url), ['https://b.test/1'])
    assert.deepEqual(outcome.served, ['second'])
    assert.equal(outcome.failures.length, 1)
    assert.equal(outcome.failures[0]?.engine, 'first')
    assert.equal(outcome.failures[0]?.code, 'ENGINE_TEST_FAILED')
  })

  it('does not query later engines once one succeeds', async () => {
    const queried: string[] = []
    const ctx = fakeContext({ first: [source('https://a.test/1')], second: [source('https://b.test/1')] })
    const original = ctx.runners?.['http-html']
    ctx.runners = {
      'http-html': async (engine, query, inner, signal) => {
        queried.push(engine.id)
        assert.ok(original !== undefined)
        return await original(engine, query, inner, signal)
      },
    }
    await dispatchSearch([makeEngine({ id: 'first' }), makeEngine({ id: 'second' })], 'q', 'bail', 2, ctx)
    assert.deepEqual(queried, ['first'])
  })

  it('treats an empty result as a failure and moves on', async () => {
    const outcome = await dispatchSearch(
      [makeEngine({ id: 'empty' }), makeEngine({ id: 'second' })],
      'q',
      'bail',
      2,
      fakeContext({ empty: [], second: [source('https://b.test/1')] }),
    )
    assert.equal(outcome.served[0], 'second')
    assert.equal(outcome.failures[0]?.message, '返回 0 条结果')
  })

  it('propagates the engine failure code when every engine fails', async () => {
    const error = await rejection(() => dispatchSearch(
      [makeEngine({ id: 'a' }), makeEngine({ id: 'b' })],
      'q',
      'bail',
      2,
      fakeContext({
        a: new LocalBrowserWebError('browser down', 'BROWSER_UNAVAILABLE'),
        b: new LocalBrowserWebError('timeout', 'WEB_FETCH_TIMEOUT'),
      }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_TEST_FAILED')
    assert.match(error.message, /a:BROWSER_UNAVAILABLE, b:WEB_FETCH_TIMEOUT/u)
  })

  it('preserves ENGINE_CONFIG_INVALID when the first engine is misconfigured', async () => {
    const error = await rejection(() => dispatchSearch(
      [makeEngine({ id: 'a' })],
      'q',
      'bail',
      1,
      fakeContext({ a: new LocalBrowserWebError('bad engine', 'ENGINE_CONFIG_INVALID') }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
  })

  it('reports NO_ENABLED_ENGINE when there is nothing to run', async () => {
    const error = await rejection(() => dispatchSearch([], 'q', 'bail', 1, fakeContext({})))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'NO_ENABLED_ENGINE')
  })
})

describe('parallel mode', () => {
  it('queries the top N engines and merges their results', async () => {
    const queried: string[] = []
    const ctx = fakeContext({
      a: [source('https://a.test/1'), source('https://shared.test/')],
      b: [source('https://b.test/1'), source('https://shared.test/')],
      c: [source('https://c.test/1')],
    })
    ctx.runners = {
      'http-html': async (engine, query, inner, signal) => {
        queried.push(engine.id)
        const runner = fakeContext({
          a: [source('https://a.test/1'), source('https://shared.test/')],
          b: [source('https://b.test/1'), source('https://shared.test/')],
          c: [source('https://c.test/1')],
        }).runners?.['http-html']
        assert.ok(runner !== undefined)
        return await runner(engine, query, inner, signal)
      },
    }
    const outcome = await dispatchSearch(
      [makeEngine({ id: 'a', priority: 10 }), makeEngine({ id: 'b', priority: 20 }), makeEngine({ id: 'c', priority: 30 })],
      'q',
      'parallel',
      2,
      ctx,
    )
    assert.deepEqual(queried, ['a', 'b'])
    assert.deepEqual(outcome.sources.map(item => item.url), ['https://a.test/1', 'https://b.test/1', 'https://shared.test/'])
    assert.deepEqual(outcome.served, ['a', 'b'])
  })

  it('keeps serving engines whose siblings failed', async () => {
    const outcome = await dispatchSearch(
      [makeEngine({ id: 'a' }), makeEngine({ id: 'b' })],
      'q',
      'parallel',
      2,
      fakeContext({ a: new Error('nope'), b: [source('https://b.test/1')] }),
    )
    assert.deepEqual(outcome.served, ['b'])
    assert.equal(outcome.failures[0]?.engine, 'a')
  })

  it('throws when every concurrent engine failed', async () => {
    const error = await rejection(() => dispatchSearch(
      [makeEngine({ id: 'a' }), makeEngine({ id: 'b' })],
      'q',
      'parallel',
      2,
      fakeContext({ a: new Error('x'), b: new Error('y') }),
    ))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_TEST_FAILED')
  })

  it('never queries more engines than the configured concurrency', async () => {
    const queried: string[] = []
    const ctx = fakeContext({})
    ctx.runners = {
      browser: async (engine) => {
        queried.push(engine.id)
        return [source(`https://${engine.id}.test/`)]
      },
    }
    await dispatchSearch(
      [
        makeEngine({ id: 'a', kind: 'browser' }),
        makeEngine({ id: 'b', kind: 'browser' }),
        makeEngine({ id: 'c', kind: 'browser' }),
      ],
      'q',
      'parallel',
      1,
      ctx,
    )
    assert.deepEqual(queried, ['a'])
  })
})

describe('runnerFor', () => {
  it('falls back to the built-in runner per kind and honors overrides', () => {
    const ctx = fakeContext({})
    const custom = ctx.runners?.['api']
    assert.ok(custom !== undefined)
    assert.equal(runnerFor('api', ctx), custom)
    assert.notEqual(runnerFor('http-html'), runnerFor('browser'))
  })
})
