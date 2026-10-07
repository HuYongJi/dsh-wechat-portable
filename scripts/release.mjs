/** Build local Release assets only. Publishing is owned by the GitHub workflow. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const PACKAGE_NAME = 'dsh-wechat-portable'
const DSH_VERSION = '0.2.0-rc.2'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const ROOT_FILES = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md'])
// Public, pure-JS runtime closure of qrcode@1.5.4 and qrcode-terminal@0.12.0.
// Keep explicit: a newly bundled SDK, native addon or dependency requires review.
export const BUNDLED_PACKAGES = Object.freeze([
  'ansi-regex', 'ansi-styles', 'camelcase', 'cliui', 'color-convert', 'color-name',
  'decamelize', 'dijkstrajs', 'emoji-regex', 'find-up', 'get-caller-file',
  'is-fullwidth-code-point', 'locate-path', 'p-limit', 'p-locate', 'p-try',
  'path-exists', 'pngjs', 'qrcode', 'qrcode-terminal', 'require-directory',
  'require-main-filename', 'set-blocking', 'string-width', 'strip-ansi',
  'which-module', 'wrap-ansi', 'y18n', 'yargs', 'yargs-parser',
])

export function releaseInfo(manifest, { tag = `v${manifest.version}`, repository } = {}) {
  assert.equal(manifest.name, PACKAGE_NAME, 'Unexpected package identity')
  assert.ok(typeof manifest.version === 'string' && manifest.version === manifest.version.trim() && VERSION.test(manifest.version), 'Use a SemVer version without build metadata')
  assert.equal(tag, `v${manifest.version}`, 'Release tag must exactly match package.json version')
  repository ??= manifest.repository?.url?.match(/^git\+https:\/\/github\.com\/(.+)\.git$/)?.[1]
  assert.ok(typeof repository === 'string' && repository === repository.trim() && REPOSITORY.test(repository), 'Expected a GitHub owner/repository, not a URL or path')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'Missing DSH bundle patch')
  assert.deepEqual(manifest.bundledDependencies, ['qrcode', 'qrcode-terminal'])
  assert.deepEqual(manifest.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md', 'docs/portable'])
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-agent'], DSH_VERSION)
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, DSH_VERSION, 'Do not widen unverified DSH compatibility')
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.ok(!manifest.scripts?.[hook], `Precompiled Release packages must not require an ${hook} script`)
  }
  const asset = `${PACKAGE_NAME}-${manifest.version}.tgz`
  return {
    name: PACKAGE_NAME, version: manifest.version, tag, repository, asset,
    prerelease: manifest.version.includes('-'), dshVersion: DSH_VERSION,
    installUrl: `https://github.com/${repository}/releases/download/${tag}/${asset}`,
  }
}

function safePackagePath(path) {
  assert.ok(typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(path), 'Unsafe package path')
  assert.ok(path.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe package path')
  return path
}

export function validatePackResult(result, manifest) {
  const info = releaseInfo(manifest)
  assert.equal(result.name, info.name, 'Packed name mismatch')
  assert.equal(result.version, info.version, 'Packed version mismatch')
  assert.equal(basename(result.filename), info.asset, 'Packed filename mismatch')
  assert.ok(Array.isArray(result.files) && result.files.length > 0, 'Missing packed-file inventory')
  const files = new Set()
  const vendors = new Set()
  for (const entry of result.files) {
    const path = safePackagePath(entry.path)
    assert.ok(!files.has(path), `Duplicate packed path: ${path}`)
    files.add(path)
    const parts = path.split('/')
    let allowed = ROOT_FILES.has(path) || /^docs\/portable\/[^/]+\.md$/.test(path)
    if (parts[0] === 'lib') allowed = path.endsWith('.js') || path.endsWith('.d.ts')
    if (parts[0] === 'node_modules') {
      allowed = parts.length > 2 && BUNDLED_PACKAGES.includes(parts[1]) && !parts.slice(2).includes('node_modules')
      if (allowed) vendors.add(parts[1])
    }
    assert.ok(allowed, `Non-allowlisted packed file: ${path}`)
  }
  assert.deepEqual([...vendors].sort(), [...BUNDLED_PACKAGES].sort(), 'Bundled runtime dependency closure changed')
  const required = [
    ...ROOT_FILES, 'lib/index.js', 'lib/client.js', 'lib/host/control.js',
    'lib/client/remote.js', 'lib/bridge/main.js', 'lib/portable/cli.js',
    ...BUNDLED_PACKAGES.map(name => `node_modules/${name}/package.json`),
  ]
  for (const entry of [...Object.values(manifest.exports ?? {}), ...Object.values(manifest.bin ?? {})]) {
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(path.startsWith('./'), 'Release exports must be package-local')
      required.push(path.slice(2))
    }
  }
  for (const path of required) assert.ok(files.has(path), `Missing packed entry: ${path}`)
  return [...files].sort()
}

export function validatePayload(path, bytes) {
  assert.ok(bytes.length <= 10 * 1024 * 1024, `Unexpected oversized file: ${path}`)
  for (const sentinel of ['PRIVATE-SENTINEL-NEVER-SHARE', 'PACKAGE-PRIVATE-CANARY-71120c20-NOT-A-REAL-SECRET']) {
    assert.ok(!bytes.includes(Buffer.from(sentinel)), `Private test sentinel in package: ${path}`)
  }
  if (!path.startsWith('node_modules/')) {
    const text = bytes.toString('utf8')
    assert.ok(!/[A-Z]:[\\/]+(?:Users|DSH(?:%20| )wechat)[\\/]/i.test(text), `Personal absolute path in package: ${path}`)
    assert.ok(!/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text), `Personal absolute path in package: ${path}`)
  }
}

export function releaseNotes(info, sha256) {
  return `# ${info.name} ${info.version}\n\n` +
    `面向 **DSH Desktop ${info.dshVersion}** 的社区预览版，不宣称兼容其他 DSH 版本。\n\n` +
    `## 在 DSH 插件页安装\n\n` +
    `打开 **插件 → 添加插件**，在“包名或地址”粘贴以下完整链接（不是仓库主页，也不是 Source code ZIP）：\n\n` +
    `\`\`\`text\n${info.installUrl}\n\`\`\`\n\n` +
    `安装并启用后，完全退出再打开 DSH。在 **设置 → 微信桥接（Portable）** 中选择工作目录、扫码并手动启动。默认不自动绑定或启动。\n\n` +
    `升级前先停止旧桥接、备份配置，再按插件页提示卸载旧版并安装新版；不要删除私有数据目录，同设备保留原绑定时无需重新扫码。\n\n` +
    `如果 DSH 无法访问 GitHub，请手动下载下面的 .tgz，核对 SHA-256 后在同一输入框填写本地绝对路径。更换 npm 镜像不能代替访问 GitHub Release。\n\n` +
    `## 校验与边界\n\n` +
    `\`\`\`text\n${sha256}  ${info.asset}\n\`\`\`\n\n` +
    `安装包包含编译后的 Host、Client 和二维码运行依赖；不包含 DSH、模型、微信凭据或会话。无需在使用者电脑上编译源码。\n\n` +
    `自动化构建和打包检查不等同于真实桌面/微信验收，也不是安全签名。先在测试账号和专用工作目录中验收；不要添加版本豁免。\n\n` +
    `[安装与迁移](https://github.com/${info.repository}/blob/${info.tag}/docs/portable/INSTALL-MIGRATE.md) · ` +
    `[验证边界](https://github.com/${info.repository}/blob/${info.tag}/docs/portable/VALIDATION.md)\n`
}

export function parseArgs(args) {
  const result = {}
  const fields = { '--tag': 'tag', '--repository': 'repository', '--out-dir': 'outDir' }
  for (let i = 0; i < args.length; i += 2) {
    const field = fields[args[i]]
    assert.ok(typeof field === 'string' && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--') && !Object.hasOwn(result, field),
      'Usage: pnpm run release:pack [--tag vVERSION] [--repository OWNER/REPO] [--out-dir dist/DIRECTORY]')
    result[field] = args[i + 1]
  }
  return result
}

function run(script, args, stdio = 'inherit') {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio, shell: false })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${basename(script)} failed (${result.status})`)
}

export function prepareOutputDirectory(projectRoot, requested = 'dist/release') {
  const project = resolve(projectRoot)
  const output = resolve(project, requested)
  const outputRelative = relative(join(project, 'dist'), output)
  assert.ok(outputRelative && !isAbsolute(outputRelative) && outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`), 'Release output must be a subdirectory of dist/')
  const canonicalRoot = realpathSync.native(project)
  const parts = relative(project, output).split(sep)
  function checkAncestors() {
    let current = project
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i])
      let stat
      try { stat = lstatSync(current) } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Release output must not pass through links or files')
      // native realpath also detects Windows junctions not exposed as symbolic links.
      assert.equal(relative(join(canonicalRoot, ...parts.slice(0, i + 1)), realpathSync.native(current)), '',
        'Release output must not escape through links')
    }
  }
  // Check every existing ancestor BEFORE listing or creating anything under it.
  checkAncestors()
  assert.ok(!existsSync(output) || readdirSync(output).length === 0, 'Output directory must be new or empty')
  mkdirSync(output, { recursive: true })
  checkAncestors()
  return output
}

export function buildRelease(options = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const info = releaseInfo(manifest, options)
  const pnpm = process.env.npm_execpath
  assert.ok(pnpm && /\.[cm]?js$/.test(pnpm) && existsSync(pnpm), 'Run with pnpm run release:pack (JavaScript pnpm launcher required)')
  assert.equal(process.env.npm_config_user_agent?.split(' ')[0], manifest.packageManager.replace('@', '/'), 'Use the pinned pnpm version')
  // Never delete or silently replace a previous release. Choose a new --out-dir.
  const output = prepareOutputDirectory(root, options.outDir)

  // Verify once, then pack with scripts disabled: do not run prepack twice.
  run(join(root, 'scripts', 'verify.mjs'), [])
  const inventoryPath = join(output, '.pack-result.json')
  const fd = openSync(inventoryPath, 'wx')
  try {
    // File-backed stdout avoids captured child-process pipes in the Windows sandbox.
    run(pnpm, ['pack', '--config.ignore-scripts=true', '--json', '--pack-destination', output], ['inherit', fd, 'inherit'])
  } finally { closeSync(fd) }
  const result = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  const files = validatePackResult(result, manifest)
  const assetPath = join(output, info.asset)
  assert.equal(resolve(root, result.filename), assetPath, 'Unexpected pack output path')
  for (const path of files) validatePayload(path, readFileSync(join(root, ...path.split('/'))))
  const sha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex')
  const metadata = {
    'SHA256SUMS.txt': `${sha256}  ${info.asset}\n`,
    'INSTALL-URL.txt': `${info.installUrl}\n`,
    'RELEASE-NOTES.md': releaseNotes(info, sha256),
    'PACKAGE-FILES.txt': files.join('\n') + '\n',
    'RELEASE-AUDIT.json': JSON.stringify({
      ...info, sha256, files: files.length, bundledPackages: BUNDLED_PACKAGES,
      inventoryAllowlistPassed: true, payloadScanPassed: true,
      note: 'Inventory comes from pnpm pack; payload scan reads its source files. No live DSH/WeChat or remote Release test was performed.',
    }, null, 2) + '\n',
  }
  for (const [name, text] of Object.entries(metadata)) writeFileSync(join(output, name), text, { flag: 'wx' })
  // This is the exact private stdout file created above, never a computed tree deletion.
  assert.equal(dirname(inventoryPath), output)
  assert.equal(basename(inventoryPath), '.pack-result.json')
  unlinkSync(inventoryPath)
  console.log(`Release assets verified: ${relative(root, output)}\nInstall URL (available only after publication): ${info.installUrl}`)
  return { ...info, sha256, output }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRelease(parseArgs(process.argv.slice(2)))
}
