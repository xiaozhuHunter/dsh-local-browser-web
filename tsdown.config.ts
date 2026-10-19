/**
 * Browser-half bundle for dsh-local-browser-web.
 *
 * The DSH client module system serves a plugin's `exports["./client"]` artifact,
 * which must be a lazy-CJS factory: a script that registers the package id and a
 * `factory(require)` on the page's module loader. The official preset that emits
 * this shape lives at packages/client/tsdown.client.ts and is NOT published, so
 * this file mirrors its required pieces:
 *
 *   - cjs + platform browser, single `lib/client.js` entry
 *   - the `window.__ModuleLoader__.load({ id, factory })` banner / intro / footer
 *   - externals = the shell's frozen module table (PLATFORM_MODULES); everything
 *     else is inlined, so no cross-plugin value import sneaks in
 *
 * Value imports from @deepseek-ai/* must therefore be limited to PLATFORM_MODULES
 * entries (primitives, slots, store, cordis, react); every other @deepseek-ai/*
 * import in the browser half is type-only and erased at build time.
 */

/** The shell's frozen module table (packages/client/web/src/platform.ts). */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Package id the loader keys this bundle under (must equal package.json name). */
const PKG_ID = 'dsh-local-browser-web'

const isExternal = (specifier) =>
  PLATFORM_MODULES.has(specifier) || specifier.startsWith('react-dom/')

export default {
  name: `${PKG_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: isExternal,
    alwaysBundle: (specifier) => !isExternal(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  // Browser bundles inline node-idiom deps that probe these; without the
  // substitution the factory throws ReferenceError at boot.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}
