/**
 * Make `mode: "readonly"` mean something.
 *
 * The panel's readonly flag used to be advice: it showed up in the prompt table
 * and nothing else, so a model that decided to edit a "readonly" root simply
 * did. This registers a tool guard that refuses such a call before it runs.
 *
 * Three rules keep it from becoming a hazard in its own right:
 *
 * 1. It only speaks up when it can positively resolve an absolute path inside a
 *    known readonly root. Anything it cannot parse is allowed through.
 * 2. It denies writes only; reading a readonly root stays normal.
 * 3. It is additive. If `tools.guard` is missing the plugin behaves exactly as
 *    it did before.
 *
 * @module dsh-multi-root/readonly-guard
 */

import { canonicalKey, describeError, noteFailure } from './util.js'

/** Tool names whose arguments name a filesystem target that must be writable. */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'create_file',
  'edit',
  'edit_file',
  'apply_patch',
  'multi_edit',
  'delete',
  'delete_file',
  'remove',
  'move',
  'move_file',
  'rename',
])

/** How deep to look inside one tool's arguments. */
const MAX_DEPTH = 4

/** How many candidate paths to collect from one call. */
const MAX_PATHS = 24

/**
 * Whether a string looks like an absolute Windows or UNC path.
 *
 * @param {string} value - the candidate.
 * @returns {boolean} true when it is absolute.
 */
function looksAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Collect the absolute paths mentioned in a tool's arguments.
 *
 * Tool arguments are model-written JSON with no schema we can rely on, so this
 * walks the structure rather than guessing field names.
 *
 * @param {unknown} value - any parsed argument fragment.
 * @param {Set<string>} found - accumulator.
 * @param {number} [depth=0] - current depth.
 * @returns {void}
 */
function collectPaths(value, found, depth = 0) {
  if (found.size >= MAX_PATHS || depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    if (value.length > 3 && value.length < 512 && looksAbsolute(value) && !value.includes('\n')) {
      found.add(value)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, found, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectPaths(item, found, depth + 1)
  }
}

/**
 * Whether a path is the same as, or below, a directory.
 *
 * @param {string} candidate - the absolute path under test.
 * @param {string} directory - the absolute directory.
 * @returns {boolean} true when the candidate lives inside the directory.
 */
function isInside(candidate, directory) {
  const child = canonicalKey(candidate)
  const parent = canonicalKey(directory)
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

/**
 * Build the guard function.
 *
 * @param {object} options - dependencies.
 * @param {object} options.snapshot - the in-memory root mirror.
 * @param {object} [options.logger] - a logger.
 * @returns {(execution: { name?: string, arguments?: unknown }) => string | undefined} the guard.
 */
export function createReadOnlyGuard({ snapshot, logger }) {
  void logger
  return (execution) => {
    try {
      const name = typeof execution?.name === 'string' ? execution.name : ''
      if (!WRITE_TOOLS.has(name)) return undefined
      const roots = typeof snapshot?.allRoots === 'function' ? snapshot.allRoots() : []
      if (roots.length === 0) return undefined
      const found = new Set()
      collectPaths(execution.arguments, found)
      if (found.size === 0) return undefined
      for (const candidate of found) {
        for (const root of roots) {
          if (root.mode !== 'readonly') continue
          if (!isInside(candidate, root.path)) continue
          return `"${candidate}" is inside the readonly root "${root.alias}". `
            + `Run /multi-root mode ${root.alias} readwrite, or write somewhere else.`
        }
      }
      return undefined
    } catch (error) {
      // A guard that throws would break every tool call, so it never throws.
      noteFailure(`readonly guard skipped a call: ${describeError(error)}`)
      return undefined
    }
  }
}

/**
 * Register the guard with the tool registry.
 *
 * Uses a scoped injection for the same reason tool registration does: a guard
 * registered through the plugin's own context is not inherited by agents.
 *
 * @param {object} options - dependencies.
 * @param {object} options.ctx - the plugin context.
 * @param {object} options.snapshot - the in-memory root mirror.
 * @param {object} [options.logger] - a logger.
 * @returns {boolean} whether the guard was registered.
 */
export function installReadOnlyGuard({ ctx, snapshot, logger }) {
  const guardFunction = createReadOnlyGuard({ snapshot, logger })
  const register = (tools) => {
    if (typeof tools?.guard !== 'function') return false
    tools.guard(guardFunction)
    noteFailure('readonly guard registered')
    return true
  }
  try {
    if (typeof ctx.inject === 'function') {
      let registered = false
      ctx.inject(['tools'], (scoped) => {
        try {
          registered = register(scoped?.tools)
        } catch (error) {
          noteFailure(`could not register the readonly guard: ${describeError(error)}`)
        }
      })
      return true
    }
    return register(typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
  } catch (error) {
    noteFailure(`could not register the readonly guard: ${describeError(error)}`)
    return false
  }
}
