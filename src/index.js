/**
 * Plugin entry point.
 *
 * Contract with DSH, in order of importance:
 *
 * 1. `inject` is empty. Nothing in this bundle can be left "pending, waiting for
 *    a service", which is how a plugin takes a whole composition down with it.
 * 2. `apply` never throws. Every registration is wrapped by `guard`, and the
 *    whole body is wrapped again, so a failure here costs features and nothing
 *    else — `ctx.fs`, `ctx.sandbox`, the file tools and the session are all
 *    owned by other plugins and are never touched.
 * 3. Every contribution is additive — a prompt section, two tools, a slash
 *    command, a skill provider, a JSON route and a client half. Dropping any of
 *    them leaves DSH indistinguishable from a run without this bundle.
 *
 * Contributions that need a service wait for it through a scoped injection
 * (`withService`), because `apply()` can run before the services exist.
 *
 * @module dsh-multi-root
 */

import { hasSchema, resolveConfig } from './config.js'
import { RootStore } from './store.js'
import { RootSnapshot } from './snapshot.js'
import { GitStatusCache } from './git.js'
import { createRootsTool } from './tool.js'
import { createFindTool, FIND_TOOL_NAME } from './find-tool.js'
import { COMMAND_NAME, registerCommand } from './command.js'
import { registerSkillProvider, SKILL_PROVIDER } from './skills.js'
import { registerRoutes } from './routes.js'
import { guard, service } from './context.js'
import { renderRootsTable, sectionWorkspacePath, SECTION_NAME } from './prompt.js'
import { describeError, debug, noteDiagnostic, report, storePath } from './util.js'

export { Config } from './config.js'
export { SECTION_NAME, TOOL_NAME } from './prompt.js'
export { FIND_TOOL_NAME } from './find-tool.js'
export { COMMAND_NAME } from './command.js'
export { SKILL_PROVIDER, SKILL_DIRECTORIES } from './skills.js'

/** The plugin's name, as the loader knows it. */
export const name = 'dsh-multi-root'

/**
 * No hard dependencies.
 *
 * Declaring services here would make the loader hold this row in `pending`
 * until every one of them appears. Reading them through `service()` instead
 * means a missing service degrades one feature immediately.
 */
export const inject = []

/** Prompt sections are ordered; this is the slot used when lookup fails. */
const FALLBACK_SECTION_ORDER = 1000

/**
 * Load into a context.
 *
 * The raw config object is kept and re-resolved on every use. Every field is
 * marked volatile in the schema, which means DSH edits it in place instead of
 * remounting the plugin, so a captured copy would silently go stale.
 *
 * @param {object} ctx - the plugin context.
 * @param {Partial<import('./config.js').DEFAULTS> | undefined} input - loader config.
 */
export function apply(ctx, input) {
  debug('apply() reached')
  try {
    const config = resolveConfig(input)
    const configOf = () => {
      try {
        return resolveConfig(input)
      } catch {
        return config
      }
    }
    if (!config.enabled) {
      report(ctx.logger, 'info', 'disabled by configuration; nothing was mounted')
      debug('disabled by configuration')
      return
    }
    mount(ctx, configOf)
  } catch (error) {
    const message = describeError(error)
    debug(`apply() failed: ${message}`)
    report(ctx.logger, 'warn', `failed to mount (${message}); DSH continues without it`)
  }
}

/**
 * Register the settings form, the prompt section and the tool, each independently.
 *
 * All three are registered unconditionally; the switches are consulted when the
 * contribution is used, so turning one off in Settings takes effect immediately.
 *
 * @param {object} ctx - the plugin context.
 * @param {() => import('./config.js').DEFAULTS} configOf - reads the live config.
 */
