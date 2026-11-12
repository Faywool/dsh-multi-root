/**
 * The loader loads a profile bundle with `require()`, not `import()`.
 *
 * That difference is invisible to every other test in this suite, because they
 * all go through ESM. It is also the difference that made this plugin vanish
 * from a real host: an `await import(...)` at module scope turned the graph into
 * an async module, and `require()` refused it with ERR_REQUIRE_ASYNC_MODULE.
 * The loader then kept the entry in its tree with no Config and no `apply()`,
 * so the plugin looked installed and did nothing.
 *
 * One test is enough to keep that from happening again: require the package the
 * way the loader does, and assert the entry points are actually there.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('loads through require(), the way the DSH loader loads a bundle', () => {
  const loaded = require('..')

  assert.equal(loaded.name, 'dsh-multi-root')
  assert.deepEqual(loaded.inject, [])
  assert.equal(typeof loaded.apply, 'function')
})

test('exports no top-level await in its own sources', async () => {
  // Guards the shape rather than the symptom: a TLA anywhere in a module that
  // is part of the entry graph breaks require(), including in a helper.
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const offenders = []

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const text = await readFile(join(source, entry.name), 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (!/^\s*(?:for\s+)?await\b/.test(line)) return
      // Only depth-0 awaits are top-level.
      const indent = line.length - line.trimStart().length
      if (indent === 0) offenders.push(`${entry.name}:${index + 1}`)
    })
  }

  assert.deepEqual(offenders, [])
})
