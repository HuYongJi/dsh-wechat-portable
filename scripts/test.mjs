import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { testEnvironment } from './test-env.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const env = testEnvironment()
// Separate processes keep DATA_DIR/env/module caches isolated, but inherit stdio.
// node --test's captured child pipes are unavailable in the Windows DSH sandbox.
for (const file of readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).sort()) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [join(root, 'tests', file)], { cwd: root, stdio: 'inherit', shell: false, env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${file} failed (${result.status})`)
}
