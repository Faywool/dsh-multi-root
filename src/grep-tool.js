/**
 * `workspace_grep`: search file *contents* across every root attached to the
 * workspace the current session belongs to.
 *
 * Why this is a plugin tool at all: DSH's own grep is scoped to the session
 * cwd, so a cross-repository question ("where is this interface defined?")
 * costs one shell round trip per repository plus manual merging. This tool
 * answers it in one call and, just as importantly, tells the model what it did
 * *not* see: files scanned, files skipped as binary or oversized, and whether a
 * budget or the result cap ended the search early. Without that trailer "no
 * match" and "gave up early" look identical, and the model confidently reports
 * the wrong conclusion.
 *
 * Everything is opt-in per workspace: a workspace whose `searchEnabled` is
 * false answers with a single sentence instead of scanning anything.
 *
 * @module dsh-multi-root/grep-tool
 */

import { grepRoots, MAX_GREP_RESULTS } from './browse.js'
import { sessionDirectory, workspaceKey } from './context.js'

/** Name of the content-search tool. */
export const GREP_TOOL_NAME = 'workspace_grep'

/** Tool parameters. `pattern` is the only required field. */
const PARAMETERS = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Text to look for. Literal by default; a regular expression when regex is true.',
    },
    alias: {
      type: 'string',
      description: 'Search only this root (its alias, aliasId or id). Defaults to every attached root.',
    },
    glob: {
      type: 'string',
      description: 'Restrict to matching files, e.g. "*.cs", "src/**", "**/*.{ts,tsx}"',
    },
    regex: {
      type: 'boolean',
      description: 'Treat pattern as a regular expression. Default false.',
    },
    ignoreCase: {
      type: 'boolean',
      description: 'Force case-insensitive matching. Default: smart case (no uppercase letters in pattern = ignore case).',
    },
    context: {
      type: 'integer',
      description: 'Lines of context before and after each match, 0 to 3. Default 0.',
    },
    maxResults: {
      type: 'integer',
      description: `Maximum matches to return, up to ${MAX_GREP_RESULTS}. Default 60.`,
    },
  },
  required: ['pattern'],
  additionalProperties: false,
}

/**
 * Build the tool definition.
 *
 * @param {{ ctx: object, store: object, snapshot: object, logger?: object }} deps
 * @returns {object} a plain tool definition (no `@deepseek-ai/dsh-tools` import).
 */
export function createGrepTool({ ctx, store, snapshot, logger }) {
  async function run(args, exec) {
    const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
    if (pattern.trim() === '') return 'the pattern is empty'

    const workspacePath = await sessionDirectory(ctx, exec)
    if (workspacePath === undefined) {
      return 'Cannot determine the workspace directory for this session, so there are no roots to search.'
    }
    const key = workspaceKey(workspacePath)

    const enabled = await store.searchEnabled(key)
    if (!enabled) {
      return 'Content search is switched off for this workspace (the dialog has a toggle for it), '
        + 'so nothing was scanned. File-name search with workspace_find still works.'
    }

    const roots = snapshot.rootsOf(key).filter((root) => root.enabled !== false)
    if (roots.length === 0) {
      return 'This workspace has no attached roots yet; use workspace_roots with action "attach" first.'
    }

    const wanted = typeof args?.alias === 'string' && args.alias.trim() !== ''
      ? String(args.alias).trim().toLowerCase()
      : ''
    const selected = wanted === ''
      ? roots
      : roots.filter((root) => [root.alias, root.aliasId, root.id]
        .some((value) => typeof value === 'string' && value.toLowerCase() === wanted))
    if (selected.length === 0) {
      return `No attached root is called "${args.alias}". Attached roots: ${roots.map((root) => root.alias).join(', ')}.`
    }

    const result = await grepRoots(selected, pattern, {
      regex: args?.regex === true,
      ignoreCase: typeof args?.ignoreCase === 'boolean' ? args.ignoreCase : !/[A-Z]/.test(pattern),
      glob: typeof args?.glob === 'string' ? args.glob : undefined,
      context: args?.context,
      maxResults: args?.maxResults,
    })
    if (!result.ok) return result.reason ?? 'the search failed'

    return formatResult(result, { pattern, selected, rootCount: roots.length })
  }

  return {
    name: GREP_TOOL_NAME,
    description: 'Search file contents across every repository attached to this workspace in one call. '
      + 'Returns path:line matches grouped by repository, plus a trailer saying how many files were scanned, '
      + 'what was skipped, and whether a time/result budget ended the search early. '
      + 'Use workspace_find to search file names instead.',
    parameters: PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 30000,
    execute: async (args, exec) => {
      try {
        return await run(args, exec)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (logger !== undefined) {
          try {
            logger.warn?.(`[dsh-multi-root] workspace_grep failed: ${message}`)
          } catch (ignored) {
            // Logging must never turn a soft failure into a hard one.
          }
        }
        return `workspace_grep could not finish: ${message}`
      }
    },
  }
}

/**
 * Render matches the way `ripgrep` does, grouped per repository.
 *
 * @param {object} result - what `grepRoots` returned.
 * @param {{ pattern: string, selected: Array<{ alias: string }>, rootCount: number }} context
 * @returns {string}
 */
export function formatResult(result, context) {
  const byRoot = new Map()
  for (const match of result.matches) {
    if (!byRoot.has(match.alias)) byRoot.set(match.alias, [])
    byRoot.get(match.alias).push(match)
  }

  const lines = []
  if (result.matches.length === 0) {
    lines.push(`No match for "${context.pattern}" in ${context.selected.length} root(s).`)
  } else {
    for (const [alias, matches] of byRoot) {
      lines.push(`${alias} (${matches.length})`)
      for (const match of matches) {
        for (const before of match.before) lines.push(`  ${match.relative}-${match.line - match.before.length + match.before.indexOf(before)}- ${before.trim()}`)
        lines.push(`  ${match.relative}:${match.line}: ${match.text}`)
        match.after.forEach((after, offset) => {
          lines.push(`  ${match.relative}-${match.line + 1 + offset}- ${after.trim()}`)
        })
      }
    }
  }

  const parts = [
    `scanned ${result.filesScanned} of ${result.filesVisited} visited files`,
    `${result.matches.length} match(es)`,
    `${result.elapsedMs} ms`,
  ]
  if (result.skippedBinary > 0) parts.push(`${result.skippedBinary} skipped (binary)`)
  if (result.skippedSize > 0) parts.push(`${result.skippedSize} skipped (larger than 512 KiB)`)
  lines.push('')
  lines.push(parts.join(' · '))

  if (result.truncated) {
    const why = result.stoppedBy === 'results'
      ? `stopped at the ${result.matches.length}-result cap; add a glob, narrow the pattern, or raise maxResults`
      : result.stoppedBy === 'files'
        ? 'stopped at the visited-file cap; add a glob to narrow the search'
        : 'stopped at the time budget; add a glob or a more specific pattern'
    lines.push(why)
  }
  return lines.join('\n')
}
