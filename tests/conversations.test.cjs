'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-conversations-'))
process.env.DSH_BRIDGE_DATA_DIR = directory
const { parseCommand, interruptsTurn } = require('../lib/bridge/commands/parser.js')
const { routeCommand } = require('../lib/bridge/commands/router.js')
const { createMessageQueue } = require('../lib/bridge/message-queue.js')
const { createConversationManager } = require('../lib/host/conversations.js')
const { createSessionStore } = require('../lib/bridge/session.js')
const { DshClient } = require('../lib/bridge/dsh-client.js')
const { handleMessage } = require('../lib/bridge/main.js')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const session = () => ({ workingDirectory: '/work/current', model: 'chosen-model', state: 'idle', chatHistory: [{ role: 'user', content: 'old context', timestamp: 1 }] })
const item = (sessionId, workspaceTitle = 'Project') => ({ sessionId, workspaceId: 'workspace', workspaceTitle, path: '/work/project', createdAt: '2026-01-01', live: false })

after(() => {
  // Only remove the freshly allocated test directory, never a user profile.
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('wb-conversations-'))
  fs.rmSync(directory, { recursive: true, force: true })
})

test('slash commands and explicit whole-message Chinese phrases share a parser', () => {
  for (const [text, name, args = ''] of [
    [' /NEW\t ', 'new'], ['/switch\t2', 'switch', '2'], ['/session\nabc', 'session', 'abc'],
    ['新建会话', 'new'], ['创建新会话。', 'new'], ['开启新会话', 'new'], ['新建对话', 'new'],
    ['查看会话列表', 'sessions'], ['会话列表！', 'sessions'], ['查看当前会话', 'session'],
    ['清空上下文', 'clear'], ['清除会话', 'clear'], ['停止当前任务', 'stop'],
    ['切换会话 2', 'switch', '2'], ['切换到会话：abc123', 'switch', 'abc123'],
    ['切换到第 2 个会话', 'switch', '2'], ['切换到会话 Project', 'switch', 'Project'],
    ['切换会话', 'switch'], ['会话帮助', 'help'],
  ]) assert.deepEqual(parseCommand(text), { name, args }, text)
  for (const text of ['你好', '请解释如何清空上下文', '不要新建会话', '“新建会话”', '`/clear`', '```\n/clear\n```', '新增一个“会话列表”功能', '清空上下文\n然后写代码', '新建会话之后会怎么样', '切换到 Python 来解决这个问题']) {
    assert.equal(parseCommand(text), undefined, text)
  }
  for (const text of ['/new', '清空上下文', '/switch 2', '/session off', '/stop', '/reset']) assert.equal(interruptsTurn(parseCommand(text)), true)
  for (const text of ['/new incorrect', '/clear all', '/session', '/switch', '/sessions', '普通文本']) assert.equal(interruptsTurn(parseCommand(text)), false)
})

function commandContext(overrides = {}) {
  const calls = []
  const ctx = { text: '', session: session(), calls,
    updateSession: partial => Object.assign(ctx.session, partial),
    createSession: async () => { calls.push('new'); return { ok: true, sessionId: 'new-abcdef12' } },
    clearContext: async reset => { calls.push(reset ? 'reset' : 'clear') },
    stopTask: async () => { calls.push('stop') },
    selectProject: async id => { calls.push(id); return { ok: true } },
    detachProject: async () => { calls.push('detach'); return { ok: true } },
    listProjects: async () => [item('session-aaaa1111'), { ...item('session-bbbb2222', 'Other'), current: true }],
    ...overrides,
  }
  return ctx
}
// Unit routes simulate a fully delivered reply; message-entry tests exercise failures.
const route = async (ctx, text) => {
  const result = await routeCommand({ ...ctx, text })
  if (result.sessionChoices) ctx.updateSession({ sessionChoices: result.sessionChoices })
  return result
}

