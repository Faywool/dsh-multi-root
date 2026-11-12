/**
 * What commands a repository expects: a bounded sniff of its build system.
 *
 * The model is good at reasoning and bad at guessing which directory holds a
 * `.sln` or whether a frontend wants `pnpm` or `npm`. This module answers that
 * question once per root with a shallow, read-only scan, so the prompt can say
 * "build: dotnet build SourceCode/PSREF.sln" instead of leaving it to trial and
 * error - and so `dotnet build` never runs at a level where there is no project.
 *
 * Nothing here executes anything, and every failure degrades to "not detected".
 *
 * @module dsh-multi-root/build
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** How deep below a root the scan looks. Solutions sit one or two levels down. */
const MAX_DEPTH = 2

/** How many directories one scan may visit, so a wide tree cannot stall refresh. */
const MAX_DIRECTORIES = 80

/** Directories that never hold the entry point of a project. */
const SKIPPED = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.venv',
  'venv', '__pycache__', 'bin', 'obj', 'coverage', '.turbo', '.cache',
])

/** Lock files, mapped to the package manager they imply. */
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * Paths inside a root are shown with forward slashes: they read the same in a
 * prompt, in a shell on Windows and in a markdown table.
 *
 * @param {string} rootPath - the absolute root.
 * @param {string} absolute - the absolute path to describe.
 * @returns {string} the path relative to the root.
 */
function show(rootPath, absolute) {
  return relative(rootPath, absolute).split('\\').join('/')
}

/**
 * Read a directory, treating failure as emptiness.
 *
 * @param {string} directory - an absolute path.
 * @returns {Promise<import('node:fs').Dirent[]>} its entries, or an empty list.
 */
async function entriesOf(directory) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Parse a package.json, treating failure as absence.
 *
 * @param {string} file - an absolute path.
 * @returns {Promise<object | undefined>} the parsed document.
 */
async function readPackage(file) {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The build command for a JavaScript project.
 *
 * @param {string} manager - pnpm, yarn, bun or npm.
 * @param {string} directory - the project directory, relative to the root.
 * @param {string} script - the npm script name.
 * @returns {string} a copy-pasteable command.
 */
function nodeCommand(manager, directory, script) {
  const at = directory === '' || directory === '.' ? '' : directory
  if (manager === 'yarn') return at === '' ? `yarn ${script}` : `yarn --cwd ${at} ${script}`
  if (manager === 'npm') return at === '' ? `npm run ${script}` : `npm --prefix ${at} run ${script}`
  return at === '' ? `${manager} run ${script}` : `${manager} -C ${at} run ${script}`
}

/**
 * Sniff the build and test commands of one root.
 *
 * @param {string} rootPath - an absolute directory.
 * @returns {Promise<{ kind: string, build?: { command: string, origin: string }, test?: { command: string, origin: string } }>}
 *   what was detected; `kind` is `none` when nothing looked buildable.
 */
export async function detectCommands(rootPath) {
  /** @type {{ rel: string, depth: number }[]} */
  const solutions = []
  /** @type {{ rel: string, depth: number, scripts: object, manager: string }[]} */
  const packages = []
  /** @type {{ rel: string, depth: number }[]} */
  const projects = []

  let visited = 0
  /** @type {{ directory: string, depth: number }[]} */
  const queue = [{ directory: rootPath, depth: 0 }]
  while (queue.length > 0 && visited < MAX_DIRECTORIES) {
    const { directory, depth } = queue.shift()
    visited += 1
    const entries = await entriesOf(directory)
    if (entries.length === 0) continue
    const names = new Set(entries.map((entry) => entry.name))
    let manager = 'npm'
    for (const [lockfile, implied] of LOCKFILES) {
      if (names.has(lockfile)) {
        manager = implied
        break
      }
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) continue
        if (SKIPPED.has(entry.name)) continue
        queue.push({ directory: absolute, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.sln')) {
        solutions.push({ rel: show(rootPath, absolute), depth })
      } else if (entry.name.endsWith('.csproj')) {
        projects.push({ rel: show(rootPath, absolute), depth })
      } else if (entry.name === 'package.json') {
        const pkg = await readPackage(absolute)
        const scripts = pkg?.scripts
        if (scripts === null || typeof scripts !== 'object') continue
        packages.push({
          rel: directory === rootPath ? '' : show(rootPath, directory),
          depth,
          scripts,
          manager,
        })
      }
    }
  }

  const shallowest = (list) => [...list].sort((a, b) =>
    a.depth - b.depth || a.rel.length - b.rel.length)[0]

  const solution = shallowest(solutions)
  if (solution !== undefined) {
    const result = {
      kind: 'dotnet',
      build: { command: `dotnet build ${solution.rel}`, origin: solution.rel },
    }
    const tests = packages.find((pkg) => typeof pkg.scripts.test === 'string' && pkg.scripts.test !== '')
    if (tests !== undefined) {
      result.test = {
        command: nodeCommand(tests.manager, tests.rel, 'test'),
        origin: tests.rel === '' ? 'package.json' : `${tests.rel}/package.json`,
      }
    } else {
      result.test = { command: `dotnet test ${solution.rel}`, origin: solution.rel }
    }
    return result
  }

  const pkg = shallowest(packages.filter((candidate) => typeof candidate.scripts.build === 'string' && candidate.scripts.build !== ''))
  if (pkg !== undefined) {
    const result = {
      kind: 'node',
      build: {
        command: nodeCommand(pkg.manager, pkg.rel, 'build'),
        origin: pkg.rel === '' ? 'package.json' : `${pkg.rel}/package.json`,
      },
    }
    if (typeof pkg.scripts.test === 'string' && pkg.scripts.test !== '') {
      result.test = {
        command: nodeCommand(pkg.manager, pkg.rel, 'test'),
        origin: result.build.origin,
      }
    }
    return result
  }

  const project = shallowest(projects)
  if (project !== undefined) {
    return {
      kind: 'dotnet',
      build: { command: `dotnet build ${project.rel}`, origin: project.rel },
      test: { command: `dotnet test ${project.rel}`, origin: project.rel },
    }
  }

  return { kind: 'none' }
}

/**
 * One line per root, for the prompt and the panel.
 *
 * An override wins over detection: the repository owner knows better than a
 * two-level scan, and a wrong line in the prompt is worse than no line.
 *
 * @param {readonly { alias: string, pull?: unknown, build?: unknown, test?: unknown, path: string }[]} roots
 *   - attached roots, as stored.
 * @param {(path: string) => { build?: { command: string }, test?: { command: string } } | undefined} detected
 *   - the detection cache.
 * @returns {string[]} prompt lines, empty when nothing is known.
 */
export function commandLines(roots, detected) {
  const lines = []
  for (const root of roots) {
    const found = detected(root.path)
    const build = typeof root.build === 'string' && root.build !== ''
      ? root.build
      : found?.build?.command
    const test = typeof root.test === 'string' && root.test !== ''
      ? root.test
      : found?.test?.command
    if (typeof build !== 'string' && typeof test !== 'string') continue
    const parts = []
    if (typeof build === 'string' && build !== '') parts.push(`build: \`${build}\``)
    if (typeof test === 'string' && test !== '') parts.push(`test: \`${test}\``)
    lines.push(`${root.alias}: ${parts.join(' · ')}`)
  }
  return lines
}
