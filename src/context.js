/**
 * Best-effort access to the host services this bundle uses.
 *
 * Every accessor here can return `undefined`. That is the entire safety story
 * of this bundle: a missing `systemPrompt`, `tools`, `settings` or
 * `workingDirectory` costs one feature, never a failed mount. Nothing in this
 * file throws, and nothing assumes a service exists.
 *
 * @module dsh-multi-root/context
 */

import { canonicalKey, debug, noteFailure } from './util.js'

/**
 * The key a workspace's roots are stored under.
 *
 * One spelling for the tool, the prompt and the store, so a root attached by
 * one path spelling is found by every other one.
 *
 * @param {string} workspacePath - an absolute workspace directory.
 * @returns {string} the storage key.
 */
export function workspaceKey(workspacePath) {
  return canonicalKey(workspacePath)
}

/**
 * The session directory carried by an execution or assembly view.
 *
 * Both the tool path and the prompt path go through this one function, which is
 * what guarantees that a root attached by the tool is the root the prompt shows
 * on the next step. It is deliberately structural: no service is consulted, so
 * it cannot disagree with itself between a sync and an async caller.
 *
 * @param {object | undefined} view - a tool execution context or an assembly context.
 * @returns {string | undefined} an absolute directory, if one can be found.
 */
export function directoryOf(view) {
  const agent = view?.agent ?? view?.scope
  const session = view?.session ?? agent?.session
  const candidates = [
    session?.header?.cwd,
    session?.cwd,
    agent?.session?.header?.cwd,
    agent?.cwd,
    view?.cwd,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * Read an optional service.
 * @param {object} ctx - the plugin context.
 * @param {string} name - the service name.
 * @returns {any} the service, or undefined.
 */
export function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * The directory a tool call is running in.
 *
 * The structural lookup is tried first so that it matches the prompt section;
 * `workingDirectory` is consulted only as a second opinion for a context shape
 * this bundle has not seen.
 *
 * @param {object} ctx - the plugin context.
 * @param {object | undefined} exec - the tool execution context.
 * @returns {string | undefined} an absolute directory, if one can be found.
 */
export function sessionDirectory(ctx, exec) {
  const direct = directoryOf(exec)
  if (direct !== undefined) return direct
  const workingDirectory = service(ctx, 'workingDirectory')
  if (typeof workingDirectory?.get === 'function') {
    const session = exec?.session ?? exec?.agent?.session
    try {
      const resolved = workingDirectory.get(session)
      if (typeof resolved === 'string' && resolved !== '') return resolved
      if (typeof resolved?.path === 'string' && resolved.path !== '') return resolved.path
    } catch {
      // A context without a session is normal during early startup.
    }
  }
  return undefined
}

/**
 * Run a registration and hand its disposer to Cordis.
 *
 * A failure is logged and dropped. This is the only place in the bundle that
 * decides what "degrade instead of break" means, so the rule lives here rather
 * than being re-derived at each call site.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} label - what is being registered, for the log line.
 * @param {() => (void | (() => void))} register - the registration attempt.
 * @returns {boolean} whether the registration succeeded.
 */
export function guard(ctx, label, register) {
  try {
    const dispose = register()
    if (typeof dispose === 'function') {
      try {
        ctx.effect(() => {
          try {
            dispose()
          } catch {
            // A failing disposer at teardown must not fail the unload.
          }
        })
      } catch {
        // Without an effect API the registration still works; it just will not
        // be torn down if this bundle is reloaded.
      }
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    debug(`${label} could not be registered: ${message}`)
    noteFailure(`${label} could not be registered: ${message}`)
    try {
      ctx.logger?.warn?.(`[dsh-multi-root] ${label} unavailable (${message}); the rest keeps working`)
    } catch {
      // Logging is best-effort.
    }
    return false
  }
}
