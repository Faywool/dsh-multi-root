/**
 * The browser-facing API of this plugin.
 *
 * The GUI needs three things a tool cannot give it: the roots of every
 * workspace, a way to change them, and each root's git state. All three are
 * served from one same-origin route so the client half stays a dumb renderer
 * and the store keeps a single writer.
 *
 * The route is additive like everything else here: no web server in the
 * composition means no route, and the plugin keeps working through its tool and
 * its prompt section.
 *
 * @module dsh-multi-root/routes
 */

import { listDirectory, readTextFile } from './browse.js'
import { service } from './context.js'
import {
  MODES,
  aliasFor,
  findRootIndex,
  moveRoot,
  normaliseAliasId,
  normalizeRoot,
  planAttach,
  sanitizeRoots,
} from './roots.js'
import { canonicalKey, describeError, isAbsolutePath, report } from './util.js'

/** Where the client half asks for, and changes, the root table. */
export const STATE_ROUTE = '/dsh-multi-root/state'

/** Where the client half lists one directory of an attached root. */
export const BROWSE_ROUTE = '/dsh-multi-root/browse'

/** Where the client half reads one file of an attached root. */
export const FILE_ROUTE = '/dsh-multi-root/file'

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * @typedef {object} RouteDeps
 * @property {import('./store.js').RootStore} store
 * @property {import('./snapshot.js').RootSnapshot} snapshot
 * @property {import('./config.js').ResolvedConfig | (() => any)} [config]
 * @property {any} [logger]
 */

/**
 * Read a JSON request body.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<any>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${describeError(error)}`))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Write a JSON response. Never throws: the socket may already be gone.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {any} body
 */
function respond(response, status, body) {
  try {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch {
    // The client disconnected mid-flight; nothing to report to anyone.
  }
}

/**
 * Whether a mutating request came from the GUI page rather than another origin.
 *
 * A browser always sends `Origin` on a cross-origin POST and on same-origin
 * POSTs from fetch in modern engines. Requests without one are not browsers
 * (the local CLI), and only the loopback host serves this route, so an absent
 * header is allowed.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {string | undefined} expected
 * @returns {boolean}
 */
function sameOrigin(request, expected) {
  const origin = request.headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  if (expected === undefined) return true
  return origin === expected
}

/**
 * Every workspace the host knows about, not only the ones with attached roots.
 *
 * The panel lists workspaces so the user can pick one; a workspace without a
 * single attached root is still a meaningful answer ("nothing attached here
 * yet"). The registry owns that list, so it is read fresh on every request
 * instead of being mirrored into our own store.
 *
 * @param {RouteDeps} deps
 * @returns {Array<{ path: string, title?: string }>}
 */
function knownWorkspaces(deps) {
  let registry
  try {
    registry = service(deps.ctx, 'workspaceRegistry')
  } catch (error) {
    registry = undefined
  }
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const items = registry.list()
    if (!Array.isArray(items)) return []
    const known = []
    for (const item of items) {
      if (item === null || typeof item !== 'object' || typeof item.path !== 'string') continue
      known.push({ path: item.path, ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title } : {}) })
    }
    return known
  } catch (error) {
    report(deps.logger, 'warn', `could not read the workspace registry: ${describeError(error)}`)
    return []
  }
}

/**
 * Which of the known workspaces contains the session the GUI is showing last.
 *
 * The sidebar selection itself is not exposed by any service, but the GUI
 * persists the open session id in local storage and can hand it to us. Live
 * sessions carry their `cwd` in the session header, so that id resolves to a
 * directory here. The remembered directory is only a fallback for CLI callers.
 *
 * @param {RouteDeps} deps
 * @param {Array<{ key: string, path: string, title?: string }>} workspaces
 * @param {string} [sessionId]
 * @returns {{ key: string, path: string, title?: string } | undefined}
 */
function currentWorkspace(deps, workspaces, sessionId) {
  let directory
  try {
    directory = typeof sessionId === 'string' && sessionId !== '' ? directoryOfSession(deps, sessionId) : undefined
  } catch (error) {
    directory = undefined
  }
  if (typeof directory !== 'string' || directory === '') {
    try {
      directory = typeof deps.currentDirectory === 'function' ? deps.currentDirectory() : undefined
    } catch (error) {
      directory = undefined
    }
  }
  if (typeof directory !== 'string' || directory === '') return undefined
  const wanted = canonicalKey(directory)
  for (const item of workspaces) {
    const key = item.key
    if (wanted === key) return item
    const prefix = key.endsWith('/') ? key : `${key}/`
    if (wanted.startsWith(prefix)) return item
  }
  return undefined
}

