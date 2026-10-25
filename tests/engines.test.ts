/**
 * Result parsers and the engine registry.
 *
 * @module dsh-local-browser-web/tests/engines
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LocalBrowserWebError } from '../src/errors.ts'
import { ParserRegistry } from '../src/engines/parsers.ts'
import {
  EngineRegistry,
  moveEngine,
  removeEngine,
  setEngineEnabled,
  sortEngines,
  upsertEngine,
} from '../src/engines/registry.ts'
import type { EngineSpec } from '../src/types.ts'
import { thrown, makeEngine } from './helpers.ts'

const BING = `
<html><body><ol class="b_results">
  <li class="b_algo"><h2><a href="https://a.test/1">Title A</a></h2><div class="b_caption"><p>Snippet A</p></div></li>
  <li class="b_algo"><h2><a href="/rel/2">Title B</a></h2><div class="b_caption"><p>Snippet B</p><span class="news_dt">2026-01-01</span></div></li>
  <li class="b_algo"><h2><a href="javascript:void(0)">Bad</a></h2><p>x</p></li>
</ol></body></html>`

const DDG = `
<html><body>
  <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.test%2F1">D Title</a><a class="result__snippet">D snippet</a></div>
  <article data-testid="result"><a data-testid="result-title-a" href="https://e.test/2">E Title</a><div data-result="snippet">E snippet</div></article>
</body></html>`

const JSON_PAYLOAD = JSON.stringify({
  results: [
    { url: 'https://j.test/1', title: 'J one', snippet: 'S one' },
    { url: 'javascript:void(0)', title: 'bad' },
    { url: 'https://j.test/2', title: 'J two', publishedAt: '2026-02-02' },
  ],
})

describe('html-bing parser', () => {
  it('extracts title, snippet, and date, dropping unusable hrefs', () => {
    const sources = new ParserRegistry().parse('html-bing', {
      engine: makeEngine({ id: 'bing', endpoint: 'https://www.bing.com/search' }),
      query: 'q',
      body: BING,
      contentType: 'text/html',
    })
    assert.equal(sources.length, 2)
    assert.deepEqual(sources[0], { url: 'https://a.test/1', title: 'Title A', snippet: 'Snippet A' })
    // The relative href resolves against the engine endpoint.
    assert.equal(sources[1]?.url, 'https://www.bing.com/rel/2')
    assert.equal(sources[1]?.snippet, 'Snippet B')
    assert.equal(sources[1]?.publishedAt, '2026-01-01')
  })
})

describe('html-ddg parser', () => {
  it('unwraps the redirect wrapper and reads the rendered markup', () => {
    const sources = new ParserRegistry().parse('html-ddg', {
      engine: makeEngine({ id: 'duckduckgo', endpoint: 'https://duckduckgo.com/?q={query}' }),
      query: 'q',
      body: DDG,
      contentType: 'text/html',
    })
    assert.equal(sources.length, 2)
    assert.equal(sources[0]?.url, 'https://d.test/1')
    assert.equal(sources[0]?.title, 'D Title')
    assert.equal(sources[0]?.snippet, 'D snippet')
    assert.equal(sources[1]?.url, 'https://e.test/2')
    assert.equal(sources[1]?.snippet, 'E snippet')
  })
})

describe('json-generic parser', () => {
  it('maps declared field paths and drops entries without a usable URL', () => {
    const sources = new ParserRegistry().parse('json-generic', {
      engine: makeEngine({
        id: 'api',
        kind: 'api',
        endpoint: 'https://api.test/search',
        resultParser: 'json-generic',
      }),
      query: 'q',
      body: JSON_PAYLOAD,
      contentType: 'application/json',
    })
    assert.equal(sources.length, 2)
    assert.equal(sources[0]?.url, 'https://j.test/1')
    assert.equal(sources[1]?.publishedAt, '2026-02-02')
  })

  it('fails with ENGINE_TEST_FAILED on a non-JSON body', () => {
    const error = thrown(() => new ParserRegistry().parse('json-generic', {
      engine: makeEngine({ id: 'api', kind: 'api' }),
      query: 'q',
      body: '<html>not json</html>',
    }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_TEST_FAILED')
  })

  it('fails with ENGINE_CONFIG_INVALID when itemsPath points at no array', () => {
    const error = thrown(() => new ParserRegistry().parse('json-generic', {
      engine: makeEngine({ id: 'api', kind: 'api', resultParser: 'json-generic', extraParams: { itemsPath: 'nope' } }),
      query: 'q',
      body: JSON.stringify({ nope: { a: 1 } }),
    }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
  })
})

describe('ParserRegistry', () => {
  it('ships the six built-in strategies and reports unknown ids', () => {
    const registry = new ParserRegistry()
    assert.deepEqual(registry.ids(), [
      'html-baidu',
      'html-bing',
      'html-ddg',
      'html-google',
      'html-so360',
      'json-generic',
    ])
    const error = thrown(() => registry.parse('missing', {
      engine: makeEngine(),
      query: 'q',
      body: '',
    }))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
  })

  it('lets a third party register and then release a strategy', () => {
    const registry = new ParserRegistry()
    const dispose = registry.register('custom', () => [{ url: 'https://c.test/1' }])
    assert.equal(registry.has('custom'), true)
    assert.deepEqual(registry.parse('custom', { engine: makeEngine(), query: 'q', body: '' }), [{ url: 'https://c.test/1' }])
    dispose()
    assert.equal(registry.has('custom'), false)
  })

  it('restores the previous strategy when a replacement is released', () => {
    const registry = new ParserRegistry()
    const dispose = registry.register('html-bing', () => [{ url: 'https://replaced.test/' }])
    assert.equal(registry.parse('html-bing', { engine: makeEngine(), query: 'q', body: BING }).length, 1)
    dispose()
    assert.equal(registry.parse('html-bing', { engine: makeEngine(), query: 'q', body: BING }).length, 2)
  })
})

describe('engine list helpers', () => {
  const list = (): EngineSpec[] => [
    makeEngine({ id: 'c', priority: 30 }),
    makeEngine({ id: 'a', priority: 10 }),
    makeEngine({ id: 'b', priority: 20 }),
  ]

  it('orders by priority then id', () => {
    assert.deepEqual(sortEngines(list()).map(engine => engine.id), ['a', 'b', 'c'])
    assert.deepEqual(sortEngines([
      makeEngine({ id: 'z', priority: 10 }),
      makeEngine({ id: 'a', priority: 10 }),
    ]).map(engine => engine.id), ['a', 'z'])
  })

  it('moves an engine and rewrites priorities so order and priority agree', () => {
    const moved = moveEngine(list(), 'c', -1)
    assert.deepEqual(moved.map(engine => engine.id), ['a', 'c', 'b'])
    assert.deepEqual(moved.map(engine => engine.priority), [10, 20, 30])
  })

  it('clamps a move at the ends', () => {
    assert.deepEqual(moveEngine(list(), 'a', -1).map(engine => engine.id), ['a', 'b', 'c'])
    assert.deepEqual(moveEngine(list(), 'c', 5).map(engine => engine.id), ['a', 'b', 'c'])
  })

  it('upserts by id and flips the enabled flag', () => {
    const appended = upsertEngine(list(), makeEngine({ id: 'd' }))
    assert.equal(appended.length, 4)
    const replaced = upsertEngine(list(), makeEngine({ id: 'b', label: 'renamed' }))
    assert.equal(replaced.length, 3)
    assert.equal(replaced.find(engine => engine.id === 'b')?.label, 'renamed')
    assert.equal(setEngineEnabled(list(), 'a', false).find(engine => engine.id === 'a')?.enabled, false)
  })

  it('removes by id', () => {
    assert.deepEqual(removeEngine(list(), 'b').map(engine => engine.id).sort(), ['a', 'c'])
  })
})

describe('EngineRegistry', () => {
  it('merges configured engines with runtime registrations, ordered by priority', () => {
    const configured = [makeEngine({ id: 'configured', priority: 20 })]
    const registry = new EngineRegistry(() => configured, () => ['html-bing'])
    registry.register(makeEngine({ id: 'runtime', priority: 5 }))
    assert.deepEqual(registry.list().map(engine => engine.id), ['runtime', 'configured'])
    assert.deepEqual(registry.runtimeIds(), ['runtime'])
  })

  it('lets the configured entry win over a runtime duplicate', () => {
    const configured = [makeEngine({ id: 'dup', label: 'configured' })]
    const registry = new EngineRegistry(() => configured, () => ['html-bing'])
    registry.register(makeEngine({ id: 'dup', label: 'runtime' }))
    assert.equal(registry.get('dup')?.label, 'configured')
  })

  it('filters by enabled and exposes the disposer', () => {
    const registry = new EngineRegistry(
      () => [makeEngine({ id: 'on' }), makeEngine({ id: 'off', enabled: false })],
      () => ['html-bing'],
    )
    assert.deepEqual(registry.enabled().map(engine => engine.id), ['on'])
    const dispose = registry.register(makeEngine({ id: 'late' }))
    assert.equal(registry.get('late') !== undefined, true)
    dispose()
    assert.equal(registry.get('late'), undefined)
  })

  it('refuses a runtime engine with an unusable shape', () => {
    const registry = new EngineRegistry(() => [], () => ['html-bing'])
    const error = thrown(() => registry.register(makeEngine({ id: 'bad', resultParser: 'nope' })))
    assert.ok(error instanceof LocalBrowserWebError)
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
  })
})
