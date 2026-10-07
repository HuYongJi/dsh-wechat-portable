const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { assertPanelRequest, readJsonBody, PromptReplay, safeInitialPermissions, persistedPreset,
  assistantTextDelta, deferHostTask, requireLoopbackHost, isOwnerSessionKey } = require('../lib/host-compat.js')
const request = (extra = {}) => ({ method: 'POST', headers: { host: 'localhost:19387', origin: 'http://localhost:19387',
  'content-type': 'application/json', 'x-dsh-wechat-csrf': '1', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '127.0.0.1' }, ...extra })

test('panel mutations require method, loopback, exact Origin and custom CSRF header', () => {
  assert.doesNotThrow(() => assertPanelRequest(request(), ['POST']))
  assert.throws(() => assertPanelRequest(request({ method: 'GET' }), ['POST']))
  for (const change of [ { origin: 'null' }, { origin: 'https://evil.invalid' }, { host: 'evil.invalid' },
    { origin: 'http://localhost:9999' }, { 'x-dsh-wechat-csrf': undefined }, { 'sec-fetch-site': 'cross-site' },
    { 'content-type': 'text/plain' } ]) {
    const req = request(); req.headers = { ...req.headers, ...change }
    assert.throws(() => assertPanelRequest(req, ['POST']))
  }
  assert.throws(() => assertPanelRequest(request({ socket: { remoteAddress: '192.0.2.1' } }), ['POST']))
  assert.throws(() => requireLoopbackHost('0.0.0.0'))
})

test('bounded JSON reader rejects large or non-object input', async () => {
  function input(text, headers = {}) { const req = Readable.from([Buffer.from(text)]); req.headers = headers; return req }
  assert.deepEqual(await readJsonBody(input('{"value":1}')), { value: 1 })
  await assert.rejects(readJsonBody(input('123')))
  await assert.rejects(readJsonBody(input('[]')))
  await assert.rejects(readJsonBody(input(' '.repeat(11)), 10), /large/)
  await assert.rejects(readJsonBody(input('{}', { 'content-length': '100' }), 10), /large/)
})

test('fast terminal events replay after subscription without cross-prompt residue', () => {
  const replay = new PromptReplay()
  replay.push({ type: 'chunk', text: 'complete before client connects' })
  replay.push({ type: 'done', terminal: 'error' })
  assert.equal(replay.snapshot().entries.length, 2)
  const lastId = replay.snapshot().entries[1].id
  assert.equal(replay.snapshot(lastId).entries.length, 0)
  replay.reset()
  assert.deepEqual(replay.snapshot().entries, [])
  replay.push({ type: 'done' })
  assert.ok(replay.snapshot().entries[0].id > lastId)
  const small = new PromptReplay(5)
  small.push({ type: 'chunk', text: 'too large' })
  assert.equal(small.snapshot().overflowed, true)
})

test('fresh policy cannot broaden defaults; invalid preset never silently becomes default', () => {
  assert.deepEqual(safeInitialPermissions({ sandbox: 'danger-full-access', approval: 'ask' }), { sandbox: 'workspace-write', approval: 'ask' })
  assert.deepEqual(safeInitialPermissions({ sandbox: 'read-only', approval: 'never' }), { sandbox: 'read-only', approval: 'never' })
  assert.throws(() => safeInitialPermissions({ sandbox: 'unknown', approval: 'ask' }))
  assert.throws(() => persistedPreset(undefined))
  assert.equal(persistedPreset('saved-preset'), 'saved-preset')
})

test('owner control rejects account-only and cross-user keys', () => {
  assert.equal(isOwnerSessionKey('bot1::owner1', 'bot1', 'owner1'), true)
  assert.equal(isOwnerSessionKey('bot1', 'bot1', 'owner1'), false)
  assert.equal(isOwnerSessionKey('bot1::user2', 'bot1', 'owner1'), false)
})

test('0.2 stream delta helper ignores lifecycle and non-text frames', () => {
  assert.equal(assistantTextDelta({ type: 'chunk', chunk: { type: 'text-delta', text: 'hello' } }), 'hello')
  assert.equal(assistantTextDelta({ type: 'start' }), undefined)
  assert.equal(assistantTextDelta({ type: 'chunk', chunk: { type: 'usage' } }), undefined)
})

test('teardown does not execute inside synchronous publication', async () => {
  let inPublication = true
  await new Promise((resolve, reject) => {
    deferHostTask(() => { assert.equal(inPublication, false); resolve() }, reject)
    inPublication = false
  })
})
