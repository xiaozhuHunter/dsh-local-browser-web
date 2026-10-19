/**
 * Small labelled-control wrappers the panel needs on top of the primitives.
 *
 * The primitives ship a text/number field, a secret field, a `Switch`, and a
 * `SegmentedControl`, but no labelled frame for the last two and no multi-line
 * control at all (the domain lists need one). These wrappers supply exactly that
 * frame — label, override badge, reset, hint — so every control in the panel reads
 * the same, without reaching for CSS the package does not publish.
 *
 * Styling uses the same `--dsw-*` design tokens the primitives' own stylesheets
 * consume, with fallbacks so a token-less host still renders legibly.
 *
 * @module dsh-local-browser-web/client/controls
 */
import type { ReactNode } from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

/** Token-based styles shared by the wrappers. */
const labelStyle = { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, fontWeight: 500 } as const
const hintStyle = { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)', fontSize: 12, lineHeight: 1.5, margin: '4px 0 0' } as const
const errorStyle = { color: 'var(--dsw-alias-label-error, #c0392b)', fontSize: 12, lineHeight: 1.5, margin: '4px 0 0' } as const
const badgeStyle = { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 11 } as const
const resetStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--dsw-alias-state-business-primary, #3b82f6)',
  cursor: 'pointer',
  fontSize: 11,
  padding: 0,
} as const
const textareaStyle = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 88,
  padding: '6px 8px',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontFamily: 'inherit',
  fontSize: 12,
  resize: 'vertical',
} as const

/** The label / badge / hint frame every control in the panel sits in. */
export function FieldShell(props: {
  id: string
  label: string
  hint: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden?: boolean
  /** Whether the draft is not a value the field accepts. */
  invalid?: boolean
  disabled?: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  onReset?: () => void
  children: ReactNode
}): ReactNode {
  const overridden = props.overridden === true
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <label htmlFor={props.id} style={labelStyle}>{props.label}</label>
        {overridden
          ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={badgeStyle}>{props.overriddenLabel}</span>
              {props.onReset === undefined
                ? null
                : <button type="button" style={resetStyle} disabled={props.disabled === true} onClick={props.onReset}>{props.resetLabel}</button>}
            </span>
          )
          : null}
      </div>
      {props.children}
      {props.invalid === true
        ? <p style={errorStyle}>{props.invalidLabel}</p>
        : props.hint.length > 0 ? <p style={hintStyle}>{props.hint}</p> : null}
    </div>
  )
}

/** A labelled `Switch`, staged through `edit`. */
export function ToggleField(props: {
  id: string
  label: string
  hint: string
  /** Draft text: exactly `'true'` or `'false'`. */
  text: string
  disabled: boolean
  onEdit: (text: string) => void
  overridden?: boolean
  onReset?: () => void
  overriddenLabel?: string
  resetLabel?: string
}): ReactNode {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      overridden={props.overridden}
      onReset={props.onReset}
      overriddenLabel={props.overriddenLabel ?? ''}
      resetLabel={props.resetLabel ?? ''}
      invalidLabel=""
    >
      <div style={{ marginTop: 6 }}>
        <Switch
          checked={props.text === 'true'}
          label={props.label}
          disabled={props.disabled}
          onChange={(next) => { props.onEdit(next ? 'true' : 'false') }}
        />
      </div>
    </FieldShell>
  )
}

/** A labelled `SegmentedControl` over a fixed option list. */
export function SelectField(props: {
  id: string
  label: string
  hint: string
  text: string
  options: readonly string[]
  disabled: boolean
  onEdit: (text: string) => void
  overridden?: boolean
  onReset?: () => void
  overriddenLabel?: string
  resetLabel?: string
}): ReactNode {
  const items = props.options.map(option => ({ value: option, label: option }))
  const [first, ...rest] = items
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      overridden={props.overridden}
      onReset={props.onReset}
      overriddenLabel={props.overriddenLabel ?? ''}
      resetLabel={props.resetLabel ?? ''}
      invalidLabel=""
    >
      <div style={{ marginTop: 6 }}>
        {first === undefined
          ? null
          : (
            <SegmentedControl
              id={props.id}
              label={props.label}
              value={props.text}
              options={[first, ...rest]}
              disabled={props.disabled}
              onChange={(value) => { props.onEdit(value) }}
            />
          )}
      </div>
    </FieldShell>
  )
}

/** A labelled multi-line control, one entry per line (the domain lists). */
export function LinesField(props: {
  id: string
  label: string
  hint: string
  text: string
  disabled: boolean
  invalid?: boolean
  onEdit: (text: string) => void
  overridden?: boolean
  onReset?: () => void
  overriddenLabel?: string
  resetLabel?: string
}): ReactNode {
  return (
    <FieldShell
      id={props.id}
      label={props.label}
      hint={props.hint}
      disabled={props.disabled}
      overridden={props.overridden}
      onReset={props.onReset}
      overriddenLabel={props.overriddenLabel ?? ''}
      resetLabel={props.resetLabel ?? ''}
      invalidLabel=""
    >
      <textarea
        id={props.id}
        style={{ ...textareaStyle, ...props.invalid === true ? { borderColor: 'var(--dsw-alias-state-error-primary, #c0392b)' } : {} }}
        value={props.text}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
    </FieldShell>
  )
}
