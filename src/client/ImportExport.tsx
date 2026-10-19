/**
 * Config export / import.
 *
 * Export copies the stored section as JSON so a working setup can be backed up or
 * moved between machines. Import stages the document through the SAME field
 * staging a hand edit uses, so an imported value passes the identical Host
 * validation and revision fence — it is a convenience, never a bypass.
 *
 * @module dsh-local-browser-web/client/ImportExport
 */
import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelLocaleKey } from './locales.ts'

/** What the import/export block needs. */
export interface ImportExportProps {
  t: Translate<PanelLocaleKey>
  disabled: boolean
  /** The stored section, deep-copied by the owner. */
  onExport: () => Record<string, unknown>
  /** Stage an imported document. */
  onImport: (section: Record<string, unknown>) => void
}

const textareaStyle = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 120,
  padding: '6px 8px',
  borderRadius: 'var(--dsw-radius-sm, 4px)',
  border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  resize: 'vertical',
} as const

const hintStyle = {
  color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: '4px 0 8px',
} as const

const errorStyle = {
  color: 'var(--dsw-alias-label-error, #c0392b)',
  fontSize: 12,
  margin: '6px 0 0',
} as const

/** Render the export control and the import textarea. */
export function ImportExport(props: ImportExportProps): JSX.Element {
  const { t } = props
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  return (
    <div>
      <strong style={{ fontSize: 13 }}>{t('importExportTitle')}</strong>
      <p style={hintStyle}>{t('importExportHint')}</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Button
          variant="ghost"
          disabled={props.disabled}
          onClick={() => { void writeClipboard(JSON.stringify(props.onExport(), null, 2)) }}
        >
          {t('exportConfig')}
        </Button>
      </div>
      <label htmlFor="local-browser-web-import" style={{ fontSize: 12 }}>{t('importConfig')}</label>
      <textarea
        id="local-browser-web-import"
        style={{ ...textareaStyle, marginTop: 6 }}
        value={text}
        spellCheck={false}
        placeholder={t('importPlaceholder')}
        disabled={props.disabled}
        onChange={(event) => { setText(event.target.value); setFailed(false) }}
      />
      {failed ? <p style={errorStyle}>{t('importInvalid')}</p> : null}
      <div style={{ marginTop: 8 }}>
        <Button
          variant="ghost"
          disabled={props.disabled || text.trim().length === 0}
          onClick={() => {
            try {
              const parsed: unknown = JSON.parse(text)
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setFailed(true)
                return
              }
              props.onImport(parsed as Record<string, unknown>)
              setText('')
            } catch {
              setFailed(true)
            }
          }}
        >
          {t('importApply')}
        </Button>
      </div>
    </div>
  )
}
