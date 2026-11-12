/**
 * `workspace_git` - one read-only question about every attached repository.
 *
 * The reason this exists: a change usually touches two or three of the six
 * repositories at once, and "which of them still has uncommitted work?" is
 * answered today by running `git status` six times and reading six outputs.
 * This tool answers it once, without ever writing to a repository.
 *
 * Read-only by construction: the only git verbs used are `status`, `diff`,
 * `diff --cached` and `log`.
 *
 * @module dsh-multi-root/git-tool
 */

import { sessionDirectory } from './context.js'
import { workspaceKey } from './context.js'
import { readDiffStat, readLog, readRepoState } from './git.js'

/** The model-facing tool name. */
export const GIT_TOOL_NAME = 'workspace_git'

/** How many commits `action: "log"` may return. */
const MAX_LOG = 20

/** Full JSON Schema, as the registry requires for every tool. */
export const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'diff', 'log'],
      description: 'status: branch, divergence and changed files. diff: --stat of staged and unstaged work. log: the newest commits.',
    },
    alias: {
      type: 'string',
      description: 'Look at one root only (its alias, aliasId or id). Defaults to every attached root.',
    },
    limit: {
      type: 'integer',
      description: `How many commits "log" returns, 1 to ${MAX_LOG}. Default 5.`,
    },
    files: {
      type: 'boolean',
      description: 'With "status", list the changed paths (up to 8 per root). Default true.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

/**
 * Pick the roots an action applies to.
 *
 * @param {readonly { id?: string, alias: string, aliasId?: string, path: string }[]} roots - attached roots.
 * @param {string} selector - an alias, aliasId, id or absolute path; empty for all.
 * @returns {{ ok: true, roots: object[] } | { ok: false, reason: string }} the selection.
 */
function selectRoots(roots, selector) {
  const wanted = typeof selector === 'string' ? selector.trim() : ''
  if (wanted === '') return { ok: true, roots: [...roots] }
  const lower = wanted.toLowerCase()
  const match = roots.find((root) =>
    String(root.id ?? '').toLowerCase() === lower
    || String(root.alias ?? '').toLowerCase() === lower
    || String(root.aliasId ?? '').toLowerCase() === lower
    || String(root.path ?? '').toLowerCase() === lower)
  if (match === undefined) return { ok: false, reason: `No attached root is called "${wanted}".` }
  return { ok: true, roots: [match] }
}

/**
 * Describe one root's status.
 *
 * @param {{ alias: string, path: string }} root - the root.
 * @param {boolean} withFiles - whether to list changed paths.
 * @returns {Promise<string>} the block for this root.
 */
async function statusBlock(root, withFiles) {
  const state = await readRepoState(root.path)
  if (state === undefined) return `${root.alias}: not a git repository (${root.path})`
  const divergence = []
  if (state.ahead > 0) divergence.push(`ahead ${state.ahead}`)
  if (state.behind > 0) divergence.push(`behind ${state.behind}`)
  const head = [`${root.alias}: ${state.branch}`]
  if (divergence.length > 0) head.push(divergence.join(', '))
  head.push(state.changed === 0 ? 'clean' : `${state.changed} changed`)
  if (state.last !== undefined) {
    head.push(`last commit ${state.last.date} ${state.last.hash} ${state.last.subject}`)
  }
  const lines = [head.join(' · ')]
  if (withFiles && state.changed > 0) {
    for (const file of state.files) lines.push(`  ${file}`)
    if (state.changed > state.files.length) lines.push(`  … ${state.changed - state.files.length} more`)
  }
  return lines.join('\n')
}

/**
 * Describe one root's diff statistics.
 *
 * @param {{ alias: string, path: string }} root - the root.
 * @returns {Promise<string>} the block for this root.
 */
async function diffBlock(root) {
  const [unstaged, staged] = await Promise.all([
    readDiffStat(root.path, false),
    readDiffStat(root.path, true),
  ])
  const body = [unstaged, staged].filter((text) => typeof text === 'string' && text.trim() !== '')
  if (body.length === 0) return `${root.alias}: no changes`
  return `${root.alias}:\n${body.map((text) => text.trimEnd()).join('\n')}`
}

/**
 * Describe one root's newest commits.
 *
 * @param {{ alias: string, path: string }} root - the root.
 * @param {number} limit - how many commits.
 * @returns {Promise<string>} the block for this root.
 */
async function logBlock(root, limit) {
  const text = await readLog(root.path, limit)
  if (typeof text !== 'string' || text.trim() === '') return `${root.alias}: no commits`
  return `${root.alias}:\n${text.trimEnd().split('\n').map((line) => `  ${line}`).join('\n')}`
}

/**
 * Build the tool definition handed to `ctx.tools.register`.
 *
 * @param {object} options - dependencies.
 * @param {object} options.ctx - the plugin context.
 * @param {object} options.snapshot - the in-memory root mirror.
 * @param {object} [options.logger] - a logger.
 * @returns {object} a registry-ready tool definition.
 */
export function createGitTool({ ctx, snapshot, logger }) {
  const run = async (args, exec) => {
    const directory = sessionDirectory(ctx, exec)
    if (directory === undefined) return 'Cannot determine the workspace directory for this session.'
    const roots = snapshot.rootsOf(workspaceKey(directory))
    if (roots.length === 0) {
      return 'This workspace has no attached roots yet; use workspace_roots with action "attach" first.'
    }
    const selection = selectRoots(roots, args?.alias)
    if (!selection.ok) return selection.reason
    const action = String(args?.action ?? '')
    if (action === 'status') {
      const withFiles = args?.files !== false
      const blocks = []
      for (const root of selection.roots) blocks.push(await statusBlock(root, withFiles))
      return blocks.join('\n\n')
    }
    if (action === 'diff') {
      const blocks = []
      for (const root of selection.roots) blocks.push(await diffBlock(root))
      return blocks.join('\n\n')
    }
    if (action === 'log') {
      const limit = Math.max(1, Math.min(MAX_LOG, Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 5))
      const blocks = []
      for (const root of selection.roots) blocks.push(await logBlock(root, limit))
      return blocks.join('\n\n')
    }
    return 'action must be "status", "diff" or "log".'
  }

  return {
    name: GIT_TOOL_NAME,
    description: 'Read-only git status, diff stats and recent commits across every repository attached to this workspace, in one call. Never writes.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 30000,
    async execute(args, exec) {
      try {
        return await run(args, exec)
      } catch (error) {
        void logger
        return `workspace_git failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}
