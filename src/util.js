/**
 * Small filesystem and logging helpers shared by the host half.
 *
 * Everything here is deliberately dependency-free: this bundle must load in
 * any DSH composition, including ones that mount no storage, no settings and
 * no git, so it brings its own primitives instead of reaching for a service.
 *
 * @module dsh-multi-root/util
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Prefix every diagnostic carries, so one grep finds all of them. */
export const LOG_PREFIX = '[dsh-multi-root]'

/**
 * Report a non-fatal problem without ever throwing.
 *
 * A throw from a logger would defeat the whole point of this bundle, so the
 * fallback silently drops the message rather than escalating.
 *
 * @param {object | undefined} logger - the calling context's logger, if it has one.
 * @param {'warn' | 'info' | 'error'} level - severity to report at.
 * @param {string} message - the diagnostic.
 */
export function report(logger, level, message) {
  try {
    const sink = logger?.[level] ?? logger?.warn ?? logger?.info
    if (typeof sink === 'function') sink.call(logger, `${LOG_PREFIX} ${message}`)
  } catch {
    // Logging is best-effort; a broken logger must never break the caller.
  }
}

/**
 * Emit a diagnostic straight to stderr, only when DSH_MULTI_ROOT_DEBUG=1.
 *
 * The host's plugin logger is not always visible from a launched instance, and
 * "did my plugin mount at all?" is the first question of any support report.
 * This bypasses the logger deliberately: it must work even when the composition
 * has no logger worth the name.
 *
 * @param {string} message - the diagnostic.
 */
export function debug(message) {
  if (process.env.DSH_MULTI_ROOT_DEBUG !== '1') return
  try {
    process.stderr.write(`${LOG_PREFIX} ${message}\n`)
  } catch {
    // A closed stderr must not break the caller.
  }
}

/**
 * Append one line to the plugin's own diagnostic log.
 *
 * This is the part of a fail-soft design that has to survive the failure: the
 * host logger may be invisible, and a silent degrade is indistinguishable from
 * a feature that never existed. The file lives beside the store, is capped at
 * one megabyte, and never throws.
 *
 * @param {string} message - the diagnostic.
 */
export function noteDiagnostic(message) {
  try {
    const file = storePath()
    mkdirSync(dirname(file), { recursive: true })
    const logFile = file.replace(/\.json$/u, '.log')
    try {
      if (statSync(logFile).size > 1024 * 1024) writeFileSync(logFile, '')
    } catch {
      // No log file yet: nothing to trim.
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${LOG_PREFIX} ${message}\n`, 'utf8')
  } catch {
    // Diagnostics must never be the reason something breaks.
  }
}

/**
 * Record one degraded contribution. Same sink as {@link noteDiagnostic}.
 *
 * @param {string} message - what could not be mounted, and why.
 */
export function noteFailure(message) {
  noteDiagnostic(message)
}

/**
 * Describe an unknown thrown value for a log line.
 * @param {unknown} error - whatever was caught.
 * @returns {string} a short, single-line description.
 */
export function describeError(error) {
  if (error instanceof Error) return error.message
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * The DSH home directory (`$DSH_HOME`, else `~/.dsh`).
 *
 * The profile directory is `$DSH_HOME/profiles/<name>`, so this is one level
 * above the profile rather than inside it: the store must survive a profile
 * rename and must never be mistaken for a profile-owned file.
 *
 * @param {NodeJS.ProcessEnv} [env] - an environment to read, for tests.
 * @returns {string} the absolute home directory.
 */
export function dshHome(env = process.env) {
  const explicit = env?.DSH_HOME?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  return join(homedir(), '.dsh')
}

/**
 * The store file this bundle owns.
 * @param {NodeJS.ProcessEnv} [env] - an environment to read, for tests.
 * @returns {string} the absolute path of the JSON store.
 */
export function storePath(env = process.env) {
  return join(dshHome(env), 'storages', 'dsh_multi_root.json')
}

/**
 * Whether a value is a usable absolute path.
 * @param {unknown} value - the candidate.
 * @returns {value is string} whether it is a non-empty absolute path string.
 */
export function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && isAbsolute(value.trim())
}

/**
 * Canonical form of a directory path, for equality and map keys.
 *
 * Windows paths are case-insensitive and mixed-separator, so a raw string
 * comparison would happily store the same repository twice. The canonical form
 * is the case-folded, separator-normalised, trailing-separator-free absolute
 * path. It is used ONLY as a key: the display path is preserved verbatim.
 *
 * @param {string} path - an absolute or relative path.
 * @returns {string} the canonical key.
 */
export function canonicalKey(path) {
  const absolute = resolve(path)
  const unified = absolute.split(sep).join('/')
  const withoutTrailing = unified.length > 1 ? unified.replace(/\/+$/, '') : unified
  return process.platform === 'win32' ? withoutTrailing.toLowerCase() : withoutTrailing
}

/**
 * Read a JSON file, returning `undefined` when it does not exist.
 *
 * A file that exists but cannot be parsed is reported and treated as absent:
 * a corrupted store must degrade to "no attached roots", never to a failed
 * plugin load. The caller decides whether to preserve the damaged file.
 *
 * @param {string} file - absolute path to read.
 * @returns {Promise<{ value: unknown, damaged: boolean }>} the parsed value, if any.
 */
export async function readJsonFile(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: undefined, damaged: false }
    throw error
  }
  try {
    return { value: JSON.parse(text), damaged: false }
  } catch {
    return { value: undefined, damaged: true }
  }
}

/**
 * Write a JSON file atomically: a sibling temp file, then a rename.
 *
 * The rename is the only step that publishes the new content, so a crash mid
 * write leaves the previous store intact instead of a truncated one.
 *
 * @param {string} file - absolute destination path.
 * @param {unknown} value - JSON-serialisable content.
 * @returns {Promise<void>} resolves once the rename published the content.
 */
export async function writeJsonFileAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Move a damaged file aside so the next write starts clean without losing it.
 * @param {string} file - the damaged file.
 * @returns {Promise<string | undefined>} the backup path, if one was made.
 */
export async function quarantine(file) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    await rename(file, backup)
    return backup
  } catch {
    return undefined
  }
}
