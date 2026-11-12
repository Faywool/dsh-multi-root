/**
 * Tests for `workspace_grep`: the pure matcher, the scanner, and the per
 * workspace switch that gates it.
 *
 * The scanner is exercised on temporary trees so the assertions describe real
 * file system behaviour (binary sniffing, size caps, result caps) instead of a
 * mocked one.
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { globToRegExp, grepRoots } from '../src/browse.js'
import { createGrepTool, formatResult, GREP_TOOL_NAME } from '../src/grep-tool.js'
import { RootStore } from '../src/store.js'

const WORKSPACE = 'D:\\work\\space'

/** A throwaway directory tree, removed by the caller. */
async function temporaryTree() {
  return mkdtemp(join(tmpdir(), 'dsh-multi-root-grep-'))
}

function root(path, alias) {
  return { id: alias, alias, path, mode: 'readwrite', skillsEnabled: false }
}

test('globToRegExp understands stars, globstars, braces and a missing glob', () => {
  assert.equal(globToRegExp(undefined), undefined)

  const cs = globToRegExp('*.cs')
  assert.equal(cs.test('Program.cs'), true)
  assert.equal(cs.test('src/Program.cs'), false, 'a bare star does not cross a separator')

  const markdown = globToRegExp('**/*.md')
  assert.equal(markdown.test('docs/readme.md'), true)
  assert.equal(markdown.test('readme.md'), true)

  const braces = globToRegExp('*.{ts,tsx}')
  assert.equal(braces.test('index.ts'), true)
  assert.equal(braces.test('index.tsx'), true)
  assert.equal(braces.test('index.js'), false)

  const question = globToRegExp('file?.txt')
  assert.equal(question.test('file1.txt'), true)
  assert.equal(question.test('file12.txt'), false)
})

test('grepRoots finds literal text with line numbers and relative paths', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  const repo = join(tree, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'a.cs'), 'class A {\n  // IPriceBook marker\n}\n', 'utf8')
  await writeFile(join(repo, 'b.txt'), 'nothing here\n', 'utf8')

  const result = await grepRoots([root(repo, 'api')], 'IPriceBook')
  assert.equal(result.ok, true)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].alias, 'api')
  assert.equal(result.matches[0].relative, 'src/a.cs')
  assert.equal(result.matches[0].line, 2)
  assert.match(result.matches[0].text, /IPriceBook/)
  assert.equal(result.filesScanned, 2)
  assert.equal(result.truncated, false)
})

test('grepRoots ignores case unless the pattern has an uppercase letter', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  await writeFile(join(tree, 'notes.md'), 'the pricebook lives here\n', 'utf8')

  const smart = await grepRoots([root(tree, 'docs')], 'pricebook')
  assert.equal(smart.matches.length, 1, 'lowercase pattern matches regardless of case')

  const exact = await grepRoots([root(tree, 'docs')], 'PriceBook', { ignoreCase: false })
  assert.equal(exact.matches.length, 0, 'uppercase pattern is case sensitive')

  const forced = await grepRoots([root(tree, 'docs')], 'PriceBook', { ignoreCase: true })
  assert.equal(forced.matches.length, 1, 'ignoreCase can be forced')
})

test('grepRoots supports regular expressions and reports a bad one', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  await writeFile(join(tree, 'a.ts'), 'export const value = 41\nconst other = 42\n', 'utf8')

  const hit = await grepRoots([root(tree, 'web')], 'value\\s*=\\s*4\\d', { regex: true })
  assert.equal(hit.matches.length, 1)
  assert.equal(hit.matches[0].line, 1)

  const bad = await grepRoots([root(tree, 'web')], '([', { regex: true })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /not a valid regular expression/)
})

