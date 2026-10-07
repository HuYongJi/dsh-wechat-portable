'use strict'
// Pure source-level tests: transpile in memory, never load src/index.ts or touch a profile/network.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const cache = new Map()
function source(relative) {
  const filename = path.resolve(root, 'src', relative)
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText
  const localRequire = (name) => {
    // Wiring tests need only the component identity, not a browser/React render.
    if (relative === 'client/index.ts' && name === './Panel.js') return { WechatBridgePanel: () => null }
    return name.startsWith('.')
      ? source(path.relative(path.join(root, 'src'), path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))))
      : require(name)
  }
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports)
  return module.exports
}
const contract = source('host/contract.ts')
const host = source('host/control.ts')
const client = source('client/remote.ts')
const status = { ready: true, running: false, paired: false, ownerOnly: true, pid: null, startedAt: null, workingDirectory: 'C:\\example', activeSessions: 0 }
function handlers(overrides = {}) {
  return {
    available: () => true,
    status: () => status,
    start: async () => ({ message: 'started' }), stop: async () => ({ message: 'stopped' }), restart: async () => ({ message: 'restarted' }),
    setWorkspace: (workingDirectory) => ({ message: 'saved without policy changes', workingDirectory }),
    startSetup: async (workingDirectory) => ({ qrcodeId: 'local-only-qr', qrcodeDataUrl: 'data:image/png;base64,AQID', workingDirectory: workingDirectory || 'C:\\example' }),
    pollSetup: async () => ({ status: 'wait', message: 'waiting', retryable: false }),
    cancelSetup: () => ({ message: 'cancelled' }),
    ...overrides,
  }
}
async function request(dispatch, action, payload = {}) { return JSON.parse(await dispatch(action, JSON.stringify(payload))) }

test('Host and explicitly mounted Client share the sole strict 0.2 descriptor', () => {
  const descriptor = contract.CONTROL_DESCRIPTOR
  assert.equal(host.TYPERT.package, 'dsh-wechat-portable')
  assert.equal(host.TYPERT.face, 'host')
  assert.deepEqual(host.TYPERT.invocations, [descriptor])
  assert.deepEqual(client.TYPERT_REMOTE.descriptors, [descriptor])
  assert.equal(descriptor.namespace, 'wechatPortableControl')
  assert.equal(descriptor.service, 'wechatPortableControl')
  assert.equal(descriptor.method, 'request')
  assert.deepEqual(descriptor.invocation, { kind: 'direct' })
  assert.deepEqual(descriptor.parameters.map((item) => [item.name, item.wire, item.source]), [['action', 'action', 'json'], ['payloadJson', 'payloadJson', 'json']])
  for (const codec of [...descriptor.parameters.map((p) => p.codec), descriptor.result]) {
    assert.equal(codec.mode, 'strict')
    assert.ok(codec.typeSymbol.startsWith('dsh-wechat-portable#'))
    for (const value of [undefined, null, 12, true, [], {}, new String('status')]) assert.throws(() => codec.create().parse(value))
  }
  assert.equal(descriptor.parameters[0].codec.create().parse('status'), 'status')
  assert.throws(() => descriptor.parameters[0].codec.create().parse('trust.add'))
})

test('request allowlist rejects unknown actions, target selectors and permission fields', () => {
  for (const action of ['__proto__', 'constructor', 'request', 'tools.execute', 'trust.add', 'trust.mode', 'config', 'logs', 'projects.select']) {
    assert.throws(() => contract.parseControlRequest(action, '{}'))
  }
  for (const action of ['status', 'start', 'stop', 'restart']) {
    assert.deepEqual(contract.parseControlRequest(action, '{}'), { action })
    for (const key of ['accountId', 'userId', 'sessionId', 'dataDir', 'host', 'token', 'approvalViaWechat', 'sandbox', '__proto__', 'constructor']) {
      assert.throws(() => contract.parseControlRequest(action, `{"${key}":"anything"}`))
    }
  }
  assert.throws(() => contract.parseControlRequest('workspace.set', '{"workingDirectory":"C:/example","permissions":"unsafe"}'))
  assert.throws(() => contract.parseControlRequest('setup.status', '{"qrcodeId":"qr","accountId":"other"}'))
})

test('malformed JSON, wrong shapes, coercions and control characters are rejected', () => {
  for (const text of ['', '{', 'null', '[]', 'true', '12', '"{}"']) assert.throws(() => contract.parseControlRequest('status', text))
  for (const value of [null, false, 0, {}, [], '', ' ', 'C:/\u0000test', 'C:/\ntest']) {
    assert.throws(() => contract.parseControlRequest('workspace.set', JSON.stringify({ workingDirectory: value })))
  }
  for (const value of [undefined, null, false, 0, {}, [], '', ' ', 'qr id', 'qr\u0000']) {
    assert.throws(() => contract.parseControlRequest('setup.status', JSON.stringify({ qrcodeId: value })))
  }
  assert.deepEqual(contract.parseControlRequest('workspace.set', '{"workingDirectory":" C:/example "}'), { action: 'workspace.set', workingDirectory: 'C:/example' })
  assert.deepEqual(contract.parseControlRequest('setup.start', '{}'), { action: 'setup.start' })
})

