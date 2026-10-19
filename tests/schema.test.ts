/**
 * The config schema against the panel's field table.
 *
 * This test exists because of a real failure: the nested `clean`/`quality` leaves
 * were declared without `.volatile()`, so the runtime section carried plain
 * booleans where `readConfig` calls `.get()` — the plugin then failed to activate
 * with `config.clean.transport.enabled.get is not a function`. The panel's
 * browser-side field table is hand-written (the client half cannot read host
 * modules), so nothing else cross-checks the two sides.
 *
 * The invariant asserted here is a bijection:
 *
 *   volatile leaves of the Config schema  ==  panel field paths  +  {engines}
 *
 * Direction A says every control the panel renders writes a field the Host will
 * actually accept (a non-volatile path makes `SettingsForms.write()` throw).
 * Direction B says no configurable field is missing a control — the task's
 * "不允许有任何只能改配置文件的隐藏项".
 *
 * @module dsh-local-browser-web/tests/schema
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Config } from '../src/config.ts'
import { FIELD_GROUPS } from '../src/client/controller.ts'

/** The slice of a Schemastery node this test reads. */
interface SchemaNode {
  meta: { volatile?: boolean }
  dict?: Record<string, SchemaNode>
  inner?: SchemaNode
}

/** Whether a path lies beneath a volatile node (mirror of `SettingsForms`'s own rule). */
function isVolatilePath(schema: SchemaNode, path: readonly string[]): boolean {
  if (schema.meta.volatile === true) return true
  const [head, ...rest] = path
  const child = head === undefined ? undefined : schema.dict?.[head]
  return child !== undefined && isVolatilePath(child, rest)
}

/**
 * Every field path whose value is a `Volatile` reference.
 *
 * A volatile node ends the walk: its children are covered by the control that
 * edits the node itself (the engine array is one such control).
 */
function volatileLeaves(schema: SchemaNode, prefix: readonly string[] = []): string[] {
  if (schema.meta.volatile === true) return [prefix.join('.')]
  const found: string[] = []
  for (const [key, child] of Object.entries(schema.dict ?? {})) {
    found.push(...volatileLeaves(child, [...prefix, key]))
  }
  return found
}

/** Paths the panel's table edits, as dotted strings. */
function panelPaths(): string[] {
  return FIELD_GROUPS.flatMap(group => group.fields.map(field => field.path.join('.')))
}

/** The one compound control that edits an array node rather than a scalar. */
const COMPOUND_PATHS = ['engines']

describe('Config schema volatility', () => {
  it('marks every path the panel edits as volatile', () => {
    const schema = Config as unknown as SchemaNode
    for (const group of FIELD_GROUPS) {
      for (const field of group.fields) {
        assert.ok(
          isVolatilePath(schema, field.path),
          `panel field "${field.path.join('.')}" is not .volatile(); the Host would refuse the write`,
        )
      }
    }
  })

  it('leaves no configurable field without a control', () => {
    const declared = new Set(volatileLeaves(Config as unknown as SchemaNode))
    const covered = new Set([...panelPaths(), ...COMPOUND_PATHS])
    const missing = [...declared].filter(path => !covered.has(path)).sort()
    assert.deepEqual(missing, [], 'these volatile fields have no control in the panel')
  })

  it('has no panel control without a volatile field', () => {
    const declared = new Set(volatileLeaves(Config as unknown as SchemaNode))
    const extra = [...panelPaths(), ...COMPOUND_PATHS].filter(path => !declared.has(path)).sort()
    assert.deepEqual(extra, [], 'these panel fields are not volatile in the schema')
  })

  it('enumerates exactly the expected field count', () => {
    // A count check makes an accidental addition or deletion visible even when the
    // two sides are edited consistently but wrongly.
    assert.equal(volatileLeaves(Config as unknown as SchemaNode).length, 37)
    assert.equal(panelPaths().length, 36)
  })

  it('covers each declared group', () => {
    assert.deepEqual(FIELD_GROUPS.map(group => group.fields.length), [4, 11, 6, 13, 2])
    // Field ids must be unique: they become DOM ids.
    const ids = FIELD_GROUPS.flatMap(group => group.fields.map(field => field.id))
    assert.equal(new Set(ids).size, ids.length)
    // Locale keys must be unique per field, so one label never shadows another.
    const labels = FIELD_GROUPS.flatMap(group => group.fields.map(field => field.labelKey))
    assert.equal(new Set(labels).size, labels.length)
  })
})
