/**
 * The plugin's settings page, browser half.
 *
 * Mounted at the `settings.section` slot so it gets its own entry in the DSH
 * Settings navigation (rather than living as a tab under the Plugins section).
 * Inside, six tabs keep the ~45 editable fields legible: search (with the engine
 * registry editor), fetch, proxy, cleaning, quality, and general.
 *
 * Every control stages a draft; the form's save is the single write.
 *
 * @module dsh-local-browser-web/client/Panel
 */
import { useEffect, useState, type ReactNode } from 'react'
import { SettingsForm, SettingsValueField, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { FIELD_GROUPS, type BrowserStatusView, type FieldDef, type PanelActions, type PanelFace, type PanelState } from './controller.ts'
import { FieldShell, LinesField, SelectField, ToggleField } from './controls.tsx'
import { EnginesEditor } from './EnginesEditor.tsx'
import { ImportExport } from './ImportExport.tsx'
import { formLabels, type PanelLocaleKey } from './locales.ts'

/**
 * Props the renderer binds for this page: the owner's share (the shell's `close`),
 * the locale seat, and the injected form face.
 */
export type PanelProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.localBrowserWeb'>
  & InjectFace<PanelFace>

/** The panel's tabs. */
type TabValue = 'search' | 'fetch' | 'proxy' | 'clean' | 'quality' | 'general'

/** Result-parser ids that ship with the plugin (spelled here; the browser half cannot read host code). */
const BUILT_IN_PARSERS = ['html-bing', 'html-ddg', 'html-baidu', 'html-google', 'html-so360', 'json-generic']

const hintStyle = {
  color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: '4px 0 12px',
} as const

const noticeStyle = {
  color: 'var(--dsw-alias-label-error, #c0392b)',
  fontSize: 12,
  lineHeight: 1.5,
  margin: '0 0 10px',
} as const

/** Render one field by its declared kind. */
function Field(props: {
  field: FieldDef
  state: SettingsFieldState
  t: Translate<PanelLocaleKey>
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}): ReactNode {
  const { field, state } = props
  const shared = {
    id: field.id,
    label: props.t(field.labelKey),
    hint: props.t(field.hintKey),
    disabled: props.disabled,
    onReset: props.onReset,
    overriddenLabel: props.t('overridden'),
    resetLabel: props.t('reset'),
  }
  switch (field.kind) {
    case 'boolean':
      return <ToggleField {...shared} text={state.text} overridden={state.overridden} onEdit={props.onEdit} />
    case 'select':
      return <SelectField {...shared} text={state.text} options={field.options ?? []} overridden={state.overridden} onEdit={props.onEdit} />
    case 'lines':
      return <LinesField {...shared} text={state.text} invalid={state.invalid} overridden={state.overridden} onEdit={props.onEdit} />
    default:
      return (
        <SettingsValueField
          {...shared}
          text={state.text}
          overridden={state.overridden}
          invalid={state.invalid}
          invalidLabel={props.t('invalidNumber')}
          numeric={field.kind === 'number'}
          onEdit={props.onEdit}
        />
      )
  }
}

/** Render one named group of fields. */
function Group(
  props: {
    titleKey: PanelLocaleKey
    fields: readonly FieldDef[]
    state: PanelState
    t: Translate<PanelLocaleKey>
    disabled: boolean
    props: PanelActions
  },
): ReactNode {
  return (
    <div>
      <h3 style={{ fontSize: 13, margin: '0 0 4px' }}>{props.t(props.titleKey)}</h3>
      {props.fields.map((field) => {
        const key = field.path.join('.')
        const state = props.state.fields[key] ?? { text: '', overridden: false, invalid: false }
        return (
          <Field
            key={key}
            field={field}
            state={state}
            t={props.t}
            disabled={props.disabled}
            onEdit={(text) => { props.props.editPath(field.path, text) }}
            onReset={() => { props.props.resetPath(field.path) }}
          />
        )
      })}
    </div>
  )
}

/**
 * The Chrome connection card: live state plus the two actions.
 *
 * Status is fetched once on mount (the panel should not lie about a port it has
 * not checked) and after every click. Nothing here touches the config form.
 */
function BrowserCard(props: {
  t: Translate<PanelLocaleKey>
  disabled: boolean
  onStatus: () => Promise<BrowserStatusView>
  onLaunch: () => Promise<BrowserStatusView>
}): ReactNode {
  const [busy, setBusy] = useState<'idle' | 'check' | 'launch'>('idle')
  const [status, setStatus] = useState<BrowserStatusView | undefined>(undefined)

  const run = async (mode: 'check' | 'launch'): Promise<void> => {
    setBusy(mode)
    try {
      setStatus(mode === 'check' ? await props.onStatus() : await props.onLaunch())
    } finally {
      setBusy('idle')
    }
  }

  useEffect(() => {
    void run('check')
    // Mount-only: the endpoint can change on save, and the next click re-reads it.
  }, [])

  const stateText = status === undefined
    ? props.t('browserUnknown')
    : status.running ? props.t('browserRunning') : props.t('browserStopped')
  const stateColor = status === undefined
    ? 'var(--dsw-alias-label-tertiary, #8b8b8b)'
    : status.running ? 'var(--dsw-alias-label-success, #2e7d32)' : 'var(--dsw-alias-label-error, #c0392b)'

  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 4px' }}>{props.t('browserTitle')}</h3>
      <p style={hintStyle}>{props.t('browserHint')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px' }}>
        <span style={{ color: stateColor, fontSize: 12, fontWeight: 600 }}>● {stateText}</span>
        {status?.running === true && status.browser !== undefined
          ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' }}>{status.browser}</span>
          : null}
        {status !== undefined && status.endpoint.length > 0
          ? <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' }}>{status.endpoint}</span>
          : null}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={props.disabled || busy !== 'idle'} onClick={() => { void run('check') }}>
          {busy === 'check' ? props.t('browserChecking') : props.t('browserCheck')}
        </button>
        <button type="button" disabled={props.disabled || busy !== 'idle'} onClick={() => { void run('launch') }}>
          {busy === 'launch' ? props.t('browserLaunching') : props.t('browserLaunch')}
        </button>
      </div>
      {status !== undefined && !status.running && status.message !== undefined
        ? <p style={noticeStyle}>{status.message}</p>
        : null}
      {status !== undefined && !status.running && status.searched.length > 0
        ? (
          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 12, cursor: 'pointer' }}>{props.t('browserSearched')}</summary>
            <ul style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }}>
              {status.searched.map(path => <li key={path}><code>{path}</code></li>)}
            </ul>
          </details>
        )
        : null}
      {status?.running === true
        ? <p style={hintStyle}>{props.t('browserRunningNote')}</p>
        : null}
    </div>
  )
}