test('request and result codecs enforce byte caps, not just JavaScript string length', () => {
  const payloadCodec = contract.CONTROL_DESCRIPTOR.parameters[1].codec.create()
  assert.equal(payloadCodec.parse(' '.repeat(contract.MAX_CONTROL_REQUEST_BYTES)).length, contract.MAX_CONTROL_REQUEST_BYTES)
  assert.throws(() => payloadCodec.parse('x'.repeat(contract.MAX_CONTROL_REQUEST_BYTES + 1)))
  assert.throws(() => payloadCodec.parse('😀'.repeat(5000)))
  assert.throws(() => contract.parseControlRequest('status', '{}'.padEnd(contract.MAX_CONTROL_REQUEST_BYTES + 1, ' ')))
  assert.throws(() => contract.CONTROL_DESCRIPTOR.result.create().parse('x'.repeat(contract.MAX_CONTROL_RESPONSE_BYTES + 1)))
})

test('dispatcher uses only fixed handlers and passes only validated fields', async () => {
  const calls = []
  const dispatch = host.createControlRequestHandler(handlers({
    setWorkspace: (directory) => { calls.push(['workspace', directory]); return { message: 'saved', workingDirectory: directory } },
    pollSetup: async (id) => { calls.push(['poll', id]); return { status: 'wait', message: '', retryable: false } },
  }))
  assert.equal((await request(dispatch, 'status')).value.ownerOnly, true)
  assert.equal((await request(dispatch, 'start')).value.message, 'started')
  assert.equal((await request(dispatch, 'stop')).value.message, 'stopped')
  assert.equal((await request(dispatch, 'restart')).value.message, 'restarted')
  await request(dispatch, 'workspace.set', { workingDirectory: ' C:/example ' })
  await request(dispatch, 'setup.status', { qrcodeId: 'qr-1' })
  assert.deepEqual(calls, [['workspace', 'C:/example'], ['poll', 'qr-1']])
  const refused = await request(dispatch, 'setWorkspace', { workingDirectory: 'C:/other' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'invalid-request')
  assert.equal(calls.length, 2)
})

test('operator guard rejects absent, foreign and payload-invented identities', () => {
  assert.doesNotThrow(() => host.assertOperatorPeer({ id: 'operator' }, { id: 'operator' }))
  for (const [peer, operator] of [[undefined, undefined], [{}, {}], [{ id: '' }, { id: '' }], [undefined, { id: 'operator' }], [{ id: 'operator' }, undefined], [{ id: 'guest' }, { id: 'operator' }]]) {
    assert.throws(() => host.assertOperatorPeer(peer, operator), /local Host operator/)
  }
})

test('real Cordis service binding reads Gateway-derived invocation context', async () => {
  const { Context } = require('@deepseek-ai/cordis')
  const ctx = new Context()
  try {
    ctx.provide('connection', { operator: { id: 'local-operator' } })
    const service = new host.WechatPortableControl(ctx, handlers())
    assert.equal(service.typertRemote.service, service)
    assert.equal(service.typertRemote.namespace, 'wechatPortableControl')
    assert.equal((await request(service.request.bind(service), 'status')).error.code, 'forbidden')
    const invocation = { peer: { id: 'local-operator' }, signal: new AbortController().signal }
    const receiver = ctx.extend({ invocation }).get('wechatPortableControl')
    assert.equal((await request(receiver.request.bind(receiver), 'status')).ok, true)
    const guest = ctx.extend({ invocation: { ...invocation, peer: { id: 'guest' } } }).get('wechatPortableControl')
    assert.equal((await request(guest.request.bind(guest), 'status')).error.code, 'forbidden')
  } finally { await ctx.fiber.dispose() }
})

test('mutations do not race; status remains readable and failures release the lock', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  let stopped = false
  const dispatch = host.createControlRequestHandler(handlers({ start: () => pending, stop: async () => { stopped = true; return { message: 'stopped' } } }))
  const first = request(dispatch, 'start')
  const second = await request(dispatch, 'stop')
  assert.equal(second.error.code, 'busy')
  assert.equal(stopped, false)
  assert.equal((await request(dispatch, 'status')).ok, true)
  release({ message: 'started' })
  assert.equal((await first).ok, true)
  assert.equal((await request(dispatch, 'stop')).ok, true)
})

