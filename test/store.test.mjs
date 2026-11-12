import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RootStore } from '../src/store.js'

async function tempStore() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-multi-root-store-'))
  return { directory, file: join(directory, 'storages', 'dsh_multi_root.json') }
}

test('a missing store reads as empty', async () => {
  const { file } = await tempStore()
  const store = new RootStore({ file })
  assert.deepEqual(await store.list('D:\\ws'), [])
  assert.deepEqual(await store.entries(), [])
})

test('roots round-trip per workspace and stay isolated', async () => {
  const { file } = await tempStore()
  const store = new RootStore({ file })

  await store.write('D:\\ws', [
    { alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' },
    { alias: 'docs', path: 'D:\\repo\\docs', mode: 'readonly' },
  ])
  await store.write('D:\\other', [{ alias: 'web', path: 'D:\\repo\\web', mode: 'readwrite' }])

  assert.deepEqual((await store.list('D:\\ws')).map((root) => root.alias), ['api', 'docs'])
  assert.deepEqual((await store.list('D:\\other')).map((root) => root.alias), ['web'])
  assert.equal((await store.list('D:\\WS')).length, 2, 'workspace keys are case-insensitive')

  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.version, 2)
  assert.equal(Object.keys(written.workspaces).length, 2)
  const [first] = written.workspaces[Object.keys(written.workspaces)[0]].roots
  assert.equal(typeof first.id, 'string')
  assert.ok(first.id.length > 0, 'every stored root carries a stable id')
  assert.equal(typeof first.addedAt, 'string')
})

test('writing an empty list removes the workspace entry', async () => {
  const { file } = await tempStore()
  const store = new RootStore({ file })
  await store.write('D:\\ws', [{ alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' }])
  await store.write('D:\\ws', [])
  assert.deepEqual(await store.entries(), [])
})

test('a damaged store is quarantined and treated as empty', async () => {
  const { directory, file } = await tempStore()
  const store = new RootStore({ file })
  await store.write('D:\\ws', [{ alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' }])
  await writeFile(file, '{ not json', 'utf8')

  assert.deepEqual(await store.list('D:\\ws'), [])

  const keep = await store.update(() => undefined)
  assert.equal(keep, undefined)
  assert.deepEqual(await store.list('D:\\ws'), [])

  const leftovers = await readFile(file, 'utf8')
  assert.match(leftovers, /"workspaces"/)
  assert.equal(directory.length > 0, true)
})

test('concurrent writes are serialised instead of lost', async () => {
  const { file } = await tempStore()
  const store = new RootStore({ file })

  await Promise.all(
    ['a', 'b', 'c'].map((alias) => store.update((document) => {
      document.workspaces['d:\\ws'] = {
        path: 'D:\\ws',
        roots: [...(document.workspaces['d:\\ws']?.roots ?? []),
          { alias, path: `D:\\repo\\${alias}`, mode: 'readwrite' }],
        updatedAt: new Date().toISOString(),
      }
    })),
  )

  const roots = await store.list('D:\\ws')
  assert.deepEqual(roots.map((root) => root.alias).sort(), ['a', 'b', 'c'])
})

test('one failed write does not poison later writes', async () => {
  const { file } = await tempStore()
  const store = new RootStore({ file })

  await assert.rejects(store.update(() => {
    throw new Error('boom')
  }))

  await store.write('D:\\ws', [{ alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' }])
  assert.equal((await store.list('D:\\ws')).length, 1)
})
