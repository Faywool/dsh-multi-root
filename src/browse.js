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
 */export function describeFsError(error) {
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

/* ------------------------------------------------------------------------ *
 * Content search
 *
 * The name search above answers "where is this file"; this one answers
 * "where is this string". Both are bounded the same way: a wall-clock
 * deadline, a visited-file cap and a result cap, so a 90k-file repository
 * cannot stall the host and the model always learns whether it saw everything.
 * ------------------------------------------------------------------------ */

/** Most files one content search opens before it gives up. */
export const MAX_GREP_FILES = 60000

/** Most bytes one content search reads from a single file. */
export const MAX_GREP_FILE_BYTES = 512 * 1024

/** Most matches one content search returns, across every root. */
export const MAX_GREP_RESULTS = 200

/** Content search wall-clock budget in milliseconds. */
export const GREP_BUDGET_MS = 12000

/** Longest line a content search examines, so one minified line cannot blow up. */
const MAX_GREP_LINE_CHARS = 4000

/** Longest pattern accepted, so a pathological regex is refused up front. */
const MAX_PATTERN_CHARS = 200

/**
 * Extensions that are certainly not text. Sniffing a PNG for NUL bytes works,
 * but it means reading megabytes of binary on every search; skipping by name is
 * the difference between a search that finishes and one that times out.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.jar', '.nupkg', '.whl',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.bin', '.dat', '.cache',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac',
  '.sqlite', '.db', '.mdb', '.pfx', '.snk', '.keystore', '.jks',
])

/**
 * Lower-cased extension of a file name, or '' when it has none.
 * @param {string} name - file name.
 * @returns {string} the extension including the dot.
 */
function extensionOf(name) {
  const ext = extname(name)
  return ext === '' ? '' : ext.toLowerCase()
}

/**
 * Compile a small glob (`*.cs`, `src/**`, `**\/*.{ts,tsx}`) into a RegExp.
 *
 * Only the shapes people actually type are supported: `*`, `**`, `?` and
 * `{a,b}`. Anything else is escaped, so a glob can never smuggle in a
 * surprising regular expression.
 *
 * @param {string} glob - the pattern.
 * @returns {RegExp | undefined} matcher, or undefined when the glob is empty.
 */
export function globToRegExp(glob) {
  const source = typeof glob === 'string' ? glob.trim().replace(/\\/g, '/') : ''
  if (source === '') return undefined
  let out = '^'
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '*') {
      if (source[index + 1] === '*') {
        if (source[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const end = source.indexOf('}', index)
      if (end > index) {
        const parts = source.slice(index + 1, end).split(',')
        out += '(?:' + parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
        index = end
        continue
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  try {
    return new RegExp(out, 'i')
  } catch (error) {
    return undefined
  }
}

/**
 * Search the contents of every file under the declared roots.
 *
 * @param {Array<{ alias: string, path: string }>} roots - roots to search.
 * @param {string} pattern - literal text, or a regular expression when `options.regex`.
 * @param {{ regex?: boolean, ignoreCase?: boolean, glob?: string, maxResults?: number, context?: number, budgetMs?: number }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   matches: Array<{ alias: string, root: string, relative: string, absolute: string, line: number, text: string, before: string[], after: string[] }>,
 *   filesVisited: number,
 *   filesScanned: number,
 *   skippedBinary: number,
 *   skippedSize: number,
 *   truncated: boolean,
 *   stoppedBy?: 'budget' | 'results' | 'files',
 *   elapsedMs: number,
 *   reason?: string,
 * }>}
 */
export async function grepRoots(roots, pattern, options = {}) {
  const empty = {
    ok: false,
    matches: [],
    filesVisited: 0,
    filesScanned: 0,
    skippedBinary: 0,
    skippedSize: 0,
    truncated: false,
    elapsedMs: 0,
  }
  const raw = typeof pattern === 'string' ? pattern : ''
  if (raw.trim() === '') return { ...empty, reason: 'the pattern is empty' }
  if (raw.length > MAX_PATTERN_CHARS) {
    return { ...empty, reason: `the pattern is longer than ${MAX_PATTERN_CHARS} characters` }
  }

  const started = Date.now()
  const budget = clampInt(options.budgetMs, 200, 30000, GREP_BUDGET_MS)
  const deadline = started + budget
  const maxResults = clampInt(options.maxResults, 1, MAX_GREP_RESULTS, 60)
  const context = clampInt(options.context, 0, 3, 0)
  const ignoreCase = options.ignoreCase !== false
  const globMatcher = globToRegExp(options.glob)
  // A glob with no path separator means "this file name, at any depth" - the
  // reading every caller expects from `*.cs`. Only a glob that names a
  // directory (`src/**`) is matched against the relative path.
  const globByBasename = typeof options.glob === 'string' && !options.glob.includes('/') && !options.glob.includes('\\')

  let matchLine
  if (options.regex === true) {
    try {
      const expression = new RegExp(raw, ignoreCase ? 'i' : '')
      matchLine = (line) => expression.test(line)
    } catch (error) {
      return { ...empty, elapsedMs: Date.now() - started, reason: `"${raw}" is not a valid regular expression` }
    }
  } else {
    const needle = ignoreCase ? raw : raw
    matchLine = ignoreCase
      ? (line) => line.toLowerCase().includes(raw.toLowerCase())
      : (line) => line.includes(needle)
  }

  const matches = []
  let filesVisited = 0
  let filesScanned = 0
  let skippedBinary = 0
  let skippedSize = 0
  let stoppedBy

  for (const root of roots) {
    if (stoppedBy !== undefined) break
    const rootPath = resolve(root.path)
    const queue = [{ absolute: rootPath, depth: 0 }]
    while (queue.length > 0) {
      if (Date.now() > deadline) {
        stoppedBy = 'budget'
        break
      }
      if (filesVisited >= MAX_GREP_FILES) {
        stoppedBy = 'files'
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
        if (Date.now() > deadline) {
          stoppedBy = 'budget'
          break
        }
        const isDir = dirent.isDirectory()
        if (isDir) {
          if (SKIPPED_DIRECTORIES.has(dirent.name)) continue
          if (current.depth < MAX_SEARCH_DEPTH) {
            queue.push({ absolute: join(current.absolute, dirent.name), depth: current.depth + 1 })
          }
          continue
        }
        if (!dirent.isFile()) continue

        // Only regular files that pass the glob count against the visited cap,
        // otherwise a `*.cs` search can burn its whole budget on `node_modules`
        // entries it was never going to read.
        const absolute = join(current.absolute, dirent.name)
        const relativePath = relative(rootPath, absolute).split(sep).join('/')
        const candidatePath = globByBasename ? dirent.name : relativePath
        if (globMatcher !== undefined && !globMatcher.test(candidatePath)) continue
        filesVisited += 1
        if (filesVisited >= MAX_GREP_FILES) {
          stoppedBy = 'files'
          break
        }

        if (BINARY_EXTENSIONS.has(extensionOf(dirent.name))) {
          skippedBinary += 1
          continue
        }

        let info
        try {
          info = await stat(absolute)
        } catch (error) {
          continue
        }
        if (info.size > MAX_GREP_FILE_BYTES) {
          skippedSize += 1
          continue
        }
        let buffer
        try {
          buffer = await readFile(absolute)
        } catch (error) {
          continue
        }
        if (buffer.includes(0)) {
          skippedBinary += 1
          continue
        }
        filesScanned += 1
        const lines = buffer.toString('utf8').split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index].length > MAX_GREP_LINE_CHARS
            ? lines[index].slice(0, MAX_GREP_LINE_CHARS)
            : lines[index]
          if (!matchLine(line)) continue
          matches.push({
            alias: root.alias,
            root: rootPath,
            relative: relativePath,
            absolute,
            line: index + 1,
            text: line.trim(),
            before: context > 0 ? lines.slice(Math.max(0, index - context), index) : [],
            after: context > 0 ? lines.slice(index + 1, index + 1 + context) : [],
          })
          if (matches.length >= maxResults) {
            stoppedBy = 'results'
            break
          }
        }
        if (stoppedBy === 'results') break
      }
    }
  }

  return {
    ok: true,
    matches,
    filesVisited,
    filesScanned,
    skippedBinary,
    skippedSize,
    truncated: stoppedBy !== undefined,
    stoppedBy,
    elapsedMs: Date.now() - started,
  }
}