test('new/clear/reset/stop execute real host hooks before acknowledging; failures do not claim success', async () => {
  const ctx = commandContext()
  for (const text of ['/new', '清空上下文', '/reset', '/stop']) assert.match((await route(ctx, text)).reply, /✅|⏹/)
  assert.deepEqual(ctx.calls, ['new', 'clear', 'reset', 'stop'])
  for (const text of ['/new ignored', '/clear all', '/reset now', '/stop now']) assert.match((await route(ctx, text)).reply, /用法/)
  assert.equal(ctx.calls.length, 4)
  for (const [text, hook] of [['/new', 'createSession'], ['/clear', 'clearContext'], ['/reset', 'clearContext'], ['/stop', 'stopTask']]) {
    const failed = commandContext({ [hook]: async () => { throw new Error('unavailable') } })
    assert.match((await route(failed, text)).reply, /失败/)
  }
  const gate = deferred()
  let acknowledged = false
  const request = route(commandContext({ createSession: () => gate.promise }), '/new').then(() => { acknowledged = true })
  await Promise.resolve()
  assert.equal(acknowledged, false)
  gate.resolve({ ok: true, sessionId: 'new' })
  await request
  assert.equal((await route(ctx, '普通对话')).handled, false)
})

test('list stores a stable numeric snapshot, marks current and supports compatibility aliases', async () => {
  const ctx = commandContext()
  for (const command of ['/sessions', '/sessionlist', '/projects', '查看会话列表']) {
    assert.match((await route(ctx, command)).reply, /【当前】/)
  }
  assert.deepEqual(ctx.session.sessionChoices, ['session-aaaa1111', 'session-bbbb2222'])
  ctx.listProjects = async () => [item('new-3333'), item('session-bbbb2222'), item('session-aaaa1111')]
  await route(ctx, '切换会话 1')
  assert.deepEqual(ctx.calls, ['session-aaaa1111'])
  ctx.listProjects = async () => [item('new-3333')]
  assert.match((await route(ctx, '/switch 1')).reply, /过期/)
  assert.equal(ctx.calls.length, 1)
  assert.match((await route(commandContext(), '/switch 1')).reply, /请先/)
  for (const number of ['0', '9999', '9999999999999999999999999']) assert.match((await route(ctx, `/switch ${number}`)).reply, /未找到/)
})

test('IDs and unique names switch; ambiguous names and short IDs never pick the first item', async () => {
  const ctx = commandContext({ listProjects: async () => [item('first-aaaa1111'), item('second-aaaa1111'), item('third-12345678', 'Unique')] })
  for (const target of ['Project', 'aaaa1111', '/work/project']) assert.match((await route(ctx, `/switch ${target}`)).reply, /多个/)
  for (const target of ['Unique', 'third-', '12345678', 'third-12345678']) assert.match((await route(ctx, `/switch ${target}`)).reply, /✅/)
  assert.deepEqual(ctx.calls, Array(4).fill('third-12345678'))
  assert.match((await route(ctx, '/switch')).reply, /用法/)
  assert.match((await route(ctx, '/switch missing')).reply, /未找到/)
  assert.match((await route(commandContext({ listProjects: async () => [] }), '/sessions')).reply, /暂无/)
  assert.match((await route(commandContext({ selectProject: async () => { throw new Error('已打开') } }), '/switch aaaa1111')).reply, /已打开/)
  assert.match((await route(ctx, '/help')).reply, /清空上下文/)
  await route(ctx, '/session off')
  assert.equal(ctx.calls.at(-1), 'detach')
})

function managerFixture(overrides = {}) {
  let local = session()
  let current = 'old-1111'
  const items = [item(current), item('other-2222')]
  const calls = []
  const deps = {
    assertOwner: key => { if (key !== 'bot::owner') throw new Error('owner only') },
    current: () => current,
    list: async () => structuredClone(items),
    isLive: () => false,
    dispose: async () => { calls.push('dispose'); current = undefined },
    stop: async () => { calls.push('stop') },
    bind: (key, id) => { calls.push(['bind', id]); current = id },
    create: async (key, input) => { calls.push(['create', input]); current = 'new-3333'; items.push(item(current)); return current },
    validateNew: () => {},
    readLocal: () => structuredClone(local),
    writeLocal: (key, value) => { local = structuredClone(value); calls.push('write') },
    defaultDirectory: () => '/work/default',
    ...overrides,
  }
  return { deps, manager: createConversationManager(deps), calls, items, get local() { return local }, get current() { return current } }
}
const key = 'bot::owner'

