import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandLines, detectCommands } from '../src/build.js'

async function scratch() {
  return mkdtemp(join(tmpdir(), 'dsh-mr-build-'))
}

async function writePackage(directory, scripts) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf8')
}

test('a solution one level down becomes the dotnet build and test command', async () => {
  const root = await scratch()
  await mkdir(join(root, 'SourceCode'), { recursive: true })
  await writeFile(join(root, 'SourceCode', 'PSREF.sln'), '', 'utf8')
  await writePackage(join(root, 'SourceCode', 'web'), { build: 'vite build', test: 'vitest' })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'ignored.sln'), '', 'utf8')

  const found = await detectCommands(root)
  assert.equal(found.kind, 'dotnet')
  assert.equal(found.build.command, 'dotnet build SourceCode/PSREF.sln')
  assert.equal(found.build.origin, 'SourceCode/PSREF.sln')
  assert.equal(found.test.command, 'npm --prefix SourceCode/web run test')
  assert.equal(found.test.origin, 'SourceCode/web/package.json')
})

test('a pnpm workspace becomes pnpm -C <dir> run <script>', async () => {
  const root = await scratch()
  const app = join(root, 'app')
  await writePackage(app, { build: 'next build', test: 'jest' })
  await writeFile(join(app, 'pnpm-lock.yaml'), '', 'utf8')

  const found = await detectCommands(root)
  assert.equal(found.kind, 'node')
  assert.equal(found.build.command, 'pnpm -C app run build')
  assert.equal(found.test.command, 'pnpm -C app run test')
})

test('npm is the fallback and a root project needs no -C', async () => {
  const root = await scratch()
  await writePackage(root, { build: 'tsc' })
  await writeFile(join(root, 'package-lock.json'), '{}', 'utf8')

  const found = await detectCommands(root)
  assert.equal(found.build.command, 'npm run build')
  assert.equal(found.test, undefined)
})

test('a single project file is buildable even without a solution', async () => {
  const root = await scratch()
  await mkdir(join(root, 'Api'), { recursive: true })
  await writeFile(join(root, 'Api', 'Api.csproj'), '<Project/>', 'utf8')

  const found = await detectCommands(root)
  assert.equal(found.kind, 'dotnet')
  assert.equal(found.build.command, 'dotnet build Api/Api.csproj')
  assert.equal(found.test.command, 'dotnet test Api/Api.csproj')
})

test('an empty directory detects nothing instead of guessing', async () => {
  const root = await scratch()
  const found = await detectCommands(root)
  assert.deepEqual(found, { kind: 'none' })
})

test('the shallowest solution wins when several exist', async () => {
  const root = await scratch()
  await writeFile(join(root, 'main.sln'), '', 'utf8')
  await mkdir(join(root, 'deep', 'nested'), { recursive: true })
  await writeFile(join(root, 'deep', 'nested', 'other.sln'), '', 'utf8')

  const found = await detectCommands(root)
  assert.equal(found.build.command, 'dotnet build main.sln')
})

test('commandLines prefers a stored override and skips roots with nothing known', async () => {
  const roots = [
    { alias: 'api', path: 'C:\\work\\api', build: 'make api' },
    { alias: 'web', path: 'C:\\work\\web' },
    { alias: 'docs', path: 'C:\\work\\docs' },
  ]
  const detected = (path) => {
    if (path === 'C:\\work\\api') return { build: { command: 'dotnet build api.sln' }, test: { command: 'dotnet test' } }
    if (path === 'C:\\work\\web') return { build: { command: 'pnpm -C web run build' } }
    return { kind: 'none' }
  }

  const lines = commandLines(roots, detected)
  assert.equal(lines.length, 2)
  assert.equal(lines[0], 'api: build: `make api` · test: `dotnet test`')
  assert.equal(lines[1], 'web: build: `pnpm -C web run build`')
})
