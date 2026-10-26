/**
 * The settings panel's staged form model.
 *
 * Why this exists rather than reusing `SettingsFormModel`: the official model
 * stages **single-segment** field paths only (`plan()` emits `path: [field]`), and
 * this plugin's form is mostly nested (`clean.transport.enabled`,
 * `quality.seoSpam.maxKeywordDensity`) plus one array (`engines`). So the same
 * staged-write contract is reimplemented here with path arrays — the browser half
 * cannot import the host's modules, and the primitives' model cannot express the
 * shape.
 *
 * Everything still goes through one `ConfigForm.mutate(ops, revision)` call, so the
 * Host keeps its single revision fence, its volatility check, and its recovery
 * read. Nothing here writes as the user types.
 *
 * @module dsh-local-browser-web/client/controller
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.configForms Context merge and the ConfigForm contract.
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelLocaleKey } from './locales.ts'

/**
 * The Host profile entry id this panel edits.
 *
 * Spelled here rather than imported from the host half: a client package must not
 * depend on a Host package (the client bundle purity gate forbids it), and the id
 * is deliberately the plugin row's id in `cordis.patch.yml`.
 */
export const ENTRY_ID = 'local-browser-web'

/** The panel's locale namespace. */
export const NS = 'settings.localBrowserWeb'

/** Which control a field projects to. */
export type FieldKind = 'text' | 'number' | 'boolean' | 'select' | 'lines'

/** One editable field, addressed by its path inside the config section. */
export interface FieldDef {
  /** Path inside the config section. */
  readonly path: readonly string[]
  /** The control to render. */
  readonly kind: FieldKind
  /** Allowed values for `select`, in display order. */
  readonly options?: readonly string[]
  /** Stable DOM id base. */
  readonly id: string
  /** Locale key of the label. */
  readonly labelKey: PanelLocaleKey
  /** Locale key of the one-line hint. */
  readonly hintKey: PanelLocaleKey
}

/**
 * Every field the panel edits, grouped by the tab that renders it.
 *
 * This table *is* the coverage guarantee: a field absent here is a field the user
 * cannot reach, so it is kept in step with `src/config.ts` deliberately rather
 * than derived (the browser half cannot read the Host schema).
 */
