'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Context } = require('@deepseek-ai/cordis')
const { SESSION_FORMAT_VERSION } = require('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = require('@deepseek-ai/dsh-session-projection')
const { z } = require('zod')
const { readClientSessionTitle } = require('../lib/host/session-titles.js')
const { cleanSessionLabel, sessionDisplayTitle, formatSessionListItem, formatSessionSummary } = require('../lib/bridge/session-display.js')
const header = Object.freeze({ id: 'synthetic-session-12345678', version: SESSION_FORMAT_VERSION, createdAt: 0, cwd: '/synthetic/workspace', isSeeded: true, parentSession: 'synthetic-parent' })

test('title reader passes exact live objects and full archived lifecycle headers without side effects', () => {
  assert.ok(Number.isSafeInteger(header.version))
  const session = { id: header.id, header }
  const calls = []
  const projections = { cachedSnapshot(value, keys) {
    assert.equal(this, projections); assert.equal(value, session); assert.deepEqual(keys, ['title'])
    calls.push('live'); return { values: { title: '当前客户端标题' } }
  } }
  const cache = { cachedSnapshot(value, keys) {
    assert.equal(this, cache); assert.equal(value, header); assert.deepEqual(keys, ['title'])
    assert.equal(value.createdAt, 0); assert.equal(value.isSeeded, true)
    calls.push('stored'); return { values: { title: '历史客户端标题' } }
  } }
  assert.equal(readClientSessionTitle({ projections, cache }, header, session), '当前客户端标题')
  assert.deepEqual(calls, ['live'])
  assert.equal(readClientSessionTitle({ projections, cache }, header), '历史客户端标题')
  assert.deepEqual(calls, ['live', 'stored'])
})

test('predecessor cache fallback is only for an absent snapshot, never missing/null title', () => {
  let snapshot
  let predecessors = 0
  const cache = { cachedSnapshot: () => snapshot, cachedPredecessorTitle(value) {
    assert.equal(value, header); predecessors++; return { values: { title: '旧格式标题' } }
  } }
  assert.equal(readClientSessionTitle({ cache }, header), '旧格式标题')
  assert.equal(predecessors, 1)
  for (const title of [null, undefined, '', ' \t\n', 12, { title: 'not a string' }]) {
    snapshot = { values: { title } }
    assert.equal(readClientSessionTitle({ cache }, header), undefined)
  }
  assert.equal(predecessors, 1)
  snapshot = { values: { title: '新格式标题' } }
  assert.equal(readClientSessionTitle({ cache }, header), '新格式标题')
})

test('live title absence and optional capability failures never resurrect old titles or hide rows', () => {
  let archivedReads = 0
  const cache = { cachedSnapshot() { archivedReads++; return { values: { title: 'stale' } } } }
  for (const projections of [undefined, {}, { cachedSnapshot: () => undefined }, { cachedSnapshot: () => ({ values: { title: null } }) }, { cachedSnapshot() { throw new Error('unavailable') } }]) {
    assert.equal(readClientSessionTitle({ projections, cache }, header, { id: header.id, header }), undefined)
  }
  assert.equal(archivedReads, 0)
  assert.equal(readClientSessionTitle({}, header), undefined)
  assert.equal(readClientSessionTitle({ cache }), undefined)
  assert.equal(readClientSessionTitle({ cache: { cachedSnapshot() { throw new Error('cache not ready') } } }, header), undefined)
  assert.equal(readClientSessionTitle({ cache: { cachedSnapshot: () => undefined, cachedPredecessorTitle() { throw new Error('old cache unavailable') } } }, header), undefined)
})

test('real SDK projection registry exposes cached title updates without folding history or generating titles', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const projections = ctx.get('sessionProjections')
  const titleSchema = z.string().min(1).nullable()
  // The installed dsh-session-title 0.2 unit's public contract (not a provider).
  const unregister = projections.register({ key: 'title', stateVersion: 1, stateSchema: titleSchema,
    init: () => null, apply: (state, event) => event.type === 'session/title' ? event.data.title : state,
    wire: { viewSchema: titleSchema, view: state => state } })
  const session = { id: header.id, header, seq: 0, inheritedEventCount: 0,
    snapshotEvents() { throw new Error('listing must not scan any history') },
    eventAt() { throw new Error('listing must not replay events') } }
  try {
    ctx.emit('session/created', session)
    assert.equal(readClientSessionTitle({ projections }, header, session), undefined)
    session.seq = 1
    ctx.emit('session/event', session, { seq: 0, type: 'session/title', data: { title: '自动生成 🧪' } })
    assert.equal(readClientSessionTitle({ projections }, header, session), '自动生成 🧪')
    assert.equal(readClientSessionTitle({ projections }, header, { ...session }), undefined, 'a copy has no live projection cells')
    session.seq = 2
    ctx.emit('session/event', session, { seq: 1, type: 'session/title', data: { title: '电脑端手动重命名' } })
    assert.equal(readClientSessionTitle({ projections }, header, session), '电脑端手动重命名')
    unregister()
    assert.equal(readClientSessionTitle({ projections }, header, session), undefined)
  } finally { await ctx.fiber.dispose() }
})

test('display uses one safe title line, compact project identity and visible fallback without path noise', () => {
  const item = { sessionId: header.id, title: '整理周报 🧪', workspaceTitle: '工作项目', path: '/do/not/show/full/path', current: true, live: true }
  assert.equal(formatSessionListItem(item, 0), '1. 【当前】整理周报 🧪\n   工作项目 · 12345678')
  assert.equal(formatSessionListItem({ ...item, current: false }, 1), '2. 整理周报 🧪（已打开）\n   工作项目 · 12345678')
  assert.equal(formatSessionSummary(item), '整理周报 🧪\n   工作项目 · 12345678')
  assert.equal(sessionDisplayTitle({}), '未命名会话')
  assert.equal(sessionDisplayTitle({ title: '\n\t' }), '未命名会话')
  assert.equal(cleanSessionLabel('\u001b[31m标题\u001b[0m\n第二行\u202e\u0000'), '标题 第二行')
  assert.equal(formatSessionListItem({ ...item, title: '\u001b]0;hidden\u0007 正文\n尾行', workspaceTitle: '项目\r\n名' }, 0).split('\n').length, 2)
  const long = formatSessionSummary({ ...item, title: '🧪'.repeat(150) }).split('\n')[0]
  assert.equal(Array.from(long).length, 120)
  assert.equal(long, '🧪'.repeat(119) + '…')
})