/**
 * Render the plugin's settings page.
 * @param props - the page's locale seat, the form face, and the owner's `close`.
 * @returns the section body.
 */
export function Panel(props: PanelProps): JSX.Element {
  const { t } = props
  const state = props.useLocalBrowserWeb(snapshot => snapshot)
  const [tab, setTab] = useState<TabValue>('search')
  const disabled = !state.writable
  const group = (titleKey: PanelLocaleKey): ReactNode => {
    const found = FIELD_GROUPS.find(candidate => candidate.titleKey === titleKey)
    if (found === undefined) return null
    return (
      <Group
        titleKey={found.titleKey}
        fields={found.fields}
        state={state}
        t={t}
        disabled={disabled}
        props={props}
      />
    )
  }

  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>{t('title')}</h2>
      <p style={hintStyle}>{t('description')}</p>
      {state.conflict ? <p style={noticeStyle}>{t('conflictWarning')}</p> : null}

      <SettingsForm
        labels={formLabels(t)}
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <SegmentedTabs
          label={t('title')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'search', id: 'tab-search', label: t('tabSearch'), panelId: 'local-browser-web-panel' },
            { value: 'fetch', id: 'tab-fetch', label: t('tabFetch'), panelId: 'local-browser-web-panel' },
            { value: 'proxy', id: 'tab-proxy', label: t('tabProxy'), panelId: 'local-browser-web-panel' },
            { value: 'clean', id: 'tab-clean', label: t('tabClean'), panelId: 'local-browser-web-panel' },
            { value: 'quality', id: 'tab-quality', label: t('tabQuality'), panelId: 'local-browser-web-panel' },
            { value: 'general', id: 'tab-general', label: t('tabGeneral'), panelId: 'local-browser-web-panel' },
          ]}
        />

        <div id="local-browser-web-panel" style={{ paddingTop: 12 }}>
          {tab === 'search'
            ? (
              <>
                {group('groupSearch')}
                <EnginesEditor
                  t={t}
                  disabled={disabled}
                  engines={state.engines}
                  enginesDirty={state.enginesDirty}
                  credentials={state.credentials}
                  secrets={state.secrets}
                  builtInParsers={BUILT_IN_PARSERS}
                  onEdit={props.editEngine}
                  onMove={props.moveEngine}
                  onRemove={props.removeEngine}
                  onAdd={props.addEngine}
                  onStageSecret={props.stageSecret}
                  onResetEngines={props.resetEngines}
                />
                <FieldShell
                  id="local-browser-web-test-note"
                  label={t('testTitle')}
                  hint={t('testHowTo')}
                  disabled={disabled}
                  overriddenLabel=""
                  resetLabel=""
                  invalidLabel=""
                >
                  <span />
                </FieldShell>
              </>
            )
            : null}
          {tab === 'fetch'
            ? (
              <>
                <BrowserCard
                  t={t}
                  disabled={disabled}
                  onStatus={props.browserStatus}
                  onLaunch={props.launchBrowser}
                />
                {group('groupFetch')}
              </>
            )
            : null}
          {tab === 'proxy'
            ? (
              <>
                {group('groupProxy')}
                <p style={hintStyle}>{t('proxyNote')}</p>
              </>
            )
            : null}
          {tab === 'clean' ? group('groupClean') : null}
          {tab === 'quality' ? group('groupQuality') : null}
          {tab === 'general'
            ? (
              <>
                {group('groupGeneral')}
                <ImportExport
                  t={t}
                  disabled={disabled}
                  onExport={props.exportConfig}
                  onImport={props.importConfig}
                />
              </>
            )
            : null}
        </div>
      </SettingsForm>
    </section>
  )
}
