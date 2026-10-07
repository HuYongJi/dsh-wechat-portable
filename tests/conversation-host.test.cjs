'use strict'
// Exercise actual Host HTTP wiring with synthetic account/session storage and an in-memory
// server/SDK. No real profile, model, WeChat connection or background process is used.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Readable } = require('node:stream')
const { createRequire } = require('node:module')
const ts = require('typescript')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-host-conversations-'))
process.env.DSH_BRIDGE_DATA_DIR = directory
const root = path.resolve(__dirname, '..')
const filename = path.join(root, 'src/index.ts')
const localRequire = createRequire(path.join(root, 'lib/index.js'))
const token = 'ab'.repeat(24)
let requestHandler
const nativeControls = []
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, 'lib/index.js')).href)), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const hostModule = { exports: {} }
new Function('require', 'module', 'exports', compiled)(name => {
  if (name === 'node:http') return { createServer: callback => {
    requestHandler = callback
    return { listen: (port, host, ready) => ready(), address: () => ({ port: 12345 }), close: () => {} }
  } }
  if (name === 'node:crypto') return { randomBytes: size => size === 24 ? Buffer.from(token, 'hex') : require('node:crypto').randomBytes(size) }
  if (name === './host/control.js') return { registerNativeControl: (ctx, handlers) => nativeControls.push(handlers) }
  if (name === 'node:child_process') return { spawn: () => { throw new Error('Host tests must never spawn a daemon') } }
  return localRequire(name)
}, hostModule, hostModule.exports)

after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('wb-host-conversations-'))
  fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(directory, 'profile-'))
  const bot = 'synthetic-bot'
  const owner = 'synthetic-owner'
  const key = `${bot}::${owner}`
  fs.mkdirSync(path.join(dataDir, 'accounts'))
  fs.writeFileSync(path.join(dataDir, 'accounts', `${bot}.json`), JSON.stringify({ userId: owner }))
  // Legacy selection must be cleared even when no agent has been loaded this run.
  fs.writeFileSync(path.join(dataDir, 'selected-sessions.json'), JSON.stringify({ [bot]: 'saved-session-1111' }))
  fs.writeFileSync(path.join(dataDir, 'session-ids.json'), JSON.stringify({ [bot]: 'saved-session-1111' }))
  const sessionFile = path.join(dataDir, 'sessions', `${bot}__${owner}.json`)
  fs.mkdirSync(path.dirname(sessionFile))
  fs.writeFileSync(sessionFile, JSON.stringify({ workingDirectory: dataDir, model: 'local-choice', state: 'idle', chatHistory: [{ content: 'old local history' }] }))
  const snapshots = new Map([['saved-session-1111', { id: 'saved-session-1111', cwd: dataDir, createdAt: 1, agentPreset: 'saved-preset' }]])
  const live = new Map()
  const calls = []
  let idle = Promise.resolve()
  const effects = []
  const workspace = { id: 'test-workspace', path: dataDir, title: 'Test Project', sessionIds: ['saved-session-1111'], createdAt: '2026-01-01',
    attachSession: async id => { if (!workspace.sessionIds.includes(id)) workspace.sessionIds.push(id) } }
  const services = {
    sessions: { get: id => live.get(id), list: () => [...live.values()] },
    sessionPersistence: { listSnapshots: async () => [...snapshots.values()].map(header => ({ header })) },
    workspaceRegistry: { list: () => [workspace], resolveByPath: async () => workspace },
  }
  function handle(id, header) {
    const session = { id, header }
    live.set(id, session)
    return { agent: { session, followup: () => calls.push(['followup', id]), cancel: () => calls.push(['cancel', id]), whenIdle: () => idle },
      dispose: async () => { calls.push(['dispose', id]); live.delete(id) } }
  }
  const context = {
    get: name => services[name], on: () => {}, inject: () => {}, tools: { register: () => {} },
    effect: setup => { effects.push(setup()) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    agentPresets: { resolve: async () => ({ id: 'default-preset' }) },
    agents: {
      create: async input => {
        calls.push(['create', input])
        const header = { id: input.sessionId, ...input.meta, createdAt: Date.now() }
        snapshots.set(input.sessionId, header)
        return handle(input.sessionId, header)
      },
      resume: async input => { calls.push(['resume', input]); return handle(input.resumeSessionId, snapshots.get(input.resumeSessionId)) },
    },
  }
  hostModule.exports.apply(context, { dataDir, host: '127.0.0.1', port: 0, autoStart: false, provider: '', model: '', workingDirectory: dataDir, approvalViaWechat: false, approvalTimeoutSec: 300 })
  const internal = requestHandler
  function request(route, body, auth = token) {
    return new Promise(resolve => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: route,
        headers: { host: '127.0.0.1', authorization: `Bearer ${auth}` }, socket: { remoteAddress: '127.0.0.1' } })
      let status
      internal(req, { writeHead: value => { status = value }, end: text => resolve({ status, data: JSON.parse(text) }) })
    })
  }
  return { key, bot, request, dataDir, sessionFile, snapshots, calls, live,
    setIdle: promise => { idle = promise },
    read: name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')),
    dispose: async () => { for (const effect of effects.reverse()) await effect?.() },
  }
}

