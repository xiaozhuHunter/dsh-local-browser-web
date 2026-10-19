/**
 * The search-engine registry.
 *
 * The registry is the plugin's answer to "search engines must not be hardcoded":
 * Bing and DuckDuckGo are ordinary entries in the plugin config, and a third-party
 * plugin can add an engine at runtime through the public service without touching
 * this package. Dispatch reads `list()`/`enabled()` and never names a concrete id.
 *
 * `kind` is descriptive only — the execution layer routes on it (HTTP fetch,
 * browser render, credentialed JSON). The registry says *what* an engine is.
 *
 * @module dsh-local-browser-web/engines/registry
 */
import { engineProblems } from '../config.ts'
import { LocalBrowserWebError } from '../errors.ts'
import type { EngineSpec } from '../types.ts'

/** Stable fallback order: lower `priority` first, then alphabetical by id. */
export function sortEngines(engines: readonly EngineSpec[]): EngineSpec[] {
  return [...engines].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * Move one engine by `delta` positions inside a priority-ordered list, rewriting
 * `priority` so the array order and the priorities cannot disagree.
 *
 * @param engines - the current list.
 * @param id - the engine to move.
 * @param delta - negative moves up, positive down.
 * @returns a new list, or the input list when the move is impossible.
 */
export function moveEngine(engines: readonly EngineSpec[], id: string, delta: number): EngineSpec[] {
  const ordered = sortEngines(engines)
  const index = ordered.findIndex(engine => engine.id === id)
  if (index < 0) return [...engines]
  const target = Math.min(Math.max(index + delta, 0), ordered.length - 1)
  if (target === index) return ordered
  const [moved] = ordered.splice(index, 1)
  if (moved === undefined) return ordered
  ordered.splice(target, 0, moved)
  return ordered.map((engine, position) => ({ ...engine, priority: (position + 1) * 10 }))
}

/** Append an engine, or replace the entry with the same id. */
export function upsertEngine(engines: readonly EngineSpec[], spec: EngineSpec): EngineSpec[] {
  const index = engines.findIndex(engine => engine.id === spec.id)
  if (index < 0) return [...engines, spec]
  return engines.map((engine, position) => (position === index ? spec : engine))
}

/** Remove an engine by id. */
export function removeEngine(engines: readonly EngineSpec[], id: string): EngineSpec[] {
  return engines.filter(engine => engine.id !== id)
}

/** Flip one engine's `enabled` flag. */
export function setEngineEnabled(engines: readonly EngineSpec[], id: string, enabled: boolean): EngineSpec[] {
  return engines.map(engine => (engine.id === id ? { ...engine, enabled } : engine))
}

/**
 * Read-only view over the config's engine list plus runtime registrations.
 *
 * Runtime additions are kept apart from the config list: they are contributed by
 * code (a third-party plugin's fiber), so they disappear with that fiber rather
 * than being written into the user's configuration. A config entry with the same
 * id wins, because the user's explicit entry is the one they can see and edit.
 */
export class EngineRegistry {
  private readonly runtime = new Map<string, EngineSpec>()

  /**
   * @param read - reads the current config engine list (called per operation, so
   * a settings save is picked up immediately).
   * @param parserIds - ids the parser registry currently knows, used for validation.
   */
  constructor(
    private readonly read: () => EngineSpec[],
    private readonly parserIds: () => string[],
  ) {}

  /**
   * Add a runtime engine.
   * @param spec - the engine to add.
   * @returns the disposer removing it again.
   * @throws {LocalBrowserWebError} `ENGINE_CONFIG_INVALID` when the entry is unusable.
   */
  register(spec: EngineSpec): () => void {
    const problems = engineProblems(spec, this.parserIds())
    if (problems.length > 0) {
      throw new LocalBrowserWebError(
        `local-browser-web: 注册引擎 "${spec.id || '(未命名)'}" 失败：${problems.join('；')}`,
        'ENGINE_CONFIG_INVALID',
      )
    }
    this.runtime.set(spec.id, spec)
    return () => {
      if (this.runtime.get(spec.id) === spec) this.runtime.delete(spec.id)
    }
  }

  /** Every configured engine plus runtime additions, in dispatch order. */
  list(): EngineSpec[] {
    const configured = this.read()
    const configuredIds = new Set(configured.map(engine => engine.id))
    const extras = [...this.runtime.values()].filter(engine => !configuredIds.has(engine.id))
    return sortEngines([...configured, ...extras])
  }

  /** Only the engines dispatch may use, in dispatch order. */
  enabled(): EngineSpec[] {
    return this.list().filter(engine => engine.enabled)
  }

  /** One engine by id, configured or runtime. */
  get(id: string): EngineSpec | undefined {
    return this.list().find(engine => engine.id === id)
  }

  /** Ids of every runtime-registered engine, for diagnostics. */
  runtimeIds(): string[] {
    return [...this.runtime.keys()].sort()
  }
}
