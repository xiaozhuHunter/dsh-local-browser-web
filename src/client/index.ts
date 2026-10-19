/**
 * The plugin's browser half.
 *
 * The package declares `dsh.client` in its manifest, so the client module system
 * discovers this module as part of the plugin row itself (a root-row half, not a
 * subpath half — see README "安装"). It registers:
 *
 * - the panel's locale namespace,
 * - a `SettingsForm`-driven config form bound to the plugin's own Host entry,
 * - the panel at the `settings.section` slot, so DSH Settings gets a dedicated
 *   navigation entry rather than burying the form inside the Plugins section.
 *
 * Everything is `ctx.effect`-scoped, so unloading the plugin removes the page, the
 * form subscription, and the dictionary together.
 *
 * @module dsh-local-browser-web/client
 */
// Type-only imports: they pull each service's Context merge (ctx.locale,
// ctx.configForms, ctx.remote, ctx.slots) and the `settings.section` SlotMap entry
// into this program. Cross-plugin collaboration goes through services, never value
// imports, because the client bundle purity gate forbids the latter.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Panel } from './Panel.tsx'
import { ENTRY_ID, NS, PanelForm, panelFace } from './controller.ts'
import { en, zh, type PanelLocaleKey } from './locales.ts'

export type { CredentialState, EngineView, FieldDef, PanelState } from './controller.ts'
export { ENTRY_ID, NS } from './controller.ts'
export { Panel } from './Panel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This panel's copy. */
    'settings.localBrowserWeb': PanelLocaleKey
  }
}

/** Required services: the slot registry, the dictionaries, the config forms, and the credentials domain. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * Mount the panel.
 * @param ctx - the browser plugin's context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'local-browser-web: dictionaries')

  const form = new PanelForm(ctx.configForms.get<Record<string, unknown>>(ENTRY_ID), ctx)
  ctx.effect(() => () => { form.dispose() }, 'local-browser-web: form subscription')

  // A key can be written from another surface (the Models page addresses the same
  // reference) and the settings section does not change when it is, so the whole
  // panel would keep reporting a state the Host already replaced.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { form.refreshCredential(ref) }),
    'local-browser-web: credential invalidations',
  )

  ctx.effect(
    () => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: ENTRY_ID,
      order: 60,
      label: () => t('title'),
      locale: NS,
      inject: () => panelFace(form),
    }, Panel))),
    'local-browser-web: settings section',
  )
}
