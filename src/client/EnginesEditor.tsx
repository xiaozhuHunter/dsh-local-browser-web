/**
 * The engine-list editor.
 *
 * This is the piece a generic schema form cannot render: the engine registry is an
 * array of objects, and the primitives' form model stages single-segment paths only.
 * So the whole list is edited as one draft and written back as a single
 * `{ op: 'set', path: ['engines'], value: [...] }` operation, which is exactly what
 * the task's §6.3 allows for deep arrays.
 *
 * Rows can be enabled/disabled, renamed, re-ordered, repointed, re-parsed, keyed,
 * and removed; a new row is added through the inline form below the list.
 *
 * @module dsh-local-browser-web/client/EnginesEditor
 */
import { useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, SettingsSecretField, SettingsValueField, Switch, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { FieldShell, SelectField } from './controls.tsx'
import type { CredentialState, EngineView } from './controller.ts'
import type { PanelLocaleKey } from './locales.ts'

/** Engine execution routes. */
const ENGINE_KINDS = ['http-html', 'browser', 'api'] as const

/** What the list editor needs. */
export interface EnginesEditorProps {
  t: Translate<PanelLocaleKey>
  disabled: boolean
  engines: readonly EngineView[]
  enginesDirty: boolean
  credentials: Record<string, CredentialState>
  secrets: Record<string, string>
  builtInParsers: readonly string[]
  onEdit: (id: string, patch: Partial<EngineView>) => void
  onMove: (id: string, delta: number) => void
  onRemove: (id: string) => void
  onAdd: (engine: EngineView) => void
  onStageSecret: (ref: string, text: string) => void
  onResetEngines: () => void
}

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l2, #d8d8d8)',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  padding: '10px 12px',
  marginBottom: 10,
} as const

const rowHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 6,
} as const

const sectionHintStyle = {
  color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: '4px 0 10px',
} as const

const toolCallStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary, #666)',
  margin: '6px 0 0',
  wordBreak: 'break-all',
} as const

/** An empty engine template for the add form. */
function emptyEngine(): EngineView {
    return {
      id: '',
      label: '',
      kind: 'http-html',
      endpoint: '',
      requiresKey: false,
      resultParser: 'html-bing',
      priority: 100,
      enabledByDefault: false,
      enabled: true,
    }
}