test('host creates immediately, retains old sessions, switches and persists the effective current selection', async () => {
  const f = managerFixture()
  assert.equal((await f.manager.create(key)).sessionId, 'new-3333')
  assert.equal(f.current, 'new-3333')
  assert.deepEqual(f.local.chatHistory, [])
  assert.equal(f.local.model, 'chosen-model')
  assert.equal(f.local.workingDirectory, '/work/current')
  assert.ok((await f.manager.list(key)).some(p => p.sessionId === 'old-1111'))
  assert.equal((await f.manager.list(key)).find(p => p.current).sessionId, 'new-3333')
  await f.manager.select(key, 'old-1111')
  assert.equal(f.current, 'old-1111')
  assert.equal(f.local.workingDirectory, '/work/project')
  // Reconstructing the control layer reads the same persisted selection, without a live agent.
  const restarted = createConversationManager(f.deps)
  assert.equal((await restarted.list(key)).find(p => p.current).sessionId, 'old-1111')
  const before = f.calls.length
  await restarted.select(key, 'old-1111')
  assert.equal(f.calls.length, before, 'reselect is a no-op')
})

test('clear removes effective binding without an active agent, preserves preferences and never deletes DSH history', async () => {
  const f = managerFixture()
  await f.manager.clear(key)
  assert.equal(f.current, undefined)
  assert.equal(f.local.model, 'chosen-model')
  assert.equal(f.local.workingDirectory, '/work/current')
  assert.deepEqual(f.local.chatHistory, [])
  assert.equal(f.items.length, 2)
  assert.equal((await f.manager.list(key)).some(p => p.current), false)
  await f.manager.clear(key, true)
  assert.equal(f.local.model, undefined)
  assert.equal(f.local.workingDirectory, '/work/default')
  assert.equal(f.local.maxHistoryLength, 100)
  const detached = managerFixture()
  await detached.manager.detach(key)
  assert.equal(detached.current, undefined)
})

test('failed creation restores old context; invalid or live targets and cross-owner controls cannot mutate state', async () => {
  const f = managerFixture({ create: async () => { throw new Error('SDK unavailable') } })
  await assert.rejects(f.manager.create(key), /SDK unavailable/)
  assert.equal(f.current, 'old-1111')
  assert.equal(f.local.chatHistory[0].content, 'old context')
  const live = managerFixture({ isLive: () => true })
  await assert.rejects(live.manager.select(key, 'other-2222'), /打开/)
  await assert.rejects(live.manager.select(key, 'missing'), /不存在/)
  for (const method of ['create', 'clear', 'detach', 'list', 'stop']) await assert.rejects(live.manager[method]('bot::stranger'), /owner/)
  await assert.rejects(live.manager.select('bot::stranger', 'other-2222'), /owner/)
  assert.deepEqual(live.calls, [])
  const invalid = managerFixture({ validateNew: () => { throw new Error('bad workspace') } })
  await assert.rejects(invalid.manager.create(key), /bad workspace/)
  assert.deepEqual(invalid.calls, [])
})

test('host mutation lock remains held across awaits and releases on failures', async () => {
  const gate = deferred()
  const f = managerFixture({ create: () => gate.promise })
  const pending = f.manager.create(key)
  assert.equal(f.manager.busy(key), true)
  await assert.rejects(f.manager.clear(key), /切换/)
  await assert.rejects(f.manager.select(key, 'other-2222'), /切换/)
  gate.resolve('new-session')
  await pending
  assert.equal(f.manager.busy(key), false)
  await assert.rejects(f.manager.select(key, 'missing'))
  assert.equal(f.manager.busy(key), false)
})

test('queue aborts a running task, discards pending messages and awaits final cleanup before control', async () => {
  const started = deferred()
  const cleanup = deferred()
  const events = []
  const queue = createMessageQueue(async (message, signal) => {
    events.push(message)
    if (message === 'old') {
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      events.push('aborted')
      await cleanup.promise
      events.push('old-finally')
    }
  }, error => { throw error })
  queue.enqueue('old')
  await started.promise
  queue.enqueue('discard')
  queue.enqueue('clear', true)
  queue.enqueue('next-message')
  await Promise.resolve()
  assert.deepEqual(events, ['old', 'aborted'])
  cleanup.resolve()
  await queue.settled()
  assert.deepEqual(events, ['old', 'aborted', 'old-finally', 'clear', 'next-message'])
  queue.enqueue('later')
  await queue.settled()
  assert.equal(events.at(-1), 'later')
})

