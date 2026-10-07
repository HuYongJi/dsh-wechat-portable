import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
export function runBin(packageName, binaryName, args = []) {
  const directory = join(root, 'node_modules', packageName)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binaryName]
  if (!relative) throw new Error(`Missing build executable: ${packageName}`)
  const result = spawnSync(process.execPath, [join(directory, relative), ...args], {
    cwd: root, stdio: 'inherit', shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${binaryName} failed (${result.status})`)
}
runBin('typescript', 'tsc', ['-p', 'tsconfig.json'])
runBin('tsdown', 'tsdown')