export const FIELD_GROUPS: readonly { readonly titleKey: PanelLocaleKey, readonly fields: readonly FieldDef[] }[] = [
  {
    titleKey: 'groupSearch',
    fields: [
      { path: ['searchProvider'], kind: 'select', options: ['local-browser-search', 'deepseek-official'], id: 'searchProvider', labelKey: 'searchProvider', hintKey: 'searchProviderHint' },
      { path: ['dispatchMode'], kind: 'select', options: ['bail', 'parallel'], id: 'dispatchMode', labelKey: 'dispatchMode', hintKey: 'dispatchModeHint' },
      { path: ['parallelMaxEngines'], kind: 'number', id: 'parallelMaxEngines', labelKey: 'parallelMaxEngines', hintKey: 'parallelMaxEnginesHint' },
      { path: ['searchTimeoutMs'], kind: 'number', id: 'searchTimeoutMs', labelKey: 'searchTimeoutMs', hintKey: 'searchTimeoutMsHint' },
      { path: ['searchScorer'], kind: 'text', id: 'searchScorer', labelKey: 'searchScorer', hintKey: 'searchScorerHint' },
      { path: ['rerankEndpoint'], kind: 'text', id: 'rerankEndpoint', labelKey: 'rerankEndpoint', hintKey: 'rerankEndpointHint' },
      { path: ['rerankModel'], kind: 'text', id: 'rerankModel', labelKey: 'rerankModel', hintKey: 'rerankModelHint' },
      { path: ['rerankTimeoutMs'], kind: 'number', id: 'rerankTimeoutMs', labelKey: 'rerankTimeoutMs', hintKey: 'rerankTimeoutMsHint' },
    ],
  },
  {
    titleKey: 'groupFetch',
    fields: [
      { path: ['fetchProvider'], kind: 'select', options: ['local-browser-fetch', 'http'], id: 'fetchProvider', labelKey: 'fetchProvider', hintKey: 'fetchProviderHint' },
      { path: ['fetchBackend'], kind: 'select', options: ['cdp', 'playwright', 'http'], id: 'fetchBackend', labelKey: 'fetchBackend', hintKey: 'fetchBackendHint' },
      { path: ['cdpEndpoint'], kind: 'text', id: 'cdpEndpoint', labelKey: 'cdpEndpoint', hintKey: 'cdpEndpointHint' },
      { path: ['browserPath'], kind: 'text', id: 'browserPath', labelKey: 'browserPath', hintKey: 'browserPathHint' },
      { path: ['headless'], kind: 'boolean', id: 'headless', labelKey: 'headless', hintKey: 'headlessHint' },
      { path: ['profileMode'], kind: 'select', options: ['shared', 'isolated'], id: 'profileMode', labelKey: 'profileMode', hintKey: 'profileModeHint' },
      { path: ['fetchTimeoutMs'], kind: 'number', id: 'fetchTimeoutMs', labelKey: 'fetchTimeoutMs', hintKey: 'fetchTimeoutMsHint' },
      { path: ['chromePath'], kind: 'text', id: 'chromePath', labelKey: 'chromePath', hintKey: 'chromePathHint' },
      { path: ['chromeProfileDir'], kind: 'text', id: 'chromeProfileDir', labelKey: 'chromeProfileDir', hintKey: 'chromeProfileDirHint' },
      { path: ['launchTimeoutMs'], kind: 'number', id: 'launchTimeoutMs', labelKey: 'launchTimeoutMs', hintKey: 'launchTimeoutMsHint' },
      { path: ['maxConcurrency'], kind: 'number', id: 'maxConcurrency', labelKey: 'maxConcurrency', hintKey: 'maxConcurrencyHint' },
      { path: ['maxResponseBytes'], kind: 'number', id: 'maxResponseBytes', labelKey: 'maxResponseBytes', hintKey: 'maxResponseBytesHint' },
      { path: ['maxBodyChars'], kind: 'number', id: 'maxBodyChars', labelKey: 'maxBodyChars', hintKey: 'maxBodyCharsHint' },
      { path: ['userAgent'], kind: 'text', id: 'userAgent', labelKey: 'userAgent', hintKey: 'userAgentHint' },
    ],
  },
  {
    titleKey: 'groupProxy',
    fields: [
      { path: ['proxy', 'enabled'], kind: 'boolean', id: 'proxyEnabled', labelKey: 'proxyEnabled', hintKey: 'proxyEnabledHint' },
      { path: ['proxy', 'url'], kind: 'text', id: 'proxyUrl', labelKey: 'proxyUrl', hintKey: 'proxyUrlHint' },
      { path: ['proxy', 'bypass'], kind: 'text', id: 'proxyBypass', labelKey: 'proxyBypass', hintKey: 'proxyBypassHint' },
      { path: ['proxy', 'http'], kind: 'boolean', id: 'proxyHttp', labelKey: 'proxyHttp', hintKey: 'proxyHttpHint' },
      { path: ['proxy', 'browser'], kind: 'boolean', id: 'proxyBrowser', labelKey: 'proxyBrowser', hintKey: 'proxyBrowserHint' },
    ],
  },
  {
    titleKey: 'groupClean',
    fields: [
      { path: ['clean', 'transport', 'enabled'], kind: 'boolean', id: 'cleanTransport', labelKey: 'cleanTransport', hintKey: 'cleanTransportHint' },
      { path: ['clean', 'render', 'enabled'], kind: 'boolean', id: 'cleanRender', labelKey: 'cleanRender', hintKey: 'cleanRenderHint' },
      { path: ['clean', 'extract', 'enabled'], kind: 'boolean', id: 'cleanExtract', labelKey: 'cleanExtract', hintKey: 'cleanExtractHint' },
      { path: ['clean', 'extract', 'fallback'], kind: 'boolean', id: 'cleanExtractFallback', labelKey: 'cleanExtractFallback', hintKey: 'cleanExtractFallbackHint' },
      { path: ['clean', 'markdown', 'enabled'], kind: 'boolean', id: 'cleanMarkdown', labelKey: 'cleanMarkdown', hintKey: 'cleanMarkdownHint' },
      { path: ['clean', 'quality', 'enabled'], kind: 'boolean', id: 'cleanQuality', labelKey: 'cleanQuality', hintKey: 'cleanQualityHint' },
    ],
  },
  {
    titleKey: 'groupQuality',
    fields: [
      { path: ['quality', 'enabled'], kind: 'boolean', id: 'qualityEnabled', labelKey: 'qualityEnabled', hintKey: 'qualityEnabledHint' },
      { path: ['quality', 'thinContent', 'enabled'], kind: 'boolean', id: 'qThinEnabled', labelKey: 'qualityThin', hintKey: 'qualityThinHint' },
      { path: ['quality', 'thinContent', 'minChars'], kind: 'number', id: 'qThinMinChars', labelKey: 'qualityThinMinChars', hintKey: 'qualityThinMinCharsHint' },
      { path: ['quality', 'snippetMinChars'], kind: 'number', id: 'qSnippetMinChars', labelKey: 'qualitySnippetMinChars', hintKey: 'qualitySnippetMinCharsHint' },
      { path: ['quality', 'seoSpam', 'enabled'], kind: 'boolean', id: 'qSeoEnabled', labelKey: 'qualitySeo', hintKey: 'qualitySeoHint' },
      { path: ['quality', 'seoSpam', 'maxKeywordDensity'], kind: 'number', id: 'qSeoDensity', labelKey: 'qualitySeoDensity', hintKey: 'qualitySeoDensityHint' },
      { path: ['quality', 'seoSpam', 'maxDuplicateRatio'], kind: 'number', id: 'qSeoDuplicate', labelKey: 'qualitySeoDuplicate', hintKey: 'qualitySeoDuplicateHint' },
      { path: ['quality', 'lowQualityAigc', 'enabled'], kind: 'boolean', id: 'qAigcEnabled', labelKey: 'qualityAigc', hintKey: 'qualityAigcHint' },
      { path: ['quality', 'lowQualityAigc', 'maxAigcMarkerRatio'], kind: 'number', id: 'qAigcRatio', labelKey: 'qualityAigcRatio', hintKey: 'qualityAigcRatioHint' },
      { path: ['quality', 'domainReputation', 'enabled'], kind: 'boolean', id: 'qDomainEnabled', labelKey: 'qualityDomain', hintKey: 'qualityDomainHint' },
      { path: ['quality', 'domainReputation', 'blocklist'], kind: 'lines', id: 'qBlocklist', labelKey: 'qualityBlocklist', hintKey: 'qualityBlocklistHint' },
      { path: ['quality', 'domainReputation', 'allowlist'], kind: 'lines', id: 'qAllowlist', labelKey: 'qualityAllowlist', hintKey: 'qualityAllowlistHint' },
      { path: ['quality', 'authority', 'enabled'], kind: 'boolean', id: 'qAuthorityEnabled', labelKey: 'qualityAuthority', hintKey: 'qualityAuthorityHint' },
      { path: ['quality', 'authority', 'minScore'], kind: 'number', id: 'qAuthorityMin', labelKey: 'qualityAuthorityMin', hintKey: 'qualityAuthorityMinHint' },
      { path: ['quality', 'freshness', 'enabled'], kind: 'boolean', id: 'qFreshEnabled', labelKey: 'qualityFreshness', hintKey: 'qualityFreshnessHint' },
      { path: ['quality', 'freshness', 'staleDays'], kind: 'number', id: 'qFreshStaleDays', labelKey: 'qualityStaleDays', hintKey: 'qualityStaleDaysHint' },
      { path: ['quality', 'conflict', 'enabled'], kind: 'boolean', id: 'qConflictEnabled', labelKey: 'qualityConflict', hintKey: 'qualityConflictHint' },
      { path: ['quality', 'annotate', 'enabled'], kind: 'boolean', id: 'qAnnotateEnabled', labelKey: 'qualityAnnotate', hintKey: 'qualityAnnotateHint' },
    ],
  },
  {
    titleKey: 'groupGeneral',
    fields: [
      { path: ['logLevel'], kind: 'select', options: ['silent', 'error', 'warn', 'info', 'debug'], id: 'logLevel', labelKey: 'logLevel', hintKey: 'logLevelHint' },
      { path: ['structuredLog'], kind: 'boolean', id: 'structuredLog', labelKey: 'structuredLog', hintKey: 'structuredLogHint' },
    ],
  },
]

