import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitTool } from '../src/git-tool.js'
import { readRepoState } from '../src/git.js'

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mr-git-'))
  git(root, ['init', '-q', '-b', 'main'])
  await writeFile(join(root, 'a.txt'), 'one\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', 'first commit'])
  return root
}

function fakeSnapshot(roots) {
  return {
    rootsOf: () => roots,
    gitStatus: () => undefined,
    allRoots: () => roots.map((root) => ({ ...root, workspace: 'C:\\ws' })),
    commandsOf: () => undefined,
  }
}

function fakeExec(directory) {
  return {
    agent: {
      session: { header: { cwd: directory } },
    },
  }
}

test('readRepoState reports branch, cleanliness and the last commit', async () => {
  const root = await repository()
  const state = await readRepoState(root)
  assert.equal(state.branch, 'main')
  assert.equal(state.changed, 0)
  assert.equal(state.last.subject, 'first commit')
  assert.match(state.last.date, /^\d{4}-\d{2}-\d{2}$/)
})

test('readRepoState counts changed paths and keeps the first few', async () => {
  const root = await repository()
  await writeFile(join(root, 'a.txt'), 'changed\n', 'utf8')
  await writeFile(join(root, 'untracked.txt'), 'ignored\n', 'utf8')
  const state = await readRepoState(root)
  assert.equal(state.changed, 1, 'untracked files are excluded on purpose')
  assert.deepEqual(state.files, ['a.txt'])
})

test('status prints one block per root and a hint when git is absent', async () => {
  const root = await repository()
  const plain = await mkdtemp(join(tmpdir(), 'dsh-mr-plain-'))
  const tool = createGitTool({
    ctx: {},
    snapshot: fakeSnapshot([
      { alias: 'api', path: root, mode: 'readwrite' },
      { alias: 'docs', path: plain, mode: 'readwrite' },
    ]),
  })
  const text = await tool.execute({ action: 'status' }, fakeExec('C:\\ws'))
  assert.match(text, /api: main · clean · last commit \d{4}-\d{2}-\d{2} [0-9a-f]+ first commit/)
  assert.match(text, /docs: not a git repository/)
})

test('status lists changed files and truncates past eight', async () => {
  const root = await repository()
  for (let index = 0; index < 10; index += 1) {
    await writeFile(join(root, `f${index}.txt`), `${index}\n`, 'utf8')
    git(root, ['add', `f${index}.txt`])
  }
  const tool = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: root, mode: 'readwrite' }]) })
  const text = await tool.execute({ action: 'status' }, fakeExec('C:\\ws'))
  assert.match(text, /10 changed/)
  assert.match(text, /… 2 more/)
  const withoutFiles = await tool.execute({ action: 'status', files: false }, fakeExec('C:\\ws'))
  assert.doesNotMatch(withoutFiles, /f0\.txt/)
})

test('diff says so when nothing changed and shows stats otherwise', async () => {
  const root = await repository()
  const tool = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: root, mode: 'readwrite' }]) })
  assert.match(await tool.execute({ action: 'diff' }, fakeExec('C:\\ws')), /api: no changes/)

  await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8')
  const text = await tool.execute({ action: 'diff' }, fakeExec('C:\\ws'))
  assert.match(text, /a\.txt/)
  assert.match(text, /1 file changed|1 insertion/)
})

test('log honours the limit and reports an empty repository', async () => {
  const root = await repository()
  for (const message of ['second', 'third']) {
    await writeFile(join(root, 'a.txt'), `${message}\n`, 'utf8')
    git(root, ['commit', '-q', '-am', message])
  }
  const tool = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: root, mode: 'readwrite' }]) })
  const two = await tool.execute({ action: 'log', limit: 2 }, fakeExec('C:\\ws'))
  assert.match(two, /third/)
  assert.match(two, /second/)
  assert.doesNotMatch(two, /first commit/)

  const empty = await mkdtemp(join(tmpdir(), 'dsh-mr-nogit-'))
  const emptyTool = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: empty, mode: 'readwrite' }]) })
  assert.match(await emptyTool.execute({ action: 'log' }, fakeExec('C:\\ws')), /no commits/)
})

test('selection and miss cases answer instead of throwing', async () => {
  const root = await repository()
  const tool = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: root, mode: 'readwrite' }]) })
  assert.match(await tool.execute({ action: 'status', alias: 'nope' }, fakeExec('C:\\ws')), /No attached root is called "nope"/)
  assert.match(await tool.execute({ action: 'bogus' }, fakeExec('C:\\ws')), /must be "status", "diff" or "log"/)

  const empty = createGitTool({ ctx: {}, snapshot: fakeSnapshot([]) })
  assert.match(await empty.execute({ action: 'status' }, fakeExec('C:\\ws')), /workspace_roots with action "attach"/)

  const lost = createGitTool({ ctx: {}, snapshot: fakeSnapshot([{ alias: 'api', path: root, mode: 'readwrite' }]) })
  assert.match(await lost.execute({ action: 'status' }, { agent: {} }), /Cannot determine the workspace directory/)
})

test('single-alias selection touches only that root', async () => {
  const first = await repository()
  const second = await repository()
  const tool = createGitTool({
    ctx: {},
    snapshot: fakeSnapshot([
      { alias: 'api', path: first, mode: 'readwrite' },
      { alias: 'web', path: second, mode: 'readwrite' },
    ]),
  })
  const text = await tool.execute({ action: 'status', alias: 'web' }, fakeExec('C:\\ws'))
  assert.match(text, /^web:/)
  assert.doesNotMatch(text, /api:/)
})
