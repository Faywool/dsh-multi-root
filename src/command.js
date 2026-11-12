/**
 * The `/multi-root` slash command.
 *
 * A command is the cheapest possible UI: the host already routes slash lines
 * and renders the returned text, so listing or attaching a repository costs
 * one keystroke and no client code. Like every other contribution here, a
 * missing `commands` service costs the command and nothing else.
 *
 * @module dsh-multi-root/command
 */

import { MAX_SEARCH_RESULTS, listDirectory, searchRoots } from './browse.js'
import { sessionDirectory, workspaceKey } from './context.js'
import { directoryProblem } from './tool.js'
import { planAttach, findRootIndex, moveRoot, normaliseAliasId, sanitizeRoots } from './roots.js'
import { report } from './util.js'

/** Command name without the slash. */
export const COMMAND_NAME = 'multi-root'

/**
 * Register the command when the service is available.
 *
 * @param {{
 *   ctx: any,
 *   commands: any,
 *   store: import('./store.js').RootStore,
 *   snapshot: import('./snapshot.js').RootSnapshot,
 *   configOf: () => any,
 *   logger: any,
 * }} deps
 * @returns {boolean} whether the registration happened.
 */
export function registerCommand({ ctx, commands, store, snapshot, configOf, logger }) {
  if (commands === undefined || commands === null || typeof commands.register !== 'function') {
    report(logger, 'info', 'the commands service is unavailable; /multi-root is not registered')
    return false
  }

  commands.register({
    name: COMMAND_NAME,
    description: 'List or change the repositories attached to this workspace by dsh-multi-root.',
    input: { hint: 'list | attach | detach | alias | mode | skills | namespace | move | open | find | dirs' },
    handler: async (invocation) => {
      try {
        const config = configOf()
        if (!config.enabled) {
          return { kind: 'error', text: 'dsh-multi-root is switched off in the plugin configuration.' }
        }
        const workspace = sessionDirectory(ctx, { agent: invocation?.agent })
        if (workspace === undefined) {
          return { kind: 'error', text: 'Cannot determine this session\'s workspace directory.' }
        }
        const key = workspaceKey(workspace)
        const roots = sanitizeRoots(await store.list(workspace))
        const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const action = tokens[0] === undefined ? 'list' : tokens[0].toLowerCase()
        const rest = tokens.slice(1).join(' ').trim()

        if (action === 'list') {
          if (roots.length === 0) {
            return {
              kind: 'success',
              text: `No repository is attached to ${workspace}. Use \`/multi-root attach <absolute path>\`.`,
            }
          }
          const lines = roots.map((root, index) => {
            const git = snapshot.gitStatus(root.path)
            const suffix = git?.branch ? ` (${git.branch}${git.dirty ? '*' : ''})` : ''
            const skills = root.skillsEnabled === true ? ' skills:on' : ''
            return `${index + 1}. ${root.alias} [${root.mode}${skills}] ${root.path}${suffix}`
          })
          return { kind: 'success', text: `${roots.length} repository(ies) attached to ${workspace}:\n${lines.join('\n')}` }
        }

        if (action === 'attach') {
          if (rest.length === 0) return { kind: 'error', text: 'Usage: /multi-root attach <absolute path>' }
          const problem = await directoryProblem(rest)
          if (problem !== undefined) return { kind: 'error', text: problem }
          const plan = planAttach(roots, [{ path: rest }], config.maxRoots)
          if (plan.added.length === 0 && plan.replaced === 0) {
            return { kind: 'error', text: `\`${rest}\` is already attached (or the limit of ${config.maxRoots} is reached).` }
          }
          await store.write(workspace, plan.roots)
          await snapshot.refresh()
          const alias = plan.added[0] ?? plan.roots.find((root) => root.path.toLowerCase() === rest.toLowerCase())?.alias
          return { kind: 'success', text: `Attached \`${alias}\` for ${rest}. New sessions see it in the prompt; this one sees it on the next step.` }
        }

        if (action === 'detach') {
          if (rest.length === 0) return { kind: 'error', text: 'Usage: /multi-root detach <id, alias or absolute path>' }
          const index = findRootIndex(roots, rest)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${rest}\`.` }
          const removed = roots[index]
          const kept = roots.filter((_root, position) => position !== index)
          await store.write(workspace, kept)
          await snapshot.refresh()
          return { kind: 'success', text: `Detached \`${removed.alias}\`. ${kept.length} repository(ies) remain.` }
        }

        if (action === 'alias' || action === 'rename') {
          const [target, ...nameParts] = tokens.slice(1)
          const name = nameParts.join(' ').trim()
          if (target === undefined || name === '') {
            return { kind: 'error', text: 'Usage: /multi-root alias <id, alias or path> <new alias>' }
          }
          const index = findRootIndex(roots, target)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${target}\`.` }
          if (roots.some((root, position) => position !== index && root.alias.toLowerCase() === name.toLowerCase())) {
            return { kind: 'error', text: `Another repository already uses \`${name}\`.` }
          }
          const previous = roots[index].alias
          roots[index] = { ...roots[index], alias: name }
          await store.write(workspace, roots)
          await snapshot.refresh()
          return { kind: 'success', text: `Renamed \`${previous}\` to \`${name}\`.` }
        }

        if (action === 'mode') {
          const [target, mode] = tokens.slice(1)
          if (target === undefined || (mode !== 'readwrite' && mode !== 'readonly')) {
            return { kind: 'error', text: 'Usage: /multi-root mode <id, alias or path> readwrite|readonly' }
          }
          const index = findRootIndex(roots, target)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${target}\`.` }
          roots[index] = { ...roots[index], mode }
          await store.write(workspace, roots)
          await snapshot.refresh()
          return { kind: 'success', text: `\`${roots[index].alias}\` is now ${mode}.` }
        }

        if (action === 'skills') {
          const [target, state] = tokens.slice(1)
          if (target === undefined) {
            return { kind: 'error', text: 'Usage: /multi-root skills <id, alias or path> [on|off]' }
          }
          const index = findRootIndex(roots, target)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${target}\`.` }
          const next = state === undefined ? roots[index].skillsEnabled !== true : state === 'on'
          roots[index] = { ...roots[index], skillsEnabled: next }
          await store.write(workspace, roots)
          await snapshot.refresh()
          return { kind: 'success', text: `Skills from \`${roots[index].alias}\` are now ${next ? 'on' : 'off'}.` }
        }

        if (action === 'namespace' || action === 'alias-id' || action === 'aliasid') {
          const [target, raw] = tokens.slice(1)
          if (target === undefined || raw === undefined) {
            return { kind: 'error', text: 'Usage: /multi-root namespace <id, alias or path> <alias-id>' }
          }
          const index = findRootIndex(roots, target)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${target}\`.` }
          const folded = normaliseAliasId(raw, roots[index].alias)
          const clash = roots.some(
            (entry, position) => position !== index
              && normaliseAliasId(entry.aliasId ?? entry.alias, entry.alias) === folded,
          )
          if (clash) return { kind: 'error', text: `Another root already uses the namespace \`${folded}\`.` }
          roots[index] = { ...roots[index], aliasId: folded }
          await store.write(workspace, roots)
          await snapshot.refresh()
          return { kind: 'success', text: `Skill namespace of \`${roots[index].alias}\` is now \`${folded}\`.` }
        }

        if (action === 'move') {
          const [target, position] = tokens.slice(1)
          if (target === undefined || position === undefined) {
            return { kind: 'error', text: 'Usage: /multi-root move <id, alias or path> up|down|<index>' }
          }
          const parsed = position === 'up' || position === 'down' ? position : Number(position)
          if (parsed !== 'up' && parsed !== 'down' && !Number.isInteger(parsed)) {
            return { kind: 'error', text: 'The position must be "up", "down" or an integer index.' }
          }
          const moved = moveRoot(roots, target, parsed)
          if (!moved.ok) return { kind: 'error', text: moved.reason }
          await store.write(workspace, moved.roots)
          await snapshot.refresh()
          return { kind: 'success', text: `Moved to position ${moved.index + 1} of ${moved.roots.length}.` }
        }

        if (action === 'open' || action === 'reveal') {
          const [target] = tokens.slice(1)
          if (target === undefined) return { kind: 'error', text: 'Usage: /multi-root open <id, alias or path>' }
          const index = findRootIndex(roots, target)
          if (index === -1) return { kind: 'error', text: `No attached repository matches \`${target}\`.` }
          const { spawn } = await import('node:child_process')
          const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          spawn(command, [roots[index].path], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          return { kind: 'success', text: `Opened ${roots[index].path} in the file manager.` }
        }

        if (action === 'find') {
          if (rest.length === 0) return { kind: 'error', text: 'Usage: /multi-root find <text>' }
          const result = await searchRoots(roots, rest, { maxResults: 15, filesOnly: true })
          if (!result.ok) return { kind: 'error', text: `find needs a query: ${result.reason}.` }
          if (result.matches.length === 0) {
            return { kind: 'success', text: `No path matched \`${rest}\` after visiting ${result.visited} entries.` }
          }
          const lines = result.matches.map((match) => match.path)
          const more = result.truncated
            ? `\nMore results exist; narrow the query (at most ${MAX_SEARCH_RESULTS} are ever shown).`
            : ''
          return { kind: 'success', text: `${result.matches.length} match(es):\n${lines.join('\n')}${more}` }
        }

        if (action === 'dirs') {
          const [root, sub] = [tokens[1], tokens.slice(2).join(' ')]
          const match = roots.find((candidate) => candidate.alias.toLowerCase() === String(root ?? '').toLowerCase())
          if (match === undefined) return { kind: 'error', text: `No attached repository is named \`${root}\`. Names: ${roots.map((r) => r.alias).join(', ') || '(none)'}.` }
          const listing = await listDirectory(match.path, sub)
          if (!listing.ok) return { kind: 'error', text: listing.reason ?? 'could not list that directory' }
          const lines = (listing.entries ?? []).slice(0, 60).map((entry) => (entry.kind === 'dir' ? `${entry.name}/` : entry.name))
          return { kind: 'success', text: `${listing.path}\n${lines.join('\n')}` }
        }

        return {
          kind: 'error',
          text: `Unknown subcommand \`${action}\`. Use: list | attach <path> | detach <ref> | alias <ref> <name> | `
            + 'mode <ref> readwrite|readonly | skills <ref> [on|off] | namespace <ref> <alias-id> | move <ref> up|down|index | open <ref> | '
            + 'find <text> | dirs <alias> [subpath]',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report(logger, 'warn', `/multi-root failed: ${message}`)
        return { kind: 'error', text: `dsh-multi-root failed: ${message}` }
      }
    },
  })

  report(logger, 'info', `/${COMMAND_NAME} is registered`)
  return true
}
