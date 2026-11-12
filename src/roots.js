/**
 * Root-list algebra. Pure functions only — no I/O, no services — so the rules
 * that decide what may be attached can be unit-tested without a running DSH.
 *
 * @module dsh-multi-root/roots
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { canonicalKey, isAbsolutePath } from './util.js'

/** Access modes a root may be attached in. */
export const MODES = Object.freeze(['readwrite', 'readonly'])

/** Longest alias accepted, in characters. */
export const MAX_ALIAS_LENGTH = 32

/**
 * Mint a stable identifier for one attached root.
 *
 * Identity must survive a rename, a re-attach of the same path and a hand edit
 * of the store, so it is a random token rather than a hash of the path or the
 * alias. Two roots may legitimately share an alias after a hand edit; the id is
 * what every mutation addresses.
 *
 * @returns {string} a fresh identifier.
 */
export function newId() {
  try {
    return randomUUID()
  } catch {
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * Normalise the optional `skillsEnabled` flag of a root record.
 * @param {unknown} value - the persisted or requested value.
 * @returns {boolean} whether the root's own skill directories are exposed.
 */
export function normaliseSkills(value) {
  return value === true
}

/**
 * Fold a requested skill namespace id into the shape the prompt and the skill
 * list can carry: lowercase ASCII, no separators a namespaced skill name cannot
 * hold, and never empty.
 *
 * The id is what namespaces a root's skills (`alias-id:skill-name`), so it is a
 * separate field from the display alias: renaming what the panel shows must not
 * silently rename every skill the model already learned.
 *
 * @param {unknown} value - the requested id.
 * @param {string} fallback - the alias to derive from when the request is empty.
 * @returns {string} a usable namespace id.
 */
export function normaliseAliasId(value, fallback) {
  const source = typeof value === 'string' && value.trim() !== '' ? value : fallback
  const folded = String(source ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, MAX_ALIAS_LENGTH)
  return folded === '' ? 'root' : folded
}

/**
 * Turn a path's last segment into a usable alias.
 *
 * Repository directories are often named things a prompt table should not
 * contain (`my.service`, `v1.2-legacy`, `数据目录`), so this keeps
 * letters, digits, dots and non-ASCII word characters and folds the rest to
 * single dashes. A non-ASCII name is preserved rather than dropped, because
 * transliterating it would produce a misleading label.
 *
 * @param {string} path - an absolute directory path.
 * @returns {string} a non-empty alias candidate.
 */
export function aliasFor(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const base = basename(trimmed) || trimmed.replace(/[^\p{L}\p{N}]+/gu, '')
  // Case is part of the name a person reads (`PSREF_Backend` is not
  // `psref_backend`), so it is preserved here. Uniqueness is still decided
  // case-insensitively — see `uniqueAlias` — so `Api` and `api` cannot coexist.
  const folded = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_ALIAS_LENGTH)
  return folded === '' ? 'root' : folded
}

/**
 * Pick an alias that collides with nothing already attached.
 * @param {string} desired - the preferred alias.
 * @param {readonly { alias: string }[]} taken - roots already attached.
 * @returns {string} the desired alias, or `desired-2`, `desired-3`, …
 */
export function uniqueAlias(desired, taken) {
  const used = new Set(taken.map((root) => root.alias.toLowerCase()))
  if (!used.has(desired.toLowerCase())) return desired
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${desired}-${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${desired}-${Date.now()}`
}

/**
 * Validate and normalise one root request.
 *
 * Failures are returned, not thrown: the caller is usually a model-driven tool
 * call, and a bad argument should come back as a readable message rather than
 * an exception the tool layer has to unwrap.
 *
 * @param {{ path?: unknown, alias?: unknown, mode?: unknown, skillsEnabled?: unknown }} input - the request.
 * @param {readonly { alias: string, path: string }[]} taken - roots already attached.
 * @param {{ id?: string, addedAt?: string, skillsEnabled?: unknown }} [identity] - the record this
 *   request updates, so a re-attach keeps its id instead of minting a new one.
 * @returns {{ ok: true, root: { id: string, alias: string, path: string, mode: string,
 *   skillsEnabled: boolean, addedAt: string } }
 *   | { ok: false, reason: string }} the normalised root, or why it was rejected.
 */
export function normalizeRoot(input, taken = [], identity = {}) {
  if (!isAbsolutePath(input?.path)) {
    return { ok: false, reason: 'path must be an absolute directory path' }
  }
  const path = input.path.trim().replace(/[\\/]+$/, '') || input.path.trim()
  const mode = input?.mode === undefined ? 'readwrite' : String(input.mode).toLowerCase()
  if (!MODES.includes(mode)) {
    return { ok: false, reason: `mode must be one of ${MODES.join(', ')}` }
  }
  const rawAlias = typeof input?.alias === 'string' ? input.alias.trim() : ''
  const alias = rawAlias === '' ? aliasFor(path) : rawAlias.slice(0, MAX_ALIAS_LENGTH)
  const wantedAliasId = typeof input?.aliasId === 'string' && input.aliasId.trim() !== ''
    ? input.aliasId
    : typeof identity.aliasId === 'string' && identity.aliasId !== ''
      ? identity.aliasId
      : alias
  const aliasId = uniqueAlias(
    normaliseAliasId(wantedAliasId, alias),
    taken.map((root) => ({
      alias: typeof root.aliasId === 'string' && root.aliasId !== '' ? root.aliasId : root.alias,
    })),
  )
  const skillsEnabled = input?.skillsEnabled === undefined
    ? normaliseSkills(identity.skillsEnabled)
    : normaliseSkills(input.skillsEnabled)
  return {
    ok: true,
    root: {
      id: typeof identity.id === 'string' && identity.id !== '' ? identity.id : newId(),
      alias: uniqueAlias(alias, taken),
      aliasId,
      path,
      mode,
      skillsEnabled,
      addedAt: typeof identity.addedAt === 'string' && identity.addedAt !== ''
        ? identity.addedAt
        : new Date().toISOString(),
    },
  }
}

/**
 * Find an attached root by id, alias or path — in that order.
 *
 * The id is what a UI hands back, the alias is what a human types, and the path
 * is what a model usually knows. Aliases are compared case-insensitively, paths
 * through {@link canonicalKey}, so `D:\WS` and `d:/ws/` are the same root.
 *
 * @param {readonly { id?: string, alias: string, path: string }[]} roots - attached roots.
 * @param {string} selector - an id, an alias, or an absolute path.
 * @returns {number} the index of the match, or -1.
 */
export function findRootIndex(roots, selector) {
  const needle = String(selector ?? '').trim()
  if (needle === '') return -1
  const byId = roots.findIndex((root) => typeof root.id === 'string' && root.id === needle)
  if (byId !== -1) return byId
  const byAlias = roots.findIndex((root) => root.alias.toLowerCase() === needle.toLowerCase())
  if (byAlias !== -1) return byAlias
  const key = canonicalKey(needle)
  return roots.findIndex((root) => canonicalKey(root.path) === key)
}

/**
 * Compute the new root list after an attach request.
 *
 * Re-attaching an existing path updates it in place (alias and mode) instead of
 * creating a duplicate, so a model that retries a failed call cannot grow the
 * list. Duplicates inside one request are collapsed the same way.
 *
 * @param {readonly { alias: string, path: string, mode: string }[]} existing - current roots.
 * @param {readonly { alias: string, path: string, mode: string }[]} incoming - requested roots.
 * @param {number} maxRoots - cap on the resulting list length.
 * @returns {{ roots: { alias: string, path: string, mode: string }[], added: string[],
 *   replaced: string[], skipped: { path: string, reason: string }[] }} the planned change.
 */
export function planAttach(existing, incoming, maxRoots) {
  const roots = existing.map((root) => ({ ...root }))
  const added = []
  const replaced = []
  const skipped = []

  for (const request of incoming) {
    const key = canonicalKey(request.path)
    const index = roots.findIndex((root) => canonicalKey(root.path) === key)
    if (index !== -1) {
      const previousAlias = roots[index].alias
      roots[index] = {
        ...roots[index],
        alias: request.alias,
        mode: request.mode,
        path: request.path,
        ...(request.aliasId === undefined ? {} : { aliasId: request.aliasId }),
        ...(request.skillsEnabled === undefined ? {} : { skillsEnabled: request.skillsEnabled }),
      }
      replaced.push(previousAlias === request.alias ? request.alias : `${previousAlias}→${request.alias}`)
      continue
    }
    if (roots.length >= maxRoots) {
      skipped.push({ path: request.path, reason: `maxRoots (${maxRoots}) reached` })
      continue
    }
    roots.push({ ...request })
    added.push(request.alias)
  }

  return { roots, added, replaced, skipped }
}

/**
 * Move one root inside the list, which is the attach order the prompt table and
 * the panel both display.
 *
 * @param {readonly object[]} roots - current roots.
 * @param {string} selector - id, alias or path of the root to move.
 * @param {'up' | 'down' | number} position - `up`/`down` by one, or a target index.
 * @returns {{ ok: true, roots: object[], index: number }
 *   | { ok: false, reason: string }} the reordered list, or why it did not move.
 */
export function moveRoot(roots, selector, position) {
  const index = findRootIndex(roots, selector)
  if (index === -1) return { ok: false, reason: `no attached root matches ${JSON.stringify(String(selector))}` }
  const target = position === 'up'
    ? index - 1
    : position === 'down'
      ? index + 1
      : Number(position)
  if (!Number.isInteger(target) || target < 0 || target >= roots.length) {
    return { ok: false, reason: `position must be an index between 0 and ${roots.length - 1}, or "up"/"down"` }
  }
  if (target === index) return { ok: true, roots: roots.map((root) => ({ ...root })), index }
  const next = roots.map((root) => ({ ...root }))
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return { ok: true, roots: next, index: target }
}

/**
 * Drop malformed roots from a persisted list.
 *
 * The store is an ordinary JSON file that a human may edit, so anything that
 * does not round-trip through {@link normalizeRoot} is discarded rather than
 * trusted. Aliases are de-duplicated too, because a hand edit can introduce
 * collisions that {@link uniqueAlias} would otherwise never have produced.
 *
 * @param {unknown} value - the persisted list.
 * @returns {object[]} the usable roots, each with a stable id.
 */
export function sanitizeRoots(value) {
  if (!Array.isArray(value)) return []
  const roots = []
  const ids = new Set()
  for (const entry of value) {
    const path = typeof entry?.path === 'string' ? entry.path : undefined
    if (!isAbsolutePath(path) || findRootIndex(roots, path) !== -1) continue
    const mode = MODES.includes(entry?.mode) ? entry.mode : 'readwrite'
    const rawAlias = typeof entry?.alias === 'string' ? entry.alias.trim() : ''
    const alias = uniqueAlias(rawAlias === '' ? aliasFor(path) : rawAlias.slice(0, MAX_ALIAS_LENGTH), roots)
    const wantedAliasId = typeof entry?.aliasId === 'string' && entry.aliasId.trim() !== ''
      ? entry.aliasId
      : alias
    const aliasId = uniqueAlias(normaliseAliasId(wantedAliasId, alias), roots.map((root) => ({ alias: root.aliasId })))
    let id = typeof entry?.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : ''
    if (id === '' || ids.has(id)) id = newId()
    ids.add(id)
    roots.push({
      id,
      alias,
      aliasId,
      path: path.trim(),
      mode,
      skillsEnabled: normaliseSkills(entry?.skillsEnabled),
      addedAt: typeof entry?.addedAt === 'string' && entry.addedAt.trim() !== ''
        ? entry.addedAt
        : new Date().toISOString(),
    })
  }
  return roots
}
