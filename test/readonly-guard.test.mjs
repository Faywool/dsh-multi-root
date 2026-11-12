import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReadOnlyGuard, installReadOnlyGuard } from '../src/readonly-guard.js'

const readonlyRoot = { alias: 'legacy', path: 'C:\\work\\legacy', mode: 'readonly', workspace: 'C:\\ws' }
const writableRoot = { alias: 'api', path: 'C:\\work\\api', mode: 'readwrite', workspace: 'C:\\ws' }

function guardFor(roots) {
  return createReadOnlyGuard({
    snapshot: {
      allRoots: () => roots,
      rootsOf: () => roots,
      gitStatus: () => undefined,
      commandsOf: () => undefined,
    },
  })
}

test('a write into a readonly root is refused with a way out', () => {
  const guard = guardFor([readonlyRoot, writableRoot])
  const verdict = guard({ name: 'write', arguments: { path: 'C:\\work\\legacy\\src\\a.cs', content: 'x' } })
  assert.equal(typeof verdict, 'string')
  assert.match(verdict, /readonly root "legacy"/)
  assert.match(verdict, /\/multi-root mode legacy readwrite/)
})

test('a write into a writable root passes', () => {
  const guard = guardFor([readonlyRoot, writableRoot])
  assert.equal(guard({ name: 'edit', arguments: { path: 'C:\\work\\api\\src\\a.cs' } }), undefined)
})

test('reads and unrelated tools are never blocked', () => {
  const guard = guardFor([readonlyRoot])
  assert.equal(guard({ name: 'read', arguments: { path: 'C:\\work\\legacy\\a.cs' } }), undefined)
  assert.equal(guard({ name: 'workspace_git', arguments: { action: 'status' } }), undefined)
})

test('paths nested in arrays and objects are found', () => {
  const guard = guardFor([readonlyRoot])
  const verdict = guard({
    name: 'apply_patch',
    arguments: { patch: { files: [{ target: 'C:\\work\\legacy\\b.cs' }], note: 'ok' } },
  })
  assert.match(String(verdict), /readonly root "legacy"/)
})

test('relative or unparseable arguments fail open', () => {
  const guard = guardFor([readonlyRoot])
  assert.equal(guard({ name: 'write', arguments: { path: 'src/a.cs' } }), undefined)
  assert.equal(guard({ name: 'write', arguments: {} }), undefined)
  assert.equal(guard({ name: 'write' }), undefined)
})

test('a root with the same name is matched case-insensitively', () => {
  const guard = guardFor([readonlyRoot])
  assert.match(String(guard({ name: 'write', arguments: { path: 'c:/WORK/Legacy/x.txt' } })), /readonly/)
})

test('a guard never throws, even on hostile input', () => {
  const guard = createReadOnlyGuard({
    snapshot: {
      get allRoots() {
        throw new Error('boom')
      },
    },
  })
  assert.equal(guard({ name: 'write', arguments: { path: 'C:\\work\\legacy\\a.cs' } }), undefined)
})

test('installation goes through a scoped tools injection when available', () => {
  let injected = false
  let registered = false
  const ctx = {
    inject(services, callback) {
      injected = services.includes('tools')
      callback({ tools: { guard: () => { registered = true } } })
    },
  }
  const ok = installReadOnlyGuard({ ctx, snapshot: { allRoots: () => [] } })
  assert.equal(ok, true)
  assert.equal(injected, true)
  assert.equal(registered, true)
})

test('installation without tools reports failure instead of throwing', () => {
  assert.equal(installReadOnlyGuard({ ctx: { get: () => undefined }, snapshot: {} }), false)
  assert.equal(installReadOnlyGuard({ ctx: {}, snapshot: {} }), false)
})
