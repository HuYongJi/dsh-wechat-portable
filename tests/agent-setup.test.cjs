const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Context, Service } = require('@deepseek-ai/cordis')
const { createScope, scopeOf } = require('@deepseek-ai/dsh-scope')
const { default: ToolsService } = require('@deepseek-ai/dsh-tools')
const { createWechatAgentSetup, WECHAT_CHANNEL_SECTION } = require('../lib/agent-setup.js')

async function harness(options = {}) {
  const ctx = new Context()
  const calls = { mounts: [], sections: [], events: [] }
  const missing = options.missing
  class Presets extends Service {
    constructor(provider) { super(provider, 'agentPresets') }
    async mount(target, id) {
      assert.ok(scopeOf(target)); calls.mounts.push(id)
      if (options.mountError) throw new Error('fixture preset failed')
      return { id: options.wrongPreset ? 'unexpected-preset' : id }
    }
  }
  class Projections extends Service {
    constructor(provider) { super(provider, 'sessionProjections') }
    stateOf(session, key) { assert.equal(key, 'agentPreset'); return options.storedPreset }
  }
  class Permissions extends Service {
    constructor(provider) { super(provider, 'permissionPresets') }
    get defaultPreset() { return 'fixture-default' }
    resolve() { return options.permissions || { sandbox: 'danger-full-access', approval: 'ask' } }
  }
  class Prompt extends Service {
    constructor(provider) { super(provider, 'systemPrompt') }
    tools() { return () => {} }
    section(value) { calls.sections.push({ key: scopeOf(this.ctx), value }) }
  }
  // Separate provider fiber: installing services on the root would implicitly
  // grant descendant scopes access and conceal the production injection bug.
  await ctx.plugin(provider => {
    if (missing !== 'agentPresets') new Presets(provider)
    new Projections(provider)
    if (missing !== 'permissionPresets') new Permissions(provider)
    new Prompt(provider)
  })
  if (missing !== 'tools') await ctx.plugin(ToolsService)
  const agent = { session: { append(type, data) { calls.events.push({ type, data }) } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const setup = createWechatAgentSetup({ accountId: 'fixture-only', resumed: !!options.resumed, presetId: 'fresh-preset' })
  return { ctx, calls, agent, scope, setup, async close() { await scope.dispose(); await ctx.fiber.dispose() } }
}

test('real raw Agent scope reproduces both alpha.3 undeclared property errors', async () => {
  const h = await harness()
  try {
    assert.throws(() => h.agent.ctx.agentPresets, /agentPresets.*without inject/)
    assert.throws(() => h.agent.ctx.tools, /tools.*without inject/)
  } finally { await h.close() }
})
test('fresh setup uses scoped lookups and actual SDK tool guard without global effects', async () => {
  const h = await harness()
  try {
    await h.setup(h.agent.ctx, h.agent)
    assert.deepEqual(h.calls.mounts, ['fresh-preset'])
    assert.deepEqual(h.calls.events, [
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { type: 'approval/policy', data: { policy: 'ask' } },
    ])
    assert.equal(h.calls.sections[0].key, h.agent)
    assert.equal(h.calls.sections[0].value.name, WECHAT_CHANNEL_SECTION)
    const tools = h.ctx.get('tools')
    assert.match(tools.guardReason({ agent: h.agent, name: 'ask_user_question' }), /cannot display/)
    assert.match(tools.guardReason({ agent: h.agent, name: 'exit_plan_mode' }), /cannot display/)
    assert.equal(tools.guardReason({ agent: h.agent, name: 'read' }), undefined)
    assert.equal(tools.guardReason({ agent: {}, name: 'ask_user_question' }), undefined)
    assert.equal(tools.guardReason({ name: 'ask_user_question' }), undefined)
    await h.scope.dispose()
    assert.equal(tools.guardReason({ agent: h.agent, name: 'ask_user_question' }), undefined)
  } finally { await h.close() }
})
test('resume retains the stored preset and does not rewrite permissions', async () => {
  const h = await harness({ resumed: true, storedPreset: 'stored-preset' })
  try {
    await h.setup(h.agent.ctx, h.agent)
    assert.deepEqual(h.calls.mounts, ['stored-preset'])
    assert.deepEqual(h.calls.events, [])
  } finally { await h.close() }
})
test('fresh setup preserves stricter read-only and never defaults', async () => {
  const h = await harness({ permissions: { sandbox: 'read-only', approval: 'never' } })
  try {
    await h.setup(h.agent.ctx, h.agent)
    assert.deepEqual(h.calls.events.map(event => event.data), [{ mode: 'read-only' }, { policy: 'never' }])
  } finally { await h.close() }
})
for (const service of ['agentPresets', 'permissionPresets', 'tools']) test(`missing ${service} fails closed instead of broadening access`, async () => {
  const h = await harness({ missing: service })
  try { await assert.rejects(h.setup(h.agent.ctx, h.agent), /service is required/) }
  finally { await h.close() }
})
for (const options of [{ resumed: true }, { mountError: true }, { wrongPreset: true }]) test(`invalid preset never falls back: ${JSON.stringify(options)}`, async () => {
  const h = await harness(options)
  try {
    await assert.rejects(h.setup(h.agent.ctx, h.agent))
    assert.deepEqual(h.calls.events, [])
    assert.equal(h.calls.sections.length, 0)
  } finally { await h.close() }
})