test('queue drains arrivals in the resolution/finalizer microtask window', async () => {
  const events = []
  const queue = createMessageQueue(async message => {
    events.push(message)
    if (message === 'first') Promise.resolve().then(() => {}).then(() => queue.enqueue('second'))
  }, error => { throw error })
  queue.enqueue('first')
  await queue.settled()
  assert.deepEqual(events, ['first', 'second'])
})

test('queue continues after one failed message instead of stranding the rest', async () => {
  const events = []
  const errors = []
  const queue = createMessageQueue(async message => { events.push(message); if (message === 'bad') throw new Error('bad') }, error => errors.push(error.message))
  queue.enqueue('bad'); queue.enqueue('good')
  await queue.settled()
  assert.deepEqual(events, ['bad', 'good'])
  assert.deepEqual(errors, ['bad'])
})

test('HTTP client requires acknowledged control success, including stop and clear', async () => {
  const original = global.fetch
  const requests = []
  const client = new DshClient('http://127.0.0.1:1', 'test-token')
  try {
    global.fetch = async (url, init) => { requests.push([url, JSON.parse(init.body)]); return new Response('{"ok":true,"sessionId":"new"}') }
    await client.stop(key)
    await client.clear(key, true)
    assert.equal((await client.newSession(key)).sessionId, 'new')
    assert.deepEqual(requests.map(r => r[1]), [{ sessionId: key }, { sessionId: key, reset: true }, { sessionId: key }])
    assert.match(requests[2][0], /\/api\/sessions\/new$/)
    for (const response of [() => new Response('{"ok":false,"error":"refused"}'), () => new Response('{}', { status: 500 }), () => new Response('not json')]) {
      global.fetch = async () => response()
      await assert.rejects(client.clear(key))
      await assert.rejects(client.stop(key))
      await assert.rejects(client.newSession(key))
      await assert.rejects(client.selectProject('saved-session'))
      await assert.rejects(client.detachProject())
    }
  } finally { global.fetch = original }
})

function messageFixture(suffix) {
  const account = { accountId: `testbot-${suffix}`, userId: 'test-owner' }
  const store = createSessionStore({ botAccountId: account.accountId, ownerUserId: account.userId, defaultWorkingDirectory: directory })
  const sent = []
  const sender = { sendText: async (user, token, text) => { sent.push(text) }, startTyping: () => () => {} }
  const config = { workingDirectory: directory, usageFooter: false }
  const message = text => ({ message_type: 1, from_user_id: account.userId, context_token: 'test-context', item_list: [{ type: 1, text_item: { text } }] })
  return { account, store, sent, sender, config, message }
}

test('real message handler routes natural phrases without prompting the model, and splits long lists', async () => {
  const f = messageFixture('commands')
  let newCalls = 0
  const client = {
    newSession: async () => { newCalls++; return { ok: true, sessionId: 'new-1111' } },
    prompt: async () => { throw new Error('a management command must not reach the model') },
    listProjects: async () => Array.from({ length: 120 }, (_, i) => item(`session-${i}`, 'A long workspace title')),
  }
  const process = text => handleMessage(f.message(text), f.account, f.store, f.sender, f.config, client, new AbortController().signal)
  await process('新建会话')
  assert.equal(newCalls, 1)
  assert.match(f.sent[0], /已创建/)
  await process('查看会话列表')
  assert.ok(f.sent.length > 2)
  assert.ok(f.sent.every(text => text.length <= 4000))
  assert.equal(f.store.load(f.account.userId).sessionChoices.length, 120)
})

test('failed list delivery invalidates numbering instead of silently switching to an unseen list', async () => {
  const f = messageFixture('list-failure')
  const state = f.store.load(f.account.userId)
  state.sessionChoices = ['previous-id']
  f.store.save(f.account.userId, state)
  f.sender.sendText = async () => { throw new Error('delivery failed') }
  const client = { listProjects: async () => [item('new-id')] }
  await assert.rejects(handleMessage(f.message('/sessions'), f.account, f.store, f.sender, f.config, client, new AbortController().signal), /delivery failed/)
  assert.equal(f.store.load(f.account.userId).sessionChoices, undefined)
})

