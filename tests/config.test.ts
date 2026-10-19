/**
 * Config validation and the plugin's structural rules.
 *
 * DSH's Schemastery build has no `.check()`, so `validateConfig` is where cross-field
 * rules are enforced. These tests pin the branches that must refuse a save.
 *
 * @module dsh-local-browser-web/tests/config
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LocalBrowserWebError } from '../src/errors.ts'
import { BUILT_IN_PARSERS, engineProblems, validateConfig } from '../src/config.ts'
import { makeConfig, makeEngine } from './helpers.ts'

const PARSERS = [...BUILT_IN_PARSERS]

describe('engineProblems', () => {
  it('accepts a complete entry', () => {
    assert.deepEqual(engineProblems(makeEngine(), PARSERS), [])
  })

  it('reports an empty id', () => {
    assert.deepEqual(engineProblems(makeEngine({ id: '  ' }), PARSERS), ['缺少 id'])
  })

  it('reports an empty endpoint', () => {
    const problems = engineProblems(makeEngine({ endpoint: '' }), PARSERS)
    assert.deepEqual(problems, ['缺少 endpoint'])
  })

  it('reports an unparsable endpoint', () => {
    const problems = engineProblems(makeEngine({ endpoint: 'not a url' }), PARSERS)
    assert.deepEqual(problems, ['endpoint 无法解析为 URL：not a url'])
  })

  it('accepts a templated endpoint', () => {
    assert.deepEqual(engineProblems(makeEngine({ endpoint: 'https://x.test/s?q={query}&r={region}' }), PARSERS), [])
  })

  it('reports a non-http endpoint scheme', () => {
    const problems = engineProblems(makeEngine({ endpoint: 'file:///etc/passwd' }), PARSERS)
    assert.equal(problems.length, 1)
  })

  it('reports a missing credential reference when a key is required', () => {
    const problems = engineProblems(makeEngine({ requiresKey: true }), PARSERS)
    assert.deepEqual(problems, ['requiresKey 为真但未填写 credentialRef'])
  })

  it('reports an unknown parser strategy', () => {
    const problems = engineProblems(makeEngine({ resultParser: 'nope' }), PARSERS)
    assert.deepEqual(problems, ['未知解析策略：nope'])
  })
})

describe('validateConfig', () => {
  const failing = (config: ReturnType<typeof makeConfig>): LocalBrowserWebError => {
    try {
      validateConfig(config, PARSERS)
    } catch (error) {
      assert.ok(error instanceof LocalBrowserWebError, 'expected a LocalBrowserWebError')
      return error
    }
    throw new Error('expected validateConfig to throw')
  }

  it('accepts the default config', () => {
    assert.doesNotThrow(() => { validateConfig(makeConfig(), PARSERS) })
  })

  it('refuses duplicate engine ids', () => {
    const error = failing(makeConfig({
      engines: [makeEngine({ id: 'dup' }), makeEngine({ id: 'dup' })],
    }))
    assert.equal(error.code, 'ENGINE_CONFIG_INVALID')
    assert.match(error.message, /引擎 id 重复：dup/u)
  })

  it('refuses a local search provider with no enabled engine', () => {
    const error = failing(makeConfig({ engines: [makeEngine({ enabled: false })] }))
    assert.match(error.message, /至少需要启用一个引擎/u)
  })

  it('allows zero engines when the local provider is switched off', () => {
    assert.doesNotThrow(() => {
      validateConfig(makeConfig({ searchProvider: 'deepseek-official', engines: [] }), PARSERS)
    })
  })

  it('refuses a parallel concurrency above the enabled engine count', () => {
    const error = failing(makeConfig({
      dispatchMode: 'parallel',
      parallelMaxEngines: 3,
      engines: [makeEngine({ id: 'a' }), makeEngine({ id: 'b' })],
    }))
    assert.match(error.message, /不得超过已启用引擎数/u)
  })

  it('allows a parallel concurrency equal to the enabled engine count', () => {
    assert.doesNotThrow(() => {
      validateConfig(makeConfig({
        dispatchMode: 'parallel',
        parallelMaxEngines: 2,
        engines: [makeEngine({ id: 'a' }), makeEngine({ id: 'b' })],
      }), PARSERS)
    })
  })

  it('refuses an unparsable CDP endpoint', () => {
    const error = failing(makeConfig({ cdpEndpoint: 'nope' }))
    assert.match(error.message, /cdpEndpoint 不是合法 URL/u)
  })

  it('accepts an empty CDP endpoint when the backend is not cdp', () => {
    assert.doesNotThrow(() => {
      validateConfig(makeConfig({ fetchBackend: 'http', cdpEndpoint: '' }), PARSERS)
    })
  })

  it('refuses a blank domain-list entry', () => {
    const config = makeConfig()
    config.quality.domainReputation.blocklist = ['ok.test', '']
    const error = failing(config)
    assert.match(error.message, /域名blocklist 含空条目/u)
  })

  it('refuses a non-positive timeout', () => {
    assert.match(failing(makeConfig({ fetchTimeoutMs: 0 })).message, /fetchTimeoutMs 必须为正数/u)
    assert.match(failing(makeConfig({ searchTimeoutMs: -1 })).message, /searchTimeoutMs 必须为正数/u)
  })

  it('refuses a non-integer concurrency', () => {
    assert.match(failing(makeConfig({ maxConcurrency: 1.5 })).message, /maxConcurrency 必须为正整数/u)
  })
})
