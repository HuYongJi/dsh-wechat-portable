'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-format-'))
process.env.DSH_BRIDGE_DATA_DIR = directory
const { formatWechatText: format } = require('../lib/bridge/wechat/format.js')
const { splitWechatText: split, takeWechatBatch: take } = require('../lib/bridge/wechat/text.js')
const { handleMessage } = require('../lib/bridge/main.js')
const { createSessionStore } = require('../lib/bridge/session.js')
const { loadPendingQueue, appendPending, createPendingQueueDrainer } = require('../lib/bridge/pending-queue.js')
const { createSender } = require('../lib/bridge/wechat/send.js')

after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('wb-format-'))
  fs.rmSync(directory, { recursive: true, force: true })
})

test('headings, emphasis, lists, tasks and quotes become a phone-readable view', () => {
  const source = '# **处理结果**\r\n\r\n已完成 **排版**，保留 `foo_bar`。\r\n\r\n- 第一步\r\n  - 子步骤\r\n- [x] 已验证\r\n- [ ] 待验收\r\n2) __重启__\r\n\r\n> 请先保存\r\n\r\n***\r\n\r\n~~旧方法~~'
  assert.equal(format(source), '【处理结果】\n\n已完成 排版，保留 foo_bar。\n\n• 第一步\n  • 子步骤\n☑ 已验证\n☐ 待验收\n2. 重启\n\n│ 请先保存\n\n────────\n\n〔已删除：旧方法〕')
  assert.equal(format('标题\n===\n\n副标题\n---\n正文'), '【标题】\n\n【副标题】\n\n正文')
  assert.equal(format('## 标题 ##\n\n*强调* _提示_ ***重点***'), '【标题】\n\n强调 提示 重点')
  assert.equal(format(' \n\n你好\n\n\n世界\n\n'), '你好\n\n世界')
  assert.equal(format(''), '')
})

test('fenced code keeps indentation, blank lines, literal syntax and shorter fences', () => {
  const code = '  # comment\n  const s = "**literal** [x](y)";\n\n\n  a_b = a * b\n  | a | b |\n  | --- | --- |'
  assert.equal(format('```ts\n' + code + '\n```'), '【代码 · ts】\n' + code)
  assert.equal(format('~~~~python\nprint("**x**")\n~~~\n~~~~\n\n**结束**'), '【代码 · python】\nprint("**x**")\n~~~\n\n结束')
  assert.equal(format('````md\n```js\n# literal\n```\n````'), '【代码 · md】\n```js\n# literal\n```')
  assert.equal(format('```\n# incomplete\n\n\n'), '【代码】\n# incomplete\n\n\n')
  assert.equal(format('```\na\n\n```'), '【代码】\na\n')
  assert.equal(format('    **indented code**\n    x_y\n\t# literal'), '    **indented code**\n    x_y\n\t# literal')
})

test('indented code and multiline inline spans cannot be reinterpreted as Markdown', () => {
  const indented = '    - **literal**\n\n\n    1) foo_bar\n    [x](y)'
  assert.equal(format(indented), indented)
  const multiline = '`**literal**\n# still code\n[x](y)`'
  assert.equal(format(multiline), multiline)
  assert.equal(format('前言\n\n' + multiline + '\n\n**结束**'), '前言\n\n' + multiline + '\n\n结束')
})

test('inline code is opaque, including multiple backticks and private-use characters', () => {
  assert.equal(format('运行 `**literal**`，以及 ``a ` b``，`[link](x)`。'), '运行 **literal**，以及 a ` b，[link](x)。')
  assert.equal(format('\uE0000\uE001 `literal` **普通**'), '\uE0000\uE001 literal 普通')
  assert.equal(format('a_b_c foo__bar__baz a*b*c 2 * 3 = 6 *.ts foo_bar.md'), 'a_b_c foo__bar__baz a*b*c 2 * 3 = 6 *.ts foo_bar.md')
  assert.equal(format(String.raw`\*不是强调\* \[不是链接\]`), '*不是强调* [不是链接]')
})

