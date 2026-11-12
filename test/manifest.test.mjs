import assert from 'node:assert/strict'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('the manifest declares a bundle patch and a web client', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(statSync(join(root, 'cordis.patch.yml')).isFile(), 'cordis.patch.yml must exist')
  assert.ok(statSync(join(root, 'src', 'client.js')).isFile(), 'the client entry must exist')
})

test('the icon is a real file inside the package and under the 256 KiB limit', () => {
  assert.equal(manifest.icon, './icon.svg', 'a package-root plugin declares a top-level icon')
  const file = join(root, 'icon.svg')
  const size = statSync(file).size
  assert.ok(size > 0 && size <= 256 * 1024, `icon size ${size} must be 1..262144 bytes`)
  const svg = readFileSync(file, 'utf8')
  assert.match(svg, /^<svg[\s>]/, 'the icon must be SVG markup')
  assert.match(svg, /viewBox="0 0 64 64"/)
  assert.ok(manifest.files.includes('icon.svg'), 'the icon must ship in the tarball')
})

test('every locale file carries a title and a description', () => {
  const dir = join(root, 'locale')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.ok(files.length >= 2, 'at least zh.json and en.json')
  assert.deepEqual(files.sort(), ['en.json', 'zh.json'])
  assert.ok(manifest.files.includes('locale'), 'locales must ship in the tarball')
  for (const name of files) {
    const meta = JSON.parse(readFileSync(join(dir, name), 'utf8')).meta
    assert.equal(typeof meta?.title, 'string', `${name}: meta.title`)
    assert.ok(meta.title.length > 0, `${name}: meta.title must not be empty`)
    assert.equal(typeof meta?.description, 'string', `${name}: meta.description`)
    assert.ok(meta.description.length > 20, `${name}: meta.description must be a sentence`)
  }
})
