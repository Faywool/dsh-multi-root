import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BROWSE_ROUTE, FILE_ROUTE, STATE_ROUTE, registerRoutes } from '../src/routes.js'
import { RootStore } from '../src/store.js'
import { resolveConfig } from '../src/config.js'

const WORKSPACE = 'D:\\work\\api'

/**
 * A response stand-in that records what the handler wrote.
 */
function makeResponse() {
  const record = { status: 0, headers: undefined, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(payload) {
      record.body = payload
    },
  }
}

/**
 * A request stand-in. `url` defaults to the state route so most tests can omit it.
 */
function makeRequest(method, body, options = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = options.headers ?? {}
  request.url = options.url ?? STATE_ROUTE
  const payload = options.raw !== undefined
    ? options.raw
    : body === undefined ? undefined : JSON.stringify(body)
  setImmediate(() => {
    if (payload !== undefined) request.emit('data', Buffer.from(payload))
    request.emit('end')
  })
  return request
}

/**
 * A context whose web server records each route by path.
 */
function makeContext(handlerBox, services = {}) {
  handlerBox.routes = {}
  return {
    effect(dispose) {
      assert.equal(typeof dispose, 'function')
    },
    get(name) {
      if (services[name] !== undefined) return services[name]
      if (name !== 'webServer') return undefined
      return {
        getOrigin: () => 'http://127.0.0.1:1',
        register(definition) {
          handlerBox.routes[definition.path] = definition
          return () => {}
        },
      }
    },
    logger: { warn() {}, info() {} },
  }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-multi-root-routes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'README.md'), '# repo\n\nhello\n', 'utf8')
  const store = new RootStore({ file: join(dir, 'store.json'), logger: { warn() {} } })
  const snapshot = {
    gitStatus: () => ({ branch: 'main', dirty: true }),
    async refresh() {},
  }
  return { dir, repo, store, snapshot }
}

/**
 * Drive one handler to completion and parse its answer.
 */
async function call(handler, method, body, options) {
  const response = makeResponse()
  try {
    handler(makeRequest(method, body, options), response)
  } catch (error) {
    console.error('HANDLER THREW', error)
  }
  // The handler answers asynchronously, after real filesystem work; poll briefly.
  for (let i = 0; i < 200 && response.record.body === ''; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (response.record.body === '') console.error('NO ANSWER', method, response.record.status)
  return { status: response.record.status, body: JSON.parse(response.record.body || '{}') }
}

function route(box, path) {
  const definition = box.routes[path]
  assert.ok(definition, `the route ${path} is registered`)
  assert.equal(definition.kind, 'exact')
  return definition.handler
}

function deps(store, snapshot, extra = {}) {
  return {
    store,
    snapshot,
    config: resolveConfig(undefined),
    logger: { warn() {}, info() {} },
    ctx: extra.ctx,
    currentDirectory: extra.currentDirectory,
  }
}

test('registerRoutes answers false when the composition has no web server', () => {
  const ctx = { effect() {}, get: () => undefined, logger: { info() {} } }
  assert.equal(registerRoutes(ctx, { store: {}, snapshot: {}, logger: {} }), false)
})

test('the state route lists roots with git state and live config', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  const ctx = makeContext(box)
  assert.equal(registerRoutes(ctx, deps(store, snapshot)), true)

  const answer = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.workspaces.length, 1)
  assert.equal(answer.body.workspaces[0].roots[0].alias, 'repo')
  assert.deepEqual(answer.body.workspaces[0].roots[0].git, { branch: 'main', dirty: true })
  assert.equal(answer.body.config.maxRoots, 16)
})

test('the state route reads the configuration on every request', async (t) => {
  const { store, snapshot } = await fixture(t)
  const box = {}
  let maxRoots = 4
  const ctx = makeContext(box)
  registerRoutes(ctx, {
    store,
    snapshot,
    config: () => ({ ...resolveConfig(undefined), maxRoots }),
    logger: {},
  })
  const first = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(first.body.config.maxRoots, 4)
  maxRoots = 9
  const second = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(second.body.config.maxRoots, 9)
})

test('the state route offers every registered workspace, even without roots', async (t) => {
  const { dir, store, snapshot } = await fixture(t)
  const box = {}
  const other = join(dir, 'elsewhere')
  const registry = { list: () => [{ path: WORKSPACE }, { path: other, title: 'Elsewhere' }] }
  const ctx = makeContext(box, { workspaceRegistry: registry })
  registerRoutes(ctx, deps(store, snapshot, { ctx }))

  const answer = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body.workspaces.map((item) => item.path), [WORKSPACE, other])
  assert.equal(answer.body.workspaces[1].roots.length, 0)
  assert.equal(answer.body.workspaces[1].title, 'Elsewhere')
  assert.equal(answer.body.workspaces[0].roots.length, 0)
})

test('the state route reports the workspace that holds the newest session', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  const box = {}
  const registry = { list: () => [{ path: WORKSPACE }, { path: repo }] }
  const ctx = makeContext(box, { workspaceRegistry: registry })
  registerRoutes(ctx, deps(store, snapshot, {
    ctx,
    currentDirectory: () => join(repo, 'src'),
  }))

  const answer = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(answer.body.current.path, repo)
})

test('the state route still answers when the registry is unavailable', async (t) => {
  const { store, snapshot } = await fixture(t)
  const box = {}
  const ctx = makeContext(box)
  registerRoutes(ctx, deps(store, snapshot, { ctx }))

  const answer = await call(route(box, STATE_ROUTE), 'GET')
  assert.equal(answer.status, 200)
  assert.equal(answer.body.current, undefined)
})