test('unavailable/disposed service refuses operations and late secret-bearing results', async () => {
  let available = false
  let calls = 0
  const dispatch = host.createControlRequestHandler(handlers({ available: () => available, start: async () => { calls++; available = false; return { message: 'started' } } }))
  assert.equal((await request(dispatch, 'start')).error.code, 'unavailable')
  assert.equal(calls, 0)
  available = true
  assert.equal((await request(dispatch, 'start')).error.code, 'unavailable')
  assert.equal(calls, 1)
})

test('response whitelist prevents status/token/log export and arbitrary error echoes', async () => {
  const secret = 'SECRET-MUST-NOT-LEAVE-HANDLER'
  const leaking = host.createControlRequestHandler(handlers({ status: () => ({ ...status, botToken: secret, logs: secret }) }))
  const response = await leaking('status', '{}')
  assert.equal(JSON.parse(response).ok, false)
  assert.ok(!response.includes(secret))
  const failing = host.createControlRequestHandler(handlers({ start: async () => { throw new Error(`https://qr.invalid/?token=${secret}`) } }))
  const failure = await failing('start', '{}')
  assert.equal(JSON.parse(failure).error.code, 'operation-failed')
  assert.ok(!failure.includes(secret))
  assert.throws(() => contract.parseControlValue('setup.start', { qrcodeId: 'qr', qrcodeUrl: secret, qrcodeDataUrl: 'data:image/png;base64,AQID', workingDirectory: 'C:/example' }))
  assert.throws(() => contract.parseControlValue('setup.start', { qrcodeId: 'qr', qrcodeDataUrl: 'https://qr.invalid/image', workingDirectory: 'C:/example' }))
})

test('native QR failures expose only fixed actionable diagnostics', async () => {
  const { WechatLoginError } = source('bridge/wechat/login-errors.ts')
  const failure = new WechatLoginError('certificate')
  failure.message = 'PRIVATE-QR-TOKEN-MUST-NOT-LEAK'
  const dispatch = host.createControlRequestHandler(handlers({ startSetup: async () => { throw failure } }))
  const result = await request(dispatch, 'setup.start')
  assert.equal(result.error.code, 'operation-failed')
  assert.match(result.error.message, /证书/)
  assert.ok(!JSON.stringify(result).includes('PRIVATE-QR-TOKEN'))
})

test('client apply explicitly awaits native contribution mount before panel registration', async () => {
  const plugin = source('client/index.ts')
  const events = []
  let finishMount
  const mount = new Promise((resolve) => { finishMount = resolve })
  const remote = { $mount: (contribution) => { assert.equal(contribution, client.TYPERT_REMOTE); events.push('mount'); return mount } }
  const slots = {
    inject: (name, callback) => { assert.equal(name, 'settings.section'); events.push('inject'); callback() },
    register: (options) => { assert.equal(options.id, 'dsh-wechat-portable-panel'); assert.equal(typeof options.inject().control.status, 'function'); events.push('register'); return () => {} },
  }
  const applied = plugin.apply({
    remote, slots,
    inject: async (dependencies, callback) => {
      assert.deepEqual(dependencies, ['remote.wechatPortableControl'])
      events.push('namespace-inject')
      callback({ remote, slots })
      return { dispose: async () => events.push('consumer-disposed') }
    },
  })
  assert.deepEqual(events, ['mount'])
  finishMount(async () => { events.push('unmount') })
  const dispose = await applied
  assert.deepEqual(events, ['mount', 'namespace-inject', 'inject', 'register'])
  await dispose()
  assert.deepEqual(events, ['mount', 'namespace-inject', 'inject', 'register', 'consumer-disposed', 'unmount'])
  let released = false
  await assert.rejects(plugin.apply({
    remote: { $mount: async () => async () => { released = true } },
    inject: async (dependencies, callback) => callback({ remote: {}, slots: { inject: () => { throw new Error('slot unavailable') } } }),
  }), /slot unavailable/)
  assert.equal(released, true)
})

/** Mirror Gateway's traced namespace service using the real Cordis runtime.
 * A plain-object fake cannot enforce service injection or plugin-fiber lifetime.
 */
function tracedClientHarness() {
  const { Context, Service } = require('@deepseek-ai/cordis')
  const ctx = new Context()
  const panels = new Set()
  const calls = []
  const dispatch = host.createControlRequestHandler(handlers())
  class Namespace extends Service {
    constructor(owner) { super(owner, 'remote.wechatPortableControl') }
    async request(action, payload) { calls.push(action); return { ok: true, value: await dispatch(action, payload) } }
  }
  class Remote extends Service {
    constructor(owner) { super(owner, 'remote') }
    get wechatPortableControl() { return this.ctx['remote.wechatPortableControl'] }
    async $mount(contribution) {
      assert.equal(contribution, client.TYPERT_REMOTE)
      const provider = ctx.plugin({ name: 'test-remote-namespace', apply: owner => { new Namespace(owner) } })
      await provider
      return provider.dispose
    }
  }
  class Slots extends Service {
    constructor(owner) { super(owner, 'slots') }
    inject(name, callback) { assert.equal(name, 'settings.section'); this.ctx.effect(callback) }
    register(options) {
      const face = options.inject()
      panels.add(face)
      return this.ctx.effect(() => () => panels.delete(face))
    }
  }
  new Remote(ctx)
  new Slots(ctx)
  return { ctx, panels, calls }
}