test('links retain destinations, balanced parentheses, image paths and titles do not leak', () => {
  assert.equal(format('[**文档**](https://example.test/a_(b)?x=one_two "说明")'), '文档（https://example.test/a_(b)?x=one_two）')
  assert.equal(format('<https://example.test/a_b> https://example.test/__raw__?q=*x*'), 'https://example.test/a_b https://example.test/__raw__?q=*x*')
  assert.equal(format('[https://example.test](https://example.test)'), 'https://example.test')
  assert.equal(format('![示意图](<./images/a b.png>)'), '图片：示意图（./images/a b.png）')
  assert.equal(format('[文档](<./a b.md#L24-L30>)'), '文档（./a b.md#L24-L30）')
  assert.equal(format(String.raw`[打开](<C:\Work\my_file (1)\foo_bar.md#L24>)`), String.raw`打开（C:\Work\my_file (1)\foo_bar.md#L24）`)
  assert.equal(format(String.raw`[括号](<C:\(test)\file.md>)`), String.raw`括号（C:\(test)\file.md）`)
  assert.equal(format(String.raw`C:\Work\__name__\*.ts \\server\share\_file_`), String.raw`C:\Work\__name__\*.ts \\server\share\_file_`)
  assert.equal(format('[broken](https://example.test'), '[broken](https://example.test')
  assert.equal(format('x < y > z'), 'x < y > z')
})

test('path separators, spaces, underscores and destination backticks survive formatting', () => {
  const posix = '/tmp/__cache__/foo.txt ~/src/_build_/x.js ./dir/__name__/y.md src/__build__/main.ts 中文目录/_temp_/文档.md'
  assert.equal(format(posix), posix)
  const windows = String.raw`C:\Program Files\__name__\file.txt`
  assert.equal(format(windows), windows)
  assert.equal(format('[open](<' + windows + '>)'), 'open（' + windows + '）')
  assert.equal(format('[open](<C:/dir/`__x__`.txt>)'), 'open（C:/dir/`__x__`.txt）')
  assert.equal(format('[`**literal**`](<./x.md>)'), '**literal**（./x.md）')
  assert.equal(format('`[open](<C:/dir/file>)`'), '[open](<C:/dir/file>)')
})

test('tables become vertical records instead of wide mobile columns', () => {
  assert.equal(format('| 项目 | 状态 |\n| :--- | ---: |\n| **排版** | 已完成 |\n| 客户端 | 不变 |'), '1. 项目：排版\n   状态：已完成\n\n2. 项目：客户端\n   状态：不变')
  assert.equal(format('名称 | 值\n--- | ---\n转义 | a\\|b\n代码 | `x|y`\n空白 |\n额外 | x | y'), '1. 名称：转义\n   值：a|b\n\n2. 名称：代码\n   值：x|y\n\n3. 名称：空白\n   值：（空）\n\n4. 名称：额外\n   值：x\n   第3列：y')
  assert.equal(format('| A | B |\n| --- | --- |\n| | |'), '1. A：（空）\n   B：（空）')
  assert.equal(format('a | b\nnot | a separator'), 'a | b\nnot | a separator')
  assert.equal(format('| A | B |\n| --- | --- |'), 'A / B')
  assert.equal(format('A | B\n--- | ---\n一 | 第一行<br>第二行'), '1. A：一\n   B：第一行\n第二行')
  assert.equal(format('| path | mode |\n| --- | --- |\n| `C:\\` | enabled |'), '1. path：C:\\\n   mode：enabled')
  assert.equal(format('| A | B |\n| --- | --- |\n| 10` | hello |'), '1. A：10`\n   B：hello')
})

