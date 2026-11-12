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

import { canonicalKey, readJsonFile, report, describeError, quarantine, writeJsonFileAtomic } from './util.js'
import { sanitizeRoots } from './roots.js'

/** Schema version written into the store. */
export const STORE_VERSION = 2

/**
 * Coerce whatever was on disk into the document shape this module writes.
 *
 * Keys are rewritten through `canonicalKey`, so a document written before the
 * store agreed with the rest of the plugin (backslash keys) merges into the
 * current spelling instead of looking empty. `rekeyed` tells the caller that
 * the document on disk should be rewritten.
 *
 * @param {unknown} value - parsed JSON, if any.
 * @returns {{ document: { version: number, workspaces: Record<string, { path: string, roots: { alias: string, path: string, mode: string }[], searchEnabled: boolean, updatedAt: string }> }, rekeyed: boolean }} the document plus whether keys changed.
 */
function coerceDocument(value) {
  const workspaces = {}
  let rekeyed = false
  const source = value?.workspaces
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [key, entry] of Object.entries(source)) {
      if (typeof key !== 'string' || key === '') continue
      const path = typeof entry?.path === 'string' && entry.path.trim() !== '' ? entry.path : undefined
      if (path === undefined) continue
      const target = canonicalKey(path)
      if (target !== key) rekeyed = true
      const previous = workspaces[target]
      const roots = sanitizeRoots(previous === undefined ? entry?.roots : [...previous.roots, ...(entry?.roots ?? [])])
      workspaces[target] = {
        path: previous?.path ?? path,
        roots,
        searchEnabled: (previous?.searchEnabled ?? true) && entry?.searchEnabled !== false,
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString(),
      }
    }
  }
  return { document: { version: STORE_VERSION, workspaces }, rekeyed }
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
   *
   * A document that needed upgrading (legacy version, legacy key spelling) is
   * written back immediately, because both upgrades mint stable identities: the
   * ids of roots and the canonical key of each workspace.
   *
   * @returns {Promise<{ version: number, workspaces: Record<string, { path: string, roots: object[], searchEnabled: boolean, updatedAt: string }> }>} the current document.
   */
  async read() {
    const { value, damaged } = await readJsonFile(this.#file)
    if (damaged) {
      const backup = await quarantine(this.#file)
      report(this.#logger, 'warn',
        `store was not valid JSON; starting empty${backup === undefined ? '' : ` (kept the damaged copy at ${backup})`}`)
      return coerceDocument(undefined).document
    }
    const { document, rekeyed } = coerceDocument(value)
    const legacyVersion = value !== undefined && value !== null && value.version !== STORE_VERSION
    if (legacyVersion || rekeyed) {
      try {
        await writeJsonFileAtomic(this.#file, document)
      } catch (error) {
        report(this.#logger, 'warn', `store upgrade could not be persisted: ${describeError(error)}`)
      }
    }
    return document
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
        searchEnabled: document.workspaces[key]?.searchEnabled !== false,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * Whether content search (`workspace_grep`) is enabled for one workspace.
   *
   * Defaults to `true`: the toggle exists so a workspace with huge roots can
   * opt out, not so every workspace has to opt in.
   *
   * @param {string} workspacePath - absolute workspace directory.
   * @returns {Promise<boolean>} the flag.
   */
  async searchEnabled(workspacePath) {
    const document = await this.read()
    const entry = document.workspaces[canonical(workspacePath)]
    return entry === undefined ? true : entry.searchEnabled !== false
  }

  /**
   * Turn content search on or off for one workspace.
   *
   * Creating the entry when it does not exist keeps the flag independent from
   * the root list: a workspace can disable search before attaching anything.
   *
   * @param {string} workspacePath - absolute workspace directory.
   * @param {boolean} enabled - the new value.
   * @returns {Promise<boolean>} the value that was stored.
   */
  async setSearchEnabled(workspacePath, enabled) {
    const value = enabled !== false
    await this.update((document) => {
      const key = canonical(workspacePath)
      const existing = document.workspaces[key]
      document.workspaces[key] = {
        path: existing?.path ?? workspacePath,
        roots: existing?.roots ?? [],
        searchEnabled: value,
        updatedAt: new Date().toISOString(),
      }
    })
    return value
  }

  /**
   * Every workspace entry, for diagnostics and migration.
   * @returns {Promise<{ path: string, roots: { alias: string, path: string, mode: string }[], searchEnabled: boolean }[]>} the entries.
   */
  async entries() {
    const document = await this.read()
    return Object.values(document.workspaces).map((entry) => ({
      path: entry.path,
      roots: entry.roots.map((root) => ({ ...root })),
      searchEnabled: entry.searchEnabled !== false,
    }))
  }
}

/**
 * Canonical map key for a workspace path.
 *
 * Delegates to `canonicalKey` so the store, the routes and the tools all spell
 * a workspace the same way; two spellings of one directory used to produce two
 * separate entries.
 *
 * @param {string} path - workspace directory.
 * @returns {string} the key.
 */
function canonical(path) {
  return canonicalKey(path)
}