test('grepRoots filters by glob, skips binaries and oversized files', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  await writeFile(join(tree, 'keep.cs'), 'needle\n', 'utf8')
  await writeFile(join(tree, 'skip.txt'), 'needle\n', 'utf8')
  await writeFile(join(tree, 'blob.bin'), Buffer.from([0x6e, 0x65, 0x00, 0x65, 0x64]), 'binary')
  await writeFile(join(tree, 'huge.txt'), `${'needle\n'.repeat(120000)}`, 'utf8')

  const globbed = await grepRoots([root(tree, 'api')], 'needle', { glob: '*.cs' })
  assert.deepEqual(globbed.matches.map((match) => match.relative), ['keep.cs'])
  assert.equal(globbed.skippedBinary, 0)

  const all = await grepRoots([root(tree, 'api')], 'needle')
  assert.deepEqual(all.matches.map((match) => match.relative), ['blob.bin', 'keep.cs', 'skip.txt'].filter((name) => name !== 'blob.bin'))
  assert.equal(all.skippedBinary, 1, 'the NUL file is skipped, not scanned')
  assert.equal(all.skippedSize, 1, 'the 720 KB file is skipped')
})

test('a glob without a separator matches the file name at any depth', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  await mkdir(join(tree, 'src', 'deep'), { recursive: true })
  await writeFile(join(tree, 'top.cs'), 'needle\n', 'utf8')
  await writeFile(join(tree, 'src', 'deep', 'nested.cs'), 'needle\n', 'utf8')
  await writeFile(join(tree, 'src', 'other.ts'), 'needle\n', 'utf8')

  const result = await grepRoots([root(tree, 'api')], 'needle', { glob: '*.cs' })
  assert.deepEqual(result.matches.map((match) => match.relative).sort(), ['src/deep/nested.cs', 'top.cs'])

  const scoped = await grepRoots([root(tree, 'api')], 'needle', { glob: 'src/**' })
  assert.deepEqual(scoped.matches.map((match) => match.relative).sort(), ['src/deep/nested.cs', 'src/other.ts'])
})

test('grepRoots stops at the result cap and says so', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  const lines = Array.from({ length: 40 }, (_, index) => `needle ${index}`).join('\n')
  await writeFile(join(tree, 'many.txt'), `${lines}\n`, 'utf8')

  const result = await grepRoots([root(tree, 'api')], 'needle', { maxResults: 5 })
  assert.equal(result.matches.length, 5)
  assert.equal(result.truncated, true)
  assert.equal(result.stoppedBy, 'results')
})