/**
 * The working directory of one live session, if the store still knows it.
 *
 * @param {RouteDeps} deps
 * @param {string} sessionId
 * @returns {string | undefined}
 */
function directoryOfSession(deps, sessionId) {
  const store = service(deps.ctx, 'sessions')
  if (store === undefined || typeof store.get !== 'function') return undefined
  const session = store.get(sessionId)
  const header = session === null || session === undefined ? undefined : session.header
  return header === undefined || header === null ? undefined : header.cwd
}

/**
 * Build the payload the panel renders from the current store and git cache.
 *
 * @param {RouteDeps} deps
 * @param {string} [workspace] - focus one workspace instead of all of them.
 * @param {string} [sessionId] - the session the GUI is showing, for `current`.
 * @returns {Promise<any>}
 */
async function buildState(deps, workspace, sessionId) {
  const entries = await deps.store.entries()
  const ordered = []
  const index = new Map()
  for (const entry of entries) {
    const item = { key: canonicalKey(entry.path), path: entry.path, roots: entry.roots }
    ordered.push(item)
    index.set(item.key, item)
  }
  for (const known of knownWorkspaces(deps)) {
    const key = canonicalKey(known.path)
    const hit = index.get(key)
    if (hit !== undefined) {
      if (known.title !== undefined) hit.title = known.title
      continue
    }
    const item = { key, path: known.path, roots: [], ...(known.title === undefined ? {} : { title: known.title }) }
    ordered.push(item)
    index.set(key, item)
  }
  const current = currentWorkspace(deps, ordered, sessionId)
  const workspaces = []
  for (const item of ordered) {
    if (workspace !== undefined && canonicalKey(workspace) !== item.key) continue
    const roots = item.roots.map((root) => {
      const status = deps.snapshot.gitStatus(root.path)
      return {
        id: root.id,
        alias: root.alias,
        ...(typeof root.aliasId === 'string' && root.aliasId !== '' ? { aliasId: root.aliasId } : {}),
        path: root.path,
        mode: root.mode,
        skillsEnabled: root.skillsEnabled === true,
        addedAt: root.addedAt,
        git: status === undefined ? null : { branch: status.branch, dirty: status.dirty },
      }
    })
    workspaces.push({
      key: item.key,
      path: item.path,
      ...(item.title === undefined ? {} : { title: item.title }),
      roots,
    })
  }
  const config = typeof deps.config === 'function' ? deps.config() : deps.config
  return {
    ok: true,
    workspaces,
    current: current === undefined ? undefined : {
      key: current.key,
      path: current.path,
      ...(current.title === undefined ? {} : { title: current.title }),
    },
    config: config === undefined ? undefined : {
      enabled: config.enabled,
      maxRoots: config.maxRoots,
      injectPrompt: config.injectPrompt,
      promptMaxChars: config.promptMaxChars,
      showGit: config.showGit,
    },
    store: deps.store.file,
  }
}

/**
 * Apply one mutation from the panel and answer with the fresh state.
 *
 * Business failures answer `ok: false` with a sentence the panel can show
 * verbatim; they are not protocol errors.
 *
 * @param {RouteDeps} deps
 * @param {any} body
 * @returns {Promise<any>}
 */
