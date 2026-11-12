/**
 * Skill directories owned by attached roots.
 *
 * A repository may ship its own skills under `.claude/skills`, `.agents/skills`
 * or `.dsh/skills` — one directory per skill with a `SKILL.md` inside. When the
 * root was attached with `skillsEnabled`, those skills should be visible to the
 * session exactly as if the repository were the workspace itself.
 *
 * The contribution is a *borrowed provider* through `ctx.skills`, never a
 * replacement: if the service is missing, or the provider throws, the caller
 * simply sees one fewer skill.
 *
 * @module dsh-multi-root/skills
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describeError, report } from './util.js'

/** Directories under a root that may hold skills, in priority order. */
export const SKILL_DIRECTORIES = Object.freeze(['.claude/skills', '.agents/skills', '.dsh/skills'])

/** Name the provider registers under. */
export const SKILL_PROVIDER = 'dsh-multi-root'

/** Largest `SKILL.md` body accepted, in bytes. */
const MAX_SKILL_BYTES = 512 * 1024

/**
 * Split YAML front matter from the body of a `SKILL.md`.
 *
 * Only the flat `key: value` subset is read: skills use `name`, `description`
 * and `whenToUse`, and a real YAML parser would be a dependency this bundle
 * does not have.
 *
 * @param {string} text - the file contents.
 * @returns {{ attributes: Record<string, string>, body: string }} the parts.
 */
export function splitFrontMatter(text) {
  const source = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { attributes: {}, body: source.trim() }
  const attributes = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (pair === null) continue
    const value = pair[2].trim().replace(/^['"]|['"]$/g, '')
    if (value !== '') attributes[pair[1]] = value
  }
  return { attributes, body: source.slice(match[0].length).trim() }
}

/**
 * Read one skill directory.
 * @param {string} directory - absolute skill directory.
 * @param {string} name - directory name, used as a fallback skill name.
 * @returns {Promise<{ name: string, description: string, whenToUse?: string, path: string } | undefined>}
 *   the summary, or undefined when the directory holds no usable `SKILL.md`.
 */
async function readSkill(directory, name) {
  const file = join(directory, 'SKILL.md')
  let text
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_SKILL_BYTES) return undefined
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const { attributes, body } = splitFrontMatter(text)
  const heading = /^#\s+(.+)$/m.exec(body)
  const summary = attributes.description
    ?? body.split(/\r?\n/).find((line) => line.trim() !== '' && !line.startsWith('#'))?.trim()
    ?? ''
  return {
    name: attributes.name ?? name,
    description: summary.slice(0, 300),
    ...(attributes.whenToUse === undefined ? {} : { whenToUse: attributes.whenToUse }),
    path: file,
    ...(heading === null ? {} : {}),
  }
}

/**
 * Collect the skills of one root.
 * @param {{ path: string, alias: string }} root - an attached root.
 * @returns {Promise<Array<object>>} skill summaries, in directory order.
 */
async function skillsOfRoot(root) {
  const found = []
  for (const relative of SKILL_DIRECTORIES) {
    const directory = join(root.path, relative)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skill = await readSkill(join(directory, entry.name), entry.name)
      if (skill === undefined) continue
      found.push({ ...skill, alias: root.alias, aliasId: root.aliasId ?? root.alias, root: root.path })
    }
  }
  return found
}

/**
 * Turn a label into the kebab-case grammar DSH accepts for skill names.
 *
 * The host validates every candidate name against
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and refuses the whole provider when one name
 * fails, so both halves of a namespaced name go through this.
 *
 * @param {string} value - alias id or folder name.
 * @returns {string} a safe name segment.
 */
function kebab(value) {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned === '' ? 'root' : cleaned
}

/**
 * Build the provider object `ctx.skills.registerProvider` expects.
 *
 * @param {object} options - dependencies.
 * @param {import('./snapshot.js').RootSnapshot} options.snapshot - root mirror.
 * @param {object} [options.logger] - a logger.
 * @returns {{ name: string, list: Function, get: Function }} the provider.
 */
export function createSkillProvider({ snapshot, logger }) {
  return {
    name: SKILL_PROVIDER,

    async list(options = {}) {
      const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
      if (cwd === undefined) return { candidates: [], complete: true }
      const roots = snapshot.rootsOf(cwd).filter((root) => root.skillsEnabled === true)
      if (roots.length === 0) return { candidates: [], complete: true }

      const candidates = []
      const seen = new Set()
      try {
        for (const root of roots) {
          for (const skill of await skillsOfRoot(root)) {
            // Two roots may ship a skill of the same name, so the alias id
            // namespaces each one (`clone-review` vs `billing-review`). The
            // separator must be a dash: DSH only accepts kebab-case skill
            // names (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) and rejects the whole
            // provider when one name breaks that grammar.
            const name = `${kebab(skill.aliasId)}-${kebab(skill.name)}`
            if (seen.has(name)) continue
            seen.add(name)
            candidates.push({
              name,
              description: skill.description,
              ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
              source: 'custom',
              provider: SKILL_PROVIDER,
              // The host reads `skill.invocation.modelInvocable` while building
              // the skill catalogue, so a candidate without this block fails the
              // whole turn with "Cannot read properties of undefined
              // (reading 'modelInvocable')".
              invocation: { modelInvocable: true, userInvocable: true },
              path: skill.path,
              rank: candidates.length,
              locator: { file: skill.path, alias: skill.alias, aliasId: skill.aliasId, root: skill.root },
            })
          }
        }
      } catch (error) {
        report(logger, 'warn', `could not list skills of attached roots: ${describeError(error)}`)
        return { candidates, complete: false }
      }
      return { candidates, complete: true }
    },

    async get(candidate) {
      const file = candidate?.locator?.file ?? candidate?.path
      if (typeof file !== 'string' || file === '') return undefined
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return undefined
      }
      const { body } = splitFrontMatter(text)
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        source: candidate.source ?? 'custom',
        provider: SKILL_PROVIDER,
        // `SkillSummary` requires the resolved policy on both the candidate and
        // the definition, so echo whatever the candidate carried.
        invocation: candidate.invocation ?? { modelInvocable: true, userInvocable: true },
        path: file,
        content: body,
      }
    },
  }
}

/**
 * Register the provider, if the skills service exists.
 *
 * @param {object} options - dependencies.
 * @param {object} options.ctx - the plugin context.
 * @param {import('./snapshot.js').RootSnapshot} options.snapshot - root mirror.
 * @param {object} [options.logger] - a logger.
 * @returns {boolean} whether the provider was registered.
 */
export function registerSkillProvider({ ctx, snapshot, logger }) {
  const skills = typeof ctx?.get === 'function' ? ctx.get('skills') : undefined
  if (skills === undefined || typeof skills.registerProvider !== 'function') {
    report(logger, 'info', 'skills service is unavailable; attached roots keep their skills to themselves')
    return false
  }
  skills.registerProvider(() => createSkillProvider({ snapshot, logger }))
  return true
}
