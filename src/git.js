/**
 * Optional git metadata for the root table.
 *
 * This is strictly ornamental: if `git` is missing, slow, or the directory is
 * not a repository, the table simply omits the branch column. Nothing here is
 * allowed to surface an error to the caller.
 *
 * @module dsh-multi-root/git
 */

import { execFile } from 'node:child_process'
import { report } from './util.js'

/** How long one `git status` may take before it is abandoned. */
const GIT_TIMEOUT_MS = 2000

/**
 * Read the branch and dirty flag of a directory in one `git` call.
 *
 * `--porcelain=v2 --branch` emits the branch on `# branch.head` lines and one
 * line per changed path, so a single invocation answers both questions.
 *
 * @param {string} directory - an absolute directory path.
 * @returns {Promise<{ branch: string, dirty: boolean } | undefined>} the status, or undefined when unavailable.
 */
export function readGitStatus(directory) {
  return new Promise((resolvePromise) => {
    execFile(
      'git',
      ['-C', directory, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolvePromise(undefined)
          return
        }
        let branch = ''
        let dirty = false
        let ahead = 0
        let behind = 0
        for (const line of stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) {
            branch = line.slice('# branch.head '.length).trim()
          } else if (line.startsWith('# branch.ab ')) {
            const match = /\+(\d+)\s+-(\d+)/.exec(line)
            if (match !== null) {
              ahead = Number.parseInt(match[1], 10)
              behind = Number.parseInt(match[2], 10)
            }
          } else if (line.trim() !== '' && !line.startsWith('#')) {
            dirty = true
          }
        }
        if (branch === '') {
          resolvePromise(undefined)
          return
        }
        resolvePromise({
          branch: branch === '(detached)' ? 'detached' : branch,
          dirty,
          ahead,
          behind,
        })
      },
    )
  })
}

/**
 * Everything the `workspace_git` tool reports about one repository.
 *
 * @typedef {object} RepoState
 * @property {string} branch - the checked-out branch, or `detached`.
 * @property {number} ahead - commits ahead of the upstream, 0 when unknown.
 * @property {number} behind - commits behind the upstream, 0 when unknown.
 * @property {number} changed - how many paths are modified or staged.
 * @property {string[]} files - the first few changed paths.
 * @property {{ hash: string, subject: string, date: string } | undefined} last
 *   - the newest commit, when one exists.
 */

/**
 * Read the full state of one repository: branch, divergence, changes, last commit.
 *
 * Two `git` calls, both read-only and bounded. A directory that is not a
 * repository resolves to `undefined` rather than throwing, so a root that
 * happens to be plain files still appears in the table without a git column.
 *
 * @param {string} directory - an absolute directory path.
 * @returns {Promise<RepoState | undefined>} the state, or undefined when unavailable.
 */
export function readRepoState(directory) {
  const status = new Promise((resolvePromise) => {
    let stdout = ''
    try {
      execFile(
        'git',
        ['-C', directory, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, out) => {
          if (error) resolvePromise(undefined)
          else { stdout = out; resolvePromise(stdout) }
        },
      )
    } catch {
      resolvePromise(undefined)
    }
  })
  const log = new Promise((resolvePromise) => {
    try {
      execFile(
        'git',
        ['-C', directory, 'log', '-1', '--format=%h%x1f%ad%x1f%s', '--date=short'],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, out) => {
          if (error) resolvePromise(undefined)
          else resolvePromise(out.trim())
        },
      )
    } catch {
      resolvePromise(undefined)
    }
  })

  return Promise.all([status, log]).then(([text, lastCommit]) => {
    if (typeof text !== 'string') return undefined
    let branch = ''
    let ahead = 0
    let behind = 0
    const files = []
    for (const line of text.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        branch = line.slice('# branch.head '.length).trim()
      } else if (line.startsWith('# branch.ab ')) {
        const match = /\+(\d+)\s+-(\d+)/.exec(line)
        if (match !== null) {
          ahead = Number.parseInt(match[1], 10)
          behind = Number.parseInt(match[2], 10)
        }
      } else if (line.trim() !== '' && !line.startsWith('#')) {
        const parts = line.split(' ')
        const path = parts.length >= 9 ? parts.slice(8).join(' ') : ''
        if (path !== '') files.push(path)
      }
    }
    if (branch === '') return undefined
    let last
    if (typeof lastCommit === 'string' && lastCommit !== '') {
      const [hash, date, ...subject] = lastCommit.split('\u001f')
      last = { hash, date, subject: subject.join('\u001f') }
    }
    return {
      branch: branch === '(detached)' ? 'detached' : branch,
      ahead,
      behind,
      changed: files.length,
      files: files.slice(0, 8),
      last,
    }
  })
}

