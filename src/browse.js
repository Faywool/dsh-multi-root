/**
 * Read-only directory browsing and name search for mounted roots.
 *
 * Everything here is a pure `fs` operation confined to a root that the user
 * already declared. No service is injected, nothing is mutated, and every
 * limit is a hard budget so a 90k-file repository cannot stall the host.
 *
 * A root that disappears (unplugged drive, renamed folder) answers with a
 * failure object instead of throwing: the caller is a UI route and a missing
 * directory is ordinary, not exceptional.
 *
 * @module dsh-multi-root/browse
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Directory names never descended into or listed. */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
])

/** Most entries one listing returns. */
export const MAX_ENTRIES = 500

/** Most bytes one file preview returns. */
export const MAX_FILE_BYTES = 256 * 1024

/** Most files one search walks before it gives up. */
export const MAX_SEARCH_VISITED = 40000

/** Deepest directory level one search descends. */
export const MAX_SEARCH_DEPTH = 12

/** Most matches one search returns. */
export const MAX_SEARCH_RESULTS = 60

/** Search wall-clock budget in milliseconds. */
export const SEARCH_BUDGET_MS = 2500

/** Extensions we surface in a preview even though they are binary. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.json5', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.svg', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.cpp', '.cc', '.c', '.h',
  '.hpp', '.php', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql',
  '.proto', '.lock', '.log', '.diff', '.patch', '.gitignore', '.dockerignore', '.editorconfig',
])

/**
 * Decide whether `relative` stays inside `rootPath`.
 *
 * @param {string} rootPath - absolute declared root.
 * @param {string} [relative] - path relative to the root, or absolute.
 * @returns {{ ok: true, absolute: string, relative: string } | { ok: false, reason: string }}
 */
export function resolveInside(rootPath, relativePath) {
  if (typeof rootPath !== 'string' || !isAbsolute(rootPath)) {
    return { ok: false, reason: 'the root path must be absolute' }
  }
  const root = resolve(rootPath)
  const requested = typeof relativePath === 'string' && relativePath.length > 0 ? relativePath : '.'
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(join(root, requested))
  const inside = relative(root, absolute)
  if (inside.startsWith('..') || (inside !== '' && isAbsolute(inside))) {
    return { ok: false, reason: 'that path is outside the root' }
  }
  return { ok: true, absolute, relative: inside.split(sep).join('/') }
}

/**
 * List one directory of a root.
 *
 * @param {string} rootPath - absolute declared root.
 * @param {string} [relativePath] - directory relative to the root.
 * @returns {Promise<{ ok: boolean, path?: string, relative?: string, entries?: Array<{ name: string, kind: 'dir' | 'file', size: number }>, truncated?: boolean, reason?: string }>}
 */
export async function listDirectory(rootPath, relativePath) {
  const target = resolveInside(rootPath, relativePath)
  if (!target.ok) return { ok: false, reason: target.reason }

  let info
  try {
    info = await stat(target.absolute)
  } catch (error) {
    return { ok: false, reason: describeFsError(error) }
  }
  if (!info.isDirectory()) return { ok: false, reason: 'that path is not a directory' }

  let dirents
  try {
    dirents = await readdir(target.absolute, { withFileTypes: true })
  } catch (error) {
    return { ok: false, reason: describeFsError(error) }
  }

  const entries = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    const isDir = dirent.isDirectory()
    if (!isDir && !dirent.isFile()) continue
    if (isDir && SKIPPED_DIRECTORIES.has(dirent.name)) continue
    let size = 0
    if (!isDir) {
      try {
        size = (await stat(join(target.absolute, dirent.name))).size
      } catch (error) {
        size = 0
      }
    }
    entries.push({ name: dirent.name, kind: isDir ? 'dir' : 'file', size })
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return {
    ok: true,
    path: target.absolute,
    relative: target.relative,
    entries,
    truncated,
  }
}

/**
 * Read a text preview of one file inside a root.
 *
 * @param {string} rootPath - absolute declared root.
 * @param {string} relativePath - file path relative to the root.
 * @returns {Promise<{ ok: boolean, path?: string, relative?: string, text?: string, bytes?: number, truncated?: boolean, binary?: boolean, reason?: string }>}
 */
export async function readTextFile(rootPath, relativePath) {
  const target = resolveInside(rootPath, relativePath)
  if (!target.ok) return { ok: false, reason: target.reason }
  if (target.relative === '') return { ok: false, reason: 'that path is a directory' }

  let info
  try {
    info = await stat(target.absolute)
  } catch (error) {
    return { ok: false, reason: describeFsError(error) }
  }
  if (!info.isFile()) return { ok: false, reason: 'that path is not a file' }

  const extension = extname(target.absolute).toLowerCase()
  const looksTextual = TEXT_EXTENSIONS.has(extension) || extension === ''
  if (!looksTextual && info.size > 0) {
    return {
      ok: true,
      path: target.absolute,
      relative: target.relative,
      bytes: info.size,
      binary: true,
      text: '',
      truncated: false,
    }
  }

  let buffer
  try {
    buffer = await readFile(target.absolute)
  } catch (error) {
    return { ok: false, reason: describeFsError(error) }
  }
  const truncated = buffer.length > MAX_FILE_BYTES
  const slice = truncated ? buffer.subarray(0, MAX_FILE_BYTES) : buffer
  const binary = slice.includes(0)
  return {
    ok: true,
    path: target.absolute,
    relative: target.relative,
    bytes: info.size,
    binary,
    truncated,
    text: binary ? '' : slice.toString('utf8'),
  }
}