test('actual Host clears legacy and canonical mappings while idle, creates, switches and resumes the chosen DSH session', async () => {
  const f = fixture()
  try {
    const before = await f.request('/api/projects')
    assert.equal(before.data.items.find(p => p.current).sessionId, 'saved-session-1111')
    assert.equal((await f.request('/api/clear', { sessionId: f.key })).status, 200)
    assert.deepEqual(f.read('selected-sessions.json'), {})
    assert.deepEqual(f.read('session-ids.json'), {})
    const cleared = JSON.parse(fs.readFileSync(f.sessionFile, 'utf8'))
    assert.deepEqual(cleared.chatHistory, [])
    assert.equal(cleared.model, 'local-choice')
    const created = await f.request('/api/sessions/new', { sessionId: f.key })
    assert.equal(created.status, 200)
    const newId = created.data.sessionId
    assert.match(newId, /^wb-[A-Za-z0-9_-]+$/)
    assert.equal(f.read('session-ids.json')[f.key], newId)
    assert.equal(f.calls.find(c => c[0] === 'create')[1].agentOptions.provider, 'test-provider')
    assert.equal(f.calls.find(c => c[0] === 'create')[1].agentOptions.model, 'local-choice')
    assert.equal((await f.request('/api/projects')).data.items.find(p => p.current).sessionId, newId)
    const switched = await f.request('/api/projects/select', { sessionId: 'saved-session-1111' })
    assert.equal(switched.status, 200)
    assert.equal(f.read('selected-sessions.json')[f.key], 'saved-session-1111', 'composite owner key must not be rejected as a filename')
    assert.equal((await f.request('/api/prompt', { sessionId: f.key, text: 'continue old context' })).status, 200)
    assert.equal(f.calls.find(c => c[0] === 'resume')[1].resumeSessionId, 'saved-session-1111')
    assert.equal(f.snapshots.size, 2, 'old and new DSH sessions are both retained')
    assert.equal((await f.request('/api/projects/detach', {})).status, 200)
    assert.deepEqual(f.read('selected-sessions.json'), {})
    assert.deepEqual(f.read('session-ids.json'), {})
  } finally { await f.dispose() }
})

test('stop acknowledgment awaits SDK quiescence and releases busy state before the next prompt', async () => {
  const f = fixture()
  let finish
  const idle = new Promise(resolve => { finish = resolve })
  try {
    await f.request('/api/prompt', { sessionId: f.key, text: 'long task' })
    f.setIdle(idle)
    let acknowledged = false
    const stopping = f.request('/api/stop', { sessionId: f.key }).then(result => { acknowledged = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(acknowledged, false)
    assert.equal((await f.request('/api/prompt', { sessionId: f.key, text: 'too early' })).status, 409)
    finish()
    assert.equal((await stopping).status, 200)
    assert.equal((await f.request('/api/prompt', { sessionId: f.key, text: 'next task' })).status, 200)
  } finally { finish(); await f.dispose() }
})

test('actual internal API rejects foreign keys, bad tokens, malformed selections and live targets before mutation', async () => {
  const f = fixture()
  try {
    for (const route of ['/api/clear', '/api/sessions/new', '/api/stop']) {
      assert.equal((await f.request(route, { sessionId: 'synthetic-bot::other-user' })).status, 403)
      assert.equal((await f.request(route, { sessionId: f.bot })).status, 403)
      assert.equal((await f.request(route, { sessionId: f.key }, 'wrong')).status, 401)
    }
    assert.equal((await f.request('/api/projects/select', { sessionId: 'missing' })).status, 400)
    assert.equal((await f.request('/api/projects/select', { sessionId: {} })).status, 400)
    const created = await f.request('/api/sessions/new', { sessionId: f.key })
    f.live.set('saved-session-1111', { id: 'saved-session-1111', header: f.snapshots.get('saved-session-1111') })
    const refused = await f.request('/api/projects/select', { sessionId: 'saved-session-1111' })
    assert.equal(refused.status, 400)
    assert.match(refused.data.error, /打开/)
    assert.equal(f.read('session-ids.json')[f.key], created.data.sessionId)
  } finally { await f.dispose() }
})