test('grepRoots keeps a few lines of context around a match', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  await writeFile(join(tree, 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8')

  const result = await grepRoots([root(tree, 'web')], 'three', { context: 1 })
  assert.equal(result.matches.length, 1)
  assert.deepEqual(result.matches[0].before, ['two'])
  assert.deepEqual(result.matches[0].after, ['four'])
})

test('grepRoots reports an empty pattern instead of scanning', async () => {
  const result = await grepRoots([root('D:\\nowhere', 'api')], '   ')
  assert.equal(result.ok, false)
  assert.match(result.reason, /pattern is empty/)
})

test('formatResult groups by root and always ends with a trailer', () => {
  const rendered = formatResult({
    ok: true,
    matches: [
      { alias: 'api', root: 'D:\\api', relative: 'src/a.cs', absolute: 'D:\\api\\src\\a.cs', line: 2, text: 'IPriceBook x', before: [], after: [] },
      { alias: 'api', root: 'D:\\api', relative: 'src/b.cs', absolute: 'D:\\api\\src\\b.cs', line: 9, text: 'IPriceBook y', before: [], after: [] },
      { alias: 'docs', root: 'D:\\docs', relative: 'spec.md', absolute: 'D:\\docs\\spec.md', line: 1, text: 'IPriceBook z', before: [], after: [] },
    ],
    filesVisited: 12,
    filesScanned: 10,
    skippedBinary: 1,
    skippedSize: 1,
    truncated: false,
    elapsedMs: 3,
  }, { pattern: 'IPriceBook', selected: [{ alias: 'api' }, { alias: 'docs' }], rootCount: 2 })

  assert.match(rendered, /^api \(2\)/m)
  assert.match(rendered, /^docs \(1\)/m)
  assert.match(rendered, /src\/a\.cs:2: IPriceBook x/)
  assert.match(rendered, /scanned 10 of 12 visited files/)
  assert.match(rendered, /1 skipped \(binary\)/)
  assert.match(rendered, /1 skipped \(larger than 512 KiB\)/)
})

test('formatResult explains a truncated search and an empty one', () => {
  const truncated = formatResult({
    ok: true,
    matches: [{ alias: 'api', root: 'D:\\api', relative: 'a.cs', absolute: 'D:\\api\\a.cs', line: 1, text: 'x', before: [], after: [] }],
    filesVisited: 3,
    filesScanned: 3,
    skippedBinary: 0,
    skippedSize: 0,
    truncated: true,
    stoppedBy: 'results',
    elapsedMs: 1,
  }, { pattern: 'x', selected: [{ alias: 'api' }], rootCount: 1 })
  assert.match(truncated, /stopped at the 1-result cap/)

  const empty = formatResult({
    ok: true,
    matches: [],
    filesVisited: 0,
    filesScanned: 0,
    skippedBinary: 0,
    skippedSize: 0,
    truncated: false,
    elapsedMs: 0,
  }, { pattern: 'zzz', selected: [{ alias: 'api' }], rootCount: 1 })
  assert.match(empty, /No match for "zzz" in 1 root\(s\)\./)
})

test('the tool refuses to scan when the workspace switch is off', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  const store = new RootStore({ file: join(tree, 'store.json') })
  await store.setSearchEnabled(WORKSPACE, false)

  const tool = createGrepTool({
    ctx: { get: () => undefined },
    store,
    snapshot: { rootsOf: () => [root(tree, 'api')] },
  })
  assert.equal(tool.name, GREP_TOOL_NAME)
  const answer = await tool.execute({ pattern: 'needle' }, { agent: { session: { header: { cwd: WORKSPACE } } } })
  assert.match(answer, /Content search is switched off for this workspace/)
  assert.equal((await store.searchEnabled(WORKSPACE)), false)
})

test('the tool explains a workspace with no roots and an unknown alias', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  const store = new RootStore({ file: join(tree, 'store.json') })

  const bare = createGrepTool({
    ctx: { get: () => undefined },
    store,
    snapshot: { rootsOf: () => [] },
  })
  assert.match(
    await bare.execute({ pattern: 'needle' }, { agent: { session: { header: { cwd: WORKSPACE } } } }),
    /no attached roots yet/,
  )

  const withRoots = createGrepTool({
    ctx: { get: () => undefined },
    store,
    snapshot: { rootsOf: () => [root(tree, 'api')] },
  })
  assert.match(
    await withRoots.execute({ pattern: 'needle', alias: 'nope' }, { agent: { session: { header: { cwd: WORKSPACE } } } }),
    /No attached root is called "nope"/,
  )
})

test('the switch defaults to on, survives writes, and can be turned back on', async (t) => {
  const tree = await temporaryTree()
  t.after(() => rm(tree, { recursive: true, force: true }))
  const store = new RootStore({ file: join(tree, 'store.json') })

  assert.equal(await store.searchEnabled(WORKSPACE), true, 'unknown workspaces default to on')

  await store.write(WORKSPACE, [{ id: 'r1', alias: 'api', path: 'D:\\api', mode: 'readwrite', skillsEnabled: false, addedAt: '2026-01-01T00:00:00.000Z' }])
  const entries = await store.entries()
  assert.equal(entries[0].searchEnabled, true)

  await store.setSearchEnabled(WORKSPACE, false)
  assert.equal(await store.searchEnabled(WORKSPACE), false)

  await store.write(WORKSPACE, [{ id: 'r1', alias: 'api', path: 'D:\\api', mode: 'readwrite', skillsEnabled: false, addedAt: '2026-01-01T00:00:00.000Z' }])
  assert.equal(await store.searchEnabled(WORKSPACE), false, 'rewriting roots keeps the switch off')

  await store.setSearchEnabled(WORKSPACE, true)
  assert.equal(await store.searchEnabled(WORKSPACE), true)
})
