/**
 * The `local-browser-fetch` provider.
 *
 * It owns no cleaning logic itself — that is the pipeline's — so this file is the
 * seam adapter: read a config snapshot, run the four stages, project the outcome
 * into `WebFetchResult`, and record what happened.
 *
 * @module dsh-local-browser-web/providers/fetch
 */
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { LOCAL_FETCH_PROVIDER_ID, type ResolvedConfig } from '../config.ts'
import { LocalBrowserWebError } from '../errors.ts'
import type { FetchBackendRegistry } from '../fetch/backends.ts'
import { runFetchPipeline } from '../fetch/pipeline.ts'
import type { Diagnostics } from '../log.ts'

/** What the provider reads per operation. */
export interface FetchProviderDeps {
  config: () => ResolvedConfig
  backends: FetchBackendRegistry
  diagnostics: Diagnostics
}

/** Local-browser fetch with the four-stage cleaning pipeline. */
export class LocalBrowserFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param deps - live config, the backend registry, and diagnostics.
   */
  constructor(private readonly deps: FetchProviderDeps) {}

  /**
   * Cheap, network-free usability check: this provider is selected and its backend
   * is registered.
   */
  available(): boolean {
    const config = this.deps.config()
    return config.fetchProvider === LOCAL_FETCH_PROVIDER_ID && this.deps.backends.has(config.fetchBackend)
  }

  /**
   * Retrieve one URL through the cleaning pipeline.
   * @param request - the URL.
   * @param signal - cancellation.
   * @returns the seam's fetch result shape (a non-2xx status is a result, not a throw).
   */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const config = this.deps.config()
    const started = Date.now()
    try {
      const outcome = await runFetchPipeline(request.url, config, this.deps.backends, signal)
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'fetch',
        backend: outcome.backend,
        target: outcome.url,
        elapsedMs: Date.now() - started,
        chars: outcome.chars,
        quality: outcome.quality,
      })
      return {
        url: outcome.url,
        statusCode: outcome.statusCode,
        body: outcome.body,
        truncated: outcome.truncated,
      }
    } catch (error) {
      this.deps.diagnostics.record({
        at: Date.now(),
        kind: 'fetch',
        backend: config.clean.render ? config.fetchBackend : 'http',
        target: request.url,
        elapsedMs: Date.now() - started,
        code: error instanceof LocalBrowserWebError ? error.code : 'EXTRACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