/** One engine entry as the browser half sees it. */
export interface EngineView {
  id: string
  label: string
  kind: string
  endpoint: string
  requiresKey: boolean
  credentialRef?: string
  resultParser: string
  priority: number
  enabledByDefault: boolean
  enabled: boolean
  extraParams?: Record<string, unknown>
}

/** What the Host reports about one credential reference (never the value). */
export interface CredentialState {
  configured: boolean
  writable: boolean
}

/** One browser-control verdict, mirrored from the host route's response. */
export interface BrowserStatusView {
  /** Whether the endpoint answered. */
  ok: boolean
  /** Whether Chrome is reachable on the configured port. */
  running: boolean
  /** The endpoint that was probed. */
  endpoint: string
  /** Browser string reported by CDP. */
  browser?: string
  /** Executable the launch resolved. */
  chromePath?: string
  /** Profile directory the launch used (or would use). */
  profileDir: string
  /** Whether this call spawned Chrome. */
  launched: boolean
  /** Machine-readable failure code. */
  code?: string
  /** Human-readable failure detail. */
  message?: string
  /** Candidate executables that were checked. */
  searched: string[]
}

/** The whole panel's render state. */
export interface PanelState extends SettingsFormShell {
  /** Field states keyed by `path.join('.')`. */
  fields: Record<string, SettingsFieldState>
  /** The engine list as it stands (draft applied). */
  engines: EngineView[]
  /** Whether the engine list differs from the stored section. */
  enginesDirty: boolean
  /** Credential availability per reference. */
  credentials: Record<string, CredentialState>
  /** Staged credential drafts per reference (blank until typed; never seeded from a response). */
  secrets: Record<string, string>
  /** Whether the last refusal was (or may have been) a revision conflict. */
  conflict: boolean
}

