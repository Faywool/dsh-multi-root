/**
 * The bundle's own persistence: `$DSH_HOME/storages/dsh_multi_root.json`.
 *
 * Rules this module exists to enforce:
 *
 * 1. It never touches a file it does not own. `workspace.json`, session state
 *    and the profile's `cordis.patch.yml` are all read-only to this bundle.
 * 2. Every write is atomic (temp file + rename), so a crash cannot leave a
 *    half-written store behind.
 * 3. A damaged store is quarantined and treated as empty. Losing the root list
 *    is recoverable; refusing to load because of a stray character is not.
 * 4. Reads always hit disk. The file is tiny and may be edited by hand or by
 *    another DSH window, so an in-memory cache would only invent staleness.
 *
 * @module dsh-multi-root/store
 */

import { readJsonFile, report, describeError, quarantine, writeJsonFileAtomic } from './util.js'
import { sanitizeRoots } from './roots.js'

/** Schema version written into the store. */
export const STORE_VERSION = 2

/**
 * Coerce whatever was on disk into the document shape this module writes.
 * @param {unknown} value - parsed JSON, if any.
 * @returns {{ version: number, workspaces: Record<string, { path: string, roots: { alias: string, path: string, mode: string }[], updatedAt: string }> }} the document.
 */
function coerceDocument(value) {
  const workspaces = {}
  const source = value?.workspaces
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, entry] of Object.entries(source)) {
      if (typeof key !== 'string' || key === '') continue
      const path = typeof entry?.path === 'string' && entry.path.trim() !== '' ? entry.path : undefined
      if (path === undefined) continue
      workspaces[key] = {
        path,
        roots: sanitizeRoots(entry?.roots),
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
      }
    }
  }
  return { version: STORE_VERSION, workspaces }
}

/**
 * Serialised, atomic access to the root store.
 *
 * All mutations go through one promise chain, so two tool calls in the same
 * process cannot interleave a read and a write and silently drop an entry.
 */
export class RootStore {
  /** @type {string} */
  #file
  /** @type {object | undefined} */
  #logger
  /** @type {Promise<unknown>} */
  #chain = Promise.resolve()

  /**
   * @param {{ file: string, logger?: object }} options - store location and a logger.
   */
  constructor({ file, logger }) {
    this.#file = file
    this.#logger = logger
  }

  /** @returns {string} the absolute path of the backing file. */
  get file() {
    return this.#file
  }

  /**
   * Read and coerce the document, quarantining it if it cannot be parsed.
   * @returns {Promise<ReturnType<typeof coerceDocument>>} the current document.
   */
  async read() {
    const { value, damaged } = await readJsonFile(this.#file)
    if (damaged) {
      const backup = await quarantine(this.#file)
      report(this.#logger, 'warn',
        `store was not valid JSON; starting empty${backup === undefined ? '' : ` (kept the damaged copy at ${backup})`}`)
      return coerceDocument(undefined)
    }
    if (value !== undefined && value !== null && value.version !== STORE_VERSION) {
      // A legacy document gets its ids minted here. Writing the upgrade back
      // immediately is what keeps those ids stable: minting a fresh set on every
      // read would make every id a caller saw yesterday meaningless.
      const upgraded = coerceDocument(value)
      try {
        await writeJsonFileAtomic(this.#file, upgraded)
      } catch (error) {
        report(this.#logger, 'warn', `store upgrade could not be persisted: ${describeError(error)}`)
      }
      return upgraded
    }
    return coerceDocument(value)
  }

  /**
   * Run a mutation against the document and persist the result.
   *
   * The mutator runs between a read and a write on the serialised chain, so it
   * must be synchronous and must not perform I/O of its own.
   *
   * @template T
   * @param {(document: ReturnType<typeof coerceDocument>) => T} mutate - the change.
   * @returns {Promise<T>} whatever the mutator returned.
   */
  async update(mutate) {
    const run = this.#chain.then(async () => {
      const document = await this.read()
      const result = mutate(document)
      await writeJsonFileAtomic(this.#file, document)
      return result
    })
    // Keep the chain alive after a failure, otherwise one rejected write would
    // poison every later call.
    this.#chain = run.catch((error) => {
      report(this.#logger, 'warn', `store write failed: ${describeError(error)}`)
    })
    return run
  }

  /**
   * The roots attached to one workspace.
   * @param {string} workspacePath - absolute workspace directory.
   * @returns {Promise<{ alias: string, path: string, mode: string }[]>} attached roots.
   */
  async list(workspacePath) {
    const document = await this.read()
    const entry = document.workspaces[canonical(workspacePath)]
    return entry === undefined ? [] : entry.roots.map((root) => ({ ...root }))
  }

  /**
   * Replace the root list of one workspace.
   * @param {string} workspacePath - absolute workspace directory.
   * @param {{ alias: string, path: string, mode: string }[]} roots - the new list.
   * @returns {Promise<void>} resolves once persisted.
   */
  async write(workspacePath, roots) {
    await this.update((document) => {
      const key = canonical(workspacePath)
      if (roots.length === 0) {
        delete document.workspaces[key]
        return
      }
      document.workspaces[key] = {
        path: workspacePath,
        roots: sanitizeRoots(roots),
        updatedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * Every workspace entry, for diagnostics and migration.
   * @returns {Promise<{ path: string, roots: { alias: string, path: string, mode: string }[] }[]>} the entries.
   */
  async entries() {
    const document = await this.read()
    return Object.values(document.workspaces).map((entry) => ({
      path: entry.path,
      roots: entry.roots.map((root) => ({ ...root })),
    }))
  }
}

/**
 * Canonical map key for a workspace path.
 *
 * Kept private to the store so every read and write agrees on one spelling.
 * @param {string} path - workspace directory.
 * @returns {string} the key.
 */
function canonical(path) {
  return process.platform === 'win32' ? path.replace(/[\\/]+$/, '').toLowerCase() : path.replace(/[\\/]+$/, '')
}
