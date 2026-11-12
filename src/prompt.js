/**
 * Rendering of the attached-root table.
 *
 * Two consumers read the same table: the model-facing prompt section and the
 * `workspace_roots` tool result. Keeping one renderer means the model cannot
 * be told two different things about the same workspace.
 *
 * Everything here is synchronous and pure so it can run inside a prompt
 * assembly callback, which has no opportunity to await.
 *
 * @module dsh-multi-root/prompt
 */

import { directoryOf } from './context.js'

/** Name of the prompt section this bundle owns. */
export const SECTION_NAME = 'dsh-multi-root:roots'

/** Tool name, re-exported so the entry point has a single source of truth. */
export const TOOL_NAME = 'workspace_roots'

/** Shown when a workspace has no roots attached yet. */
const EMPTY_LINE = 'No additional roots are attached to this workspace.'

/**
 * The workspace a prompt assembly is being rendered for.
 *
 * Uses the same structural lookup as the tool, so the table the model sees is
 * always the list the tool wrote.
 *
 * @param {{ scope?: object, signal?: AbortSignal } | undefined} context - assembly context.
 * @returns {string | undefined} the absolute session directory, if known.
 */
export function sectionWorkspacePath(context) {
  return directoryOf(context)
}

/**
 * Render the attached-root table.
 *
 * @param {object} input - what to render.
 * @param {string} input.workspacePath - the workspace the table belongs to.
 * @param {readonly { alias: string, path: string, mode: string }[]} input.roots - attached roots.
 * @param {(path: string) => { branch: string, dirty: boolean } | undefined} [input.gitStatus]
 *   - a synchronous status lookup; omitted when git reporting is off.
 * @param {(path: string) => string | undefined} [input.notes]
 *   - a synchronous lookup of a root's own AGENTS.md text.
 * @param {number} [input.maxChars] - character budget for the whole table.
 * @param {string} [input.heading] - title line, so prompt and tool output can differ.
 * @returns {string} the table, or an empty string when there is nothing to say.
 */
export function renderRootsTable({ workspacePath, roots, gitStatus, notes, maxChars = 4000, heading }) {
  if (!Array.isArray(roots) || roots.length === 0) return ''
  const title = heading ?? 'Additional workspace roots (attached with dsh-multi-root)'
  const preamble = [title, '']
  if (typeof workspacePath === 'string' && workspacePath !== '') {
    preamble.push(`Primary workspace directory: ${workspacePath}`, '')
  }

  const withGit = typeof gitStatus === 'function'
    && roots.some((root) => gitStatus(root.path) !== undefined)

  const columns = withGit ? ['alias', 'path', 'mode', 'git'] : ['alias', 'path', 'mode']
  const rows = roots.map((root) => {
    const row = [root.alias, root.path, root.mode]
    if (withGit) {
      const status = gitStatus(root.path)
      row.push(status === undefined ? '—' : `${status.branch}${status.dirty ? '*' : ''}`)
    }
    return row
  })

  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => row[index].length)))
  const emit = (row) => `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`
  const header = [
    emit(columns),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
  ]

  const footer = [
    '',
    'These paths are absolute and outside the primary workspace directory.',
    '`readwrite` roots may be edited and used for commands; `readonly` roots must only be read.',
    'A `*` after a branch name means the working tree has uncommitted changes.',
    'Use the `workspace_roots` tool to list, attach or detach roots.',
  ]

  const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 4000

  // Repo notes are appended after the table and share its budget: the table is
  // the navigational fact, the notes are commentary, so the table wins ties.
  const noteBlocks = []
  if (typeof notes === 'function') {
    for (const root of roots) {
      const text = notes(root.path)
      if (typeof text !== 'string' || text.trim() === '') continue
      noteBlocks.push(`#### ${root.alias} (${root.path})\n${text.trim()}`)
    }
  }
  const notesSection = noteBlocks.length === 0
    ? ''
    : `\n\nRepository notes (each root's own AGENTS.md):\n\n${noteBlocks.join('\n\n')}`

  const fixed = [...preamble, ...header, ...footer].join('\n').length

  for (let count = rows.length; count >= 0; count -= 1) {
    const included = rows.slice(0, count)
    const omitted = rows.length - count
    const notice = omitted === 0
      ? ''
      : `\n\n… ${omitted} more root(s) omitted to stay within the prompt budget.`
    const body = included.map(emit).join('\n')
    const roomForNotes = omitted === 0 ? notesSection : ''
    const total = fixed + body.length + notice.length + roomForNotes.length
    if (count === 0 || total <= budget) {
      return [...preamble, ...header, body, ...footer].join('\n') + notice + roomForNotes
    }
  }
  return ''
}

/**
 * A single line for workspaces that have nothing attached.
 *
 * Kept in one place so the prompt does not vary in wording between steps, which
 * would make the model think something changed.
 * @returns {string} the empty-state line.
 */
export function renderEmptyRoots() {
  return EMPTY_LINE
}
