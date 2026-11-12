/**
 * An in-memory mirror of the store, for the synchronous prompt callback.
 *
 * Prompt assembly cannot await, but the store lives on disk. This class keeps a
 * copy that is refreshed on a timer and after every write, so the section
 * renders from memory while still tracking edits made by hand or by another
 * DSH window.
 *
 * @module dsh-multi-root/snapshot
 */

import { report, describeError } from './util.js'
import { workspaceKey } from './context.js'
import { readRootAgentsFile } from './browse.js'

/** How often the mirror re-reads the store. */
const REFRESH_INTERVAL_MS = 5000

export class RootSnapshot {
  /** @type {InstanceType<import('./store.js').RootStore>} */
  #store
  /** @type {import('./git.js').GitStatusCache | undefined} */
  #git
  /** @type {object | undefined} */
  #logger
  /** @type {Map<string, { path: string, roots: { alias: string, path: string, mode: string }[] }>} */
  #byWorkspace = new Map()
  /** @type {Map<string, string>} root path → its AGENTS.md (or CLAUDE.md) notes */
  #agentsByRoot = new Map()
  /** @type {boolean} */
  #ready = false

  /**
   * @param {object} options - dependencies.
   * @param {InstanceType<import('./store.js').RootStore>} options.store - the backing store.
   * @param {import('./git.js').GitStatusCache} [options.git] - optional git reporter.
   * @param {object} [options.logger] - a logger.
   */
  constructor({ store, git, logger }) {
    this.#store = store
    this.#git = git
    this.#logger = logger
  }

  /** @returns {boolean} whether at least one successful read has happened. */
  get ready() {
    return this.#ready
  }

  /**
   * Re-read every workspace entry and warm git metadata for the roots.
   * @returns {Promise<void>} resolves when the mirror is current.
   */
  async refresh() {
    try {
      const entries = await this.#store.entries()
      const next = new Map()
      for (const entry of entries) {
        next.set(workspaceKey(entry.path), { path: entry.path, roots: entry.roots })
      }
      this.#byWorkspace = next
      this.#ready = true
      if (this.#git !== undefined) {
        const directories = entries.flatMap((entry) => entry.roots.map((root) => root.path))
        await this.#git.warm(directories)
      }
      await this.#readAgentsFiles(entries.flatMap((entry) => entry.roots.map((root) => root.path)))
    } catch (error) {
      report(this.#logger, 'info', `could not refresh attached roots: ${describeError(error)}`)
    }
  }

  /**
   * Read each root's top-level agent instructions, best effort.
   *
   * A repository's `AGENTS.md` is the strongest hint about how to work in it,
   * and the official discovery never looks outside the session directory. The
   * text is capped per root so a chatty file cannot flood the prompt.
   *
   * @param {string[]} directories - every attached root path.
   * @returns {Promise<void>}
   */
  async #readAgentsFiles(directories) {
    const next = new Map()
    for (const directory of directories) {
      if (next.has(directory)) continue
      try {
        const text = await readRootAgentsFile(directory)
        if (text !== undefined) next.set(directory, text)
      } catch {
        // An unreadable file is the same as an absent one.
      }
    }
    this.#agentsByRoot = next
  }

  /**
   * The agent instructions declared by one root.
   * @param {string} directory - an absolute root path.
   * @returns {string | undefined} its notes, if any.
   */
  agentsOf(directory) {
    return this.#agentsByRoot.get(directory)
  }

  /**
   * The roots attached to a workspace, from memory.
   * @param {string} workspacePath - an absolute workspace directory.
   * @returns {{ alias: string, path: string, mode: string }[]} attached roots.
   */
  rootsOf(workspacePath) {
    return this.#byWorkspace.get(workspaceKey(workspacePath))?.roots ?? []
  }

  /**
   * A synchronous git lookup for the prompt table.
   * @param {string} directory - an absolute directory path.
   * @returns {{ branch: string, dirty: boolean } | undefined} cached status, if fresh.
   */
  gitStatus(directory) {
    return this.#git?.peek(directory)
  }

  /**
   * Start the periodic refresh.
   * @param {object} ctx - the plugin context, for disposal.
   * @returns {() => void} a stop function.
   */
  start(ctx) {
    const timer = setInterval(() => {
      void this.refresh()
    }, REFRESH_INTERVAL_MS)
    // Never hold the process open just to poll a JSON file.
    if (typeof timer?.unref === 'function') timer.unref()
    const stop = () => clearInterval(timer)
    try {
      ctx.effect(stop)
    } catch {
      // Without an effect API the timer still exists; it is unref'd either way.
    }
    return stop
  }
}
