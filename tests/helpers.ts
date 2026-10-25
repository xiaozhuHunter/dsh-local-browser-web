/**
 * Shared fixtures for the unit tests.
 *
 * @module dsh-local-browser-web/tests/helpers
 */
import { DEFAULT_ENGINES, type ResolvedConfig } from '../src/config.ts'
import type { EngineSpec } from '../src/types.ts'

/** A fully-resolved config with sensible test defaults; override only what a test cares about. */
export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    searchProvider: 'local-browser-search',
    dispatchMode: 'bail',
    parallelMaxEngines: 2,
    engines: DEFAULT_ENGINES.map(engine => ({ ...engine })),
    searchTimeoutMs: 20_000,
    fetchProvider: 'local-browser-fetch',
    fetchBackend: 'cdp',
    browserPath: undefined,
    cdpEndpoint: 'http://127.0.0.1:9222',
    headless: true,
    profileMode: 'shared',
    fetchTimeoutMs: 45_000,
    maxConcurrency: 2,
    maxResponseBytes: 5_000_000,
    maxBodyChars: 100_000,
    // Empty is the shipped default: HTTP falls back to the built-in browser UA and
    // the browser transports keep the UA of the Chrome they drive.
    userAgent: '',
    proxy: { enabled: false, url: '', bypass: 'localhost,127.0.0.1,::1', http: true, browser: true },
    clean: {
      transport: true,
      render: true,
      extract: true,
      extractFallback: true,
      markdown: true,
      quality: true,
    },
    quality: {
      enabled: true,
      thinContent: { enabled: true, minChars: 200 },
      snippetMinChars: 40,
      seoSpam: { enabled: true, maxKeywordDensity: 0.12, maxDuplicateRatio: 0.5 },
      lowQualityAigc: { enabled: true, maxAigcMarkerRatio: 0.05 },
      domainReputation: { enabled: true, blocklist: [], allowlist: [] },
      authority: { enabled: true, minScore: 30 },
      freshness: { enabled: true, staleDays: 365 },
      conflict: { enabled: true },
      annotate: { enabled: true },
    },
    logLevel: 'silent',
    structuredLog: false,
    ...overrides,
  }
}

/** An engine entry for registry/dispatch tests. */
export function makeEngine(overrides: Partial<EngineSpec> = {}): EngineSpec {
  return {
    id: 'test',
    label: 'Test',
    kind: 'http-html',
    endpoint: 'https://example.com/search',
    requiresKey: false,
    resultParser: 'html-bing',
    priority: 10,
    enabledByDefault: false,
    enabled: true,
    ...overrides,
  }
}

/**
 * The value a call threw.
 *
 * `assert.throws` is typed as returning nothing in this Node typings version, so an
 * `instanceof` check on its result does not compile. Catching here keeps the
 * identity of the thrown value (and therefore `instanceof` and `.code`) intact.
 * @param run - the call expected to throw.
 * @returns whatever was thrown.
 */
export function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

/** The reason a promise rejected. @param run - the call expected to reject. */
export async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to reject')
}
