import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * The client half is a `window.__ModuleLoader__.load` bundle, so this test
 * emulates the two globals it reads (`window`, and `react` through `require`)
 * and then checks what it registers and that rendering survives a hostile
 * environment. It is a contract test, not a browser test: it cannot tell you
 * whether the panel looks right, only that it cannot throw its way out.
 */

const STATE = {
  ok: true,
  workspaces: [
    {
      key: 'd:\\work\\api',
      path: 'D:\\work\\api',
      roots: [
        { alias: 'docs', path: 'D:\\work\\docs', mode: 'readonly', git: { branch: 'main', dirty: true } },
      ],
    },
  ],
  config: { enabled: true, maxRoots: 16, injectPrompt: true, promptMaxChars: 4000, showGit: true },
  store: 'C:\\Users\\x\\.dsh\\storages\\dsh_multi_root.json',
}

/**
 * A very small hook runtime: enough for useState/useEffect to behave like they
 * do in a browser across repeated renders of one component instance.
 */
let hooks = []
let cursor = 0

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial, dirty: false }
      }
      const slot = hooks[index]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        slot.dirty = true
      }]
    },
    useEffect(effect) {
      const index = cursor
      cursor += 1
      if (hooks[index] !== undefined) return undefined
      hooks[index] = { ran: true }
      return effect()
    },
  }
}

/** A slot registry that records each registration, the way the real one resolves it. */
function makeSlots() {
  const registered = []
  let current
  return {
    registered,
    inject(slotName, factory) {
      current = slotName
      factory()
      return () => {}
    },
    register(definition, Component) {
      registered.push({ slotName: current, definition, Component })
      return () => {}
    },
  }
}

let bundlePromise

async function loadBundle() {
  // The bundle body runs once per process: ESM caches it, and the loader only
  // sees whatever `window` existed at that moment. Every later call reuses the
  // captured definition, which is exactly how the browser behaves.
  bundlePromise ??= (async () => {
    let definition
    globalThis.window = {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    }
    globalThis.fetch = async () => ({ json: async () => STATE })
    await import('../src/client.js')
    assert.ok(definition !== undefined, 'the bundle registered a module definition')
    return definition
  })()
  const definition = await bundlePromise
  const module = definition.factory((specifier) => {
    if (specifier === 'react') return fakeReact()
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { definition, module }
}

async function mount(Component, props) {
  hooks = []
  let text = ''
  // Render, let the fetch land, render again: the panel paints an empty state
  // first and the loaded table second, exactly like in the browser.
  for (let pass = 0; pass < 4; pass += 1) {
    cursor = 0
    text = flatten(render({ type: Component, props }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return text
}

test('the bundle id matches the package name', async () => {
  const { definition } = await loadBundle()
  assert.equal(definition.id, 'dsh-multi-root')
})

test('apply registers the bottom entry, the dialog and the settings page', async () => {
  const { module } = await loadBundle()
  assert.deepEqual(module.inject, ['slots'])

  const slots = makeSlots()
  const ctx = {
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect() {},
  }
  module.apply(ctx)

  assert.deepEqual(slots.registered.map((entry) => entry.slotName), [
    'settings.section',
    'settings.section.icon',
    'sidebar.footer.action',
    'shell.overlay',
  ])
  const footer = slots.registered.find((entry) => entry.slotName === 'sidebar.footer.action')
  const overlay = slots.registered.find((entry) => entry.slotName === 'shell.overlay')
  assert.equal(footer.definition.id, 'dsh-multi-root-footer')
  assert.equal(overlay.definition.id, 'dsh-multi-root-modal')
  assert.equal(typeof overlay.Component, 'function')
  // No top-level sidebar icon and no full-page panel: the entry lives at the
  // sidebar foot and opens a dialog, which is what the original plugin does.
  assert.equal(slots.registered.some((entry) => entry.slotName === 'sidebar.panellist'), false)
  assert.equal(slots.registered.some((entry) => entry.slotName === 'main'), false)
})

test('apply survives a context without slots', async () => {
  const { module } = await loadBundle()
  const ctx = {
    get() {
      throw new Error('no services here')
    },
  }
  assert.doesNotThrow(() => module.apply(ctx))
})

test('apply survives a slot registry that throws on every registration', async () => {
  const { module } = await loadBundle()
  const ctx = {
    get(name) {
      if (name !== 'slots') return undefined
      return {
        inject() {
          throw new Error('slot missing')
        },
        register() {
          throw new Error('slot missing')
        },
      }
    },
    effect() {},
  }
  assert.doesNotThrow(() => module.apply(ctx))
})

test('the settings page renders mounted roots and config; the dialog is closed by default', async () => {
  const { module } = await loadBundle()
  const slots = makeSlots()
  const ctx = { get: (name) => (name === 'slots' ? slots : undefined), effect() {} }
  module.apply(ctx)

  const settings = slots.registered.find((entry) => entry.slotName === 'settings.section')
  const settingsText = await mount(settings.Component, { ctx })
  assert.match(settingsText, /多仓库工作区/)
  assert.match(settingsText, /docs/)
  assert.match(settingsText, /只读/)
  assert.match(settingsText, /添加仓库目录/)
  assert.match(settingsText, /D:\\work\\docs/)
  assert.match(settingsText, /配置/)
  assert.match(settingsText, /dsh_multi_root\.json/)

  const overlay = slots.registered.find((entry) => entry.slotName === 'shell.overlay')
  assert.equal(await mount(overlay.Component, { ctx }), '')
})

test('the dialog follows the session the sidebar is showing', async () => {
  const { module } = await loadBundle()
  const slots = makeSlots()
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [
          { workspaceId: 'w1', path: 'D:\\work\\api', sessionIds: ['s-api'] },
          { workspaceId: 'w2', path: 'D:\\work\\web', sessionIds: ['s-web'] },
        ],
      }),
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'workspaces') return workspaces
      return undefined
    },
    effect() {},
  }
  const previousStorage = globalThis.localStorage
  const previousFetch = globalThis.fetch
  globalThis.localStorage = {
    getItem: (key) => (key === 'dsh.sessions.current' ? JSON.stringify({ sessionId: 's-web' }) : null),
  }
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      workspaces: [
        { key: 'd:\\work\\api', path: 'D:\\work\\api', roots: [] },
        { key: 'd:\\work\\web', path: 'D:\\work\\web', roots: [] },
      ],
      config: { maxRoots: 16 },
      store: 'C:\\Users\\x\\.dsh\\storages\\dsh_multi_root.json',
    }),
  })
  try {
    module.apply(ctx)
    const settings = slots.registered.find((entry) => entry.slotName === 'settings.section')
    hooks = []
    cursor = 0
    let tree
    for (let pass = 0; pass < 4; pass += 1) {
      cursor = 0
      tree = render({ type: settings.Component, props: { ctx } })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.equal(findSelect(tree).props.value, 'D:\\work\\web')
  } finally {
    globalThis.fetch = previousFetch
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }
})

/** The first rendered `select`, which is the workspace picker. */
function findSelect(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSelect(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.type === 'select') return node
  return findSelect(node.props === undefined ? undefined : node.props.children)
}

/**
 * Walk a fake React tree, invoking function components, so hooks run the same
 * way they would during a real render.
 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((child) => render(child))
  if (typeof node === 'string' || typeof node === 'number') return node
  if (typeof node.type === 'function') return render(node.type(node.props ?? {}))
  return { type: node.type, props: { ...node.props, children: render(node.props?.children) } }
}

function flatten(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  const { props } = node
  if (props === undefined) return ''
  return flatten(props.children)
}