function mount(ctx, configOf) {
  const logger = ctx.logger
  const git = new GitStatusCache({ logger })
  const store = new RootStore({ file: storePath(process.env), logger })
  const snapshot = new RootSnapshot({ store, git, logger })

  // Prime the mirror without blocking the mount: the first prompt assembly
  // simply omits the table, and every one after the read completes has it.
  void snapshot.refresh()
  snapshot.start(ctx)

  const mounted = []
  const note = (label) => {
    mounted.push(label)
    noteDiagnostic(`mounted ${label}`)
  }

  // Which workspace the GUI is showing. No service reports the sidebar
  // selection, so the panel route maps the newest session directory onto a
  // workspace; this keeps that directory current without touching any store.
  // Session events are emitted inside each Session's own context, so the
  // listener has to be global to see them from here.
  let recentDirectory = ''
  if (guard(ctx, 'session tracking', () => {
    if (typeof ctx.on !== 'function') return undefined
    let announced = false
    const listener = (session, event) => {
      try {
        const header = session === null || session === undefined ? undefined : (session.header ?? session.session?.header)
        const directory = header === undefined ? undefined : header.cwd
        if (!announced) {
          announced = true
          noteDiagnostic(`first session event: ${String(event?.type ?? 'unknown')}; directory ${String(directory ?? 'unknown')}`)
        }
        if (typeof directory === 'string' && directory !== '') recentDirectory = directory
      } catch (error) {
        /* a shape we do not understand must not cost the session */
      }
    }
    const dispose = ctx.on('session/event', listener, { global: true })
    return dispose
  })) {
    /* tracked; nothing to announce */
  }

  if (withService(ctx, 'settings', 'settings form', (settings) => {
    if (typeof settings?.configure !== 'function') {
      throw new Error('the settings service is not mounted')
    }
    const dispose = settings.configure({ auto: true })
    debugSettings(settings, ctx)
    note('settings')
    return dispose
  })) { /* scheduled (or mounted, when the context cannot wait) */ }

  withService(ctx, 'systemPrompt', 'prompt section', (systemPrompt) => {
    if (typeof systemPrompt?.section !== 'function') {
      throw new Error('the systemPrompt service is not mounted')
    }
    note('prompt')
    return systemPrompt.section({
      name: SECTION_NAME,
      order: sectionOrder(systemPrompt),
      text: (context) => sectionText(configOf, snapshot, context),
    })
  })

  // `registerTool` waits for `tools` itself, with a scoped injection, because a
  // registration made through the plugin's own context lands in a layer no agent
  // resolves. Reading the service here first would skip that path entirely.
  if (guard(ctx, 'workspace_roots tool', () => registerTool(ctx, createRootsTool({ ctx, store, snapshot, configOf, logger })))) {
    mounted.push('tool')
  }

  if (guard(ctx, 'workspace_find tool', () => registerTool(ctx, createFindTool({ ctx, snapshot, configOf, logger })))) {
    mounted.push(FIND_TOOL_NAME)
  }

  withService(ctx, 'commands', 'slash command', (commands) => {
    const registered = registerCommand({ ctx, commands, store, snapshot, configOf, logger })
    if (registered) note(`/${COMMAND_NAME}`)
  })

  // Skills a root ships itself. Additive: the provider is borrowed, so a missing
  // skills service or a throwing provider costs one skill, never the composition.
  withService(ctx, 'skills', 'skill provider', () => {
    if (registerSkillProvider({ ctx, snapshot, logger })) note('skills')
  })

  // The panel's data route. Absent web server = headless composition, which is
  // a normal way to run DSH, so this stays quiet instead of warning.
  withService(ctx, 'webServer', 'state route', (webServer) => {
    const deps = {
      store,
      snapshot,
      config: configOf,
      logger,
      ctx,
      currentDirectory: () => recentDirectory,
    }
    if (registerRoutes(ctx, deps, webServer)) note('panel')
  })

  // One line that says what actually took effect. Contributions marked with `*`
  // wait for their service, so they may still land after this line: each one
  // logs `mounted <name>` on arrival, which makes a late composition readable.
  const summary = mounted.length === 0
    ? 'scheduled nothing: none of settings, systemPrompt or tools were available'
    : `scheduled ${mounted.join(', ')}; schema ${hasSchema() ? 'loaded' : 'unavailable'}; roots are stored in ${store.file}`
  debug(summary)
  noteDiagnostic(summary)
  report(logger, mounted.length === 0 ? 'warn' : 'info', summary)
}

/**
 * Run a registration when a service is available, and only then.
 *
 * `apply()` may run before the services it wants exist: on a real reload this
 * bundle mounted while `tools`, `settings` and `webServer` were still absent,
 * and a one-shot `ctx.get()` then lost every contribution for that whole
 * generation. Waiting through a scoped injection fixes the order without
 * making the row `pending` — the row itself declares no dependencies, so a
 * service that never appears costs one feature instead of the composition.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} name - the service name.
 * @param {string} label - what is being registered, for the log line.
 * @param {(value: any, scoped: object) => (void | (() => void))} run - the registration.
 * @returns {boolean} whether the registration was scheduled.
 */
