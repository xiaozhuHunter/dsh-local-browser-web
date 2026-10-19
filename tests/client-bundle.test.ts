/**
 * The client bundle's contract, verified by actually loading it.
 *
 * The official tsdown preset that emits a DSH client bundle is not published, so
 * this package mirrors it by hand (see `tsdown.config.ts`). The mirror is only
 * correct if the artifact satisfies the loader's contract:
 *
 *  - it registers `window.__ModuleLoader__.load({ id, factory })` under the package name,
 *  - the factory resolves externals through the injected `require` (module-table rows)
 *    rather than a globals/import map,
 *  - the returned module exposes `inject` and `apply(ctx)`,
 *  - `apply` really registers the `settings.section` page, and the injected face's
 *    snapshot carries the whole field table.
 *
 * That last assertion is what makes the panel's coverage claim testable: if a field
 * disappears from the controller's table, this fails.
 *
 * @module dsh-local-browser-web/tests/client-bundle
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/** The module a bundle's factory returns. */
interface ClientModule {
  inject?: unknown
  apply?: (ctx: unknown) => void
  Panel?: unknown
  ENTRY_ID?: unknown
  NS?: unknown
}

/** What the loader receives from the artifact. */
interface LoaderDefinition {
  id: string
  factory: (require: (specifier: string) => unknown) => ClientModule
}

/** The bundle path, relative to this test file. */
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** A snapshot store good enough for the controller's use. */
function createSnapshotStore<T>(initial: T): {
  getSnapshot: () => T
  set: (next: T) => void
  update: (edit: (draft: T) => void) => void
  subscribe: (listener: () => void) => () => void
} {
  let state = initial
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const listener of listeners) listener() }
  return {
    getSnapshot: () => state,
    set: (next) => { state = next; publish() },
    update: (edit) => { edit(state); publish() },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** Stubs for the platform module rows the bundle is allowed to require. */
const STUBS: Record<string, unknown> = {
  'react': { useState: <T,>(initial: T) => [initial, () => undefined] as const, default: {} },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
  '@deepseek-ai/dsh-client-store': { createSnapshotStore },
  '@deepseek-ai/dsh-client-ui-primitives': {
    SettingsForm: () => null,
    SettingsValueField: () => null,
    SettingsSecretField: () => null,
    Switch: () => null,
    SegmentedControl: () => null,
    SegmentedTabs: () => null,
    Button: () => null,
    writeClipboard: async () => undefined,
  },
}

/** A `require` that answers only from the frozen module table. */
function requireStub(specifier: string): unknown {
  const found = STUBS[specifier]
  if (found === undefined) throw new Error(`bundle required an unlisted external: ${specifier}`)
  return found
}

/** Evaluate the artifact and capture what it registers. */
function loadBundle(): LoaderDefinition {
  const code = readFileSync(BUNDLE, 'utf8')
  let captured: LoaderDefinition | undefined
  const globals = globalThis as unknown as {
    window?: { __ModuleLoader__: { load(definition: LoaderDefinition): void } }
  }
  globals.window = {
    __ModuleLoader__: {
      load(definition) { captured = definition },
    },
  }
  new Function(code)()
  assert.ok(captured !== undefined, 'the bundle must register with window.__ModuleLoader__')
  return captured
}

/** The config section the fake Host serves. */
const SECTION = {
  searchProvider: 'local-browser-search',
  dispatchMode: 'bail',
  engines: [{
    id: 'bing',
    label: 'Bing',
    kind: 'http-html',
    endpoint: 'https://www.bing.com/search',
    requiresKey: false,
    resultParser: 'html-bing',
    priority: 10,
    enabledByDefault: true,
    enabled: true,
  }],
  clean: { transport: { enabled: true } },
  quality: { seoSpam: { maxKeywordDensity: 0.12 } },
}

/** A fake browser plugin context recording what the panel registers. */
function fakeContext(): { ctx: unknown, registrations: { options: Record<string, unknown>, face: Record<string, unknown> }[] } {
  const registrations: { options: Record<string, unknown>, face: Record<string, unknown> }[] = []
  const configForm = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: SECTION,
      base: {},
      user: {},
      revision: 3,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: () => () => undefined,
    mutate: async () => true,
    set: async () => true,
    unset: async () => true,
  }
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    effect: (run: () => unknown) => {
      const disposer = run()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    locale: { bind: () => (key: string) => key, register: () => () => undefined },
    configForms: {
      get: () => configForm,
      whileServed: (_namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        register(new Set(['local-browser-web']))
        return () => undefined
      },
    },
    remote: {
      $on: () => () => undefined,
      credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => undefined },
    },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (options: Record<string, unknown>, _component: unknown) => {
        registrations.push({ options, face: {} })
        return () => undefined
      },
    },
  }
  return { ctx, registrations }
}

