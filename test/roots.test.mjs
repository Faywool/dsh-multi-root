import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aliasFor,
  findRootIndex,
  normalizeRoot,
  planAttach,
  sanitizeRoots,
  uniqueAlias,
} from '../src/roots.js'

test('aliasFor folds a directory name into a usable label', () => {
  assert.equal(aliasFor('D:\\work\\my_service'), 'my_service')
  assert.equal(aliasFor('D:\\repo\\v1.2_legacy'), 'v1.2_legacy')
  assert.equal(aliasFor('D:\\repo\\my repo -- two'), 'my-repo-two')
  assert.equal(aliasFor('D:\\'), 'd')
  assert.equal(aliasFor('D:\\repo\\数据目录'), '数据目录')
})

test('uniqueAlias never hands out a taken label', () => {
  const taken = [{ alias: 'backend' }, { alias: 'backend-2' }]
  assert.equal(uniqueAlias('frontend', taken), 'frontend')
  assert.equal(uniqueAlias('Backend', taken), 'Backend-3', 'the requested spelling is preserved')
})

test('normalizeRoot accepts absolute directories and rejects the rest', () => {
  const ok = normalizeRoot({ path: 'D:\\repo\\api\\' })
  assert.equal(ok.ok, true)
  assert.equal(ok.root.path, 'D:\\repo\\api')
  assert.equal(ok.root.mode, 'readwrite')

  assert.equal(normalizeRoot({ path: 'repo/api' }).ok, false)
  assert.equal(normalizeRoot({ path: '' }).ok, false)
  assert.equal(normalizeRoot({ path: 'D:\\repo\\api', mode: 'write' }).ok, false)
})

test('normalizeRoot de-duplicates an alias against existing roots', () => {
  const result = normalizeRoot({ path: 'D:\\repo\\api', alias: 'api' }, [{ alias: 'api' }])
  assert.equal(result.ok, true)
  assert.equal(result.root.alias, 'api-2')
})

test('planAttach appends, updates in place and honours the cap', () => {
  const existing = [{ alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' }]
  const incoming = [
    { alias: 'api', path: 'D:\\repo\\api', mode: 'readonly' },
    { alias: 'web', path: 'D:\\repo\\web', mode: 'readwrite' },
  ]

  const plan = planAttach(existing, incoming, 4)
  assert.deepEqual(plan.added, ['web'])
  assert.deepEqual(plan.replaced, ['api'])
  assert.equal(plan.roots.length, 2)
  assert.equal(plan.roots[0].mode, 'readonly')

  const capped = planAttach(existing, incoming, 1)
  assert.equal(capped.roots.length, 1)
  assert.equal(capped.skipped.length, 1)
  assert.match(capped.skipped[0].reason, /maxRoots \(1\)/)
})

test('planAttach collapses duplicates inside one request', () => {
  const plan = planAttach([], [
    { alias: 'one', path: 'D:\\repo\\api', mode: 'readwrite' },
    { alias: 'two', path: 'D:\\Repo\\API', mode: 'readonly' },
  ], 16)
  assert.equal(plan.roots.length, 1)
  assert.equal(plan.roots[0].alias, 'two')
})

test('sanitizeRoots drops malformed and duplicate entries', () => {
  const roots = sanitizeRoots([
    { alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' },
    { alias: 'api', path: 'd:\\repo\\API', mode: 'readwrite' },
    { alias: 'relative', path: 'repo/web', mode: 'readwrite' },
    { alias: 'bad-mode', path: 'D:\\repo\\git', mode: 'execute' },
    null,
  ])
  assert.equal(roots.length, 2)
  assert.equal(roots[0].alias, 'api')
  assert.equal(roots[1].alias, 'bad-mode')
  assert.equal(roots[1].mode, 'readwrite')
})

test('findRootIndex resolves by alias and by path, ignoring case and separators', () => {
  const roots = [
    { alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' },
    { alias: 'web', path: 'D:\\repo\\web', mode: 'readwrite' },
  ]
  assert.equal(findRootIndex(roots, 'API'), 0)
  assert.equal(findRootIndex(roots, 'D:/REPO/WEB'), 1)
  assert.equal(findRootIndex(roots, 'nope'), -1)
  assert.equal(findRootIndex(roots, ''), -1)
})
