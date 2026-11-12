import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootStore } from '../src/store.js'
import { RootSnapshot } from '../src/snapshot.js'
import { createRootsTool, commonParent } from '../src/tool.js'
import { resolveConfig } from '../src/config.js'

/** A context stub: no services, so every optional lookup degrades. */
const CTX = {
  logger: { warn() {}, info() {} },
  get() { return undefined },
  effect() {},
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-multi-root-tool-'))
  const workspace = join(base, 'workspace')
  const api = join(base, 'repo-api')
  const docs = join(base, 'repo-docs')
  await mkdir(workspace, { recursive: true })
  await mkdir(api, { recursive: true })
  await mkdir(docs, { recursive: true })
  const store = new RootStore({ file: join(base, 'storages', 'dsh_multi_root.json') })
  const snapshot = new RootSnapshot({ store })
  const tool = createRootsTool({
    ctx: CTX,
    store,
    snapshot,
    configOf: () => resolveConfig(undefined),
  })
  const exec = { agent: { session: { header: { cwd: workspace } } } }
  const call = (args) => tool.execute(args, exec)
  return { base, workspace, api, docs, store, snapshot, tool, call }
}

test('the tool is a plain definition with a string output', async () => {
  const { tool } = await fixture()
  assert.equal(tool.name, 'workspace_roots')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.properties.action.type, 'string')
  assert.deepEqual(tool.output.render(undefined, 'x'), [{ type: 'text', text: 'x' }])
})

test('list on a clean workspace explains how to start', async () => {
  const { call } = await fixture()
  const text = await call({ action: 'list' })
  assert.match(text, /No additional roots are attached/)
  assert.match(text, /action "attach"/)
})

test('attach, list and detach round-trip through the store', async () => {
  const { call, api, docs, store, workspace } = await fixture()

  const attached = await call({ action: 'attach', paths: [api, docs] })
  assert.match(attached, /Attached: repo-api, repo-docs/)
  assert.match(attached, /Attached workspace roots/)

  const listed = await call({ action: 'list' })
  assert.match(listed, /repo-api/)
  assert.match(listed, /repo-docs/)

  assert.deepEqual((await store.list(workspace)).map((root) => root.alias), ['repo-api', 'repo-docs'])

  const detached = await call({ action: 'detach', path: 'repo-api' })
  assert.match(detached, /Detached repo-api/)
  assert.deepEqual((await store.list(workspace)).map((root) => root.alias), ['repo-docs'])
})

test('re-attaching the same path updates it instead of duplicating', async () => {
  const { call, api, store, workspace } = await fixture()
  await call({ action: 'attach', paths: [api] })
  const second = await call({ action: 'attach', paths: [api], mode: 'readonly' })
  assert.match(second, /Updated: repo-api/)
  const roots = await store.list(workspace)
  assert.equal(roots.length, 1)
  assert.equal(roots[0].mode, 'readonly')
})

test('a single attach accepts an explicit alias', async () => {
  const { call, store, workspace, api } = await fixture()
  await call({ action: 'attach', paths: [api], alias: 'backend' })
  assert.deepEqual((await store.list(workspace)).map((root) => root.alias), ['backend'])
})

test('bad paths are reported and nothing is written', async () => {
  const { call, store, workspace, base } = await fixture()
  const missing = join(base, 'nope')
  const text = await call({ action: 'attach', paths: [missing] })
  assert.match(text, /Nothing was attached/)
  assert.match(text, /cannot access it/)
  assert.deepEqual(await store.list(workspace), [])

  const relative = await call({ action: 'attach', paths: ['repo/api'] })
  assert.match(relative, /path must be absolute/)
})

test('the workspace itself cannot be attached as a root', async () => {
  const { call, workspace } = await fixture()
  const text = await call({ action: 'attach', paths: [workspace] })
  assert.match(text, /primary workspace directory/)
})

test('detach without a selector explains the options', async () => {
  const { call, api } = await fixture()
  await call({ action: 'attach', paths: [api] })
  const text = await call({ action: 'detach' })
  assert.match(text, /needs `target`/)
})

test('detach all clears the workspace', async () => {
  const { call, api, docs, store, workspace } = await fixture()
  await call({ action: 'attach', paths: [api, docs] })
  const text = await call({ action: 'detach', all: true })
  assert.match(text, /Detached all 2 root/)
  assert.deepEqual(await store.list(workspace), [])
})

test('an unknown action is reported, not thrown', async () => {
  const { call } = await fixture()
  assert.match(await call({ action: 'nope' }), /Unknown action/)
})

test('a call with no session directory explains itself', async () => {
  const { tool } = await fixture()
  const text = await tool.execute({ action: 'list' }, {})
  assert.match(text, /Cannot determine the workspace directory/)
})

