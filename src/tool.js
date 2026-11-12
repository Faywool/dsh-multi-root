/**
 * The `workspace_roots` tool.
 *
 * This is the only place the model can change which repositories belong to a
 * workspace. It is intentionally one tool with an `action` switch rather than
 * four tools: every extra tool name is another thing a future DSH release can
 * collide with, and the schema stays small enough to read in one glance.
 *
 * @module dsh-multi-root/tool
 */

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { sessionDirectory } from './context.js'
import { canonicalKey, dshHome, describeError, isAbsolutePath } from './util.js'
import { findRootIndex, moveRoot, normaliseAliasId, normalizeRoot, planAttach, sanitizeRoots } from './roots.js'
import { renderRootsTable, TOOL_NAME } from './prompt.js'

export { TOOL_NAME }

/** File the plugin this bundle replaces used for the same data. */
const LEGACY_STORE = 'multi_root_workspace.json'

/**
 * Check that a path names a directory that exists.
 * @param {string} path - an absolute path.
 * @returns {Promise<string | undefined>} the reason it is unusable, if it is.
 */
export async function directoryProblem(path) {
  if (!isAbsolutePath(path)) return 'path must be absolute'
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return `cannot access it (${error?.code ?? describeError(error)})`
  }
  if (!info.isDirectory()) return 'it is not a directory'
  return undefined
}

/**
 * Render a workspace's attached roots for a tool result.
 * @param {object} options - rendering inputs.
 * @param {string} options.workspacePath - the workspace directory.
 * @param {{ alias: string, path: string, mode: string }[]} options.roots - attached roots.
 * @param {import('./snapshot.js').RootSnapshot} options.snapshot - for git metadata.
 * @param {number} options.maxChars - prompt budget.
 * @returns {string} the table, or a message when nothing is attached.
 */
function render({ workspacePath, roots, snapshot, maxChars }) {
  const table = renderRootsTable({
    workspacePath,
    roots,
    gitStatus: (path) => snapshot.gitStatus(path),
    maxChars,
    heading: 'Attached workspace roots',
  })
  if (table !== '') return table
  return `No additional roots are attached to ${workspacePath}.\n`
    + 'Use this tool with action "attach" and an absolute directory path to add one.'
}

/**
 * Build the tool definition.
 *
 * The result is a plain object rather than a `defineTool(...)` wrapper: the
 * wrapper lives in `@deepseek-ai/dsh-tools`, and importing it would add a
 * resolve-time dependency to a bundle whose whole point is having none.
 *
 * @param {object} options - dependencies and configuration.
 * @param {object} options.ctx - the plugin context.
 * @param {import('./store.js').RootStore} options.store - the root store.
 * @param {import('./snapshot.js').RootSnapshot} options.snapshot - the mirror.
 * @param {object} options.configOf - reads the live config.
 * @param {object} [options.logger] - a logger.
 * @returns {object} a ToolDefinition.
 */