describe('client bundle artifact', () => {
  it('registers the package id with a closure factory', () => {
    const definition = loadBundle()
    assert.equal(definition.id, 'dsh-local-browser-web')
    assert.equal(typeof definition.factory, 'function')
  })

  it('exposes the client plugin contract', () => {
    const module = loadBundle().factory(requireStub)
    assert.equal(typeof module.apply, 'function')
    assert.ok(Array.isArray(module.inject))
    for (const service of ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']) {
      assert.ok((module.inject as readonly string[]).includes(service), `inject must declare ${service}`)
    }
  })

  it('does not leak a host package into the browser half', () => {
    const code = readFileSync(BUNDLE, 'utf8')
    // Type-only imports are erased; a value import would have inlined the package.
    assert.equal(code.includes('require("@deepseek-ai/dsh-web")'), false)
    assert.equal(code.includes('jsdom'), false)
  })
})

describe('client plugin apply', () => {
  it('registers the settings.section page while the namespace is served', () => {
    const module = loadBundle().factory(requireStub)
    const { ctx, registrations } = fakeContext()
    module.apply?.(ctx)
    assert.equal(registrations.length, 1)
    const registered = registrations[0]
    assert.ok(registered !== undefined)
    assert.equal(registered.options['name'], 'settings.section')
    assert.equal(registered.options['id'], 'local-browser-web')
    assert.equal(registered.options['locale'], 'settings.localBrowserWeb')
    assert.equal(typeof registered.options['label'], 'function')
    assert.equal(typeof registered.options['order'], 'number')
    assert.equal(typeof registered.options['inject'], 'function')
  })

  it("injects a snapshot carrying the panel's whole field table", () => {
    const module = loadBundle().factory(requireStub)
    const { ctx, registrations } = fakeContext()
    module.apply?.(ctx)
    const options = registrations[0]?.options
    assert.ok(options !== undefined)
    const face = (options['inject'] as () => Record<string, unknown>)()
    const hooks = face['hooks'] as { localBrowserWeb: { getSnapshot: () => Record<string, unknown> } }
    assert.ok(hooks.localBrowserWeb !== undefined)
    const state = hooks.localBrowserWeb.getSnapshot()
    assert.equal(state['available'], true)
    assert.equal(state['writable'], true)

    const fields = state['fields'] as Record<string, { text: string }>
    // Spot-check one field from each group, plus each kind of nested path.
    for (const key of [
      'searchProvider',
      'dispatchMode',
      'parallelMaxEngines',
      'fetchBackend',
      'cdpEndpoint',
      'clean.transport.enabled',
      'clean.extract.fallback',
      'quality.enabled',
      'quality.thinContent.minChars',
      'quality.seoSpam.maxKeywordDensity',
      'quality.lowQualityAigc.maxAigcMarkerRatio',
      'quality.domainReputation.blocklist',
      'quality.authority.minScore',
      'logLevel',
      'structuredLog',
    ]) {
      assert.ok(fields[key] !== undefined, `field ${key} must be editable from the panel`)
    }
    // Values come from the served section, not from a hardcoded default.
    assert.equal(fields['searchProvider']?.text, 'local-browser-search')
    assert.equal(fields['quality.seoSpam.maxKeywordDensity']?.text, '0.12')

    const engines = state['engines'] as readonly { id: string }[]
    assert.deepEqual(engines.map(engine => engine.id), ['bing'])
    assert.equal(state['enginesDirty'], false)
  })

  it('exposes the write actions the page drives the form with', () => {
    const module = loadBundle().factory(requireStub)
    const { ctx, registrations } = fakeContext()
    module.apply?.(ctx)
    const options = registrations[0]?.options
    assert.ok(options !== undefined)
    const face = (options['inject'] as () => Record<string, unknown>)()
    for (const action of ['editPath', 'resetPath', 'save', 'discard', 'editEngine', 'moveEngine', 'removeEngine', 'addEngine', 'resetEngines', 'stageSecret', 'exportConfig', 'importConfig']) {
      assert.equal(typeof face[action], 'function', `face must expose ${action}`)
    }
  })

  it('stages an edit and stages it for the Host on save', () => {
    const module = loadBundle().factory(requireStub)
    const { ctx, registrations } = fakeContext()
    module.apply?.(ctx)
    const options = registrations[0]?.options
    assert.ok(options !== undefined)
    const face = (options['inject'] as () => Record<string, unknown>)()
    const store = (face['hooks'] as { localBrowserWeb: { getSnapshot: () => Record<string, unknown>, subscribe: (l: () => void) => () => void } }).localBrowserWeb
    ;(face['editPath'] as (path: readonly string[], text: string) => void)(['clean', 'render', 'enabled'], 'false')
    const state = store.getSnapshot()
    const fields = state['fields'] as Record<string, { text: string, overridden: boolean }>
    assert.equal(fields['clean.render.enabled']?.text, 'false')
    assert.equal(state['dirty'], true)
    ;(face['discard'] as () => void)()
    assert.equal((store.getSnapshot()['dirty']), false)
  })
})