/** Read one member of a nested path. */
function atPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = Reflect.get(cursor, segment)
  }
  return cursor
}

/** Render a stored value as draft text. */
export function formatValue(kind: FieldKind, value: unknown): string {
  switch (kind) {
    case 'boolean': return value === true ? 'true' : 'false'
    case 'number': return typeof value === 'number' ? String(value) : ''
    case 'lines': return Array.isArray(value) ? value.filter(line => typeof line === 'string').join('\n') : ''
    default: return typeof value === 'string' ? value : ''
  }
}

/** The write a draft text asks for, or undefined when the draft is not accepted. */
export function parseValue(kind: FieldKind, text: string): { value: unknown } | 'clear' | undefined {
  const trimmed = text.trim()
  switch (kind) {
    case 'boolean':
      if (text === 'true') return { value: true }
      if (text === 'false') return { value: false }
      return undefined
    case 'number': {
      if (trimmed === '') return 'clear'
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { value: parsed } : undefined
    }
    case 'lines':
      return { value: trimmed === '' ? [] : trimmed.split('\n').map(line => line.trim()).filter(line => line.length > 0) }
    default:
      return trimmed === '' ? 'clear' : { value: trimmed }
  }
}

/** Move one engine by `delta`, rewriting priorities so order and priority agree. */
export function moveEngineIn(list: readonly EngineView[], id: string, delta: number): EngineView[] {
  const ordered = [...list]
  const index = ordered.findIndex(engine => engine.id === id)
  if (index < 0) return ordered
  const target = Math.min(Math.max(index + delta, 0), ordered.length - 1)
  if (target === index) return ordered
  const [moved] = ordered.splice(index, 1)
  if (moved === undefined) return ordered
  ordered.splice(target, 0, moved)
  return ordered.map((engine, position) => ({ ...engine, priority: (position + 1) * 10 }))
}

/** Stages edits over one Host entry and writes them on save. */
export class PanelForm {
  private readonly store: SnapshotStore<PanelState>
  private readonly specs = new Map<string, FieldDef>()
  private readonly staged = new Map<string, { text: string, clear: boolean }>()
  private readonly stagedSecrets = new Map<string, string>()
  private readonly credentials = new Map<string, CredentialState>()
  private enginesDraft: EngineView[] | undefined
  private baselineRevision: number | undefined
  private saving = false
  private failed = false
  private conflict = false
  private readonly unsubscribe: () => void

