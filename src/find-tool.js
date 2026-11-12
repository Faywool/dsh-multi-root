/**
 * The `workspace_find` tool: cross-root file search for the agent.
 *
 * The official file-reference index only covers the session's own working
 * directory, so a model asked about `web-app` inside a workspace whose primary
 * directory is `backend` has no way to discover those files. Replacing `ctx.fs` to fix that is what makes
 * other multi-root plugins fragile; this tool instead answers the same question
 * with an ordinary, bounded directory walk.
 *
 * @module dsh-multi-root/find-tool
 */

import { searchRoots, MAX_SEARCH_RESULTS } from './browse.js'
import { sessionDirectory } from './context.js'
import { workspaceKey } from './context.js'
import { report } from './util.js'

/** Tool name as the model sees it. */
export const FIND_TOOL_NAME = 'workspace_find'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/**
 * Build the tool definition.
 *
 * @param {{
 *   ctx: any,
 *   snapshot: import('./snapshot.js').RootSnapshot,
 *   configOf: () => any,
 *   logger: any,
 * }} deps
 * @returns {object}
 */
export function createFindTool({ ctx, snapshot, configOf, logger }) {
  return {
    name: FIND_TOOL_NAME,
    description:
      'Find files by path across every repository attached to this workspace with dsh-multi-root. '
      + 'Matching is a case-insensitive substring test on the path relative to its repository, so '
      + '`src/api` or `Settings.tsx` both work. Returns absolute paths, which the file tools accept. '
      + 'Use it when a file you need lives in another repository than the session directory.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring of the path to look for, for example `src/hooks` or `settings`.',
        },
        alias: {
          type: 'string',
          description: 'Restrict the search to one attached repository, by its alias.',
        },
        maxResults: {
          type: 'integer',
          description: `Most paths to return (default 20, at most ${MAX_SEARCH_RESULTS}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30000,
    execute: async (args, exec) => {
      try {
        const config = configOf()
        if (!config.enabled) return 'dsh-multi-root is switched off, so no extra repository can be searched.'
        const workspace = sessionDirectory(ctx, exec)
        if (workspace === undefined) return 'Cannot determine the workspace directory for this session.'
        const roots = snapshot.rootsOf(workspaceKey(workspace)).filter((root) => root.mode !== 'disabled')
        if (roots.length === 0) {
          return 'No repository is attached to this workspace yet. Attach one with the workspace_roots tool first.'
        }
        const alias = typeof args?.alias === 'string' ? args.alias.trim().toLowerCase() : ''
        const selected = alias.length === 0
          ? roots
          : roots.filter((root) => String(root.alias).toLowerCase() === alias)
        if (selected.length === 0) {
          return `No attached repository is named \`${args.alias}\`. Attached: ${roots.map((root) => root.alias).join(', ')}.`
        }

        const result = await searchRoots(selected, String(args?.query ?? ''), {
          maxResults: args?.maxResults,
          filesOnly: true,
        })
        if (!result.ok) return `workspace_find needs a query: ${result.reason}.`
        if (result.matches.length === 0) {
          return `No path matched \`${args?.query}\` in ${selected.length} repository(ies) after visiting ${result.visited} entries.`
        }

        const lines = result.matches.map((match) => `${match.path}`)
        const header = `Matched ${result.matches.length} path(s) in ${selected.length} repository(ies):`
        const footer = result.truncated
          ? '\n\nMore results exist; narrow the query or raise `maxResults` (up to 60).'
          : ''
        return `${header}\n${lines.join('\n')}${footer}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report(logger, 'warn', `workspace_find failed: ${message}`)
        return `workspace_find failed: ${message}`
      }
    },
  }
}
