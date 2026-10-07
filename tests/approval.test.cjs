const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createApprovalManager } = require('../lib/approval.js')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(timeoutMs = 1000) {
  const messages = []
  const manager = createApprovalManager({ timeoutMs, push: async (text, key) => { messages.push({ text, key }); return true } })
  const id = (n = messages.length - 1) => /\/yes ([a-f0-9]+)/.exec(messages[n].text)[1]
  return { manager, messages, id }
}
const next = async () => { throw new Error('Must not fall back to another approval surface') }

test('pre-aborted requests never allocate or send', async () => {
  const { manager, messages } = fixture()
  const controller = new AbortController(); controller.abort()
  assert.equal(await manager.handleRequest('owner', { toolName: 'edit', signal: controller.signal }, next), 'cancelled')
  assert.equal(manager.hasPending('owner'), false)
  assert.equal(messages.length, 0)
  manager.dispose()
})

test('decisions are scoped and require the exact single-use request nonce', async () => {
  const { manager, messages, id } = fixture()
  const first = manager.handleRequest('owner1', { toolName: 'edit' }, next)
  const other = manager.handleRequest('owner2', { toolName: 'read' }, next)
  await tick()
  assert.equal(messages.length, 2)
  assert.equal(manager.decide('owner1', true).ok, false)
  assert.equal(manager.decide('owner2', true, id(0)).ok, false)
  assert.equal(manager.decide('owner1', true, id(0)).ok, true)
  assert.equal(await first, 'allowed-once')
  const second = manager.handleRequest('owner1', { toolName: 'pwsh' }, next)
  await tick()
  assert.equal(manager.decide('owner1', true, id(0)).reason, 'stale-decision')
  assert.equal(manager.hasPending('owner1'), true)
  assert.equal(manager.decide('owner1', false, id(2)).ok, true)
  assert.equal(await second, 'rejected')
  manager.dispose()
  assert.equal(await other, 'cancelled')
})

test('abort and ordinary settlement both detach signal listeners', async () => {
  for (const action of ['abort', 'decide']) {
    const { manager, id } = fixture()
    const controller = new AbortController()
    let removed = 0
    const original = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = (...args) => { removed++; return original(...args) }
    const result = manager.handleRequest('owner', { toolName: 'write', signal: controller.signal }, next)
    await tick()
    if (action === 'abort') controller.abort()
    else manager.decide('owner', true, id())
    assert.equal(await result, action === 'abort' ? 'cancelled' : 'allowed-once')
    assert.equal(removed, 1)
    manager.dispose()
  }
})

test('hung delivery cannot defeat approval timeout', async () => {
  const manager = createApprovalManager({ timeoutMs: 20, push: () => new Promise(() => {}) })
  assert.equal(await manager.handleRequest('owner', { toolName: 'pwsh' }, next), 'rejected')
  assert.equal(manager.hasPending('owner'), false)
  manager.dispose()
})

test('delivery failures and concurrent duplicates fail closed', async () => {
  const manager = createApprovalManager({ timeoutMs: 1000, push: async () => false })
  const result = manager.handleRequest('owner', { toolName: 'pwsh' }, next)
  assert.equal(await manager.handleRequest('owner', { toolName: 'edit' }, next), 'rejected')
  assert.equal(await result, 'unavailable')
  manager.dispose()
  assert.equal(await manager.handleRequest('owner', { toolName: 'read' }, next), 'cancelled')
})
