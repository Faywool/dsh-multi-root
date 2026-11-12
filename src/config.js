/**
 * The plugin's Config schema.
 *
 * Every field is a plugin-wide switch. Per-workspace root lists are deliberately
 * NOT here: they are runtime data that belongs to a workspace, not deployment
 * configuration, and putting them in the profile patch would make every
 * attachment an edit to a file the loader owns. Roots live in the store instead
 * (see `store.js`).
 *
 * The schema library is required **synchronously**. `@deepseek-ai/schemastery`
 * is a dependency of DSH itself and resolves from the profile that installs
 * this bundle, but a unit test run outside a profile, or a future DSH that
 * renames the package, must not turn a missing schema into a failure to load.
 * Without it the plugin still runs — configuration just arrives unvalidated.
 *
 * Synchronous is not a style choice. The loader pulls a profile bundle in with
 * `require()`, and Node refuses a module graph that contains top-level await:
 * `ERR_REQUIRE_ASYNC_MODULE | require() cannot be used on an ESM graph with
 * top-level await`. An `await import(...)` here made the whole plugin invisible
 * to the host (loader entry `status: "absent"`, no tool registered) while every
 * unit test — which imports through ESM — stayed green.
 *
 * @module dsh-multi-root/config
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Absolute ceiling for {@link Config.maxRoots}; a guard against typos. */
export const MAX_ROOTS_CEILING = 64

/** Lowest accepted prompt budget, in characters. */
export const MIN_PROMPT_CHARS = 400

/** Defaults used when a field is absent (and by the store when seeding). */
export const DEFAULTS = Object.freeze({
  enabled: true,
  maxRoots: 16,
  injectPrompt: true,
  promptMaxChars: 4000,
  showGit: true,
  // On by default: an installed bundle never changes on disk, so the watcher
  // costs one idle fs.watch handle, while a `link:` checkout gets hot reload
  // without anyone having to touch a config file (bundle config in
  // cordis.patch.yml is only read when the composition is built, so a config
  // switch can never help a running instance see an edited bundle).
  devReload: true,
})

/**
 * The profile manifest to anchor resolution at, when one is known.
 *
 * @returns {string | undefined} an absolute path, or undefined.
 */
function profileManifest() {
  const profileDirectory = process.env.DSH_PROFILE_DIR?.trim()
  return profileDirectory ? join(profileDirectory, 'package.json') : undefined
}

/**
 * The copy of schemastery that ships inside the DeepSeek Harness install.
 *
 * A `link:` bundle resolves through its real path outside the profile, and the
 * desktop application does not promise to export `DSH_PROFILE_DIR` to plugins.
 * Deriving the packaged location from the running executable covers both cases
 * without asking the host for anything. From `…\DeepSeek Harness\resources\
 * app.asar\dsh\node_modules\@deepseek-ai\`, the relative walk is stable because
 * it is the layout the application itself loads from.
 *
 * @returns {string | undefined} a module path, or undefined.
 */
function packagedSchemaLibrary() {
  const execPath = process.execPath
  if (typeof execPath !== 'string' || execPath === '') return undefined
  try {
    return join(dirname(execPath), 'resources', 'app.asar', 'dsh', 'node_modules',
      '@deepseek-ai', 'schemastery')
  } catch {
    return undefined
  }
}

/**
 * Load the schema library, if this environment has it.
 *
 * Three attempts, because bundles arrive in three shapes. A bundle copied into
 * `profiles/<name>/node_modules` finds the bare specifier from its own URL; a
 * `file:`/junction install lives outside the profile, so the profile manifest
 * is the next anchor; a host that exports neither still has its own copy at a
 * path derived from the executable.
 *
 * Every attempt is `require`, never `import`: see the module comment.
 *
 * @returns {any | undefined} schemastery, or undefined.
 */
function loadSchemaLibrary() {
  const anchors = [import.meta.url, profileManifest(), packagedSchemaLibrary()]
  for (const anchor of anchors) {
    if (anchor === undefined) continue
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery')
      return loaded?.default ?? loaded
    } catch {
      // Try the next anchor; a DSH without schemastery simply has no schema.
    }
  }
  return undefined
}

/**
 * Build the schema from a schemastery instance.
 *
 * Every field is marked `.volatile()`, which is what makes DSH's Settings page
 * render it. Only fields under a volatile node become form controls, so an
 * unmarked schema produces a namespace with no controls at all. `.volatile()`
 * returns a copy, hence the rebuild.
 *
 * Volatility is also a promise: the host will not remount the plugin when one
 * of these changes, so the values are read at use time (see `index.js`) rather
 * than captured once during mount.
 *
 * @param {any} z - the schema library.
 * @returns {any} the schema.
 */
function buildSchema(z) {
  const fields = {
    enabled: z.boolean().default(DEFAULTS.enabled)
      .description('Master switch. Off unmounts every contribution but keeps stored roots.'),
    maxRoots: z.number().min(1).max(MAX_ROOTS_CEILING).default(DEFAULTS.maxRoots)
      .description('Cap on attached roots per workspace. Stored roots above the cap keep working.'),
    injectPrompt: z.boolean().default(DEFAULTS.injectPrompt)
      .description('Add the attached-root table to the model-facing prompt.'),
    promptMaxChars: z.number().min(MIN_PROMPT_CHARS).default(DEFAULTS.promptMaxChars)
      .description('Character budget for the attached-root table.'),
    showGit: z.boolean().default(DEFAULTS.showGit)
      .description("Include each root's git branch and dirty flag in the table."),
    devReload: z.boolean().default(DEFAULTS.devReload)
      .description('Watch this plugin\'s client bundle and republish it after every edit (local development only).'),
  }
  const marked = Object.fromEntries(Object.entries(fields).map(([key, field]) => [
    key,
    typeof field.volatile === 'function' ? field.volatile() : field,
  ]))
  return z.object(marked).description('多仓库工作区：给一个工作区挂载额外仓库')
}

const schemaLibrary = loadSchemaLibrary()

/**
 * The loader-validated schema, or undefined when no schema library is present.
 *
 * `settings.configure({ auto: true })` turns this same schema into a Settings
 * page, so the switches are editable live without touching the profile patch.
 */
export const Config = schemaLibrary === undefined ? undefined : buildSchema(schemaLibrary)

/**
 * Whether this environment could load the schema library.
 * @returns {boolean} true when a schema is available.
 */
export function hasSchema() {
  return Config !== undefined
}

/**
 * Fill defaults into a loader-supplied config and clamp the numeric fields.
 *
 * The loader validates the schema, but this runs again because callers may hand
 * over a bare object (tests, a programmatic mount, a config edited by hand).
 *
 * @param {Partial<typeof DEFAULTS> | undefined} input - raw config.
 * @returns {typeof DEFAULTS} a complete, in-range config.
 */
export function resolveConfig(input) {
  const maxRoots = Number(input?.maxRoots)
  const promptMaxChars = Number(input?.promptMaxChars)
  return {
    enabled: input?.enabled !== false,
    maxRoots: Number.isInteger(maxRoots) && maxRoots >= 1
      ? Math.min(maxRoots, MAX_ROOTS_CEILING)
      : DEFAULTS.maxRoots,
    injectPrompt: input?.injectPrompt !== false,
    promptMaxChars: Number.isInteger(promptMaxChars) && promptMaxChars >= MIN_PROMPT_CHARS
      ? promptMaxChars
      : DEFAULTS.promptMaxChars,
    showGit: input?.showGit !== false,
    devReload: input?.devReload === undefined ? DEFAULTS.devReload : input.devReload === true,
  }
}