  /**
   * @param scope - the shared config form for this plugin's Host entry.
   * @param ctx - the panel plugin's context, whose `remote.credentials` answers for engine keys.
   */
  constructor(
    private readonly scope: ConfigForm<Record<string, unknown>>,
    private readonly ctx: ClientContext,
  ) {
    for (const group of FIELD_GROUPS) {
      for (const field of group.fields) this.specs.set(field.path.join('.'), field)
    }
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = this.scope.subscribe(() => {
      this.store.set(this.project())
      void this.readCredentials()
    })
    void this.readCredentials()
  }

  /** The snapshot store the panel's slot injects as a hook. */
  get snapshot(): SnapshotStore<PanelState> {
    return this.store
  }

  /** Release the config subscription. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Stage draft text for one field. */
  editPath(path: readonly string[], text: string): void {
    const key = path.join('.')
    const spec = this.specs.get(key)
    if (spec === undefined) return
    this.baselineRevision ??= this.scope.getSnapshot().revision
    this.staged.set(key, { text, clear: false })
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Stage a clear so the field re-inherits the composition layer. */
  resetPath(path: readonly string[]): void {
    const key = path.join('.')
    const spec = this.specs.get(key)
    if (spec === undefined) return
    this.baselineRevision ??= this.scope.getSnapshot().revision
    this.staged.set(key, { text: formatValue(spec.kind, atPath(this.section(), path)), clear: true })
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Stage one credential literal, written through the credentials domain on save. */
  stageSecret(ref: string, text: string): void {
    this.baselineRevision ??= this.scope.getSnapshot().revision
    this.stagedSecrets.set(ref, text)
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Replace the engine list draft (add / remove / reorder / edit). */
  setEngines(next: EngineView[]): void {
    this.baselineRevision ??= this.scope.getSnapshot().revision
    this.enginesDraft = next
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Apply a partial edit to one engine, staging the whole list. */
  editEngine(id: string, patch: Partial<EngineView>): void {
    const current = this.engines()
    this.setEngines(current.map(engine => (engine.id === id ? { ...engine, ...patch } : engine)))
  }

  /** Drop a staged engine edit, returning the list to the stored section. */
  resetEngines(): void {
    this.enginesDraft = undefined
    this.failed = false
    this.publish()
  }

  /** Append one engine to the staged list. */
  addEngine(engine: EngineView): void {
    this.setEngines([...this.engines(), engine])
  }

  /** Remove one engine from the staged list. */
  removeEngine(id: string): void {
    this.setEngines(this.engines().filter(engine => engine.id !== id))
  }

  /** Move one engine up or down inside the staged list. */
  moveEngine(id: string, delta: number): void {
    this.setEngines(moveEngineIn(this.engines(), id, delta))
  }

  /**
   * A deep copy of the stored config section, for the export control.
   * @returns the section as stored, or an empty object before the first read.
   */
  exportSection(): Record<string, unknown> {
    const section = this.section()
    return section === undefined ? {} : structuredClone(section) as Record<string, unknown>
  }

  /**
   * Stage an imported document as ordinary field edits.
   *
   * Import deliberately reuses the same staging path as typing, so an imported
   * value goes through the identical Host validation and revision fence as a
   * hand-edited one — an import is a convenience, not a bypass.
   *
   * @param section - a document shaped like the plugin's config section.
   */
  stageImport(section: Record<string, unknown>): void {
    for (const [key, spec] of this.specs) {
      const value = atPath(section, spec.path)
      if (value === undefined) continue
      this.staged.set(key, { text: formatValue(spec.kind, value), clear: false })
    }
    const engines = atPath(section, ['engines'])
    if (Array.isArray(engines)) {
      this.enginesDraft = engines.filter(isEngineView).map(engine => ({ ...engine }))
    }
    this.baselineRevision ??= this.scope.getSnapshot().revision
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Write every staged edit in one revision-fenced mutation. */
  async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    if (this.saving || !snapshot.writable) return
    const ops: SettingsPathOpView[] = []
    let invalid = false
    for (const [key, staged] of this.staged) {
      const spec = this.specs.get(key)
      if (spec === undefined) continue
      if (staged.clear) {
        ops.push({ op: 'unset', path: [...spec.path] })
        continue
      }
      const write = parseValue(spec.kind, staged.text)
      if (write === undefined) { invalid = true; continue }
      if (write === 'clear') ops.push({ op: 'unset', path: [...spec.path] })
      else ops.push({ op: 'set', path: [...spec.path], value: write.value as JsonValue })
    }
    if (this.enginesDraft !== undefined) {
      ops.push({ op: 'set', path: ['engines'], value: this.enginesDraft as unknown as JsonValue })
    }
    const secrets = [...this.stagedSecrets.entries()].filter(([, text]) => text.trim().length > 0)
    if (invalid || (ops.length === 0 && secrets.length === 0)) return

    this.saving = true
    this.failed = false
    this.conflict = false
    this.publish()
    try {
      let landed = ops.length === 0 || await this.scope.mutate(ops, this.baselineRevision)
      if (!landed) {
        // `mutate` answers only accepted/refused, so a refusal is reported as a
        // POSSIBLE revision conflict rather than asserted to be one.
        this.failed = true
        this.conflict = ops.length > 0
        return
      }
      for (const [ref, text] of secrets) {
        const accepted = await this.writeCredential(ref, text)
        landed = accepted && landed
      }
      if (landed) {
        this.staged.clear()
        this.stagedSecrets.clear()
        this.enginesDraft = undefined
        this.baselineRevision = undefined
        await this.readCredentials()
      }
      this.failed = !landed
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Drop every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && this.stagedSecrets.size === 0 && this.enginesDraft === undefined && !this.failed) return
    this.staged.clear()
    this.stagedSecrets.clear()
    this.enginesDraft = undefined
    this.baselineRevision = undefined
    this.failed = false
    this.conflict = false
    this.publish()
  }

  /** Re-ask the credentials domain after the Host reports a change to one reference. */
  refreshCredential(ref: string): void {
    if (!this.credentials.has(ref) && !this.knownRefs().includes(ref)) return
    void this.readCredentials()
  }

  private section(): Record<string, unknown> | undefined {
    return this.scope.getSnapshot().value
  }

  private userLayer(): Record<string, unknown> | undefined {
    const user = this.scope.getSnapshot().user
    return user !== null && typeof user === 'object' && !Array.isArray(user) ? user as Record<string, unknown> : undefined
  }

  /** The engine list the panel shows: the draft when one is staged, else the section. */
  engines(): EngineView[] {
    if (this.enginesDraft !== undefined) return this.enginesDraft
    const stored = this.section()?.['engines']
    if (!Array.isArray(stored)) return []
    return stored.filter(isEngineView).map(engine => ({ ...engine }))
  }

  private knownRefs(): string[] {
    return this.engines()
      .filter(engine => engine.requiresKey && (engine.credentialRef ?? '').length > 0)
      .map(engine => engine.credentialRef as string)
  }

  private async readCredentials(): Promise<void> {
    const refs = [...new Set(this.knownRefs())]
    if (refs.length === 0) return
    try {
      const response = await this.ctx.remote.credentials.describe(refs)
      if (!response.ok) return
      const value = response.value as Record<string, { configured?: boolean, writable?: boolean } | undefined>
      for (const ref of refs) {
        const view = value[ref]
        this.credentials.set(ref, { configured: view?.configured ?? false, writable: view?.writable ?? true })
      }
      this.publish()
    } catch {
      // A credentials domain that refuses to answer leaves the controls enabled;
      // the Host is the authority on whether a write of a new key lands.
    }
  }

  private async writeCredential(ref: string, value: string): Promise<boolean> {
    try {
      await this.ctx.remote.credentials.set(ref, value)
      await this.readCredentials()
      return this.credentials.get(ref)?.configured ?? false
    } catch {
      return false
    }
  }

  /** Build the whole render state from the scope snapshot and the drafts. */
  private project(): PanelState {
    const snapshot = this.scope.getSnapshot()
    const fields: Record<string, SettingsFieldState> = {}
    for (const [key, spec] of this.specs) {
      const stored = atPath(snapshot.value, spec.path)
      const staged = this.staged.get(key)
      if (staged === undefined) {
        fields[key] = {
          text: formatValue(spec.kind, stored),
          overridden: atPath(this.userLayer(), spec.path) !== undefined,
          invalid: false,
        }
        continue
      }
      const write = staged.clear ? 'clear' : parseValue(spec.kind, staged.text)
      fields[key] = {
        text: staged.text,
        overridden: write !== 'clear' && write !== undefined,
        invalid: write === undefined,
      }
    }
    const credentials: Record<string, CredentialState> = {}
    for (const [ref, state] of this.credentials) credentials[ref] = state
    const secrets: Record<string, string> = {}
    for (const [ref, text] of this.stagedSecrets) secrets[ref] = text
    const dirty = this.staged.size > 0 || this.enginesDraft !== undefined
      || [...this.stagedSecrets.values()].some(text => text.trim().length > 0)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty,
      invalid: Object.values(fields).some(field => field.invalid),
      saving: this.saving,
      failed: this.failed,
      conflict: this.conflict,
      fields,
      engines: this.engines(),
      enginesDirty: this.enginesDraft !== undefined,
      credentials,
      secrets,
    }
  }

  private publish(): void {
    this.store.set(this.project())
  }
}

/** Narrow one stored engine entry to the panel's view. */
function isEngineView(value: unknown): value is EngineView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && typeof record['endpoint'] === 'string'
}

/** The write actions the panel's slot entry injects as props. */
export interface PanelActions {
  /** Stage draft text for one field path. */
  editPath(path: readonly string[], text: string): void
  /** Stage a clear so the field re-inherits the composition layer. */
  resetPath(path: readonly string[]): void
  /** Write every staged edit. */
  save(): void
  /** Drop every staged edit. */
  discard(): void
  /** Apply a partial edit to one engine of the staged list. */
  editEngine(id: string, patch: Partial<EngineView>): void
  /** Move one engine up (-1) or down (+1). */
  moveEngine(id: string, delta: number): void
  /** Remove one engine. */
  removeEngine(id: string): void
  /** Append one engine. */
  addEngine(engine: EngineView): void
  /** Drop the staged engine-list edit. */
  resetEngines(): void
  /** Stage one engine credential literal. */
  stageSecret(ref: string, text: string): void
  /** The stored config section, for the export control. */
  exportConfig(): Record<string, unknown>
  /** Stage an imported document as ordinary field edits. */
  importConfig(section: Record<string, unknown>): void
  /** Probe the CDP endpoint without starting anything. */
  browserStatus(): Promise<BrowserStatusView>
  /** Probe, and start Chrome when the endpoint is absent. */
  launchBrowser(): Promise<BrowserStatusView>
}

/**
 * The business face a slot entry injects.
 *
 * `hooks` is the reserved compartment: the renderer binds `localBrowserWeb` as a
 * `useLocalBrowserWeb(selector)` prop. Every other member arrives verbatim.
 */
export interface PanelFace extends PanelActions {
  hooks: {
    /** Bound by the renderer as `useLocalBrowserWeb`. */
    localBrowserWeb: SnapshotStore<PanelState>
  }
}

/**
 * The carrier the panel uses for the host's browser-control route.
 *
 * Declared structurally so this module does not import the HTTP carrier: the
 * panel only needs the two actions, and a test can pass a plain stub.
 */
export interface BrowserControlFace {
  /** Probe the endpoint. */
  status(): Promise<BrowserStatusView>
  /** Probe, and start Chrome when absent. */
  launch(): Promise<BrowserStatusView>
}

/**
 * Bind one form instance onto the face a slot registration injects.
 * @param form - the panel's staged form model.
 * @param browser - the browser-control carrier.
 * @returns the face: snapshot hook plus every write action.
 */
export function panelFace(form: PanelForm, browser: BrowserControlFace): PanelFace {
  return {
    hooks: { localBrowserWeb: form.snapshot },
    editPath: (path, text) => { form.editPath(path, text) },
    resetPath: (path) => { form.resetPath(path) },
    save: () => { void form.save() },
    discard: () => { form.discard() },
    editEngine: (id, patch) => { form.editEngine(id, patch) },
    moveEngine: (id, delta) => { form.moveEngine(id, delta) },
    removeEngine: (id) => { form.removeEngine(id) },
    addEngine: (engine) => { form.addEngine(engine) },
    resetEngines: () => { form.resetEngines() },
    stageSecret: (ref, text) => { form.stageSecret(ref, text) },
    exportConfig: () => form.exportSection(),
    importConfig: (section) => { form.stageImport(section) },
    browserStatus: async () => await browser.status(),
    launchBrowser: async () => await browser.launch(),
  }
}