/** Render the engine registry as an editable list plus an add form. */
export function EnginesEditor(props: EnginesEditorProps): JSX.Element {
  const { t } = props
  const [draft, setDraft] = useState<EngineView | undefined>(undefined)
  const [tested, setTested] = useState<string | undefined>(undefined)

  const field = (engine: EngineView, key: keyof EngineView, id: string, label: string, hint = '') => {
    const value = engine[key]
    return (
      <SettingsValueField
        id={id}
        label={label}
        hint={hint}
        text={typeof value === 'string' ? value : ''}
        overridden={false}
        invalid={false}
        overriddenLabel=""
        resetLabel=""
        invalidLabel=""
        disabled={props.disabled}
        onEdit={(text) => { props.onEdit(engine.id, { [key]: text } as Partial<EngineView>) }}
        onReset={() => undefined}
      />
    )
  }

  return (
    <div>
      <div style={rowHeadStyle}>
        <strong>{t('enginesTitle')}</strong>
        {props.enginesDirty
          ? <Button variant="ghost" onClick={props.onResetEngines}>{t('reset')}</Button>
          : null}
      </div>
      <p style={sectionHintStyle}>{t('enginesHint')}</p>

      {props.engines.length === 0 ? <p style={sectionHintStyle}>{t('noEngines')}</p> : null}

      {props.engines.map((engine, index) => {
        const ref = engine.credentialRef ?? ''
        const credential: CredentialState | undefined = ref.length > 0 ? props.credentials[ref] : undefined
        const toolCall = `local_search_test engine="${engine.id || '?'}"`
        return (
          <div key={`${engine.id}-${String(index)}`} style={cardStyle}>
            <div style={rowHeadStyle}>
              <span style={{ fontFamily: 'inherit', fontSize: 13, fontWeight: 600 }}>
                {engine.label.length > 0 ? engine.label : engine.id || '(未命名)'}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Button variant="ghost" disabled={props.disabled || index === 0} onClick={() => { props.onMove(engine.id, -1) }}>
                  {t('engineMoveUp')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={props.disabled || index === props.engines.length - 1}
                  onClick={() => { props.onMove(engine.id, 1) }}
                >
                  {t('engineMoveDown')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={props.disabled}
                  onClick={() => { setTested(tested === engine.id ? undefined : engine.id) }}
                  title={t('engineTestHint')}
                >
                  {t('engineTest')}
                </Button>
                <Button variant="ghost" disabled={props.disabled} onClick={() => { props.onRemove(engine.id) }}>
                  {t('engineRemove')}
                </Button>
              </span>
            </div>

            <FieldShell
              id={`engine-enabled-${engine.id}`}
              label={t('engineEnabled')}
              hint=""
              disabled={props.disabled}
              overriddenLabel=""
              resetLabel=""
              invalidLabel=""
            >
              <div style={{ marginTop: 4 }}>
                <SwitchRow
                  checked={engine.enabled}
                  label={t('engineEnabled')}
                  disabled={props.disabled}
                  onChange={(next) => { props.onEdit(engine.id, { enabled: next }) }}
                />
              </div>
            </FieldShell>

            {field(engine, 'id', `engine-id-${engine.id}`, t('engineId'), '唯一 id；改动相当于换一个引擎')}
            {field(engine, 'label', `engine-label-${engine.id}`, t('engineLabel'))}

            <SelectField
              id={`engine-kind-${engine.id}`}
              label={t('engineKind')}
              hint="http-html 轻量 HTTP；browser 浏览器渲染；api 带凭据 JSON"
              text={ENGINE_KINDS.includes(engine.kind as typeof ENGINE_KINDS[number]) ? engine.kind : ''}
              options={ENGINE_KINDS}
              disabled={props.disabled}
              onEdit={(text) => { props.onEdit(engine.id, { kind: text }) }}
            />
            {field(engine, 'endpoint', `engine-endpoint-${engine.id}`, t('engineEndpoint'), 'browser/api 可用 {query} 占位')}
            {field(
              engine,
              'resultParser',
              `engine-parser-${engine.id}`,
              t('engineParser'),
              `内置：${props.builtInParsers.join(' / ')}`,
            )}

            <FieldShell
              id={`engine-key-${engine.id}`}
              label={t('engineRequiresKey')}
              hint=""
              disabled={props.disabled}
              overriddenLabel=""
              resetLabel=""
              invalidLabel=""
            >
              <div style={{ marginTop: 4 }}>
                <SwitchRow
                  checked={engine.requiresKey}
                  label={t('engineRequiresKey')}
                  disabled={props.disabled}
                  onChange={(next) => { props.onEdit(engine.id, { requiresKey: next }) }}
                />
              </div>
            </FieldShell>

            {engine.requiresKey
              ? (
                <>
                  {field(engine, 'credentialRef', `engine-ref-${engine.id}`, t('engineCredentialRef'), '凭据域中的引用名，如 MY_SEARCH_KEY')}
                  {ref.length > 0
                    ? (
                      <SettingsSecretField
                        id={`engine-secret-${engine.id}`}
                        label={t('engineSecretLabel')}
                        hint={t('engineSecretHint')}
                        text={props.secrets[ref] ?? ''}
                        configured={credential?.configured ?? false}
                        stateLabel={credential?.configured ?? false ? t('engineSecretSet') : t('engineSecretUnset')}
                        disabled={props.disabled || credential?.writable === false}
                        onEdit={(text) => { props.onStageSecret(ref, text) }}
                      />
                    )
                    : null}
                </>
              )
              : null}

            {tested === engine.id
              ? (
                <div>
                  <p style={toolCallStyle}>{toolCall}</p>
                  <Button
                    variant="ghost"
                    onClick={() => { void writeClipboard(toolCall) }}
                  >
                    复制
                  </Button>
                </div>
              )
              : null}
          </div>
        )
      })}

      <div style={cardStyle}>
        <strong style={{ fontSize: 13 }}>{t('engineAddTitle')}</strong>
        {draft === undefined
          ? (
            <div style={{ marginTop: 8 }}>
              <Button variant="ghost" disabled={props.disabled} onClick={() => { setDraft(emptyEngine()) }}>
                {t('engineAdd')}
              </Button>
            </div>
          )
          : (
            <div style={{ marginTop: 6 }}>
              {field(draft, 'id', 'new-engine-id', t('engineId'))}
              {field(draft, 'label', 'new-engine-label', t('engineLabel'))}
              <SelectField
                id="new-engine-kind"
                label={t('engineKind')}
                hint=""
                text={draft.kind}
                options={ENGINE_KINDS}
                disabled={props.disabled}
                onEdit={(text) => { setDraft({ ...draft, kind: text }) }}
              />
              {field(draft, 'endpoint', 'new-engine-endpoint', t('engineEndpoint'))}
              {field(draft, 'resultParser', 'new-engine-parser', t('engineParser'), `内置：${props.builtInParsers.join(' / ')}`)}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  variant="ghost"
                  disabled={props.disabled || draft.id.trim().length === 0 || draft.endpoint.trim().length === 0}
                  onClick={() => {
                    props.onAdd({
                      ...draft,
                      priority: (props.engines.length + 1) * 10,
                      enabledByDefault: false,
                      enabled: true,
                    })
                    setDraft(undefined)
                  }}
                >
                  {t('engineAdd')}
                </Button>
                <Button variant="ghost" onClick={() => { setDraft(undefined) }}>{t('engineCancel')}</Button>
              </div>
            </div>
          )}
      </div>
    </div>
  )
}

/** A bare `Switch` (engine rows edit a draft, so the staged `ToggleField` does not apply). */
function SwitchRow(props: {
  checked: boolean
  label: string
  disabled: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return <Switch checked={props.checked} label={props.label} disabled={props.disabled} onChange={props.onChange} />
}