test('real Cordis rejects the alpha.1 undeclared namespace before any RPC', async () => {
  const h = tracedClientHarness()
  let control
  try {
    const old = h.ctx.plugin({ inject: ['remote', 'slots'], async apply(ctx) {
      const unmount = await ctx.remote.$mount(client.TYPERT_REMOTE)
      control = client.createControlClient(ctx.remote)
      return unmount
    } })
    await old
    await assert.rejects(control.status(), /cannot get property "remote\.wechatPortableControl" without inject/)
    assert.deepEqual(h.calls, [])
  } finally { await h.ctx.fiber.dispose() }
})

test('panel calls run in an injected Cordis fiber and survive unload/remount', async () => {
  const plugin = source('client/index.ts')
  const h = tracedClientHarness()
  // Requiring the namespace on the mounting plugin itself deadlocks its own $mount.
  assert.ok(!plugin.inject.includes('remote.wechatPortableControl'))
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const fiber = h.ctx.plugin(plugin)
      await fiber
      assert.equal(h.panels.size, 1)
      const { control } = [...h.panels][0]
      assert.deepEqual(await control.status(), status)
      assert.equal((await control.startSetup()).qrcodeId, 'local-only-qr')
      await fiber.dispose()
      assert.equal(h.panels.size, 0)
      assert.equal(h.ctx.get('remote.wechatPortableControl'), undefined)
    }
    assert.deepEqual(h.calls, ['status', 'setup.start', 'status', 'setup.start'])
  } finally { await h.ctx.fiber.dispose() }
})

test('client waits for an outstanding QR poll before local cancellation', async () => {
  let finishPoll
  const calls = []
  const api = client.createControlClient({ wechatPortableControl: { request: (action) => {
    calls.push(action)
    if (action === 'setup.status') return new Promise((resolve) => { finishPoll = resolve })
    return Promise.resolve({ ok: true, value: JSON.stringify({ ok: true, value: { message: 'cancelled' } }) })
  } } })
  const first = api.pollSetup('qr')
  assert.equal(api.pollSetup('qr'), first)
  const cancellation = api.cancelSetup('qr')
  assert.deepEqual(calls, ['setup.status'])
  finishPoll({ ok: true, value: JSON.stringify({ ok: true, value: { status: 'wait', message: '', retryable: false } }) })
  await first
  await cancellation
  assert.deepEqual(calls, ['setup.status', 'setup.cancel'])
})

test('client unwraps actual RemoteResult and cannot fall back to browser fetch', async () => {
  const dispatch = host.createControlRequestHandler(handlers())
  const calls = []
  const api = client.createControlClient({ wechatPortableControl: { request: async (...args) => {
    calls.push(args)
    return { ok: true, value: await dispatch(...args) }
  } } })
  assert.deepEqual(await api.status(), status)
  assert.equal((await api.startSetup()).qrcodeId, 'local-only-qr')
  assert.equal((await api.pollSetup('local-only-qr')).status, 'wait')
  assert.equal((await api.cancelSetup('local-only-qr')).message, 'cancelled')
  assert.deepEqual(calls[0], ['status', '{}'])
  const unavailable = client.createControlClient({ wechatPortableControl: { request: async () => ({ ok: false, error: { code: 'gateway/service-unavailable' } }) } })
  await assert.rejects(unavailable.status(), /Native WeChat IPC unavailable/)
  const malformed = client.createControlClient({ wechatPortableControl: { request: async () => ({ ok: true, value: 'not json' }) } })
  await assert.rejects(malformed.status(), /Malformed native control response/)
  for (const filename of ['client/index.ts', 'client/remote.ts', 'client/Panel.tsx']) {
    const text = fs.readFileSync(path.join(root, 'src', filename), 'utf8')
    assert.ok(!/\bfetch\s*\(/.test(text), `${filename} must not fetch a browser-only route`)
    assert.ok(!/localStorage|sessionStorage/.test(text), `${filename} must not persist QR secrets`)
  }
  assert.match(fs.readFileSync(path.join(root, 'src/client/index.ts'), 'utf8'), /await ctx\.remote\.\$mount\(TYPERT_REMOTE\)/)
})