test('import adopts the legacy store once, deduplicated', async () => {
  const { base, workspace, store } = await fixture()
  const home = join(base, 'home')
  await mkdir(join(home, 'storages'), { recursive: true })
  const apiPath = join(base, 'repo-api')
  const docsPath = join(base, 'repo-docs')
  const legacy = {
    tables: {
      roots: {
        'D:\\ws': { roots: [{ path: apiPath, aliasId: 'backend' }, { path: docsPath, aliasId: 'docs' }] },
        'd:\\ws': { roots: [{ path: apiPath, aliasId: 'backend' }, { path: docsPath, aliasId: 'docs' }] },
      },
    },
  }
  await writeFile(join(home, 'storages', 'multi_root_workspace.json'), JSON.stringify(legacy), 'utf8')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const tool = createRootsTool({
      ctx: CTX,
      store,
      snapshot: new RootSnapshot({ store }),
      configOf: () => resolveConfig(undefined),
    })
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    const text = await tool.execute({ action: 'import' }, exec)
    assert.match(text, /Imported 2 root/)
    assert.match(text, /share the parent directory/)
    assert.deepEqual((await store.list(workspace)).map((root) => root.alias), ['backend', 'docs'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('import without a legacy store says so', async () => {
  const { call, base } = await fixture()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(base, 'empty-home')
  try {
    const text = await call({ action: 'import' })
    assert.match(text, /No legacy store found/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('commonParent finds the shared directory, including a drive root', () => {
  assert.equal(commonParent(['D:\\a\\b\\c', 'D:\\a\\b\\d']), 'D:\\a\\b')
  assert.equal(commonParent(['D:\\a\\b']), 'D:\\a')
  assert.equal(commonParent(['D:\\a', 'E:\\a']), undefined)
  assert.equal(commonParent([]), undefined)
})

test('roots keep their ids when renamed, re-moded and reordered', async () => {
  const { call, api, docs, store, workspace } = await fixture()
  await call({ action: 'attach', paths: [api, docs] })
  const before = await store.list(workspace)
  const apiId = before[0].id
  const docsId = before[1].id

  const renamed = await call({ action: 'rename', target: apiId, newAlias: 'backend' })
  assert.match(renamed, /backend/)

  const moded = await call({ action: 'mode', target: apiId, mode: 'readonly' })
  assert.match(moded, /readonly/)

  const skilled = await call({ action: 'skills', target: apiId, skillsEnabled: true })
  assert.match(skilled, /skills/i)

  const moved = await call({ action: 'move', target: docsId, position: 'up' })
  assert.match(moved, /position 1/)

  const after = await store.list(workspace)
  assert.deepEqual(after.map((root) => root.alias), ['repo-docs', 'backend'])
  assert.deepEqual(after.map((root) => root.id), [docsId, apiId], 'ids never change on edit')
  assert.equal(after[1].mode, 'readonly')
  assert.equal(after[1].skillsEnabled, true)

  const detached = await call({ action: 'detach', target: apiId })
  assert.match(detached, /Detached backend/)
  assert.deepEqual((await store.list(workspace)).map((root) => root.id), [docsId])
})

test('the same alias cannot be handed to two roots', async () => {
  const { call, api, docs, workspace, store } = await fixture()
  await call({ action: 'attach', paths: [api], alias: 'shared' })
  const second = await call({ action: 'attach', paths: [docs], alias: 'shared' })
  assert.match(second, /Attached: shared-2/)
  const roots = await store.list(workspace)
  assert.equal(roots.length, 2)
  assert.notEqual(roots[0].alias, roots[1].alias)
  assert.notEqual(roots[0].id, roots[1].id)
})

test('an unknown target is explained, not thrown', async () => {
  const { call } = await fixture()
  const text = await call({ action: 'rename', target: 'nope', newAlias: 'x' })
  assert.match(text, /No attached root matches|no attached root/i)
})

test('the skill namespace is set per root and must not collide', async () => {
  const { call, api, docs, workspace, store } = await fixture()
  await call({ action: 'attach', paths: [api, docs] })
  const roots = await store.list(workspace)
  assert.equal(roots[0].aliasId, 'repo-api', 'the namespace defaults to the alias')
  assert.equal(roots[1].aliasId, 'repo-docs')

  const renamed = await call({ action: 'namespace', target: roots[0].id, aliasId: 'backend' })
  assert.match(renamed, /Skill namespace of repo-api is now backend/)
  assert.equal((await store.list(workspace))[0].aliasId, 'backend')

  const clash = await call({ action: 'namespace', target: roots[1].id, aliasId: 'backend' })
  assert.match(clash, /already uses the namespace "backend"/)
})
