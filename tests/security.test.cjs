const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-security-test-'))
process.env.DSH_BRIDGE_DATA_DIR = path.join(root, 'state')
const { saveInboundMedia, validateOutboundFile } = require('../lib/bridge/safe-files.js')
const { readLimitedBody, buildCdnDownloadUrl } = require('../lib/bridge/wechat/cdn.js')
const { decideTrust, isPlausibleUserId } = require('../lib/bridge/trust.js')
const { redact } = require('../lib/bridge/logger.js')
const { routeCommand } = require('../lib/bridge/commands/router.js')
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace)
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('dsh-security-test-'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('owner-only ignores stale explicit trust and inherited object properties', () => {
  const trusted = { owner2: { addedAt: 'today', by: 'owner' } }
  assert.equal(decideTrust({ fromUserId: 'owner2', ownerUserId: 'owner1', file: { mode: 'owner-only', trusted } }).allowed, false)
  for (const id of ['constructor', '__proto__', 'prototype', 'toString']) {
    assert.equal(isPlausibleUserId(id), false)
    assert.equal(decideTrust({ fromUserId: id, ownerUserId: 'owner1', file: { mode: 'manual', trusted: {} } }).allowed, false)
  }
  assert.equal(decideTrust({ fromUserId: 'owner2', ownerUserId: '', file: { mode: 'manual', trusted } }).allowed, false)
})

test('alpha command surface cannot enable other users', async () => {
  for (const text of ['/trust owner2', '/trustmode manual', '/trustmode bootstrap', '/distrust owner1']) {
    const result = await routeCommand({ text })
    assert.equal(result.handled, true)
    assert.equal(result.setTrustMode, undefined)
    assert.match(result.reply, /仅供扫码绑定者/)
  }
})

test('remote filenames cannot traverse, choose a device path, or overwrite an attachment', () => {
  const contents = Buffer.from('safe test bytes')
  const outputs = ['../../overwrite.txt', '..\\..\\overwrite.txt', 'C:\\Windows\\win.ini', '/etc/passwd', 'CON', 'x.txt:stream']
    .map(name => saveInboundMedia(contents, name))
  for (const file of outputs) {
    assert.equal(path.dirname(file), path.join(process.env.DSH_BRIDGE_DATA_DIR, 'media'))
    assert.match(path.basename(file), /^media-[0-9a-f-]+\.[a-z0-9]{1,8}$/)
    assert.deepEqual(fs.readFileSync(file), contents)
  }
  assert.equal(new Set(outputs).size, outputs.length)
  assert.equal(fs.existsSync(path.join(root, 'overwrite.txt')), false)
})

test('outbound files require explicit workspace containment and supported regular files', () => {
  const report = path.join(workspace, 'report.txt')
  fs.writeFileSync(report, 'report')
  assert.equal(validateOutboundFile('report.txt', workspace), fs.realpathSync(report))
  const sibling = path.join(root, 'outside.txt')
  fs.writeFileSync(sibling, 'private')
  assert.throws(() => validateOutboundFile(sibling, workspace), /outside/)
  fs.writeFileSync(path.join(workspace, '.env'), 'private')
  fs.writeFileSync(path.join(workspace, 'credentials.txt'), 'private')
  fs.writeFileSync(path.join(workspace, 'script.ps1'), 'private')
  assert.throws(() => validateOutboundFile('.env', workspace), /Hidden/)
  assert.throws(() => validateOutboundFile('script.ps1', workspace), /type/)
  assert.throws(() => validateOutboundFile(workspace, workspace), /regular/)
  assert.throws(() => validateOutboundFile('\\\\server\\share\\file.txt', workspace), /Network/)
  assert.throws(() => validateOutboundFile(report, workspace, workspace), /Private/)
  const huge = path.join(workspace, 'large.pdf')
  fs.writeFileSync(huge, '')
  fs.truncateSync(huge, 25 * 1024 * 1024 + 1)
  assert.throws(() => validateOutboundFile(huge, workspace), /25 MiB/)
  assert.throws(() => saveInboundMedia(Buffer.alloc(25 * 1024 * 1024 + 1), 'large.pdf'), /25 MiB/)
})

test('junction/symlink escape is rejected', t => {
  const outside = path.join(root, 'other')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private')
  const link = path.join(workspace, 'link')
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Platform does not permit test symlink creation'); return }
    throw error
  }
  assert.throws(() => validateOutboundFile(path.join(link, 'secret.txt'), workspace), /outside|Symbolic/)
})

test('download stream caps apply without a Content-Length header', async () => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(7)); controller.enqueue(new Uint8Array(7)); controller.close()
  }}))
  await assert.rejects(readLimitedBody(response, 10), /size limit/)
  await assert.rejects(readLimitedBody(new Response('abc', { headers: { 'content-length': '100' } }), 10), /size limit/)
  assert.equal((await readLimitedBody(new Response('abc'), 10)).toString(), 'abc')
  assert.throws(() => buildCdnDownloadUrl('https://evil.invalid?a=1#fragment'))
  assert.match(buildCdnDownloadUrl('A+B='), /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\//)
})

test('credential and QR log redaction covers camelCase and flat key names', () => {
  const value = redact({ botToken: 'CANARY', bot_token: 'CANARY', aeskey: 'CANARY', aes_key: 'CANARY', qrcodeId: 'CANARY', contextToken: 'CANARY', apiKey: 'CANARY' })
  assert.ok(!value.includes('CANARY'))
  assert.equal(redact('Authorization: Bearer CANARY'), 'Authorization: Bearer ***')
})
