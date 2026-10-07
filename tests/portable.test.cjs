const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-portable-test-'))
process.env.DSH_BRIDGE_DATA_DIR = path.join(root, 'private')
const { resolveDataDir, atomicJson } = require('../lib/portable/paths.js')
const { exportSettings, parseSettings, importSettings, writeSettingsExport, MAX_SETTINGS_BYTES } = require('../lib/portable/settings.js')
const { saveAccount, loadLatestAccount } = require('../lib/bridge/wechat/accounts.js')
const envelope = (settings = {}) => JSON.stringify({ format: 'dsh-wechat-portable-settings', schemaVersion: 1, settings })
const workspace = path.join(root, '另一台设备 workspace')
fs.mkdirSync(workspace)
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('dsh-portable-test-'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('profile defaults and explicit data directories remain isolated', () => {
  const home = path.join(root, 'home')
  assert.equal(resolveDataDir(undefined, { DSH_HOME: home, DSH_PROFILE: 'desktop' }), path.join(home, 'profiles', 'desktop', 'wechat-portable'))
  assert.notEqual(resolveDataDir(undefined, { DSH_HOME: home, DSH_PROFILE: 'desktop' }), resolveDataDir(undefined, { DSH_HOME: home, DSH_PROFILE: 'other' }))
  assert.equal(resolveDataDir(path.join(root, 'custom')), path.join(root, 'custom'))
  assert.throws(() => resolveDataDir('relative'))
  assert.throws(() => resolveDataDir(undefined, { DSH_HOME: home, DSH_PROFILE: '../escape' }))
  assert.throws(() => resolveDataDir(path.parse(root).root))
  assert.throws(() => resolveDataDir('\\\\server\\share'))
})

test('positive export whitelist excludes every private sentinel and free-text preference', () => {
  const privateValue = 'PRIVATE-SENTINEL-NEVER-SHARE'
  const result = exportSettings({ workingDirectory: privateValue, systemPrompt: privateValue, model: privateValue,
    botToken: privateValue, accounts: privateValue, trusted: privateValue, logs: privateValue,
    sessions: privateValue, endpoint: privateValue, usageFooter: true, notifyRejected: false,
    calm: { enabled: false, silenceMs: 120000, intervalMs: 180000, maxCount: 2, messages: [privateValue] } })
  assert.ok(!JSON.stringify(result).includes(privateValue))
  assert.deepEqual(parseSettings(JSON.stringify(result)), result)
  assert.equal(Object.keys(result).join(','), 'format,schemaVersion,settings')
})

for (const [label, text] of [
  ['malformed JSON', '{'], ['oversize', ' '.repeat(MAX_SETTINGS_BYTES + 1)],
  ['unknown version', '{"format":"dsh-wechat-portable-settings","schemaVersion":2,"settings":{}}'],
  ['prototype pollution', envelope(JSON.parse('{"__proto__":{"polluted":true}}'))],
  ['constructor pollution', envelope({ constructor: { prototype: { polluted: true } } })],
  ['unknown executable field', envelope({ command: 'do-not-run' })],
  ['path import', envelope({ workingDirectory: workspace })],
  ['permission import', envelope({ sandbox: 'danger-full-access' })],
  ['credential import', envelope({ botToken: 'secret' })],
  ['string boolean', envelope({ usageFooter: 'yes' })],
  ['unbounded timer', envelope({ calm: { silenceMs: 1 } })],
  ['unknown nested field', envelope({ calm: { messages: ['private free text'] } })],
  ['array envelope', '[]'], ['null preferences', envelope(null)],
]) test(`reject ${label} before any state mutation`, () => {
  const state = path.join(root, 'reject')
  assert.throws(() => importSettings(state, text, workspace, true))
  assert.equal(fs.existsSync(state), false)
  assert.equal({}.polluted, undefined)
})

test('preview has no write/start side effect; confirmed import preserves local-only data', () => {
  const state = path.join(root, 'target')
  importSettings(state, envelope({ usageFooter: false }), workspace)
  assert.equal(fs.existsSync(state), false)
  atomicJson(path.join(state, 'config.json'), { model: 'local-model', systemPrompt: 'local-only' })
  atomicJson(path.join(state, 'accounts', 'account123.json'), { botToken: 'local-token' })
  importSettings(state, envelope({ usageFooter: false }), workspace, true)
  const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'))
  assert.equal(config.workingDirectory, fs.realpathSync(workspace))
  assert.equal(config.usageFooter, false)
  assert.equal(config.model, 'local-model')
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'accounts', 'account123.json'), 'utf8')).botToken, 'local-token')
  assert.equal(fs.existsSync(path.join(state, 'daemon.pid')), false)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(state).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(state, 'config.json')).mode & 0o777, 0o600)
  }
})

test('running marker prevents imports; exports never overwrite files or private state', () => {
  const state = path.join(root, 'running')
  atomicJson(path.join(state, 'config.json'), { usageFooter: true })
  fs.writeFileSync(path.join(state, 'daemon.pid'), '123')
  assert.throws(() => importSettings(state, envelope(), workspace, true), /Stop the bridge/)
  assert.throws(() => writeSettingsExport(state, path.join(state, 'config.json')))
  const out = path.join(root, 'share.json')
  writeSettingsExport(state, out)
  assert.throws(() => writeSettingsExport(state, out), /EEXIST/)
})

test('QR/account helpers honor explicit directory without process.env changes', async () => {
  const alternate = path.join(root, 'custom account state')
  const account = { botToken: 'test-only', accountId: 'account123', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'owner123', createdAt: new Date().toISOString() }
  saveAccount(account, alternate)
  assert.deepEqual(loadLatestAccount(alternate), account)
  assert.equal(loadLatestAccount(), null)
  // Pure response fixture: must never accidentally make a live login request.
  const { parseQrStatusResponse } = require('../lib/bridge/wechat/login.js')
  const qrState = path.join(root, 'qr custom')
  const result = parseQrStatusResponse({ ret: 0, status: 'confirmed', bot_token: 'test-qr-token', ilink_bot_id: 'qraccount1', ilink_user_id: 'owner123' }, qrState)
  assert.equal(result.status, 'confirmed')
  assert.equal(loadLatestAccount(qrState).botToken, 'test-qr-token')
  assert.equal(loadLatestAccount(), null)
  assert.equal(fs.existsSync(process.env.DSH_BRIDGE_DATA_DIR), false)
})

test('CLI runs from paths with spaces/non-ASCII and previews without writes', () => {
  const state = path.join(root, 'CLI 私有状态')
  const input = path.join(root, '配置 示例.json')
  fs.writeFileSync(input, envelope({ usageFooter: false }))
  const cli = path.resolve(__dirname, '../lib/portable/cli.js')
  const args = [cli, 'import', input, '--workspace', workspace, '--data-dir', state]
  const preview = spawnSync(process.execPath, args, { cwd: workspace, stdio: 'ignore' })
  assert.ifError(preview.error)
  assert.equal(preview.status, 0)
  assert.equal(fs.existsSync(state), false)
  const confirmed = spawnSync(process.execPath, [...args, '--confirm'], { cwd: workspace, stdio: 'ignore' })
  assert.ifError(confirmed.error)
  assert.equal(confirmed.status, 0)
  assert.equal(fs.existsSync(path.join(state, 'config.json')), true)
})