async function mutate(deps, body) {
  const action = typeof body?.action === 'string' ? body.action : ''
  const workspace = typeof body?.workspace === 'string' ? body.workspace.trim() : ''

  if (action === '' || workspace === '') {
    return { ok: false, error: 'the request needs an action and a workspace' }
  }
  if (!isAbsolutePath(workspace)) {
    return { ok: false, error: 'the workspace must be an absolute path' }
  }

  const key = canonicalKey(workspace)
  const existing = (await deps.store.list(workspace)).map((root) => ({ ...root }))
  const config = typeof deps.config === 'function' ? deps.config() : deps.config

  if (action === 'attach') {
    const requested = Array.isArray(body.paths)
      ? body.paths
      : typeof body.path === 'string' ? [body.path] : []
    if (requested.length === 0) return { ok: false, error: 'attach needs a path' }

    const target = String(requested[0]).trim()
    if (canonicalKey(target) === key) {
      return { ok: false, error: 'that is the workspace directory itself' }
    }

    const taken = new Set(existing.map((root) => root.alias.toLowerCase()))
    const normalized = normalizeRoot({ path: target, alias: body.alias, mode: body.mode }, existing)
    if (!normalized.ok) return { ok: false, error: normalized.reason }

    const plan = planAttach(existing, [normalized.root], config?.maxRoots ?? 16)
    if (plan.added === 0 && plan.replaced === 0) {
      return { ok: false, error: `already attached, or the limit of ${config?.maxRoots ?? 16} roots is reached` }
    }
    await deps.store.write(workspace, sanitizeRoots(plan.roots))
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'detach') {
    const selector = typeof body.id === 'string' && body.id !== ''
      ? body.id
      : typeof body.alias === 'string' && body.alias !== ''
        ? body.alias
        : typeof body.path === 'string' ? body.path : ''
    const index = findRootIndex(existing, selector)
    if (index === -1) return { ok: false, error: 'no attached root matches that' }
    const kept = existing.filter((_root, position) => position !== index)
    await deps.store.write(workspace, kept)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'mode') {
    const mode = body.mode
    if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}` }
    const selector = typeof body.id === 'string' && body.id !== ''
      ? body.id
      : typeof body.alias === 'string' && body.alias !== ''
        ? body.alias
        : typeof body.path === 'string' ? body.path : ''
    const index = findRootIndex(existing, selector)
    if (index === -1) return { ok: false, error: 'no attached root matches that path' }
    existing[index] = { ...existing[index], mode }
    await deps.store.write(workspace, existing)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'alias') {
    const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
    const selector = typeof body.id === 'string' && body.id !== '' ? body.id : body.path
    if (alias === '') return { ok: false, error: 'alias needs a name' }
    const index = findRootIndex(existing, typeof selector === 'string' ? selector : '')
    if (index === -1) return { ok: false, error: 'no attached root matches that path' }
    if (existing.some((root, position) => position !== index && root.alias.toLowerCase() === alias.toLowerCase())) {
      return { ok: false, error: `another root already uses the alias "${alias}"` }
    }
    existing[index] = { ...existing[index], alias: aliasFor(alias) }
    await deps.store.write(workspace, existing)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'skills') {
    const selector = typeof body.id === 'string' && body.id !== ''
      ? body.id
      : typeof body.alias === 'string' && body.alias !== ''
        ? body.alias
        : typeof body.path === 'string' ? body.path : ''
    const index = findRootIndex(existing, selector)
    if (index === -1) return { ok: false, error: 'no attached root matches that' }
    const next = typeof body.skillsEnabled === 'boolean' ? body.skillsEnabled : existing[index].skillsEnabled !== true
    existing[index] = { ...existing[index], skillsEnabled: next }
    await deps.store.write(workspace, existing)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'namespace') {
    const aliasId = typeof body.aliasId === 'string' ? body.aliasId.trim() : ''
    const selector = typeof body.id === 'string' && body.id !== '' ? body.id : body.path
    if (aliasId === '') return { ok: false, error: 'namespace needs an aliasId' }
    const index = findRootIndex(existing, typeof selector === 'string' ? selector : '')
    if (index === -1) return { ok: false, error: 'no attached root matches that' }
    const folded = normaliseAliasId(aliasId, existing[index].alias)
    const clash = existing.some(
      (root, position) => position !== index
        && normaliseAliasId(root.aliasId ?? root.alias, root.alias) === folded,
    )
    if (clash) return { ok: false, error: `another root already uses the namespace "${folded}"` }
    existing[index] = { ...existing[index], aliasId: folded }
    await deps.store.write(workspace, existing)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'move') {
    const selector = typeof body.id === 'string' && body.id !== ''
      ? body.id
      : typeof body.alias === 'string' && body.alias !== ''
        ? body.alias
        : typeof body.path === 'string' ? body.path : ''
    const position = body.position === 'up' || body.position === 'down'
      ? body.position
      : Number(body.position)
    if (position !== 'up' && position !== 'down' && !Number.isInteger(position)) {
      return { ok: false, error: 'position must be "up", "down" or an integer index' }
    }
    const moved = moveRoot(existing, selector, position)
    if (!moved.ok) return { ok: false, error: moved.reason }
    await deps.store.write(workspace, moved.roots)
    await deps.snapshot.refresh()
    return buildState(deps, workspace)
  }

  if (action === 'reveal') {
    const selector = typeof body.id === 'string' && body.id !== ''
      ? body.id
      : typeof body.alias === 'string' && body.alias !== ''
        ? body.alias
        : typeof body.path === 'string' ? body.path : ''
    const index = findRootIndex(existing, selector)
    if (index === -1) return { ok: false, error: 'no attached root matches that' }
    const target = existing[index].path
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    try {
      const { spawn } = await import('node:child_process')
      spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch (error) {
      return { ok: false, error: `could not open the directory: ${describeError(error)}` }
    }
    return { ok: true, opened: target }
  }

  return { ok: false, error: `unknown action "${action}"` }
}

/**
 * Resolve `workspace` + `alias` query parameters to one declared root.
 *
 * Only roots the user declared are reachable: the route can read a repository
 * the user attached, never an arbitrary path on the machine.
 *
 * @param {RouteDeps} deps
 * @param {URL} url
 * @returns {Promise<{ ok: true, root: any, workspace: string } | { ok: false, status: number, error: string }>}
 */
async function resolveRoot(deps, url) {
  const workspace = url.searchParams.get('workspace') ?? ''
  const alias = (url.searchParams.get('alias') ?? '').trim().toLowerCase()
  if (workspace === '' || !isAbsolutePath(workspace)) {
    return { ok: false, status: 400, error: 'the request needs an absolute workspace path' }
  }
  if (alias === '') return { ok: false, status: 400, error: 'the request needs an alias' }
  const roots = sanitizeRoots(await deps.store.list(workspace))
  const root = roots.find((candidate) => candidate.alias.toLowerCase() === alias)
  if (root === undefined) return { ok: false, status: 404, error: `no root named "${alias}" is attached to that workspace` }
  return { ok: true, root, workspace }
}

/**
 * Register the read-only browsing routes for the panel.
 *
 * @param {any} ctx
 * @param {RouteDeps} deps
 * @param {any} webServer
 * @returns {number} how many routes were registered.
 */
function registerBrowseRoutes(ctx, deps, webServer) {
  let registered = 0

  const browseHandler = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    resolveRoot(deps, url).then(
      async (resolved) => {
        if (!resolved.ok) {
          respond(response, resolved.status, { ok: false, error: resolved.error })
          return
        }
        const listing = await listDirectory(resolved.root.path, url.searchParams.get('path') ?? '')
        respond(response, listing.ok ? 200 : 404, {
          ...listing,
          alias: resolved.root.alias,
          root: resolved.root.path,
        })
      },
      (error) => respond(response, 500, { ok: false, error: describeError(error) }),
    )
  }

  const fileHandler = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    resolveRoot(deps, url).then(
      async (resolved) => {
        if (!resolved.ok) {
          respond(response, resolved.status, { ok: false, error: resolved.error })
          return
        }
        const preview = await readTextFile(resolved.root.path, url.searchParams.get('path') ?? '')
        respond(response, preview.ok ? 200 : 404, {
          ...preview,
          alias: resolved.root.alias,
          root: resolved.root.path,
        })
      },
      (error) => respond(response, 500, { ok: false, error: describeError(error) }),
    )
  }

  for (const [path, handler] of [[BROWSE_ROUTE, browseHandler], [FILE_ROUTE, fileHandler]]) {
    try {
      const dispose = webServer.register({ kind: 'exact', path, handler })
      if (typeof dispose === 'function') ctx.effect(() => dispose)
      registered += 1
    } catch (error) {
      report(deps.logger, 'warn', `could not register ${path}: ${describeError(error)}`)
    }
  }
  return registered
}

/**
 * Register the state route on the host web server.
 *
 * @param {any} ctx - the plugin context.
 * @param {RouteDeps} deps
 * @param {object} [webServer] - an already-resolved web server, when the caller
 *   waited for the service itself (a scoped injection hands it over).
 * @returns {boolean} whether the route was registered.
 */
export function registerRoutes(ctx, deps, webServer) {
  webServer ??= service(ctx, 'webServer')
  if (typeof webServer?.register !== 'function') {
    report(deps.logger, 'info', 'no web server in this composition; the settings page is unavailable')
    return false
  }

  let origin
  try {
    origin = webServer.getOrigin?.()
  } catch {
    origin = undefined
  }

  const handler = (request, response) => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const sessionId = (url.searchParams.get('session') ?? '').trim()
    if (method === 'GET') {
      buildState(deps, undefined, sessionId).then(
        (state) => respond(response, 200, state),
        (error) => respond(response, 500, { ok: false, error: describeError(error) }),
      )
      return
    }
    if (method !== 'POST') {
      respond(response, 405, { ok: false, error: 'only GET and POST are supported' })
      return
    }
    if (!sameOrigin(request, origin)) {
      respond(response, 403, { ok: false, error: 'cross-origin writes are refused' })
      return
    }
    readBody(request).then(
      (body) => mutate(deps, body).then(
        (result) => respond(response, 200, result),
        (error) => respond(response, 500, { ok: false, error: describeError(error) }),
      ),
      (error) => respond(response, 400, { ok: false, error: describeError(error) }),
    )
  }

  let stateRegistered = false
  try {
    const dispose = webServer.register({ kind: 'exact', path: STATE_ROUTE, handler })
    if (typeof dispose === 'function') ctx.effect(() => dispose)
    stateRegistered = true
  } catch (error) {
    report(deps.logger, 'warn', `could not register ${STATE_ROUTE}: ${describeError(error)}`)
  }

  const browseRegistered = registerBrowseRoutes(ctx, deps, webServer)
  return stateRegistered || browseRegistered > 0
}
