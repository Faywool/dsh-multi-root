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
        for (const line of stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) {
            branch = line.slice('# branch.head '.length).trim()
          } else if (line.trim() !== '' && !line.startsWith('#')) {
            dirty = true
          }
        }
        if (branch === '') {
          resolvePromise(undefined)
          return
        }
        resolvePromise({ branch: branch === '(detached)' ? 'detached' : branch, dirty })
      },
    )
  })
}

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