test('message entry rejects non-owner commands and ordinary prompts', async () => {
  const f = messageFixture('owner')
  for (const text of ['新建会话', '/clear', '/sessions', 'hello']) {
    const msg = { ...f.message(text), from_user_id: 'another-user' }
    await handleMessage(msg, f.account, f.store, f.sender, f.config, {}, new AbortController().signal)
  }
  assert.deepEqual(f.sent, [])
})

test('clear while streaming cannot restore old history or leak buffered text into the new conversation', async () => {
  const f = messageFixture('stream')
  const started = deferred()
  const events = []
  const client = {
    prompt: async () => ({ accepted: true }),
    stream: async (key, callback, signal) => {
      callback({ type: 'chunk', text: 'unsent old reply' })
      started.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      throw new Error('aborted')
    },
    stop: async () => { events.push('stop') },
    clear: async () => { events.push('clear'); f.store.clear(f.account.userId, f.store.load(f.account.userId)) },
  }
  const queue = createMessageQueue((msg, signal) => handleMessage(msg, f.account, f.store, f.sender, f.config, client, signal), error => { throw error })
  queue.enqueue(f.message('long task'))
  await started.promise
  queue.enqueue(f.message('must be discarded'))
  queue.enqueue(f.message('清空上下文'), true)
  await queue.settled()
  assert.deepEqual(events, ['stop', 'clear'])
  assert.deepEqual(f.store.load(f.account.userId).chatHistory, [])
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0], /上下文已清空/)
})

test('a slow outbound send does not delay Host cancellation, but local cleanup still precedes the control', async () => {
  const f = messageFixture('slow-send')
  const sending = deferred()
  const releaseSend = deferred()
  const stopped = deferred()
  const events = []
  f.sender.sendText = async (user, token, text) => {
    if (text.startsWith('buffered')) {
      events.push('sending'); sending.resolve(); await releaseSend.promise; events.push('sent')
    } else events.push('reply')
  }
  const client = {
    prompt: async () => ({ accepted: true }),
    stream: async (key, callback, signal) => {
      callback({ type: 'chunk', text: 'buffered'.repeat(200) })
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    },
    stop: async () => { events.push('stop'); stopped.resolve() },
    clear: async () => { events.push('clear'); f.store.clear(f.account.userId) },
  }
  const queue = createMessageQueue((msg, signal) => handleMessage(msg, f.account, f.store, f.sender, f.config, client, signal), error => { throw error })
  queue.enqueue(f.message('long task'))
  await sending.promise
  queue.enqueue(f.message('/clear'), true)
  await stopped.promise
  assert.deepEqual(events, ['sending', 'stop'])
  releaseSend.resolve()
  await queue.settled()
  assert.deepEqual(events, ['sending', 'stop', 'sent', 'clear', 'reply'])
  assert.deepEqual(f.store.load(f.account.userId).chatHistory, [])
})

test('cancellation during prompt acceptance waits for acceptance then stops before creating a new conversation', async () => {
  const f = messageFixture('acceptance')
  const started = deferred()
  const accepted = deferred()
  const events = []
  const client = {
    prompt: async () => { started.resolve(); return accepted.promise },
    stop: async () => { events.push('stop') },
    newSession: async () => { events.push('new'); f.store.clear(f.account.userId); return { ok: true, sessionId: 'new' } },
  }
  const queue = createMessageQueue((msg, signal) => handleMessage(msg, f.account, f.store, f.sender, f.config, client, signal), error => { throw error })
  queue.enqueue(f.message('long task'))
  await started.promise
  queue.enqueue(f.message('/new'), true)
  assert.deepEqual(events, [])
  accepted.resolve({ accepted: true })
  await queue.settled()
  assert.deepEqual(events, ['stop', 'new'])
  assert.deepEqual(f.store.load(f.account.userId).chatHistory, [])
  assert.equal(f.sent.length, 1)
})
