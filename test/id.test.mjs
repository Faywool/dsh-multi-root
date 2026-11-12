import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  findRootIndex,
  moveRoot,
  normalizeRoot,
  planAttach,
  sanitizeRoots,
} from '../src/roots.js'

test('every accepted root carries a stable id and a timestamp', () => {
  const result = normalizeRoot({ path: 'D:\\repo\\api' })
  assert.equal(result.ok, true)
  assert.equal(typeof result.root.id, 'string')
  assert.ok(result.root.id.length > 0)
  assert.equal(typeof result.root.addedAt, 'string')
  assert.equal(Number.isNaN(Date.parse(result.root.addedAt)), false)

  const again = normalizeRoot({ path: 'D:\\repo\\api' })
  assert.notEqual(again.root.id, result.root.id, 'a fresh attach gets a fresh id')
})

test('re-attaching the same path keeps the id it already had', () => {
  const first = normalizeRoot({ path: 'D:\\repo\\api' })
  const kept = normalizeRoot({ path: 'D:\\repo\\api' }, [], { id: first.root.id, addedAt: first.root.addedAt })
  assert.equal(kept.root.id, first.root.id)
  assert.equal(kept.root.addedAt, first.root.addedAt)
})

test('a root is addressed by id before alias or path', () => {
  const roots = [
    { id: 'r1', alias: 'api', path: 'D:\\repo\\api' },
    { id: 'r2', alias: 'docs', path: 'D:\\repo\\docs' },
  ]
  assert.equal(findRootIndex(roots, 'r2'), 1)
  assert.equal(findRootIndex(roots, 'DOCS'), 1, 'alias matching stays case-insensitive')
  assert.equal(findRootIndex(roots, 'D:/REPO/API'), 0)
  assert.equal(findRootIndex(roots, 'missing'), -1)
})

test('a colliding alias is folded instead of refused', () => {
  const taken = [{ id: 'r1', alias: 'api', path: 'D:\\repo\\api' }]
  const result = normalizeRoot({ path: 'D:\\repo\\other', alias: 'api' }, taken)
  assert.equal(result.ok, true)
  assert.equal(result.root.alias, 'api-2')
  assert.notEqual(result.root.id, 'r1')
})

test('moveRoot reorders by id, alias or path and refuses out-of-range targets', () => {
  const roots = [
    { id: 'r1', alias: 'api', path: 'D:\\repo\\api' },
    { id: 'r2', alias: 'docs', path: 'D:\\repo\\docs' },
    { id: 'r3', alias: 'web', path: 'D:\\repo\\web' },
  ]
  const down = moveRoot(roots, 'r1', 'down')
  assert.deepEqual(down.roots.map((root) => root.id), ['r2', 'r1', 'r3'])
  assert.equal(down.index, 1)

  const up = moveRoot(roots, 'docs', 'up')
  assert.deepEqual(up.roots.map((root) => root.id), ['r2', 'r1', 'r3'])

  const toLast = moveRoot(roots, 'D:\\repo\\api', 2)
  assert.deepEqual(toLast.roots.map((root) => root.id), ['r2', 'r3', 'r1'])
  assert.equal(toLast.index, 2)

  const past = moveRoot(roots, 'api', 99)
  assert.equal(past.ok, false)
  assert.match(past.reason, /position/)

  const first = moveRoot(roots, 'r1', 'up')
  assert.equal(first.ok, false, 'moving the first root up is refused')

  const unknown = moveRoot(roots, 'nope', 'up')
  assert.equal(unknown.ok, false)
})

test('planAttach keeps ids, replaces in place and caps the list', () => {
  const existing = [{ id: 'r1', alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite', addedAt: 'now' }]
  const incoming = normalizeRoot({ path: 'D:\\REPO\\api', mode: 'readonly' })
  const plan = planAttach(existing, [incoming.root], 4)
  assert.equal(plan.roots.length, 1)
  assert.equal(plan.replaced.length, 1)
  assert.equal(plan.roots[0].id, 'r1', 'the id survives a mode change')
  assert.equal(plan.roots[0].mode, 'readonly')

  const capped = planAttach([], Array.from({ length: 5 }, (_item, index) => (
    normalizeRoot({ path: `D:\\repo\\r${index}` }).root
  )), 3)
  assert.equal(capped.roots.length, 3)
  assert.equal(capped.skipped.length, 2)
})

test('sanitizeRoots mints missing ids and drops duplicate paths', () => {
  const cleaned = sanitizeRoots([
    { alias: 'api', path: 'D:\\repo\\api' },
    { alias: 'api-2', path: 'D:\\repo\\api' },
    { id: 'dup', alias: 'docs', path: 'D:\\repo\\docs' },
    { id: 'dup', alias: 'web', path: 'D:\\repo\\web' },
  ])
  assert.equal(cleaned.length, 3, 'the repeated path is dropped, the repeated id is reissued')
  assert.equal(typeof cleaned[0].id, 'string')
  assert.notEqual(cleaned[1].id, cleaned[2].id, 'a duplicated id is replaced by a fresh one')
})

test('sanitizeRoots leaves a clean list byte-for-byte alone', () => {
  const roots = [{ id: 'r1', alias: 'api', aliasId: 'api', path: 'D:\\repo\\api', mode: 'readonly', skillsEnabled: true, addedAt: 'now' }]
  assert.deepEqual(sanitizeRoots(roots), roots)
})

test('a skill directory is read from the root it belongs to', async () => {
  const { createSkillProvider, splitFrontMatter } = await import('../src/skills.js')
  const base = await mkdtemp(join(tmpdir(), 'dsh-multi-root-skills-'))
  const skillDir = join(base, '.claude', 'skills', 'review')
  await mkdir(skillDir, { recursive: true })
  await (await import('node:fs/promises')).writeFile(
    join(skillDir, 'SKILL.md'),
    '---\nname: pr-review\ndescription: Review a pull request\nwhenToUse: before merging\n---\n\n# Review\n\nRead the diff.\n',
  )

  const snapshot = {
    rootsOf: (workspace) => (workspace === 'D:\\ws' ? [{ id: 'r1', alias: 'api', aliasId: 'api', path: base, mode: 'readwrite', skillsEnabled: true }] : []),
  }
  const provider = createSkillProvider({ snapshot })
  const listed = await provider.list({ cwd: 'D:\\ws' })
  assert.equal(listed.complete, true)
  assert.equal(listed.candidates.length, 1)
  assert.equal(listed.candidates[0].name, 'api-pr-review', 'skills are namespaced by the root alias id')
  assert.match(listed.candidates[0].name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'DSH only accepts kebab-case skill names')
  assert.equal(listed.candidates[0].description, 'Review a pull request')
  assert.equal(listed.candidates[0].rank, 0)
  assert.deepEqual(
    listed.candidates[0].invocation,
    { modelInvocable: true, userInvocable: true },
    'the host reads skill.invocation.modelInvocable while building the catalogue',
  )

  const loaded = await provider.get(listed.candidates[0])
  assert.equal(loaded.content, '# Review\n\nRead the diff.')
  assert.deepEqual(loaded.invocation, { modelInvocable: true, userInvocable: true }, 'a definition carries the policy too')

  const off = createSkillProvider({
    snapshot: {
      rootsOf: () => [{ id: 'r1', alias: 'api', path: base, mode: 'readwrite', skillsEnabled: false }],
    },
  })
  assert.deepEqual((await off.list({ cwd: 'D:\\ws' })).candidates, [])

  assert.deepEqual(splitFrontMatter('no front matter'), { attributes: {}, body: 'no front matter' })
  await rm(base, { recursive: true, force: true })
})