/**
 * Find files whose path matches `query`, across every declared root.
 *
 * Matching is a case-insensitive substring test against the path relative to
 * its root, so `backend/src` and `Settings` both work. Results are ordered
 * by match position, then by path, and capped so the answer stays readable.
 *
 * @param {Array<{ alias: string, path: string }>} roots - roots to search.
 * @param {string} query - substring to look for.
 * @param {{ maxResults?: number, filesOnly?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, matches: Array<{ root: string, alias: string, path: string, relative: string, kind: 'dir' | 'file' }>, visited: number, truncated: boolean, reason?: string }>}
 */
export async function searchRoots(roots, query, options = {}) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase().replace(/\\/g, '/') : ''
  if (needle.length === 0) return { ok: false, matches: [], visited: 0, truncated: false, reason: 'the query is empty' }

  const maxResults = clampInt(options.maxResults, 1, MAX_SEARCH_RESULTS, 20)
  const filesOnly = options.filesOnly !== false
  const matches = []
  const deadline = Date.now() + SEARCH_BUDGET_MS
  let visited = 0
  let truncated = false

  for (const root of roots) {
    if (truncated) break
    const queue = [{ absolute: resolve(root.path), depth: 0 }]
    while (queue.length > 0) {
      if (matches.length >= maxResults || visited >= MAX_SEARCH_VISITED || Date.now() > deadline) {
        truncated = true
        break
      }
      const current = queue.shift()
      let dirents
      try {
        dirents = await readdir(current.absolute, { withFileTypes: true })
      } catch (error) {
        continue
      }
      for (const dirent of dirents) {
        visited += 1
        if (visited >= MAX_SEARCH_VISITED) {
          truncated = true
          break
        }
        const isDir = dirent.isDirectory()
        if (isDir && SKIPPED_DIRECTORIES.has(dirent.name)) continue
        if (!isDir && !dirent.isFile()) continue
        if (isDir && filesOnly) {
          if (current.depth < MAX_SEARCH_DEPTH) {
            queue.push({ absolute: join(current.absolute, dirent.name), depth: current.depth + 1 })
          }
          continue
        }
        const absolute = join(current.absolute, dirent.name)
        const relativePath = relative(resolve(root.path), absolute).split(sep).join('/')
        if (relativePath.toLowerCase().includes(needle)) {
          matches.push({
            root: root.path,
            alias: root.alias,
            path: absolute,
            relative: relativePath,
            kind: isDir ? 'dir' : 'file',
          })
          if (matches.length >= maxResults) {
            truncated = true
            break
          }
        }
        if (isDir && current.depth < MAX_SEARCH_DEPTH) {
          queue.push({ absolute, depth: current.depth + 1 })
        }
      }
    }
  }

  return { ok: true, matches, visited, truncated }
}

/**
 * Turn a Node filesystem error into one short sentence for the UI.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeFsError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  switch (code) {
    case 'ENOENT':
      return 'that path does not exist'
    case 'EACCES':
    case 'EPERM':
      return 'access to that path was denied'
    case 'ENOTDIR':
      return 'that path is not a directory'
    case 'EISDIR':
      return 'that path is a directory'
    default:
      return error instanceof Error ? error.message : 'the filesystem refused the request'
  }
}

/**
 * Read the top-level `AGENTS.md` of one root, capped for prompt budget.
 *
 * @param {string} rootPath - absolute declared root.
 * @param {number} [maxChars]
 * @returns {Promise<string | undefined>}
 */
export async function readRootAgentsFile(rootPath, maxChars = 1200) {
  const candidates = ['AGENTS.md', 'CLAUDE.md']
  for (const name of candidates) {
    const target = join(resolve(rootPath), name)
    try {
      const info = await stat(target)
      if (!info.isFile()) continue
      const text = await readFile(target, 'utf8')
      const trimmed = text.trim()
      if (trimmed.length === 0) continue
      return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n… (${name} truncated)` : trimmed
    } catch (error) {
      continue
    }
  }
  return undefined
}

/**
 * Best-effort display name for a path.
 *
 * @param {string} value
 * @returns {string}
 */
export function displayName(value) {
  try {
    return basename(resolve(value)) || resolve(value)
  } catch (error) {
    return String(value)
  }
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}
