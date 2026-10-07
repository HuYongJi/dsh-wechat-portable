'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { syncBuiltinESMExports } = require('node:module')
const { spawnSync } = require('node:child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-login-test-'))
process.env.DSH_WECHAT_PORTABLE_DATA_DIR = path.join(root, 'private')
const { requestLoginJson, MAX_LOGIN_RESPONSE_BYTES } = require('../lib/bridge/wechat/login-transport.js')
const { WechatLoginError, safeLoginFailure } = require('../lib/bridge/wechat/login-errors.js')
const { startQrLogin, parseQrStartResponse, parseQrStatusResponse } = require('../lib/bridge/wechat/login.js')
const cert = path.join(__dirname, 'fixtures/localhost-test-cert.pem')
const key = path.join(__dirname, 'fixtures/localhost-test-key.pem')
const trusted = process.argv.includes('--trusted-fixture')
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('dsh-login-test-'))
  fs.rmSync(root, { recursive: true, force: true })
})
async function fixture(handler, operation) {
  const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler)
  server.on('tlsClientError', () => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await operation(`https://localhost:${server.address().port}`, server.address().port) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
const kind = expected => error => error instanceof WechatLoginError && error.kind === expected

if (trusted) {
  test('trusted local TLS succeeds with env=0; POST body and env remain unchanged', async () => {
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
    await fixture((req, res) => {
      assert.equal(req.method, 'POST')
      assert.equal(req.headers['accept-encoding'], 'identity')
      let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
        assert.deepEqual(JSON.parse(body), { local_token_list: [] })
        res.end(JSON.stringify({ ok: true }))
      })
    }, async url => assert.deepEqual(await requestLoginJson(url, 3000, '{"local_token_list":[]}'), { ok: true }))
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
  })
  test('trusted CA does not disable certificate hostname validation', async () => {
    await fixture((req, res) => res.end('{}'), async (url, port) => {
      await assert.rejects(requestLoginJson(`https://127.0.0.1:${port}`, 3000), kind('certificate'))
    })
  })
  test('HTTPS redirects and HTTP failures are refused without following Location', async () => {
    let followed = false
    await fixture((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/destination?secret=fixture-only' }); res.end() }
      else if (req.url === '/destination?secret=fixture-only') { followed = true; res.end('{}') }
      else { res.writeHead(503); res.end('private-response-must-not-leak') }
    }, async url => {
      await assert.rejects(requestLoginJson(url + '/redirect', 3000), kind('redirect'))
      await assert.rejects(requestLoginJson(url + '/failure', 3000), kind('http'))
      assert.equal(followed, false)
    })
  })
  test('body is bounded at exactly 64 KiB including chunked responses', async () => {
    await fixture((req, res) => {
      if (req.url === '/exact') res.end(JSON.stringify({ a: 'x'.repeat(MAX_LOGIN_RESPONSE_BYTES - 8) }))
      else if (req.url === '/declared') { res.writeHead(200, { 'Content-Length': MAX_LOGIN_RESPONSE_BYTES + 1 }); res.flushHeaders() }
      else { res.write(' '); res.end('x'.repeat(MAX_LOGIN_RESPONSE_BYTES)) }
    }, async url => {
      assert.equal((await requestLoginJson(url + '/exact', 3000)).a.length, MAX_LOGIN_RESPONSE_BYTES - 8)
      for (const suffix of ['/declared', '/chunked']) await assert.rejects(requestLoginJson(url + suffix, 3000), kind('oversized'))
    })
  })
  test('full deadline covers stalled headers and stalled response body', async () => {
    let bodyStarted = false
    await fixture((req, res) => {
      if (req.url === '/body') { bodyStarted = true; res.writeHead(200); res.flushHeaders(); res.write('{') }
    }, async url => {
      await assert.rejects(requestLoginJson(url + '/headers', 300), kind('timeout'))
      await assert.rejects(requestLoginJson(url + '/body', 300), kind('timeout'))
      assert.equal(bodyStarted, true)
    })
  })
  test('premature close and malformed/nonobject JSON fail safely', async () => {
    await fixture((req, res) => {
      if (req.url === '/close') { res.writeHead(200, { 'Content-Length': 500 }); res.write('{'); res.socket.destroy() }
      else if (req.url === '/array') res.end('[]')
      else res.end('not JSON: private-response-must-not-leak')
    }, async url => {
      await assert.rejects(requestLoginJson(url + '/close', 3000), kind('network'))
      await assert.rejects(requestLoginJson(url + '/array', 3000), kind('malformed'))
      await assert.rejects(requestLoginJson(url + '/bad', 3000), kind('malformed'))
    })
  })
} else {
  test('untrusted TLS is still rejected when process-wide verification is disabled', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try { await fixture((req, res) => res.end('{}'), async url => assert.rejects(requestLoginJson(url, 3000), kind('certificate'))) }
    finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous }
  })
  test('real trusted TLS transport matrix in isolated CA-scoped process', () => {
    const result = spawnSync(process.execPath, [__filename, '--trusted-fixture'], {
      stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    })
    assert.ifError(result.error); assert.equal(result.status, 0)
  })
  test('fresh QR request is strict POST with empty token list and optional ret', async () => {
    const original = https.request
    let invoked = false
    https.request = (url, options, callback) => {
      assert.equal(url.hostname, 'ilinkai.weixin.qq.com')
      assert.equal(url.pathname, '/ilink/bot/get_bot_qrcode')
      assert.equal(url.searchParams.get('bot_type'), '3')
      assert.equal(options.method, 'POST')
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.agent.options.rejectUnauthorized, true)
      assert.equal(options.headers.Authorization, undefined)
      const req = new EventEmitter(); req.destroy = () => {}
      req.end = body => {
        assert.deepEqual(JSON.parse(body), { local_token_list: [] }); invoked = true
        queueMicrotask(() => {
          const res = Readable.from([Buffer.from('{"qrcode":"fixture-id","qrcode_img_content":"https://example.invalid/fixture"}')])
          res.statusCode = 200; res.headers = {}; callback(res)
        })
      }
      return req
    }
    syncBuiltinESMExports()
    try { assert.equal((await startQrLogin()).qrcodeId, 'fixture-id'); assert.equal(invoked, true) }
    finally { https.request = original; syncBuiltinESMExports() }
  })
  test('QR shape accepts absent/numeric-zero ret and rejects malformed statuses', () => {
    const valid = { qrcode: 'fixture-id', qrcode_img_content: 'https://example.invalid/fixture' }
    for (const data of [valid, { ...valid, ret: 0 }]) assert.equal(parseQrStartResponse(data).qrcodeId, 'fixture-id')
    for (const ret of [null, '0', false, 1, -1]) assert.throws(() => parseQrStartResponse({ ...valid, ret }), kind('rejected'))
    for (const data of [{}, { ...valid, qrcode: '' }, { ...valid, qrcode: 'with space' }]) assert.throws(() => parseQrStartResponse(data), kind('malformed'))
  })
  test('unsupported phone challenges and redirects terminate with fixed messages', () => {
    for (const status of ['need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect', 'unknown-fixture']) {
      const response = parseQrStatusResponse({ status, redirect_host: 'private-response-must-not-leak', message: 'private-response-must-not-leak' })
      assert.equal(response.status, 'error'); assert.equal(response.retryable, false)
      assert.ok(!JSON.stringify(response).includes('private-response'))
    }
  })
  test('rejected, expired-owner, and untrusted-base confirmations never persist credentials', () => {
    const confirmed = { status: 'confirmed', bot_token: 'fixture-token', ilink_bot_id: 'fixturebot', ilink_user_id: 'fixtureowner' }
    for (const data of [{ ...confirmed, ret: 1 }, { ...confirmed, baseurl: 'https://evil.invalid' }, { ...confirmed, baseurl: 'http://ilinkai.weixin.qq.com' }, { ...confirmed, baseurl: 'https://ilinkai.weixin.qq.com@evil.invalid' }, { ...confirmed, baseurl: 'https://weixin.qq.com.evil.invalid' }]) {
      const target = path.join(root, 'rejected')
      assert.equal(parseQrStatusResponse(data, target).status, 'error'); assert.equal(fs.existsSync(target), false)
    }
    const late = path.join(root, 'late')
    assert.equal(parseQrStatusResponse(confirmed, late, () => false).status, 'expired')
    assert.equal(fs.existsSync(late), false)
  })
  test('safe diagnostics cannot echo exception-message secrets', () => {
    const error = new WechatLoginError('certificate'); error.message = 'private-response-must-not-leak'
    assert.match(safeLoginFailure(error), /证书/)
    assert.ok(!safeLoginFailure(error).includes('private-response'))
  })
}
