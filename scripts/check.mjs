#!/usr/bin/env node
/**
 * Syntax-check every runtime source file.
 *
 * The package ships its sources as-is (no build step), so `node --check` is the
 * only compile-time gate we have. Running it through one script keeps the
 * `files` list in one place instead of repeating a long `&&` chain in
 * package.json.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(root, 'src')

const files = readdirSync(sourceDirectory)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => join('src', name))

if (files.length === 0) {
  console.error('check: no source files found under src/')
  process.exit(1)
}

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    failed += 1
    console.error(`check: ${file} failed`)
  }
}

if (failed > 0) {
  console.error(`check: ${failed} of ${files.length} file(s) failed`)
  process.exit(1)
}

console.log(`check: ${files.length} file(s) ok`)