test('POST attach mounts a directory and answers with the new state', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))

  const answer = await call(route(box, STATE_ROUTE), 'POST', {
    action: 'attach',
    workspace: WORKSPACE,
    path: repo,
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.workspaces[0].roots.length, 1)
  assert.equal(answer.body.workspaces[0].roots[0].alias, 'repo')
  assert.equal((await store.list(WORKSPACE)).length, 1)
})

test('POST attach refuses the workspace directory itself', async (t) => {
  const { store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const answer = await call(route(box, STATE_ROUTE), 'POST', {
    action: 'attach',
    workspace: WORKSPACE,
    path: WORKSPACE,
  })
  assert.equal(answer.body.ok, false)
  assert.match(answer.body.error, /workspace directory itself/)
})

test('POST detach removes the root again', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))

  const answer = await call(route(box, STATE_ROUTE), 'POST', {
    action: 'detach',
    workspace: WORKSPACE,
    alias: 'repo',
  })
  assert.equal(answer.body.ok, true)
  assert.equal((await store.list(WORKSPACE)).length, 0)
})

test('POST mode flips one root and rejects an unknown mode', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const handler = route(box, STATE_ROUTE)

  const flipped = await call(handler, 'POST', { action: 'mode', workspace: WORKSPACE, path: repo, mode: 'readonly' })
  assert.equal(flipped.body.ok, true)
  assert.equal(flipped.body.workspaces[0].roots[0].mode, 'readonly')

  const rejected = await call(handler, 'POST', { action: 'mode', workspace: WORKSPACE, path: repo, mode: 'nope' })
  assert.equal(rejected.body.ok, false)
  assert.match(rejected.body.error, /mode must be one of/)
})

test('POST search turns content search off and the state reports it', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const handler = route(box, STATE_ROUTE)

  const before = await call(handler, 'GET')
  assert.equal(before.body.workspaces[0].searchEnabled, true, 'content search starts on')

  const off = await call(handler, 'POST', { action: 'search', workspace: WORKSPACE, enabled: false })
  assert.equal(off.body.ok, true)
  assert.equal(off.body.workspaces[0].searchEnabled, false, 'the mutation answers with fresh state')
  assert.equal(await store.searchEnabled(WORKSPACE), false, 'and it persisted')

  const on = await call(handler, 'POST', { action: 'search', workspace: WORKSPACE, enabled: true })
  assert.equal(on.body.workspaces[0].searchEnabled, true)
  assert.equal((await call(handler, 'GET')).body.workspaces[0].searchEnabled, true)
})

test('a cross-origin write is refused and changes nothing', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))

  const answer = await call(route(box, STATE_ROUTE), 'POST', {
    action: 'attach',
    workspace: WORKSPACE,
    path: repo,
  }, { headers: { origin: 'http://evil.example' } })
  assert.equal(answer.status, 403)
  assert.equal(answer.body.ok, false)
  assert.equal((await store.list(WORKSPACE)).length, 0)
})

test('a same-origin write is accepted', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const answer = await call(route(box, STATE_ROUTE), 'POST', {
    action: 'attach',
    workspace: WORKSPACE,
    path: repo,
  }, { headers: { origin: 'http://127.0.0.1:1' } })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
})

test('a malformed body is a bad request, not a crash', async (t) => {
  const { store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const answer = await call(route(box, STATE_ROUTE), 'POST', undefined, { raw: '{not json' })
  assert.equal(answer.status, 400)
  assert.equal(answer.body.ok, false)
  assert.match(answer.body.error, /invalid JSON/)
})

test('methods other than GET and POST are refused', async (t) => {
  const { store, snapshot } = await fixture(t)
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const answer = await call(route(box, STATE_ROUTE), 'DELETE')
  assert.equal(answer.status, 405)
})

test('the browse route lists a declared root only', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))

  const query = `?workspace=${encodeURIComponent(WORKSPACE)}&alias=repo`
  const listed = await call(route(box, BROWSE_ROUTE), 'GET', undefined, { url: BROWSE_ROUTE + query })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.ok, true)
  const names = listed.body.entries.map((entry) => entry.name)
  assert.ok(names.includes('src'))
  assert.ok(names.includes('README.md'))

  const unknown = await call(route(box, BROWSE_ROUTE), 'GET', undefined, {
    url: `${BROWSE_ROUTE}?workspace=${encodeURIComponent(WORKSPACE)}&alias=nothing`,
  })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /no root named/)
})

test('the browse route refuses to leave the root', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))
  const answer = await call(route(box, BROWSE_ROUTE), 'GET', undefined, {
    url: `${BROWSE_ROUTE}?workspace=${encodeURIComponent(WORKSPACE)}&alias=repo&path=../../..`,
  })
  assert.equal(answer.status, 404)
  assert.equal(answer.body.ok, false)
  assert.match(answer.body.reason, /outside the root/)
})

test('the file route returns text and marks what it cannot show', async (t) => {
  const { repo, store, snapshot } = await fixture(t)
  await store.write(WORKSPACE, [{ alias: 'repo', path: repo, mode: 'readwrite' }])
  const box = {}
  registerRoutes(makeContext(box), deps(store, snapshot))

  const read = await call(route(box, FILE_ROUTE), 'GET', undefined, {
    url: `${FILE_ROUTE}?workspace=${encodeURIComponent(WORKSPACE)}&alias=repo&path=README.md`,
  })
  assert.equal(read.status, 200)
  assert.equal(read.body.ok, true)
  assert.match(read.body.text, /hello/)
  assert.equal(read.body.binary, false)

  const outside = await call(route(box, FILE_ROUTE), 'GET', undefined, {
    url: `${FILE_ROUTE}?workspace=${encodeURIComponent(WORKSPACE)}&alias=repo&path=../secret.txt`,
  })
  assert.equal(outside.status, 404)
  assert.match(outside.body.reason, /outside the root/)
})
