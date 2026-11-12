import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../src/index.js'
import { RootStore } from '../src/store.js'
import { resolveConfig, DEFAULTS } from '../src/config.js'

/** Point the plugin's store at a throwaway home before anything mounts. */
const home = await mkdtemp(join(tmpdir(), 'dsh-multi-root-apply-'))
process.env.DSH_HOME = home
const storeFile = join(home, 'storages', 'dsh_multi_root.json')

/**
 * A context stub with working fakes for the three services this bundle uses.
 * @param {Record<string, unknown>} [extra] - services to add or replace.
 * @returns {{ ctx: object, registered: object, warnings: string[], services: object }} the stub.
 */
function fakeContext(extra = {}) {
  const registered = { tools: [], sections: [], settings: 0 }
  const warnings = []
  const services = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder: () => 500,
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
    },
    settings: {
      configure() {
        registered.settings += 1
        return () => {}
      },
    },
    ...extra,
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info() {} },
    effect() {},
    get(service) {
      return service in services ? services[service] : undefined
    },
  }
  return { ctx, registered, warnings, services }
}

test('the plugin declares no hard dependencies', () => {
  assert.equal(name, 'dsh-multi-root')
  assert.deepEqual(inject, [])
})

test('apply registers one section, two tools and one settings form', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, { enabled: true })

  assert.equal(registered.settings, 1)
  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].name, 'dsh-multi-root:roots')
  assert.equal(registered.sections[0].order, 501)
  assert.equal(typeof registered.sections[0].text, 'function')
  assert.equal(registered.tools.length, 2)
  assert.deepEqual(
    registered.tools.map((tool) => tool.name).sort(),
    ['workspace_find', 'workspace_roots'],
  )
})

test('a context with no services at all still mounts without throwing', () => {
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message), info() {} },
    effect() {},
    get() {
      throw new Error('service registry is not ready')
    },
  }
  assert.doesNotThrow(() => apply(ctx, undefined))
  assert.equal(warnings.length >= 1, true)
  assert.match(warnings.join('\n'), /keeps working/)
})

test('a throwing registration is contained and the rest still registers', () => {
  const { ctx, registered, warnings } = fakeContext({
    settings: {
      configure() {
        throw new Error('settings is already configured')
      },
    },
  })
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))
  assert.equal(registered.tools.length, 2, 'the tools still registered')
  assert.equal(registered.sections.length, 1, 'the section still registered')
  assert.match(warnings.join('\n'), /settings form unavailable/)
})

test('a missing systemPrompt or tools costs only that contribution', () => {
  const { ctx, registered, warnings } = fakeContext({ tools: undefined, systemPrompt: undefined })
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))
  assert.equal(registered.tools.length, 0)
  assert.equal(registered.sections.length, 0)
  assert.equal(registered.settings, 1)
  assert.match(warnings.join('\n'), /prompt section unavailable/)
  assert.match(warnings.join('\n'), /workspace_roots tool unavailable/)
})

test('enabled: false mounts nothing', () => {
  let looked = 0
  const ctx = {
    logger: { warn() {}, info() {} },
    effect() {},
    get() {
      looked += 1
      return undefined
    },
  }
  apply(ctx, { enabled: false })
  assert.equal(looked, 0)
})

test('the section renders the roots attached to the session directory', async () => {
  const store = new RootStore({ file: storeFile })
  await store.write('D:\\ws', [{ alias: 'api', path: 'D:\\repo\\api', mode: 'readwrite' }])

  const { ctx, registered } = fakeContext()
  apply(ctx, { enabled: true })
  await new Promise((resolve) => setTimeout(resolve, 50))

  const section = registered.sections[0]
  const text = section.text({ scope: { session: { header: { cwd: 'D:\\ws' } } } })
  assert.match(text, /api/)
  assert.match(text, /D:\\repo\\api/)

  assert.equal(section.text({ scope: { session: { header: { cwd: 'D:\\elsewhere' } } } }), '')
  assert.equal(section.text(undefined), '')
})

test('the section never throws, even on a hostile context', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, { enabled: true })
  const section = registered.sections[0]
  const hostile = new Proxy({}, {
    get() {
      throw new Error('nope')
    },
  })
  assert.doesNotThrow(() => section.text(hostile))
})

test('config defaults and clamping', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULTS })
  assert.equal(resolveConfig({ maxRoots: 1000 }).maxRoots, 64)
  assert.equal(resolveConfig({ maxRoots: 0 }).maxRoots, DEFAULTS.maxRoots)
  assert.equal(resolveConfig({ maxRoots: 2.5 }).maxRoots, DEFAULTS.maxRoots)
  assert.equal(resolveConfig({ promptMaxChars: 10 }).promptMaxChars, DEFAULTS.promptMaxChars)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})