test('message splitting is lossless, bounded and preserves emoji/combining sequences', () => {
  for (const limit of [2, 17, 1200, 4000]) {
    const text = '标题\n\n' + ('  const x = "👩🏽‍💻 e\u0301 **literal**";\n\n\n').repeat(260) + '结尾'
    const chunks = split(text, limit)
    assert.equal(chunks.join(''), text)
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= limit && chunk.isWellFormed()))
    if (limit > 17) {
      const boundaries = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), value => value.index))
      let offset = 0
      for (const chunk of chunks) { assert.ok(boundaries.has(offset)); offset += chunk.length }
    }
    const [first, rest] = take(text, limit)
    assert.equal(first + rest, text)
  }
  for (const limit of [1200, 4000]) {
    const text = '字'.repeat(limit - 1) + '😀' + 'e\u0301'.repeat(limit)
    const [first, rest] = take(text, limit)
    assert.equal(first.length, limit - 1)
    assert.ok(rest.startsWith('😀'))
    assert.equal(split(text, limit).join(''), text)
  }
  assert.deepEqual(split('.\u0301A', 2), ['.\u0301', 'A'])
  assert.deepEqual(split(''), [])
  for (const invalid of [0, 1, -1, 1.5, Infinity, NaN]) assert.throws(() => split('text', invalid), RangeError)
})

function fixture(suffix, texts, options = {}) {
  const account = { accountId: `format-${suffix}`, userId: 'synthetic-owner' }
  const store = createSessionStore({ botAccountId: account.accountId, ownerUserId: account.userId, defaultWorkingDirectory: directory })
  const sent = []
  const events = texts.map(text => Object.freeze({ type: 'chunk', text }))
  const sender = {
    sendText: async (_user, _token, text) => { sent.push(text) },
    startTyping: () => () => {},
    ...options.sender,
  }
  const client = {
    prompt: async input => { assert.equal(input.text, '请回答'); return { accepted: true } },
    stream: async (_key, callback) => {
      for (const event of events) callback(event)
      callback({ type: 'done', terminal: 'completed' })
    },
    ...options.client,
  }
  const run = () => handleMessage({ message_type: 1, from_user_id: account.userId, context_token: 'fake-context', item_list: [{ type: 1, text_item: { text: '请回答' } }] }, account, store, sender, { workingDirectory: directory, usageFooter: false }, client, new AbortController().signal)
  return { account, store, sent, sender, events, run }
}

test('actual daemon message entry formats only outbound view; event and stored Markdown stay original', async () => {
  const source = '# 完成\n\n- **微信**：更易读\n- **客户端**：原样\n\n```js\nconst name = "**literal**";\n```'
  const f = fixture('separation', [source])
  await f.run()
  assert.deepEqual(f.sent, [format(source)])
  assert.equal(f.events[0].text, source)
  const history = f.store.load(f.account.userId).chatHistory
  assert.equal(history.at(-1).content, source)
  assert.equal(history[0].content, '请回答')
})

test('separate committed messages keep display boundaries without changing raw history', async () => {
  const sources = ['**第一条**', '```txt\n# 第二条\n```', '# 第三条']
  const f = fixture('messages', sources)
  await f.run()
  assert.equal(f.sent.join(''), sources.map(format).join('\n\n'))
  assert.equal(f.store.load(f.account.userId).chatHistory.at(-1).content, sources.join(''))
})

test('long code and table formatting occurs before both batching and transport splits', async () => {
  const source = '# 大回复\n\n```js\n' + ('  const x = "**code** [x](y) 😀";\n\n\n').repeat(350) + '```\n\n| 项目 | 值 |\n| --- | --- |\n| A | 完成 |'
  const f = fixture('large', [source])
  await f.run()
  assert.ok(f.sent.length > 3)
  assert.ok(f.sent.every(part => part.length <= 4000 && part.isWellFormed()))
  assert.equal(f.sent.join(''), format(source))
  assert.equal(f.store.load(f.account.userId).chatHistory.at(-1).content, source)
})