function withService(ctx, name, label, run) {
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject([name], (scoped) => {
        guard(scoped, label, () => {
          const value = scoped?.[name] ?? service(scoped, name)
          return run(value, scoped)
        })
      })
      return true
    } catch (error) {
      noteFailure(`${label} could not wait for ${name}: ${describeError(error)}`)
    }
  }
  return guard(ctx, label, () => run(service(ctx, name), ctx))
}

/**
 * Register a tool so that every agent can see it.
 *
 * The way in is a scoped injection, exactly as first-party and third-party tool
 * plugins do it: `ctx.inject(['tools'], scoped => scoped.tools.register(...))`.
 * A plain `service(ctx, 'tools').register(...)` looks like it works — the
 * registration is accepted and even refuses a duplicate — but it lands in the
 * plugin's own layer, which no agent resolves.
 *
 * The scoped fiber owns the registration, so it is disposed with the service or
 * with this bundle; no manual cleanup is needed.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} definition - a registry-ready tool definition.
 * @returns {() => void} a disposer for symmetry with a direct registration.
 */
function registerTool(ctx, definition) {
  if (typeof ctx.inject === 'function') {
    return ctx.inject(['tools'], (scoped) => {
      const tools = scoped.tools ?? service(scoped, 'tools')
      if (typeof tools?.register !== 'function') return
      try {
        tools.register(definition)
        noteDiagnostic(`registered ${definition.name} through a scoped tools injection`)
      } catch (error) {
        noteFailure(`could not register ${definition.name}: ${describeError(error)}`)
      }
    })
  }
  const tools = service(ctx, 'tools')
  if (typeof tools?.register !== 'function') throw new Error('the tools service is not mounted')
  noteDiagnostic(`registered ${definition.name} directly; ctx.inject is unavailable`)
  return tools.register(definition)
}

/**
 * Log which settings namespaces exist, when debugging is on.
 *
 * A Config-only plugin gets no Settings page in DSH 0.2.2: every page is
 * contributed by a client UI plugin. This line makes that visible instead of
 * leaving "the form did not appear" to guesswork.
 *
 * @param {object} settings - the settings service.
 * @param {object} ctx - the plugin context, for the config editor.
 */
function debugSettings(settings, ctx) {
  try {
    const described = settings.describe?.()
    if (!Array.isArray(described)) return
    const mine = described.some((entry) => entry?.ns === 'dsh-multi-root')
    debug(`settings namespaces: ${described.length} registered; ours ${mine ? 'present' : 'absent'}`)
  } catch (error) {
    debug(`settings.describe() failed: ${describeError(error)}`)
  }
}

/**
 * Where the attached-root section belongs in the prompt.
 *
 * Anchoring to an existing section keeps the position meaningful across DSH
 * versions that renumber the built-in sections. If the anchor is unknown the
 * fallback order is used, which puts the section late but never breaks assembly.
 *
 * @param {object} systemPrompt - the systemPrompt service.
 * @returns {number} a finite section order.
 */
function sectionOrder(systemPrompt) {
  try {
    const anchor = systemPrompt.getSectionOrder?.('TOOL_SESSION_QUERY')
    if (Number.isFinite(anchor)) return anchor + 1
  } catch {
    // An unknown anchor name is expected on some versions.
  }
  return FALLBACK_SECTION_ORDER
}

/**
 * Render the section for one assembly.
 *
 * Prompt assembly is synchronous, so this reads the in-memory mirror rather
 * than the store. Anything unexpected renders as no section at all: a missing
 * table is harmless, a thrown error during assembly is not.
 *
 * @param {() => import('./config.js').DEFAULTS} configOf - reads the live config.
 * @param {import('./snapshot.js').RootSnapshot} snapshot - the mirror.
 * @param {{ scope?: object, signal?: AbortSignal } | undefined} context - assembly context.
 * @returns {string} the section text.
 */
function sectionText(configOf, snapshot, context) {
  try {
    const config = configOf()
    if (!config.enabled || !config.injectPrompt) return ''
    const workspacePath = sectionWorkspacePath(context)
    if (workspacePath === undefined) return ''
    const roots = snapshot.rootsOf(workspacePath)
    if (roots.length === 0) return ''
    return renderRootsTable({
      workspacePath,
      roots,
      gitStatus: config.showGit ? (path) => snapshot.gitStatus(path) : undefined,
      notes: (path) => snapshot.agentsOf(path),
      maxChars: config.promptMaxChars,
    })
  } catch {
    return ''
  }
}
