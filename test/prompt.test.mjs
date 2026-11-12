import assert from 'node:assert/strict'
import test from 'node:test'

import { renderRootsTable, sectionWorkspacePath, TOOL_NAME, SECTION_NAME } from '../src/prompt.js'
import { directoryOf } from '../src/context.js'

const ROOTS = [
  { alias: 'backend', path: 'D:\\work\\backend', mode: 'readwrite' },
  { alias: 'documents', path: 'D:\\work\\docs', mode: 'readonly' },
]

test('section and tool names are stable', () => {
  assert.equal(SECTION_NAME, 'dsh-multi-root:roots')
  assert.equal(TOOL_NAME, 'workspace_roots')
})

test('an empty root list renders nothing', () => {
  assert.equal(renderRootsTable({ workspacePath: 'D:\\ws', roots: [] }), '')
  assert.equal(renderRootsTable({ workspacePath: 'D:\\ws', roots: undefined }), '')
})

test('the table names the workspace and every root', () => {
  const text = renderRootsTable({ workspacePath: 'D:\\ws', roots: ROOTS })
  assert.match(text, /Primary workspace directory: D:\\ws/)
  assert.match(text, /backend/)
  assert.match(text, /readonly/)
  assert.match(text, /workspace_roots/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('| backend')).length, 1)
})

test('git metadata is omitted entirely when no lookup is supplied', () => {
  const text = renderRootsTable({ workspacePath: 'D:\\ws', roots: ROOTS })
  assert.doesNotMatch(text, /\| git \|/)
})

test('git metadata adds a branch column when available', () => {
  const text = renderRootsTable({
    workspacePath: 'D:\\ws',
    roots: ROOTS,
    gitStatus: (path) => (path.includes('backend') ? { branch: 'main', dirty: true } : undefined),
  })
  assert.match(text, /\| git /)
  assert.match(text, /main\*/)
})

test('the budget drops rows from the end instead of overflowing', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    alias: `root-${index}`,
    path: `D:\\repo\\root-${index}-with-a-fairly-long-name`,
    mode: 'readwrite',
  }))
  const text = renderRootsTable({ workspacePath: 'D:\\ws', roots: many, maxChars: 900 })
  assert.equal(text.length <= 1200, true)
  assert.match(text, /omitted to stay within the prompt budget/)
  assert.match(text, /root-0/)
  assert.doesNotMatch(text, /root-39/)
})

test('a budget too small for even one row still says why', () => {
  const text = renderRootsTable({ workspacePath: 'D:\\ws', roots: ROOTS, maxChars: 420 })
  assert.match(text, /omitted to stay within the prompt budget/)
})

test('the assembly context resolves through scope, session and cwd shapes', () => {
  assert.equal(directoryOf({ scope: { session: { header: { cwd: 'D:\\a' } } } }), 'D:\\a')
  assert.equal(directoryOf({ scope: { cwd: 'D:\\b' } }), 'D:\\b')
  assert.equal(directoryOf({ cwd: 'D:\\c' }), 'D:\\c')
  assert.equal(directoryOf({}), undefined)
  assert.equal(directoryOf(undefined), undefined)
  assert.equal(sectionWorkspacePath({ scope: { session: { header: { cwd: 'D:\\a' } } } }), 'D:\\a')
})
