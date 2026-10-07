import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import assert from 'node:assert/strict'
import vm from 'node:vm'
const root = fileURLToPath(new URL('../', import.meta.url))
function run(script) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${script} failed (${result.status})`)
}
run('build.mjs')
run('test.mjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-wechat-portable')
for (const [name, value] of Object.entries(pkg.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(value, '0.2.0-rc.2', 'No unsupported host range/exemption')
}
for (const entry of Object.values(pkg.exports)) {
  for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) assert.ok(existsSync(join(root, path)), `Missing export ${path}`)
}
assert.deepEqual(pkg.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md', 'docs/portable'])
assert.match(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'), /autoStart: false/)
function inspect(folder) {
  for (const name of readdirSync(folder)) {
    const file = join(folder, name)
    if (statSync(file).isDirectory()) { inspect(file); continue }
    const rel = relative(root, file)
    assert.ok(/\.(js|ts)$/.test(file), `Unexpected generated payload: ${rel}`)
    const text = readFileSync(file, 'utf8')
    assert.ok(!/[A-Z]:[\\/](?:Users|DSH wechat)[\\/]/i.test(text), `Personal absolute path in ${rel}`)
    assert.ok(!/PRIVATE-SENTINEL-NEVER-SHARE/.test(text), `Private fixture in ${rel}`)
  }
}
inspect(join(root, 'lib'))
let registration
vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load: entry => { registration = entry } } },
})
assert.equal(registration.id, pkg.name)
assert.equal(typeof registration.factory, 'function')
console.log('PASS: build, isolated regressions, exports, client bundle registration and generated-payload allowlist.')
