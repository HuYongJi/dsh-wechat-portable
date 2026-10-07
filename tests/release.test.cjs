const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, existsSync } = require('node:fs')
const { join, dirname, basename, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { BUNDLED_PACKAGES, releaseInfo, validatePackResult, validatePayload, releaseNotes, parseArgs, prepareOutputDirectory } = require('../scripts/release.mjs')
const source = require('../package.json')
const manifest = () => structuredClone(source)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-release-test-'))
after(() => {
  assert.equal(dirname(temporaryRoot), resolve(tmpdir()))
  assert.ok(basename(temporaryRoot).startsWith('dsh-release-test-'))
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function projectFixture(name) {
  const project = join(temporaryRoot, name)
  mkdirSync(project)
  return project
}

// The output helper must reject a junction before mkdir/readdir touches its target.
test('output stays in dist and previous artifacts are never overwritten', () => {
  const project = projectFixture('regular')
  for (const path of ['dist', '../escape', 'dist/../../escape']) {
    assert.throws(() => prepareOutputDirectory(project, path), /subdirectory/)
  }
  const output = prepareOutputDirectory(project, 'dist/中文 preview')
  assert.equal(output, join(project, 'dist', '中文 preview'))
  writeFileSync(join(output, 'keep.txt'), 'original')
  assert.throws(() => prepareOutputDirectory(project, 'dist/中文 preview'), /new or empty/)
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'original')
})

for (const nested of [false, true]) test(`linked ${nested ? 'nested ancestor' : 'dist'} is rejected before any outside write`, () => {
  const project = projectFixture(nested ? 'nested-link' : 'dist-link')
  const outside = projectFixture(nested ? 'outside-nested' : 'outside-dist')
  writeFileSync(join(outside, 'keep.txt'), 'unchanged')
  const link = nested ? join(project, 'dist', 'linked') : join(project, 'dist')
  if (nested) mkdirSync(join(project, 'dist'))
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const target = nested ? 'dist/linked/must-not-exist/leaf' : 'dist/must-not-exist/leaf'
  assert.throws(() => prepareOutputDirectory(project, target), /links/)
  assert.equal(existsSync(join(outside, 'must-not-exist')), false)
  assert.deepEqual(readdirSync(outside), ['keep.txt'])
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'unchanged')
})

function inventory(pkg = manifest()) {
  const files = new Set([
    'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md',
    'docs/portable/INSTALL-MIGRATE.md', 'lib/index.js', 'lib/client.js',
    'lib/host/control.js', 'lib/client/remote.js', 'lib/bridge/main.js', 'lib/portable/cli.js',
    ...BUNDLED_PACKAGES.map(name => `node_modules/${name}/package.json`),
  ])
  for (const entry of [...Object.values(pkg.exports), ...Object.values(pkg.bin)]) {
    for (const path of typeof entry === 'string' ? [entry] : Object.values(entry)) files.add(path.slice(2))
  }
  return { name: pkg.name, version: pkg.version, filename: releaseInfo(pkg).asset, files: [...files].map(path => ({ path })) }
}

test('release link names the exact repository, version tag and prebuilt tarball', () => {
  const pkg = manifest()
  const info = releaseInfo(pkg)
  assert.equal(info.installUrl, `https://github.com/HuYongJi/dsh-wechat-portable/releases/download/v${pkg.version}/dsh-wechat-portable-${pkg.version}.tgz`)
  assert.equal(info.prerelease, true)
  assert.equal(info.dshVersion, '0.2.0-rc.2')
  assert.equal(releaseInfo(pkg, { repository: 'example-owner/portable-fork' }).repository, 'example-owner/portable-fork')
  pkg.version = '1.0.0'
  assert.equal(releaseInfo(pkg).prerelease, false)
})

test('tag/package mismatch, unsafe versions and repository strings fail before building', () => {
  assert.throws(() => releaseInfo(manifest(), { tag: 'v0.9.1' }), /exactly match/)
  for (const version of ['../escape', '1.2.3+metadata', '01.2.3', '1.2', '1.2.3-alpha.01', '1.2.3-']) {
    assert.throws(() => releaseInfo({ ...manifest(), version }), /SemVer/)
  }
  for (const repository of ['https://github.com/o/r', '../other', 'owner/repo/extra', 'owner/repo\n', 'owner/repo?token=x', '-bad/repo', '']) {
    assert.throws(() => releaseInfo(manifest(), { repository }), /owner\/repository/)
  }
})

test('release refuses widened DSH compatibility, a wrong bundle or install-time builds', () => {
  for (const hook of ['install', 'preinstall', 'postinstall', 'prepare']) {
    const pkg = manifest()
    pkg.scripts[hook] = 'node unreviewed-script.js'
    assert.throws(() => releaseInfo(pkg), /must not require/)
  }
  const wide = manifest()
  wide.peerDependencies['@deepseek-ai/dsh-session'] = '*'
  assert.throws(() => releaseInfo(wide), /compatibility/)
  const noPatch = manifest()
  delete noPatch.dsh.bundle
  assert.throws(() => releaseInfo(noPatch), /bundle patch/)
  const broadFiles = manifest()
  broadFiles.files.push('data')
  assert.throws(() => releaseInfo(broadFiles))
})

test('release command accepts only explicit known options with values', () => {
  assert.deepEqual(parseArgs([]), {})
  assert.deepEqual(parseArgs(['--tag', 'v1.0.0', '--repository', 'owner/repo', '--out-dir', 'dist/路径 with spaces']),
    { tag: 'v1.0.0', repository: 'owner/repo', outDir: 'dist/路径 with spaces' })
  for (const args of [['--tag'], ['--skip-tests'], ['--tag', '--out-dir'], ['--tag', 'x', '--tag', 'y'], ['extra'], ['toString', 'x'], ['__proto__', 'x']]) {
    assert.throws(() => parseArgs(args), /Usage/)
  }
})

test('packed inventory contains all declared exports, native remotes and bundled runtimes', () => {
  const pkg = manifest()
  const result = inventory(pkg)
  const files = validatePackResult(result, pkg)
  assert.ok(files.includes('lib/client.js'))
  assert.ok(files.includes('lib/host/control.js'))
  assert.ok(files.includes('node_modules/qrcode/package.json'))
  assert.deepEqual(files, [...files].sort())
})

test('missing compiled entry or bundled dependency rejects the release', () => {
  for (const missing of ['lib/index.js', 'lib/client.js', 'lib/host/control.js', 'lib/client/remote.js',
    'lib/bridge/main.js', 'lib/types/index.d.ts', 'cordis.patch.yml', 'node_modules/qrcode/package.json']) {
    const result = inventory()
    result.files = result.files.filter(file => file.path !== missing)
    assert.throws(() => validatePackResult(result, manifest()), /Missing packed|dependency closure/)
  }
})

test('private state, developer files, SDKs and unsafe paths cannot enter the release', () => {
  for (const path of ['accounts.json', '.env', '.npmrc', '.git/config', 'data/config.json',
    'logs/bridge.log', 'tests/fixture.pem', 'src/index.ts', 'lib/accounts.json',
    'node_modules/@deepseek-ai/dsh-agent/package.json', 'node_modules/unknown/index.js',
    'node_modules/qrcode/node_modules/unknown/index.js', '/lib/index.js', '../lib/index.js',
    'lib/../private.js', 'lib\\private.js', 'C:/private.js', 'lib//index.js', 'lib/bad\n.js']) {
    const result = inventory()
    result.files.push({ path })
    assert.throws(() => validatePackResult(result, manifest()), /Unsafe|Non-allowlisted/)
  }
})

test('wrong package identity and duplicate paths are rejected', () => {
  for (const field of ['name', 'version', 'filename']) {
    const result = inventory()
    result[field] = 'wrong'
    assert.throws(() => validatePackResult(result, manifest()), /mismatch/)
  }
  const result = inventory()
  result.files.push(result.files[0])
  assert.throws(() => validatePackResult(result, manifest()), /Duplicate/)
})

test('payload scan rejects test sentinels, personal paths and oversized files', () => {
  validatePayload('lib/index.js', Buffer.from('export const name = "portable"'))
  for (const text of ['PRIVATE-SENTINEL-NEVER-SHARE', 'PACKAGE-PRIVATE-CANARY-71120c20-NOT-A-REAL-SECRET',
    'C:\\Users\\example\\token', 'E:/DSH wechat/private', '/home/example/private', '/Users/example/private']) {
    assert.throws(() => validatePayload('lib/index.js', Buffer.from(text)), /sentinel|absolute path/)
  }
  assert.throws(() => validatePayload('lib/index.js', Buffer.alloc(10 * 1024 * 1024 + 1)), /oversized/)
})

test('release notes expose installable asset URL, checksum and explicit validation limits', () => {
  const info = releaseInfo(manifest())
  const checksum = 'a'.repeat(64)
  const notes = releaseNotes(info, checksum)
  assert.ok(notes.includes(info.installUrl))
  assert.ok(notes.includes(`${checksum}  ${info.asset}`))
  assert.ok(notes.includes('插件 → 添加插件'))
  assert.ok(notes.includes('DSH Desktop 0.2.0-rc.2'))
  assert.ok(notes.includes('不等同于真实桌面/微信验收'))
  assert.ok(notes.includes('更换 npm 镜像不能代替访问 GitHub'))
})

test('workflows use frozen pnpm and no longer publish to npm', () => {
  const workflow = name => readFileSync(join(__dirname, '..', '.github', 'workflows', name), 'utf8')
  for (const text of [workflow('ci.yml'), workflow('publish.yml')]) {
    assert.match(text, /pnpm install --frozen-lockfile --ignore-scripts/)
    assert.match(text, /pnpm run release:pack/)
    assert.doesNotMatch(text, /npm ci|npm publish|id-token:\s*write/)
  }
  const text = workflow('publish.yml')
  assert.match(text, /needs: build/)
  assert.match(text, /--verify-tag/)
  assert.match(text, /--prerelease --latest=false/)
  assert.doesNotMatch(text, /--clobber/)
})
