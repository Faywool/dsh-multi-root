import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { clientBundlePath, startDevReload } from '../src/dev-reload.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-multi-root-dev-reload-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })

function recorder() {
  const lines = []
  return {
    lines,
    logger: {
      info: (message) => lines.push(['info', message]),
      warn: (message) => lines.push(['warn', message]),
      error: (message) => lines.push(['error', message]),
    },
  }
}

function contextWithEffect() {
  const cleanups = []
  return {
    cleanups,
    ctx: { effect: (fn) => { cleanups.push(fn()) } },
  }
}

test('a missing or hostile clientModules service reports no bundle path', () => {
  assert.equal(clientBundlePath(undefined, 'dsh-multi-root'), undefined)
  assert.equal(clientBundlePath({}, 'dsh-multi-root'), undefined)
  assert.equal(clientBundlePath({ clientPath: () => '' }, 'x'), undefined)
  assert.equal(clientBundlePath({ clientPath: () => { throw new Error('nope') } }, 'x'), undefined)
  assert.equal(clientBundlePath({ clientPath: (id) => (id === 'x' ? '/tmp/x.js' : undefined) }, 'x'), '/tmp/x.js')
})

test('no client bundle turns hot reload off without throwing', () => {
  const { logger, lines } = recorder()
  const { ctx, cleanups } = contextWithEffect()
  assert.equal(startDevReload({ ctx, id: 'dsh-multi-root', clientModules: {}, logger }), false)
  assert.equal(clientBundlePath({}, 'dsh-multi-root'), undefined)
  assert.equal(cleanups.length, 0)
  assert.match(lines[0][1], /no client bundle/)
})

test('a host that cannot republish turns hot reload off', () => {
  const { logger } = recorder()
  const { ctx } = contextWithEffect()
  const service = { clientPath: () => join(scratch, 'client.js') }
  assert.equal(startDevReload({ ctx, id: 'dsh-multi-root', clientModules: service, logger }), false)
})

test('a write to the bundle asks the host to republish it', async () => {
  const file = join(scratch, 'client.js')
  writeFileSync(file, '// one\n')
  const { logger, lines } = recorder()
  const { ctx, cleanups } = contextWithEffect()
  const rebuilt = []
  const service = {
    clientPath: () => file,
    rebuilt: (id) => { rebuilt.push(id); return 'rev-2' },
  }
  assert.equal(startDevReload({ ctx, id: 'dsh-multi-root', clientModules: service, logger, debounceMs: 20 }), true)
  writeFileSync(file, '// two\n')
  await new Promise((resolve) => setTimeout(resolve, 400))
  cleanups.forEach((fn) => fn())
  assert.deepEqual(rebuilt, ['dsh-multi-root'])
  assert.ok(lines.some(([, message]) => /client bundle changed; published revision rev-2/.test(message)))
})
