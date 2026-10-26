/**
 * Link this plugin's `node_modules` at the DSH checkout and the installed DSH
 * profile, so `@deepseek-ai/*` resolves to the SAME module instances the host
 * runs (one schemastery, one cordis) and the build tooling is reachable.
 *
 * Nothing here writes to the DSH checkout or to the live profile: symlinks are
 * created inside THIS package only. Re-runnable; existing links are replaced.
 *
 *   node scripts/setup-links.mjs
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** DSH source checkout (host packages + vendored cordis framework + tooling). */
const REPO = '/Users/wangshuai/VscodeProject/deepseek-harness'
/** Installed DSH profile dependency store (complete, version-matched install). */
const PROFILE = '/Users/wangshuai/.dsh/profiles/node_modules'

/** specifier → absolute directory to link it to. */
const LINKS = {
  // ── cordis framework (vendored in the DSH checkout) ──────────────────────
  '@deepseek-ai/cordis': join(REPO, 'vendor/cordis'),
  '@deepseek-ai/cosmokit': join(REPO, 'vendor/cosmokit'),
  '@deepseek-ai/schemastery': join(REPO, 'vendor/schemastery'),

  // ── host seam and services ───────────────────────────────────────────────
  '@deepseek-ai/dsh-web': join(REPO, 'packages/web/web'),
  '@deepseek-ai/dsh-tools': join(REPO, 'packages/core/tools'),
  '@deepseek-ai/dsh-llm': join(REPO, 'packages/llm/llm'),
  '@deepseek-ai/dsh-credentials': join(REPO, 'packages/credentials/credentials'),
  '@deepseek-ai/dsh-launch-environment': join(REPO, 'packages/util/launch-environment'),
  '@deepseek-ai/dsh-util-values': join(REPO, 'packages/util/values'),
  '@deepseek-ai/dsh-host-webserver': join(REPO, 'packages/host/webserver'),
  '@deepseek-ai/dsh-system-prompt': join(REPO, 'packages/core/system-prompt'),

  // ── browser halves and their type faces ──────────────────────────────────
  '@deepseek-ai/dsh-client-ui-settings': join(REPO, 'packages/client/ui-settings'),
  '@deepseek-ai/dsh-client-ui-primitives': join(REPO, 'packages/client/ui-primitives'),
  '@deepseek-ai/dsh-client-ui-slots': join(REPO, 'packages/client/ui-slots'),
  '@deepseek-ai/dsh-client-store': join(REPO, 'packages/client/store'),
  '@deepseek-ai/dsh-client-locale': join(REPO, 'packages/client/locale'),
  '@deepseek-ai/dsh-client-ui-renderer': join(REPO, 'packages/client/ui-renderer'),
  '@deepseek-ai/dsh-api-remotes': join(REPO, 'packages/api/remotes'),

  // ── third-party runtime libraries ────────────────────────────────────────
  jsdom: join(REPO, 'node_modules/jsdom'),
  turndown: join(PROFILE, 'turndown'),
  react: join(PROFILE, 'react'),
  'react-dom': join(PROFILE, 'react-dom'),
  // The profile's own @types/react symlink is stale; the pnpm store path is real.
  '@types/react': join(REPO, 'node_modules/.pnpm/@types+react@18.3.31/node_modules/@types/react'),
  '@types/react-dom': join(REPO, 'node_modules/.pnpm/@types+react-dom@18.3.7_@types+react@18.3.31/node_modules/@types/react-dom'),
  '@types/jsdom': join(REPO, 'node_modules/.pnpm/@types+jsdom@28.0.3/node_modules/@types/jsdom'),
  '@types/turndown': join(REPO, 'node_modules/.pnpm/@types+turndown@5.0.6/node_modules/@types/turndown'),
  '@types/node': join(REPO, 'node_modules/.pnpm/@types+node@22.20.4/node_modules/@types/node'),

  // ── build tooling ────────────────────────────────────────────────────────
  typescript: join(REPO, 'node_modules/typescript'),
  tsdown: join(REPO, 'node_modules/tsdown'),
}

let created = 0
let skipped = 0
for (const [specifier, target] of Object.entries(LINKS)) {
  if (!existsSync(target)) {
    console.warn(`skip  ${specifier} — target missing: ${target}`)
    skipped += 1
    continue
  }
  const dest = join(root, 'node_modules', ...specifier.split('/'))
  mkdirSync(dirname(dest), { recursive: true })
  const current = lstatSync(dest, { throwIfNoEntry: false })
  if (current !== undefined) {
    if (current.isSymbolicLink() && readlinkSync(dest) === target) continue
    rmSync(dest, { recursive: true, force: true })
  }
  symlinkSync(target, dest, 'dir')
  created += 1
}
console.log(`setup-links: ${String(created)} link(s) created, ${String(skipped)} skipped`)