/**
 * The diff stats of one repository, as plain text.
 *
 * @param {string} directory - an absolute directory path.
 * @param {boolean} [staged=false] - report the index instead of the working tree.
 * @returns {Promise<string | undefined>} the `--stat` output, or undefined.
 */
export function readDiffStat(directory, staged = false) {
  return runGit(directory, staged ? ['diff', '--cached', '--stat'] : ['diff', '--stat'], 4096)
}

/**
 * The last commits of one repository.
 *
 * @param {string} directory - an absolute directory path.
 * @param {number} limit - how many commits to read, 1–20.
 * @returns {Promise<string | undefined>} one line per commit, or undefined.
 */
export function readLog(directory, limit) {
  return runGit(directory, ['log', `-n${limit}`, '--format=%h %ad %s', '--date=short'], 128 * 1024)
}

/**
 * Run one read-only git command and return its stdout.
 *
 * @param {string} directory - an absolute directory path.
 * @param {readonly string[]} args - git arguments.
 * @param {number} maxBuffer - the output cap in bytes.
 * @returns {Promise<string | undefined>} the output, or undefined on any failure.
 */
function runGit(directory, args, maxBuffer) {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        'git',
        ['-C', directory, ...args],
        { timeout: GIT_READ_TIMEOUT_MS, windowsHide: true, maxBuffer },
        (error, stdout) => {
          if (error) resolvePromise(undefined)
          else resolvePromise(stdout)
        },
      )
    } catch {
      resolvePromise(undefined)
    }
  })
}

/** How long a read-only report command may take. */
const GIT_READ_TIMEOUT_MS = 4000

/**
 * A small time-based cache in front of {@link readGitStatus}.
 *
 * Assembling the prompt runs on every step, so an uncached `git` call per root
 * would spawn processes continuously. Five seconds is short enough that the
 * table still tracks a checkout and long enough that a burst of steps shares
 * one lookup per root.
 */
export class GitStatusCache {
  /** @type {Map<string, { at: number, value: { branch: string, dirty: boolean } | undefined }>} */
  #entries = new Map()
  /** @type {number} */
  #ttlMs
  /** @type {object | undefined} */
  #logger

  /**
   * @param {{ ttlMs?: number, logger?: object }} [options] - cache lifetime and logger.
   */
  constructor({ ttlMs = 5000, logger } = {}) {
    this.#ttlMs = ttlMs
    this.#logger = logger
  }

  /**
   * The cached status, when it is still fresh.
   *
   * `allowStale` is for display paths (the panel, the prompt table): a five
   * second old branch name is far better than a blank cell, and the periodic
   * refresh is what keeps it honest.
   *
   * @param {string} directory - an absolute directory path.
   * @param {boolean} [allowStale=false] - return the last known value regardless of age.
   * @returns {{ branch: string, dirty: boolean } | undefined} the status, if known.
   */
  peek(directory, allowStale = false) {
    const entry = this.#entries.get(directory)
    if (entry === undefined) return undefined
    if (!allowStale && Date.now() - entry.at > this.#ttlMs) return undefined
    return entry.value
  }

  /**
   * Refresh one directory's status.
   * @param {string} directory - an absolute directory path.
   * @returns {Promise<{ branch: string, dirty: boolean } | undefined>} the status, if available.
   */
  async get(directory) {
    const cached = this.peek(directory)
    if (cached !== undefined) return cached
    let value
    try {
      value = await readGitStatus(directory)
    } catch (error) {
      report(this.#logger, 'info', `git status unavailable for ${directory}`)
      value = undefined
    }
    this.#entries.set(directory, { at: Date.now(), value })
    return value
  }

  /**
   * Warm the cache for a set of directories, in parallel.
   * @param {readonly string[]} directories - absolute directory paths.
   * @returns {Promise<void>} resolves when every lookup settled.
   */
  async warm(directories) {
    await Promise.all(directories.map((directory) => this.get(directory)))
  }
}