export function createRootsTool({ ctx, store, snapshot, configOf, logger }) {
  return {
    name: TOOL_NAME,
    description:
      'Manage the repositories attached to the current workspace besides its primary directory. '
      + 'Use "list" to see them (each row carries the id that every other action accepts), "attach" to add one '
      + 'or more absolute directory paths, "detach" to remove one by id, alias or path (or all), "rename" to '
      + 'change an alias, "mode" to switch readwrite/readonly, "skills" to expose a root\'s own skill '
      + 'directories, "move" to reorder, "reveal" to open a root in the file manager, and "import" once to '
      + 'adopt the roots recorded by the older multi-root plugin. Attached roots are absolute paths outside '
      + 'the primary workspace directory, so always address their files by absolute path.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'attach', 'detach', 'import', 'rename', 'mode', 'skills', 'namespace', 'move', 'reveal'],
          description: 'What to do.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute directory paths to attach. Required for action "attach".',
        },
        path: {
          type: 'string',
          description: 'A single absolute path: the root to attach, or the alias/path to detach. '
            + '`alias` selects a detach target by alias.',
        },
        alias: {
          type: 'string',
          description: 'Optional short name for an attached root, used in the prompt table. '
            + 'Only valid when attaching exactly one path.',
        },
        mode: {
          type: 'string',
          enum: ['readwrite', 'readonly'],
          description: 'Access mode recorded for the attached root. Defaults to readwrite.',
        },
        all: {
          type: 'boolean',
          description: 'With action "detach": remove every attached root.',
        },
        target: {
          type: 'string',
          description: 'Which attached root to change, by id, alias or absolute path. '
            + 'Required by rename, mode, skills, move and reveal.',
        },
        newAlias: {
          type: 'string',
          description: 'The new alias for action "rename".',
        },
        position: {
          type: 'string',
          description: 'For action "move": "up", "down", or a zero-based index.',
        },
        skillsEnabled: {
          type: 'boolean',
          description: 'For action "skills": expose the root\'s own .claude/skills and '
            + '.agents/skills directories to this workspace. Omit to toggle.',
        },
        aliasId: {
          type: 'string',
          description: 'For action "namespace": the id that prefixes this root\'s skills '
            + '(`aliasId:skill-name`). Defaults to the alias when the root is attached.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
    },
    timeoutMs: 20000,
    execute: async (args, exec) => {
      try {
        return await run(args, exec)
      } catch (error) {
        return `workspace_roots failed: ${describeError(error)}`
      }
    },
  }

  /**
   * Dispatch one tool call.
   * @param {Record<string, unknown>} args - validated arguments.
   * @param {object | undefined} exec - tool execution context.
   * @returns {Promise<string>} a human-readable result.
   */
  async function run(args, exec) {
    const config = configOf()
    if (!config.enabled) {
      return 'dsh-multi-root is switched off in Settings, so attached roots are unavailable.'
    }
    const action = String(args?.action ?? 'list').toLowerCase()
    const workspacePath = sessionDirectory(ctx, exec)
    if (workspacePath === undefined) {
      return 'Cannot determine the workspace directory for this session, so attached roots are unavailable. '
        + 'This is usually a DSH version mismatch rather than a problem with the roots themselves.'
    }

    if (action === 'list') {
      const roots = await store.list(workspacePath)
      await snapshot.refresh()
      return render({ workspacePath, roots, snapshot, maxChars: config.promptMaxChars })
    }

    if (action === 'attach') return attach(args, workspacePath)
    if (action === 'detach') return detach(args, workspacePath)
    if (action === 'rename') return renameRoot(args, workspacePath)
    if (action === 'mode') return setMode(args, workspacePath)
    if (action === 'skills') return setSkills(args, workspacePath)
    if (action === 'namespace') return setNamespace(args, workspacePath)
    if (action === 'move') return move(args, workspacePath)
    if (action === 'reveal') return reveal(args, workspacePath)
    if (action === 'import') return importLegacy(workspacePath)

    return `Unknown action "${action}". Use one of: list, attach, detach, rename, mode, skills, namespace, move, reveal, import.`
  }

  /**
   * Attach one or more roots.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary of what changed.
   */
  async function attach(args, workspacePath) {
    const config = configOf()
    const requested = Array.isArray(args?.paths) && args.paths.length > 0
      ? args.paths.map((entry) => String(entry))
      : (typeof args?.path === 'string' && args.path !== '' ? [args.path] : [])
    if (requested.length === 0) {
      return 'action "attach" needs `paths` (an array of absolute directory paths) or `path`.'
    }
    if (args?.alias !== undefined && requested.length > 1) {
      return '`alias` applies to a single path; attach multiple paths without it or call once per root.'
    }

    const existing = await store.list(workspacePath)
    const accepted = []
    const rejected = []
    for (const raw of requested) {
      const candidate = raw.trim().replace(/[\\/]+$/, '')
      const problem = await directoryProblem(candidate)
      if (problem !== undefined) {
        rejected.push(`${raw} — ${problem}`)
        continue
      }
      if (canonicalKey(candidate) === canonicalKey(workspacePath)) {
        rejected.push(`${raw} — it is the primary workspace directory, not an additional root`)
        continue
      }
      const normalized = normalizeRoot({
        path: candidate,
        alias: requested.length === 1 ? args?.alias : undefined,
        mode: args?.mode,
      }, existing.concat(accepted))
      if (!normalized.ok) {
        rejected.push(`${raw} — ${normalized.reason}`)
        continue
      }
      accepted.push(normalized.root)
    }

    if (accepted.length === 0) {
      return `Nothing was attached.\n${rejected.map((entry) => `- ${entry}`).join('\n')}`
    }

    const plan = planAttach(existing, accepted, config.maxRoots)
    await store.write(workspacePath, plan.roots)
    await snapshot.refresh()

    const parts = []
    if (plan.added.length > 0) parts.push(`Attached: ${plan.added.join(', ')}`)
    if (plan.replaced.length > 0) parts.push(`Updated: ${plan.replaced.join(', ')}`)
    if (rejected.length > 0) parts.push(`Rejected:\n${rejected.map((entry) => `- ${entry}`).join('\n')}`)
    if (plan.skipped.length > 0) {
      parts.push(`Skipped (cap reached):\n${plan.skipped.map((entry) => `- ${entry.path} — ${entry.reason}`).join('\n')}`)
    }
    parts.push('')
    parts.push(render({ workspacePath, roots: plan.roots, snapshot, maxChars: config.promptMaxChars }))
    return parts.join('\n')
  }

  /**
   * Detach one root, or all of them.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary of what changed.
   */
  async function detach(args, workspacePath) {
    const config = configOf()
    const existing = await store.list(workspacePath)
    if (existing.length === 0) {
      return `No roots are attached to ${workspacePath}.`
    }
    if (args?.all === true) {
      await store.write(workspacePath, [])
      await snapshot.refresh()
      return `Detached all ${existing.length} root(s) from ${workspacePath}.`
    }
    const selector = targetOf(args)
    if (selector === undefined) {
      return 'action "detach" needs `target` (an id, alias or absolute path), or `all: true`.'
    }
    const index = findRootIndex(existing, selector)
    if (index === -1) {
      return `No attached root matches "${selector}". Attached roots: ${existing.map((root) => root.alias).join(', ')}.`
    }
    const [removed] = existing.splice(index, 1)
    await store.write(workspacePath, existing)
    await snapshot.refresh()
    return `Detached ${removed.alias} (${removed.path}).\n\n`
      + render({ workspacePath, roots: existing, snapshot, maxChars: config.promptMaxChars })
  }

  /**
   * Resolve the target of a per-root action.
   * @param {Record<string, unknown>} args - tool arguments.
   * @returns {string | undefined} the selector, if one was supplied.
   */
  function targetOf(args) {
    for (const candidate of [args?.target, args?.path, args?.alias]) {
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return undefined
  }

  /**
   * Read the list, find one root, hand it to `change`, persist, re-render.
   * @param {string} action - the action name, for messages.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @param {(root: object, roots: object[]) => { ok: true, root?: object, roots?: object[], note?: string }
   *   | { ok: false, reason: string }} change - the mutation.
   * @returns {Promise<string>} a summary of what changed.
   */
  async function mutate(action, args, workspacePath, change) {
    const config = configOf()
    const selector = targetOf(args)
    if (selector === undefined) {
      return `action "${action}" needs \`target\`: the id, alias or absolute path of an attached root.`
    }
    const existing = await store.list(workspacePath)
    const index = findRootIndex(existing, selector)
    if (index === -1) {
      return `No attached root matches "${selector}". Attached roots: `
        + `${existing.map((root) => root.alias).join(', ') || '(none)'}.`
    }
    const outcome = change(existing[index], existing)
    if (!outcome.ok) return outcome.reason
    const roots = outcome.roots ?? existing
    await store.write(workspacePath, roots)
    await snapshot.refresh()
    const head = outcome.note === undefined ? `Updated ${roots[index]?.alias ?? selector}.` : outcome.note
    return `${head}\n\n` + render({ workspacePath, roots, snapshot, maxChars: config.promptMaxChars })
  }

  /**
   * Rename one root.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function renameRoot(args, workspacePath) {
    const raw = typeof args?.newAlias === 'string' ? args.newAlias.trim() : ''
    if (raw === '') return 'action "rename" needs `newAlias`.'
    return mutate('rename', args, workspacePath, (root, roots) => {
      const others = roots.filter((entry) => entry.id !== root.id)
      if (others.some((entry) => entry.alias.toLowerCase() === raw.toLowerCase())) {
        return { ok: false, reason: `Another root already uses the alias "${raw}".` }
      }
      return {
        ok: true,
        roots: roots.map((entry) => (entry.id === root.id ? { ...entry, alias: raw } : entry)),
        note: `Renamed ${root.alias} to ${raw}.`,
      }
    })
  }

  /**
   * Switch one root between readwrite and readonly.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function setMode(args, workspacePath) {
    const mode = typeof args?.mode === 'string' ? args.mode.toLowerCase() : ''
    if (mode !== 'readwrite' && mode !== 'readonly') {
      return 'action "mode" needs `mode`: "readwrite" or "readonly".'
    }
    return mutate('mode', args, workspacePath, (root, roots) => ({
      ok: true,
      roots: roots.map((entry) => (entry.id === root.id ? { ...entry, mode } : entry)),
      note: `${root.alias} is now ${mode}.`,
    }))
  }

  /**
   * Turn one root's own skill directories on or off.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function setSkills(args, workspacePath) {
    return mutate('skills', args, workspacePath, (root, roots) => {
      const next = typeof args?.skillsEnabled === 'boolean' ? args.skillsEnabled : !root.skillsEnabled
      return {
        ok: true,
        roots: roots.map((entry) => (entry.id === root.id ? { ...entry, skillsEnabled: next } : entry)),
        note: `Skills from ${root.alias} are now ${next ? 'on' : 'off'}.`,
      }
    })
  }

  /**
   * Change the skill namespace id of one root.
   *
   * The namespace is separate from the alias on purpose: renaming what the panel
   * shows must not rename every `namespace:skill` the model already learned.
   *
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function setNamespace(args, workspacePath) {
    const raw = typeof args?.aliasId === 'string' ? args.aliasId.trim() : ''
    if (raw === '') return 'action "namespace" needs `aliasId` (letters, digits, dot, dash or underscore).'
    return mutate('namespace', args, workspacePath, (root, roots) => {
      const aliasId = normaliseAliasId(raw, root.alias)
      const clash = roots.find(
        (entry) => entry.id !== root.id && normaliseAliasId(entry.aliasId ?? entry.alias, entry.alias) === aliasId,
      )
      if (clash !== undefined) {
        return { ok: false, reason: `Another root already uses the namespace "${aliasId}".` }
      }
      return {
        ok: true,
        roots: roots.map((entry) => (entry.id === root.id ? { ...entry, aliasId } : entry)),
        note: `Skill namespace of ${root.alias} is now ${aliasId}.`,
      }
    })
  }

  /**
   * Reorder one root.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function move(args, workspacePath) {
    const position = typeof args?.position === 'string' && args.position.trim() !== ''
      ? args.position.trim()
      : args?.position
    if (position === undefined) return 'action "move" needs `position`: "up", "down" or an index.'
    const parsed = position === 'up' || position === 'down' ? position : Number(position)
    if (parsed !== 'up' && parsed !== 'down' && !Number.isInteger(parsed)) {
      return '`position` must be "up", "down" or an integer index.'
    }
    return mutate('move', args, workspacePath, (_root, roots) => {
      const selector = targetOf(args)
      const moved = moveRoot(roots, selector, parsed)
      if (!moved.ok) return moved
      return { ok: true, roots: moved.roots, note: `Moved to position ${moved.index + 1} of ${moved.roots.length}.` }
    })
  }

  /**
   * Open one root in the platform file manager.
   * @param {Record<string, unknown>} args - tool arguments.
   * @param {string} workspacePath - the workspace directory.
   * @returns {Promise<string>} a summary.
   */
  async function reveal(args, workspacePath) {
    const selector = targetOf(args)
    if (selector === undefined) {
      return 'action "reveal" needs `target`: the id, alias or absolute path of an attached root.'
    }
    const existing = await store.list(workspacePath)
    const index = findRootIndex(existing, selector)
    if (index === -1) {
      return `No attached root matches "${selector}". Attached roots: `
        + `${existing.map((root) => root.alias).join(', ') || '(none)'}.`
    }
    const root = existing[index]
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try {
      const child = spawn(command, [root.path], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } catch (error) {
      return `Could not open ${root.path}: ${describeError(error)}`
    }
    return `Opened ${root.path} in the file manager.`
  }

  /**
   * Adopt the roots recorded by the plugin this bundle replaces.
   *
   * The old store keyed roots by workspace path and, on this machine, stored the
   * same list twice under differently-cased keys. Everything is deduplicated by
   * canonical path, and the common parent of the legacy roots is reported as the
   * directory that workspace should probably be opened on.
   *
   * @param {string} workspacePath - the workspace to attach the legacy roots to.
   * @returns {Promise<string>} a summary, or an explanation of why nothing happened.
   */
  async function importLegacy(workspacePath) {
    const config = configOf()
    const file = join(dshHome(), 'storages', LEGACY_STORE)
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return `No legacy store found at ${file}, so there is nothing to import.`
      }
      return `Could not read ${file}: ${describeError(error)}`
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return `The legacy store at ${file} is not valid JSON (${describeError(error)}).`
    }

    const collected = []
    const seen = new Set()
    for (const table of Object.values(parsed?.tables?.roots ?? {})) {
      for (const entry of Array.isArray(table?.roots) ? table.roots : []) {
        if (typeof entry?.path !== 'string') continue
        // The legacy store recorded the same list under differently-cased
        // workspace keys; dedupe by canonical path so a single import cannot
        // attach a repository twice under `backend` and `backend-2`.
        const key = canonicalKey(entry.path)
        if (seen.has(key)) continue
        const alias = typeof entry.aliasId === 'string' && entry.aliasId !== ''
          ? entry.aliasId
          : (typeof entry.alias === 'string' ? entry.alias : undefined)
        const normalized = normalizeRoot({ path: entry.path, alias, mode: 'readwrite' }, collected)
        if (!normalized.ok) continue
        seen.add(key)
        collected.push(normalized.root)
      }
    }

    if (collected.length === 0) {
      return `The legacy store at ${file} contains no usable roots.`
    }

    const existing = await store.list(workspacePath)
    const plan = planAttach(existing, collected, config.maxRoots)
    await store.write(workspacePath, sanitizeRoots(plan.roots))
    await snapshot.refresh()

    const parent = commonParent(collected.map((root) => root.path))
    const lines = [
      `Imported ${collected.length} root(s) from the legacy store into ${workspacePath}.`,
      plan.skipped.length > 0
        ? `Skipped ${plan.skipped.length} because the cap of ${config.maxRoots} was reached.`
        : '',
      parent === undefined
        ? ''
        : `These repositories share the parent directory ${parent}; opening that directory as a `
          + 'workspace would make all of them native to the session, with no attached roots needed.',
      '',
      render({ workspacePath, roots: plan.roots, snapshot, maxChars: config.promptMaxChars }),
    ]
    return lines.filter((line) => line !== '').join('\n')
  }
}

/**
 * The deepest directory that contains every path.
 * @param {readonly string[]} paths - absolute paths.
 * @returns {string | undefined} the common parent, if there is one.
 */
export function commonParent(paths) {
  if (paths.length === 0) return undefined
  const split = (path) => path.split(sep).filter((part) => part !== '')
  let shared = split(dirname(paths[0]))
  if (shared.length === 0) shared = split(paths[0])
  for (const path of paths.slice(1)) {
    const parts = split(dirname(path))
    let index = 0
    while (index < shared.length && index < parts.length
      && shared[index].toLowerCase() === parts[index].toLowerCase()) {
      index += 1
    }
    shared = shared.slice(0, index)
  }
  if (shared.length === 0) return undefined
  return shared.join(sep)
}
