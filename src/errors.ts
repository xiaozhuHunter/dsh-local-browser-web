/**
 * Typed failures for the local-browser web plugin.
 *
 * Every failure extends `WebError`, the seam's own error class, so the code is
 * surfaced in structured error metadata exactly as a first-party provider's is:
 * the `ctx.web` seam, `dsh-tool-web` and the session log all route on `code`.
 *
 * Codes are an OPEN set — consumers must tolerate provider-specific codes — so
 * the shared web codes are reused verbatim and the plugin-specific ones are
 * added alongside them.
 *
 * @module dsh-local-browser-web/errors
 */
import { WebError } from '@deepseek-ai/dsh-web'

/** The plugin's own failure codes, plus the shared `ctx.web` ones it raises. */
export type LocalBrowserWebErrorCode =
  // ── shared with every web provider ───────────────────────────────────────
  /** No reachable browser backend (CDP endpoint down, Playwright not installed). */
  | 'BROWSER_UNAVAILABLE'
  /** A search or fetch exceeded its configured budget. */
  | 'WEB_FETCH_TIMEOUT'
  /** The page answered with an anti-bot / challenge page instead of content. */
  | 'WEB_FETCH_CHALLENGE'
  /** Rendering succeeded but no main content could be extracted. */
  | 'EXTRACTION_FAILED'
  /** Decoded body exceeded the configured size cap. */
  | 'CONTENT_TOO_LARGE'
  /** Response content-type is not one this provider can represent. */
  | 'UNSUPPORTED_CONTENT_TYPE'
  // ── plugin-specific ──────────────────────────────────────────────────────
  /** A custom engine's metadata is unusable (missing field, unparsable endpoint, unknown parser). */
  | 'ENGINE_CONFIG_INVALID'
  /** A settings-panel "test connection" run failed; carries the failing stage. */
  | 'ENGINE_TEST_FAILED'
  /** Every configured engine is disabled, so no query can run. */
  | 'NO_ENABLED_ENGINE'
  /**
   * Settings-panel save lost an optimistic-revision race.
   *
   * The Host's own conflict class reports `SETTINGS_CONFLICT`; this code is the
   * panel-facing alias the prompt names, raised by the client controller when it
   * maps that refusal onto UI copy.
   */
  | 'FORM_REVISION_CONFLICT'

/** Stage a failed engine test stopped at, for `ENGINE_TEST_FAILED` reporting. */
export type EngineTestStage = 'dns' | 'http' | 'parse' | 'credential'

/** One typed local-browser web failure. */
export class LocalBrowserWebError extends WebError {
  /**
   * @param message - human-readable description (never used for routing).
   * @param code - the machine-routable failure class.
   * @param options - optional `cause` chain.
   */
  constructor(message: string, code: LocalBrowserWebErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
