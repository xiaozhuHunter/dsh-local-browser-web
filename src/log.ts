/**
 * Structured logging and the diagnostics ring.
 *
 * Every search and fetch emits one record: which engine or backend served it, how
 * long it took, how many characters came back, which quality rules fired, and —
 * on failure — the machine code. Prose lines go to the Cordis logger; the same
 * records are retained in a bounded ring so `local_search_test` can report recent
 * failures without the caller having to read logs.
 *
 * The ring is bounded on purpose: a diagnostics buffer that grows without limit
 * is a leak, and only the recent past is actionable.
 *
 * @module dsh-local-browser-web/log
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LogLevel } from './types.ts'
import type { QualityVerdict } from './types.ts'

/** One completed (or failed) web operation. */
export interface OperationRecord {
  /** When the operation finished. */
  at: number
  /** Which capability ran. */
  kind: 'search' | 'fetch'
  /** Search engine id, when the operation was a search. */
  engine?: string
  /** Fetch backend id, when the operation was a fetch. */
  backend?: string
  /** Target URL (fetch) or query (search). */
  target: string
  /** Wall-clock duration in milliseconds. */
  elapsedMs: number
  /** Characters of content produced. */
  chars?: number
  /** Quality verdict, when one was computed. */
  quality?: QualityVerdict
  /** Failure code, when the operation did not succeed. */
  code?: string
  /** Failure message. */
  message?: string
}

/** Log verbosity ordering: a record is emitted when its level is at or above the configured one. */
const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

/** How many records the ring retains. */
const RING_SIZE = 50

/** Emits structured log lines and retains the recent operations. */
export class Diagnostics {
  private readonly ring: OperationRecord[] = []

  /**
   * @param logger - the Cordis logger (or undefined when the context has none).
   * @param level - reads the live configured level, so a save takes effect immediately.
   * @param structured - reads whether to emit one JSON line instead of prose.
   */
  constructor(
    private readonly logger: Context['logger'] | undefined,
    private readonly level: () => LogLevel,
    private readonly structured: () => boolean,
  ) {}

  /**
   * Retain and emit one record.
   * @param record - the completed operation.
   */
  record(record: OperationRecord): void {
    this.ring.push(record)
    if (this.ring.length > RING_SIZE) this.ring.shift()
    const configured = LEVELS[this.level()]
    const wanted = record.code === undefined ? LEVELS.info : LEVELS.warn
    if (configured < wanted || configured === 0) return
    if (this.structured()) {
      this.emitJson(record)
      return
    }
    const where = record.engine ?? record.backend ?? '-'
    const bits = [`kind=${record.kind}`, `via=${where}`, `ms=${String(Math.round(record.elapsedMs))}`]
    if (record.chars !== undefined) bits.push(`chars=${String(record.chars)}`)
    if (record.quality !== undefined) bits.push(`score=${String(record.quality.score)}`, `flags=${record.quality.flags.join(',') || '-'}`)
    if (record.code !== undefined) bits.push(`code=${record.code}`)
    const line = `local-browser-web ${bits.join(' ')} target=${record.target}`
    if (record.code !== undefined) this.logger?.warn(`${line} ${record.message ?? ''}`)
    else this.logger?.info(line)
  }

  private emitJson(record: OperationRecord): void {
    const line = JSON.stringify(record)
    if (record.code !== undefined) this.logger?.warn(line)
    else this.logger?.info(line)
  }

  /**
   * The most recent operations, newest first.
   * @param limit - how many to return (default all retained).
   * @param onlyFailures - keep only records that carry a failure code.
   * @returns a detached copy, safe to serialize into a tool result.
   */
  recent(limit = RING_SIZE, onlyFailures = false): OperationRecord[] {
    const filtered = onlyFailures ? this.ring.filter(record => record.code !== undefined) : [...this.ring]
    return filtered.slice(-limit).reverse()
  }
}