test('partial-send failure persists only rendered failed/unsent suffix, not acknowledged chunks', async () => {
  const source = '```md\n' + ('**literal** [link](url)\n\n\n').repeat(600) + '```'
  const sent = []
  let attempts = 0
  const f = fixture('retry', [source], { sender: { sendText: async (_user, _token, text) => {
    attempts++
    // First 1200 batch succeeds, then first 4000 transport chunk succeeds.
    if (attempts >= 3) throw new Error('synthetic offline')
    sent.push(text)
  } } })
  await f.run()
  assert.equal(sent.length, 2)
  const pending = loadPendingQueue(f.account.accountId)
  assert.equal(pending.length, 1)
  assert.equal(sent.join('') + pending[0].text, format(source))
  assert.match(pending[0].text, /\*\*literal\*\* \[link\]\(url\)/)
  assert.equal(f.store.load(f.account.userId).chatHistory.at(-1).content, source)
})

test('a new committed message arriving during a failed send retains its display boundary', async () => {
  let began, release
  const started = new Promise(resolve => { began = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const source = 'a'.repeat(1200)
  const sent = []
  let attempts = 0
  const f = fixture('inflight-boundary', [], {
    sender: { sendText: async (_user, _token, text) => {
      if (++attempts === 1) { began(); await gate; throw new Error('offline') }
      sent.push(text)
    } },
    client: { stream: async (_key, callback) => {
      callback({ type: 'chunk', text: source })
      await started
      callback({ type: 'chunk', text: '**SECOND**' })
      release()
      callback({ type: 'done', terminal: 'completed' })
    } },
  })
  await f.run()
  assert.equal(sent.join(''), source + '\n\nSECOND')
  assert.deepEqual(loadPendingQueue(f.account.accountId), [])
})

test('persistent retry splits legacy/code text verbatim and only retains failed suffix across restart', async () => {
  const accountId = 'format-persistent'
  const text = ('# literal **code** [link](path)\n\n  😀\n').repeat(400)
  appendPending(accountId, { role: 'final', text, queuedAt: 1 })
  const sent = []
  let attempts = 0
  const firstDrain = createPendingQueueDrainer(accountId, 'synthetic-owner', async (target, part) => {
    assert.equal(target, 'synthetic-owner')
    assert.ok(part.length <= 4000 && part.isWellFormed())
    if (++attempts === 2) throw new Error('offline')
    sent.push(part)
  })
  await firstDrain()
  const remaining = loadPendingQueue(accountId)
  assert.equal(remaining.length, 1)
  assert.equal(sent.join('') + remaining[0].text, text)
  const restarted = createPendingQueueDrainer(accountId, 'synthetic-owner', async (_target, part) => { sent.push(part) })
  await restarted()
  assert.equal(sent.join(''), text)
  assert.deepEqual(loadPendingQueue(accountId), [])
})

test('persistent drain prevents overlap, keeps concurrent appends and rejects another owner', async () => {
  const accountId = 'format-overlap'
  let release, began
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { began = resolve })
  const sent = []
  appendPending(accountId, { role: 'final', text: 'first', queuedAt: 1 })
  appendPending(accountId, { role: 'final', text: 'must not send', userId: 'stranger', queuedAt: 1 })
  const drain = createPendingQueueDrainer(accountId, 'synthetic-owner', async (_target, text) => {
    sent.push(text)
    if (text === 'first') { began(); await gate }
  })
  const running = drain()
  await started
  await drain()
  assert.deepEqual(sent, ['first'])
  appendPending(accountId, { role: 'final', text: 'later', queuedAt: 2 })
  release()
  await running
  assert.deepEqual(loadPendingQueue(accountId).map(item => item.text), ['later'])
  await drain()
  assert.deepEqual(sent, ['first', 'later'])
  assert.deepEqual(loadPendingQueue(accountId), [])
})

test('protocol sender stays raw so approval commands and already formatted literal code are untouched', async () => {
  const captured = []
  const sender = createSender({ sendMessage: async value => { captured.push(value.msg) } }, 'synthetic-bot')
  const approval = '审批：`/yes nonce_123` 或 `/no nonce_123`\n**literal**'
  await sender.sendText('synthetic-owner', 'fake-context', approval)
  assert.equal(captured[0].item_list[0].text_item.text, approval)
})
