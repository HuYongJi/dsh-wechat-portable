/**
 * dsh-wechat-portable — DSH 微信桥接插件（hybrid）。
 *
 * Host 侧：
 *  - 启动一个仅监听 127.0.0.1 的内部 HTTP + SSE 服务，供桥接守护进程调用；
 *  - 用 DSH 自身 Agent（ctx.agents）处理微信转发来的消息；
 *  - 提供 wechat_bridge_* 工具与可选的 Web 面板同源路由。
 *
 * 三端通用：Windows / macOS / Linux 都使用纯 Node 进程管理（PID 文件 +
 * spawn/kill），不依赖 launchd/systemd。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync, unlinkSync, chmodSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createApprovalManager } from './approval.js'
import { createWechatAgentSetup } from './agent-setup.js'
import { registerNativeControl } from './host/control.js'
import { createConversationManager } from './host/conversations.js'
import type { Session as BridgeSession } from './bridge/session.js'
import { ControlError, parseControlValue, type ControlSetupStatus } from './host/contract.js'
import { resolveDataDir, defaultWorkingDirectory, ensurePrivateDir, atomicJson, requireWorkspace } from './portable/paths.js'
import { HttpBoundaryError, requireLoopbackHost, isLoopbackAddress, assertPanelRequest, readJsonBody, ownerSessionKey, isOwnerSessionKey, PromptReplay, assistantTextDelta, deferHostTask } from './host-compat.js'

// Pull in Context augmentation for agents/session/default-model/workspace events.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { startQrLogin, checkQrStatus } from './bridge/wechat/login.js'
import { loadJson, saveJson, validateAccountId } from './bridge/store.js'
import type { NotifyStatus } from './bridge/notify.js'
import { loadTrust, saveTrust, addTrusted, removeTrusted, setTrustMode, listTrusted, isPlausibleUserId, type TrustFile, type TrustMode } from './bridge/trust.js'
import { parseSessionKey } from './bridge/session-key.js'
import { parseCalmConfig } from './bridge/config.js'

export const name = 'dsh-wechat-portable'

/** Host services the plugin needs. `webServer` is optional (headless profiles). */
export const inject = ['tools', 'agents', 'agentDefaultModel', 'agentPresets']

export interface Config {
  /** Data directory for accounts/sessions/logs. */
  dataDir: string
  /** Internal API bind host; keep loopback for safety. */
  host: string
  /** Internal API port; 0 = OS-assigned. */
  port: number
  /** Auto-start bridge daemon when the plugin loads. */
  autoStart: boolean
  /** Provider route for the DSH agent created per WeChat account. */
  provider: string
  /** Default model for the DSH agent created per WeChat account. */
  model: string
  /** Default workspace for the DSH agent created per WeChat account. */
  workingDirectory: string
  /** Bridge approval requests to WeChat (/yes /no); false = leave them to the desktop GUI. */
  approvalViaWechat: boolean
  /** Seconds before a WeChat approval request auto-rejects (fail-closed). */
  approvalTimeoutSec: number
}

export const Config = z.object({
  dataDir: z.string().default(''),
  host: z.string().default('127.0.0.1'),
  port: z.number().min(0).max(65535).default(0),
  autoStart: z.boolean().default(false),
  provider: z.string().default(''),
  model: z.string().default(''),
  workingDirectory: z.string().default(''),
  approvalViaWechat: z.boolean().default(true),
  approvalTimeoutSec: z.number().min(10).max(3600).default(300),
})

interface StreamUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

interface StreamEvent {
  type: 'chunk' | 'done' | 'error' | 'status'
  text?: string
  sessionId?: string
  message?: string
  turn?: number
  terminal?: string
  /** 本轮最后一步的 LLM 用量（turn/end 时随 done 下发，供微信端尾注展示）。 */
  usage?: StreamUsage
}

interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface ProjectSessionItem {
  sessionId: string
  workspaceId: string
  workspaceTitle: string
  path: string
  cwd?: string
  createdAt: string
  live: boolean
}

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx: Context, config: Config): void {
  requireLoopbackHost(config.host)
  const dataDir = resolveDataDir(config.dataDir)
  const daemonLogPath = join(dataDir, 'logs', 'daemon.log')
  const pidPath = join(dataDir, 'daemon.pid')

  ensurePrivateDir(dataDir)
  ensurePrivateDir(join(dataDir, 'logs'))

  const token = randomBytes(24).toString('hex')
  const pluginLogPath = join(dataDir, 'plugin.log')

  function debugLog(message: string, data?: unknown): void {
    try {
      ensurePrivateDir(dataDir)
      const line = `[${new Date().toISOString()}] ${message}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`
      appendFileSync(pluginLogPath, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // ignore
    }
  }

  const agents = new Map<string, AgentHandle>()
  /** Maps the WeChat-facing account id (used by the daemon) to the real DSH session id. */
  const sessionIds = new Map<string, string>()
  const activeSessionIds = new Set<string>()
  const creating = new Map<string, Promise<AgentHandle>>()
  const creationControllers = new Map<string, AbortController>()
  const closing = new Set<string>()
  const pendingPrompts = new Set<string>()
  const streamReplay = new Map<string, PromptReplay<StreamEvent & { [key: string]: unknown }>>()
  let hostDisposed = false
  const streamClients = new Map<string, Set<ServerResponse>>()
  /** Accounts waiting to switch to a selected project after the current turn ends. */
  const pendingProjectSwitches = new Set<string>()
  let bridgeChild: ChildProcess | undefined
  let daemonStarting: Promise<{ ok: boolean; message: string }> | undefined
  let bridgeStartedAt: number | undefined
  let internalServer: ReturnType<typeof createServer> | undefined
  let internalPort = 0
  let pendingSetup: { qrcodeId: string; workingDirectory: string } | undefined
  // Native Stop is an explicit user decision: the watchdog must not undo it.
  let nativeStopRequested = false
  let nativeDaemonChange = false
  let nativeSetup: { qrcodeId: string; expiresAt: number } | undefined

  // -------------------------------------------------------------------------
  // DSH session id persistence (cross-restart continuation)
  // -------------------------------------------------------------------------

  const sessionIdMapPath = join(dataDir, 'session-ids.json')

  function loadSessionIdMap(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(sessionIdMapPath, 'utf8')) as Record<string, string>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveSessionIdMap(map: Record<string, string>): void {
    ensurePrivateDir(dataDir)
    atomicJson(sessionIdMapPath, map)
  }

  function persistSessionId(accountId: string, dshSessionId: string): void {
    const map = loadSessionIdMap()
    map[accountId] = dshSessionId
    saveSessionIdMap(map)
  }

  function removePersistedSessionId(accountId: string): void {
    const map = loadSessionIdMap()
    if (accountId in map) {
      delete map[accountId]
      saveSessionIdMap(map)
    }
  }

  /**
   * 多用户迁移（P1-2 / M2）：旧单用户时代 session-ids.json 的 key 是 bot accountId，
   * 新版统一为 `${accountId}::${userId}`。能确定 owner 的条目一次性改名为新 key
   * （owner 的 DSH 会话无缝续上）；不能确定的保留原样不动（绝不丢历史，
   * 只是该条目不会再被命中，新消息走新 key）。
   */
  function migrateSessionIdMap(): void {
    const map = loadSessionIdMap()
    let changed = false
    for (const key of Object.keys(map)) {
      if (key.includes('::')) continue
      const owner = ownerUserIdOf(key)
      if (!owner) continue
      const newKey = `${key}::${owner}`
      if (!(newKey in map)) {
        map[newKey] = map[key]
        delete map[key]
        changed = true
        debugLog('session-ids.json migrated to per-user key', { oldKey: key, newKey })
      }
    }
    if (changed) saveSessionIdMap(map)
  }

  // -------------------------------------------------------------------------
  // Explicit project-conversation binding (Web panel selection)
  // -------------------------------------------------------------------------

  const selectedSessionIdPath = join(dataDir, 'selected-sessions.json')

  function loadSelectedSessionIds(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(selectedSessionIdPath, 'utf8')) as Record<string, string>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  function saveSelectedSessionIds(map: Record<string, string>): void {
    ensurePrivateDir(dataDir)
    atomicJson(selectedSessionIdPath, map)
  }

  function persistSelectedSessionId(accountId: string, dshSessionId: string): void {
    assertOwnerKey(accountId)
    const map = loadSelectedSessionIds()
    map[accountId] = dshSessionId
    saveSelectedSessionIds(map)
  }

  function removeSelectedSessionId(accountId: string): void {
    const map = loadSelectedSessionIds()
    if (accountId in map) {
      delete map[accountId]
      saveSelectedSessionIds(map)
    }
  }

  const selectedSessionIds = new Map<string, string>(Object.entries(loadSelectedSessionIds()))

  function currentSessionId(key: string): string | undefined {
    return selectedSessionIds.get(key) ?? selectedSessionIds.get(botPrefixOf(key))
      ?? sessionIds.get(key) ?? loadSessionIdMap()[key]
  }

  function newDshSessionId(key: string): string {
    // 多用户 key 形如 ${botAccountId}::${userId}，而账号/用户 id 本身自带 '@' 与 '.'。
    // DSH 会话 id 有两处字符集要求：
    //  - Windows 文件名：':' 之类非法；
    //  - 存储层 per-record key（session_projcache 用会话 id 作 key）：必须匹配
    //    /^[a-zA-Z0-9_-]+$/，否则该会话的投影缓存每次写入都被拒绝，日志持续刷
    //    "per-record key ... is not path-safe"。
    // 因此这里只保留 [A-Za-z0-9_-]，其余一律替换为 '-'。
    const safe = key.replace(/[^A-Za-z0-9_-]/g, '-')
    return `wb-${safe}-${Date.now()}-${randomBytes(4).toString('hex')}`
  }

  /** session key 的 bot 账号前缀（'::' 之前；单段 key 原样返回）。 */
  function botPrefixOf(key: string): string {
    const i = key.indexOf('::')
    return i === -1 ? key : key.slice(0, i)
  }

  /** 从 session key 解出微信用户 ID（单段旧 key 返回空）。 */
  function userIdOfKey(key: string): string {
    return parseSessionKey(key)?.userId || ''
  }

  // -------------------------------------------------------------------------
  // 信任集（多用户支持 P1-2 / M1）——trust.json 是唯一真相源
  // -------------------------------------------------------------------------

  function trustPath(): string {
    return join(dataDir, 'trust.json')
  }

  function loadTrustFile(): TrustFile {
    return loadTrust(trustPath())
  }

  function saveTrustFile(file: TrustFile): void {
    saveTrust(file, trustPath())
  }

  /** owner userId：最新绑定账号的 userId（用于面板展示与账号级会话文件定位）。 */
  function ownerUserIdOf(accountId: string): string {
    try {
      const acc = loadJson<{ userId?: unknown }>(join(dataDir, 'accounts', `${accountId}.json`), {})
      return typeof acc.userId === 'string' ? acc.userId : ''
    } catch {
      return ''
    }
  }

  /**
   * daemon 侧会话文件名：session key `${bot}::${user}` → `${bot}__${user}`；
   * 账号级 key（面板操作）→ 定位 owner 的 per-user 文件，找不到才退回旧文件名。
   */
  function bridgeSessionStem(key: string): string {
    if (key.includes('::')) return key.replace(/::/g, '__')
    const owner = ownerUserIdOf(key)
    if (owner && /^[A-Za-z0-9_.\-@=]+$/.test(owner)) return `${key}__${owner}`
    return key
  }

  // -------------------------------------------------------------------------
  // Agent management
  // -------------------------------------------------------------------------

  function assertOwnerKey(key: string): void {
    const account = latestAccountId()
    if (!account || !isOwnerSessionKey(key, account, ownerUserIdOf(account))) {
      throw new HttpBoundaryError('Only the currently paired account owner may control the bridge', 403)
    }
  }

  function ownerControlKey(target?: string): string {
    const account = latestAccountId()
    if (!account) throw new Error('No paired account')
    const key = !target || target === account ? ownerSessionKey(account, ownerUserIdOf(account)) : target
    assertOwnerKey(key)
    return key
  }

  async function ensureAgent(accountId: string, input?: { cwd?: string; model?: string }): Promise<AgentHandle> {
    assertOwnerKey(accountId)
    if (hostDisposed || closing.has(accountId)) throw new Error('Bridge session is closing')
    if (pendingProjectSwitches.has(accountId)) {
      pendingProjectSwitches.delete(accountId)
      await disposeAgent(accountId, { preserveSelection: true })
    }
    const existing = agents.get(accountId)
    if (existing) return existing
    const pending = creating.get(accountId)
    if (pending) return pending
    const controller = new AbortController()
    creationControllers.set(accountId, controller)
    const task = (async () => {
      const selection = ctx.agentDefaultModel.currentSelection()
      const provider = config.provider || selection?.provider
      const model = input?.model || config.model || selection?.model
      if (!provider || !model) throw new Error('Select a DSH provider and model before using WeChat')
      const agentOptions = { provider, model }
      const selectedSessionId = selectedSessionIds.get(accountId)
        ?? selectedSessionIds.get(botPrefixOf(accountId))
      const mapped = selectedSessionId ?? sessionIds.get(accountId) ?? loadSessionIdMap()[accountId]
      const resumed = !!mapped
      const preset = resumed ? undefined : await ctx.agentPresets.resolve()
      if (preset?.broken) throw new Error(`Agent preset is unavailable: ${preset.broken}`)
      controller.signal.throwIfAborted()
      const setup = createWechatAgentSetup({
        accountId, resumed, presetId: preset?.id, approval: approvalManager, log: debugLog,
        onStream: (frame) => {
          // Only committed assistant/message text is published to WeChat. A
          // failed/retried live attempt cannot be retracted once sent to a phone.
          if (frame.type === 'chunk' && frame.chunk.type === 'usage') lastUsage.set(accountId, frame.chunk.usage)
        },
      })
      const id = mapped ?? newDshSessionId(accountId)
      const cwd = requireWorkspace(resolve(input?.cwd || config.workingDirectory || readBridgeConfig().workingDirectory || defaultWorkingDirectory()))
      let handle: AgentHandle | undefined
      try {
        // Failed resume must preserve its mapping and policies, not silently create a fresh Agent.
        handle = mapped
          ? await ctx.agents.resume({ resumeSessionId: SessionId(mapped), agentOptions, setup, signal: controller.signal })
          : await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd, agentPreset: preset!.id }, agentOptions, setup, signal: controller.signal })
        controller.signal.throwIfAborted()
        if (hostDisposed || closing.has(accountId)) throw new Error('Bridge session was cancelled during creation')
        if (mapped && !selectedSessionId && input?.cwd && handle.agent.session.header.cwd && resolve(input.cwd) !== resolve(handle.agent.session.header.cwd)) {
          throw new Error('Stored session belongs to another workspace; use /new explicitly before changing it')
        }
        assertOwnerKey(accountId)
        persistSessionId(accountId, id)
        sessionIds.set(accountId, id)
        agents.set(accountId, handle)
        activeSessionIds.add(id)
        await attachSessionToWorkspace(id, handle.agent.session.header.cwd || cwd)
        controller.signal.throwIfAborted()
        if (hostDisposed || closing.has(accountId)) throw new Error('Bridge session cancelled while attaching workspace')
        debugLog('agent ready', { accountId, dshSessionId: id, resumed })
        return handle
      } catch (error) {
        if (handle) {
          if (agents.get(accountId) === handle) agents.delete(accountId)
          activeSessionIds.delete(id)
          await handle.dispose()
        }
        throw error
      }
    })()
    creating.set(accountId, task)
    try { return await task }
    finally {
      if (creating.get(accountId) === task) creating.delete(accountId)
      if (creationControllers.get(accountId) === controller) creationControllers.delete(accountId)
    }
  }

  async function disposeAgent(accountId: string, options?: { preserveSelection?: boolean }): Promise<void> {
    closing.add(accountId)
    creationControllers.get(accountId)?.abort(new Error('Bridge session cleared'))
    try {
      await creating.get(accountId)?.catch(() => undefined)
      const handle = agents.get(accountId)
      const id = sessionIds.get(accountId)
      if (id) activeSessionIds.delete(id)
      sessionIds.delete(accountId)
      agents.delete(accountId)
      removePersistedSessionId(accountId)
      if (!options?.preserveSelection) {
        // Remove the legacy bot-level fallback as well, even with no live agent.
        for (const key of new Set([accountId, botPrefixOf(accountId)])) {
          selectedSessionIds.delete(key)
          removeSelectedSessionId(key)
          removePersistedSessionId(key)
        }
        pendingProjectSwitches.delete(accountId)
      }
      if (handle) await handle.dispose()
      closeStreams(accountId)
      turnStreamState.delete(accountId)
      pendingPrompts.delete(accountId)
      streamReplay.delete(accountId)
    } finally { closing.delete(accountId) }
  }

  /** Register the DSH session under a dedicated workspace so it doesn't stay Ungrouped. */
  async function attachSessionToWorkspace(dshSessionId: string, cwd: string): Promise<void> {
    const registry = ctx.get('workspaceRegistry') as {
      resolveByPath(path: string): Promise<{ attachSession(id: SessionId): Promise<void> } | undefined>
      create(path: string, title?: string): Promise<{ attachSession(id: SessionId): Promise<void> }>
    } | undefined
    if (!registry) return
    try {
      let ws = await registry.resolveByPath(cwd)
      if (!ws) ws = await registry.create(cwd, '微信桥接')
      await ws.attachSession(SessionId(dshSessionId))
      debugLog('workspace attached', { dshSessionId, cwd })
    } catch (err) {
      debugLog('workspace attach failed', {
        dshSessionId,
        cwd,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -------------------------------------------------------------------------
  // Project conversation selection (Web panel)
  // -------------------------------------------------------------------------

  function latestAccountId(): string | undefined {
    try {
      const accountsDir = join(dataDir, 'accounts')
      const files = readdirSync(accountsDir).filter((file) => file.endsWith('.json'))
      if (files.length === 0) return undefined
      let latestFile = files[0]
      let latestMtime = 0
      for (const file of files) {
        const stat = statSync(join(accountsDir, file))
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latestFile = file
        }
      }
      return latestFile.replace(/\.json$/, '')
    } catch {
      return undefined
    }
  }

  async function listProjectSessions(): Promise<ProjectSessionItem[]> {
    const registry = ctx.get('workspaceRegistry') as
      | { list(): Array<{ id: string; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string }> }
      | undefined
    if (!registry?.list) return []

    const sessionsService = ctx.get('sessions') as
      | { list(): Array<{ id: unknown; header: { id?: unknown; cwd?: string; createdAt?: string } }> }
      | undefined
    const persistence = ctx.get('sessionPersistence') as
      | { listSnapshots?: () => Promise<Array<{ header: { id: unknown; cwd?: string; createdAt?: string } }>> }
      | undefined

    const headerById = new Map<string, { cwd?: string; createdAt?: string }>()
    const liveIds = new Set<string>()

    for (const session of sessionsService?.list() ?? []) {
      const id = String(session.id ?? session.header.id)
      if (!id) continue
      liveIds.add(id)
      headerById.set(id, {
        cwd: session.header.cwd,
        createdAt: session.header.createdAt,
      })
    }

    if (persistence?.listSnapshots) {
      try {
        for (const snap of await persistence.listSnapshots()) {
          const id = String(snap.header.id)
          if (!id) continue
          if (!headerById.has(id)) {
            headerById.set(id, {
              cwd: snap.header.cwd,
              createdAt: snap.header.createdAt,
            })
          }
        }
      } catch (err) {
        debugLog('listProjectSessions snapshots failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    const items: ProjectSessionItem[] = []
    for (const ws of registry.list()) {
      for (const sid of ws.sessionIds) {
        const sessionId = String(sid)
        const header = headerById.get(sessionId)
        items.push({
          sessionId,
          workspaceId: ws.id,
          workspaceTitle: ws.title,
          path: ws.path,
          cwd: header?.cwd || ws.path,
          createdAt: header?.createdAt || ws.createdAt,
          live: liveIds.has(sessionId),
        })
      }
    }
    return items
  }

  async function selectedProjectPayload(accountId?: string): Promise<Record<string, unknown> | null> {
    const target = ownerControlKey(accountId)
    if (!target) return null
    const selectedId = currentSessionId(target)
    if (!selectedId) return null
    const items = await listProjectSessions()
    const item = items.find((candidate) => candidate.sessionId === selectedId)
    if (!item) return null
    return {
      sessionId: selectedId,
      workspaceId: item.workspaceId,
      workspaceTitle: item.workspaceTitle,
      path: item.path,
    }
  }

  function accountIdForAgent(agent: { session?: { id?: unknown } } | undefined): string | undefined {
    if (!agent?.session?.id) return undefined
    const sid = String(agent.session.id)
    for (const [accountId, dshSessionId] of sessionIds) {
      if (dshSessionId === sid) return accountId
    }
    return undefined
  }

  async function selectProjectFromAgent(agent: { session?: { id?: unknown } } | undefined, sessionId: string): Promise<Record<string, unknown>> {
    const accountId = accountIdForAgent(agent)
    if (!accountId) {
      return { ok: false, error: '当前不是微信桥接会话，无法切换项目。' }
    }
    const items = await listProjectSessions()
    const item = items.find((candidate) => candidate.sessionId === sessionId)
    if (!item) {
      return { ok: false, error: '未找到该项目会话，请先使用 wechat_bridge_list_projects 查看可绑定项目。' }
    }

    const currentDshSessionId = sessionIds.get(accountId)
    if (sessionId === currentDshSessionId) {
      return {
        ok: true,
        accountId,
        selectedSessionId: sessionId,
        project: item,
        message: `已经在项目 ${item.workspaceTitle} 中。`,
      }
    }

    const sessionsService = ctx.get('sessions') as { get(id: unknown): unknown } | undefined
    if (sessionsService?.get(SessionId(sessionId))) {
      return { ok: false, error: '该项目会话当前正在 DSH 中打开，请先在 DSH 中关闭该会话后再进入。' }
    }

    selectedSessionIds.set(accountId, sessionId)
    persistSelectedSessionId(accountId, sessionId)
    resetBridgeAccountSession(accountId, item.path)
    pendingProjectSwitches.add(accountId)

    return {
      ok: true,
      accountId,
      selectedSessionId: sessionId,
      project: item,
      message: `已进入项目 ${item.workspaceTitle}（${item.path}），后续对话会记录到这个项目。`,
    }
  }

  function readBridgeAccountSession(key: string): Record<string, unknown> {
    const stem = bridgeSessionStem(key)
    validateAccountId(stem)
    return loadJson<Record<string, unknown>>(join(dataDir, 'sessions', `${stem}.json`), {})
  }

  function writeBridgeAccountSession(key: string, session: Record<string, unknown>): void {
    const stem = bridgeSessionStem(key)
    validateAccountId(stem)
    saveJson(join(dataDir, 'sessions', `${stem}.json`), session)
  }

  function resetBridgeAccountSession(key: string, cwd: string): void {
    const session = readBridgeAccountSession(key)
    session.workingDirectory = cwd
    session.state = 'idle'
    session.chatHistory = []
    writeBridgeAccountSession(key, session)
  }

  const conversations = createConversationManager({
    assertOwner: assertOwnerKey,
    current: currentSessionId,
    list: listProjectSessions,
    isLive: (id) => !!ctx.get('sessions')?.get(SessionId(id)),
    dispose: disposeAgent,
    stop: async (key) => {
      creationControllers.get(key)?.abort(new Error('WeChat stop requested'))
      await creating.get(key)?.catch(() => undefined)
      const handle = agents.get(key)
      if (handle) {
        handle.agent.cancel({ kind: 'user' })
        await handle.agent.whenIdle()
      }
      pendingPrompts.delete(key)
    },
    bind: (key, id) => {
      persistSelectedSessionId(key, id)
      selectedSessionIds.set(key, id)
    },
    create: async (key, input) => String((await ensureAgent(key, input)).agent.session.id),
    validateNew: (input) => {
      const selection = ctx.agentDefaultModel.currentSelection()
      if (!(config.provider || selection?.provider) || !(input.model || config.model || selection?.model)) {
        throw new Error('请先在 DSH 中选择模型。')
      }
      input.cwd = requireWorkspace(resolve(input.cwd.replace(/^~(?=$|[\\/])/, homedir())))
    },
    readLocal: (key) => ({
      workingDirectory: readBridgeConfig().workingDirectory, state: 'idle', chatHistory: [],
      ...readBridgeAccountSession(key),
    }) as BridgeSession,
    writeLocal: (key, session) => writeBridgeAccountSession(key, { ...session }),
    defaultDirectory: () => readBridgeConfig().workingDirectory,
  })

  async function selectProjectSession(dshSessionId: string, accountId?: string, restart = true): Promise<Record<string, unknown>> {
    const target = ownerControlKey(accountId)
    const result = await conversations.select(target, dshSessionId)
    if (restart && daemonRunning() && result.daemon !== '已经在该会话中。') {
      return { ...result, accountId: target, daemon: (await restartDaemon()).message }
    }
    return { ...result, accountId: target }
  }

  async function detachProjectSession(accountId?: string, restart = true): Promise<Record<string, unknown>> {
    const target = ownerControlKey(accountId)
    const result = await conversations.detach(target)
    if (restart && daemonRunning()) return { ...result, accountId: target, daemon: (await restartDaemon()).message }
    return { ...result, accountId: target }
  }

  /** dispose 精确匹配 key 及其 `${key}::` 前缀下的全部 agent（账号级操作用于多用户）。 */
  async function disposeKeysUnder(key: string): Promise<void> {
    const targets = [...new Set([...agents.keys(), ...creating.keys()])].filter((k) => k === key || k.startsWith(`${key}::`))
    for (const k of targets) {
      await disposeAgent(k)
    }
  }

  // -------------------------------------------------------------------------
  // SSE broadcast
  // -------------------------------------------------------------------------

  function broadcast(sessionId: string, event: StreamEvent): void {
    let replay = streamReplay.get(sessionId)
    if (!replay) { replay = new PromptReplay(); streamReplay.set(sessionId, replay) }
    const item = replay.push({ ...event, sessionId })
    const clients = streamClients.get(sessionId)
    if (!clients || clients.size === 0) return
    const payload = `id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`
    for (const res of [...clients]) {
      try {
        res.write(payload)
      } catch {
        // Client may have gone away; cleanup below.
      }
    }
    if (event.type === 'done' || event.type === 'error') {
      closeStreams(sessionId)
    }
  }

  function closeStreams(sessionId: string): void {
    const clients = streamClients.get(sessionId)
    if (!clients) return
    for (const res of [...clients]) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    streamClients.delete(sessionId)
  }

    // 每账号最近一次 LLM 用量：inputTokens + cacheReadTokens ≈ 当前上下文大小。
    const lastUsage = new Map<string, StreamUsage>()
    /**
     * 本轮流式状态：宿主是否真的推送过 text-delta，以及最后一条 assistant 消息正文。
     *
     * 会话格式 v3 起 `assistant/chunk` 不再写入会话日志，而 `session/event` 只广播
     * 被 append 的事件，所以该事件不会再到达这里（实测一轮里能收到
     * turn/start、assistant/message、turn/end，但没有任何 assistant/chunk）。
     * 若只依赖 chunk，守护进程收不到任何文本，只会回一句「DSH 无返回内容。」。
     */
    const turnStreamState = new Map<string, { hasChunk: boolean; lastText: string }>()

  ctx.on('session/event', (session: { id: unknown }, event: SessionEvent) => {
    const sid = String(session.id)
    if (!activeSessionIds.has(sid)) return
    const accountId = [...sessionIds.entries()].find(([, id]) => id === sid)?.[0]
    if (!accountId) return
    const state = turnStreamState.get(accountId) ?? { hasChunk: false, lastText: '' }
    turnStreamState.set(accountId, state)
    if (event.type === 'turn/start') {
      state.hasChunk = false
      state.lastText = ''
      lastUsage.delete(accountId)
    } else if (event.type === 'assistant/message') {
      const content = event.data.message.content
      const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      // Per-attempt fallback only. Live text has already been sent; do not duplicate it.
      if (!state.hasChunk && text) broadcast(accountId, { type: 'chunk', text })
      if (event.data.usage) lastUsage.set(accountId, event.data.usage)
      state.lastText = text
    } else if (event.type === 'turn/end') {
      turnStreamState.delete(accountId)
      pendingPrompts.delete(accountId)
      const terminal = event.data.reason.kind
      const messages: Record<string, string> = {
        completed: '', aborted: '任务已取消。', error: '任务失败，请在电脑端查看具体错误。',
        blocked: '任务未完成：工具或权限受到限制。', 'max-tokens': '本轮达到输出限制，可继续提问。',
      }
      broadcast(accountId, { type: 'done', turn: event.data.turn, terminal, message: messages[terminal] ?? '本轮已结束。', usage: lastUsage.get(accountId) })
      if (pendingProjectSwitches.has(accountId)) {
        pendingProjectSwitches.delete(accountId)
        closing.add(accountId)
        // session/event is inside append: teardown/cancel may append, so defer it.
        deferHostTask(() => disposeAgent(accountId, { preserveSelection: true }), (err) => {
          closing.delete(accountId)
          debugLog('pending project switch dispose failed', { accountId, error: String(err) })
        })
      }
    }
  })

  ctx.on('agent/error', ({ agent }) => {
    const sid = String(agent.session.id)
    const key = [...sessionIds].find(([, id]) => id === sid)?.[0]
    if (!key || !activeSessionIds.has(sid)) return
    pendingPrompts.delete(key)
    broadcast(key, { type: 'error', message: 'DSH 任务执行失败，请检查电脑端诊断。' })
  })

  // -------------------------------------------------------------------------
  // Internal HTTP server (daemon-facing, token protected)
  // -------------------------------------------------------------------------

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization || ''
    return isLoopbackAddress(req.socket.remoteAddress) && !req.headers.origin && header === `Bearer ${token}`
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const parsedBodies = new WeakMap<IncomingMessage, Record<string, unknown>>()
  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const cached = parsedBodies.get(req)
    if (cached) return cached
    const body = await readJsonBody(req)
    parsedBodies.set(req, body)
    return body
  }

  async function handleInternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        sendJson(res, 200, await statusPayload())
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/projects') {
        sendJson(res, 200, { ok: true, items: await conversations.list(ownerControlKey()) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/projects/select') {
        const body = await readBody(req)
        const sessionId = String(body.sessionId || '')
        const result = await selectProjectSession(sessionId, undefined, false)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/projects/detach') {
        const result = await detachProjectSession(undefined, false)
        sendJson(res, result.ok ? 200 : 400, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        assertOwnerKey(sessionId)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new HttpBoundaryError('text is required', 400)
        if (pendingPrompts.has(sessionId) || conversations.busy(sessionId)) throw new HttpBoundaryError('session is busy', 409)
        pendingPrompts.add(sessionId)
        const replay = streamReplay.get(sessionId) ?? new PromptReplay()
        replay.reset()
        streamReplay.set(sessionId, replay)
        try {
          const handle = await ensureAgent(sessionId, {
            cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            model: typeof body.model === 'string' ? body.model : undefined,
          })
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
          sendJson(res, 200, { accepted: true, sessionId })
        } catch (error) {
          pendingPrompts.delete(sessionId)
          broadcast(sessionId, { type: 'error', message: String(error) })
          throw error
        }
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/stop') {
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        assertOwnerKey(sessionId)
        sendJson(res, 200, await conversations.stop(sessionId))
        return
      }

      // 微信审批裁决：daemon 转发的 /yes /no。仅裁决本账号自己的 pending，
      // 无 pending（超时/被撤销/从未推送）时明确返回 no-pending。
      if (req.method === 'POST' && url.pathname === '/api/approval/decide') {
        const body = await readBody(req)
        const sessionId = String(body.sessionId || '')
        assertOwnerKey(sessionId)
        const approved = body.approved === true
        if (!approvalManager) {
          sendJson(res, 200, { ok: false, reason: 'disabled' })
          return
        }
        // 未知/非法 accountId 在 decide 里自然落到 no-pending，无需额外校验。
        const result = sessionId
          ? approvalManager.decide(sessionId, approved, typeof body.approvalId === 'string' ? body.approvalId : undefined)
          : { ok: false as const, reason: 'no-pending' as const }
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && (url.pathname === '/api/clear' || url.pathname === '/api/sessions/new')) {
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        assertOwnerKey(sessionId)
        const result = url.pathname === '/api/sessions/new'
          ? await conversations.create(sessionId)
          : await conversations.clear(sessionId, body.reset === true)
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/stream') {
        const sessionId = url.searchParams.get('sessionId') || ''
        assertOwnerKey(sessionId)
        if (!agents.has(sessionId)) {
          sendJson(res, 404, { ok: false, error: 'session not active' })
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 3000\n\n')
        let set = streamClients.get(sessionId)
        if (!set) {
          set = new Set()
          streamClients.set(sessionId, set)
        }
        set.add(res)
        const lastId = typeof req.headers['last-event-id'] === 'string' ? Number(req.headers['last-event-id']) : 0
        const replay = streamReplay.get(sessionId)?.snapshot(Number.isSafeInteger(lastId) && lastId >= 0 ? lastId : 0)
        if (replay?.overflowed) {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'Reply exceeded replay buffer; request it again in smaller parts', sessionId })}\n\n`)
          res.end()
          set.delete(res)
          return
        }
        for (const item of replay?.entries ?? []) {
          res.write(`id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`)
          if (item.event.type === 'done' || item.event.type === 'error') {
            res.end(); set.delete(res); return
          }
        }
        req.on('close', () => {
          set?.delete(res)
          if (set?.size === 0) streamClients.delete(sessionId)
        })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, err instanceof HttpBoundaryError ? err.status : 400, { ok: false, error: message })
    }
  }

  // -------------------------------------------------------------------------
  // Daemon process management (cross-platform)
  // -------------------------------------------------------------------------

  function bridgeScript(): string {
    return join(dirname(fileURLToPath(import.meta.url)), 'bridge', 'main.js')
  }

  function readPid(): number | null {
    try {
      const raw = readFileSync(pidPath, 'utf8').trim()
      const pid = Number(raw)
      return Number.isInteger(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function daemonRunning(): boolean {
    if (bridgeChild && bridgeChild.pid !== undefined) {
      try {
        if (bridgeChild.exitCode === null) return true
      } catch {
        // fall through
      }
    }
    return false
  }

  function daemonPid(): number | undefined {
    return bridgeChild && bridgeChild.exitCode === null && bridgeChild.signalCode === null ? bridgeChild.pid : undefined
  }

  function startDaemon(): Promise<{ ok: boolean; message: string }> {
    if (daemonStarting) return daemonStarting
    const task = startDaemonImpl()
    daemonStarting = task
    void task.finally(() => { if (daemonStarting === task) daemonStarting = undefined }).catch(() => {})
    return task
  }

  async function startDaemonImpl(): Promise<{ ok: boolean; message: string }> {
    if (daemonRunning()) {
      return { ok: true, message: `已运行 (PID: ${daemonPid()})` }
    }
    if (hostDisposed || !internalPort || !latestAccountId()) return { ok: false, message: '请等待 Host 就绪并先扫码绑定。' }
    const recorded = readPid()
    if (recorded !== null && isPidAlive(recorded)) {
      return { ok: false, message: '发现无法确认归属的运行进程记录。请先关闭原桥接/原宿主或重启设备；不会根据磁盘 PID 杀进程或启动第二份轮询。' }
    }
    nativeStopRequested = false

    const script = bridgeScript()
    if (!existsSync(script)) {
      return { ok: false, message: `桥接脚本不存在: ${script}（请先 build 插件）` }
    }

    const filesystem = await import('node:fs')
    const logFd = filesystem.openSync(daemonLogPath, 'a', 0o600)
    const child = spawn(process.execPath, [script, 'start'], {
      cwd: dirname(script),
      env: {
        ...process.env,
        // 宿主是 Electron（DSH Desktop）时 process.execPath 是 Electron 二进制：
        // 必须用 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式执行 daemon 脚本，
        // 否则每次拉起都会启动一个 Electron 实例（窗口闪现后秒退，watchdog 无限循环）。
        // 纯 node 宿主（npx dsh web）下该变量无害。
        ELECTRON_RUN_AS_NODE: '1',
        NODE_TLS_REJECT_UNAUTHORIZED: '1',
        DSH_WECHAT_PORTABLE_DATA_DIR: dataDir,
        DSH_BRIDGE_DATA_DIR: dataDir,
        DSH_BRIDGE_API_BASE: `http://127.0.0.1:${internalPort}`,
        DSH_BRIDGE_API_TOKEN: token,
      },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })

    filesystem.closeSync(logFd)
    let spawnFailed = false
    child.once('error', () => { spawnFailed = true; if (bridgeChild === child) bridgeChild = undefined })
    bridgeChild = child
    if (child.pid) atomicJson(pidPath, child.pid)

    child.on('exit', (code) => {
      try {
        if (bridgeChild === child) bridgeChild = undefined
        const pid = readPid()
        if (pid === child.pid) unlinkSync(pidPath)
      } catch {
        // ignore
      }
      ctx.logger?.info?.('[dsh-wechat-bridge] daemon exited', { code })
    })

    // Give the daemon a moment to fail early (missing account etc.).
    await new Promise(r => setTimeout(r, 300))
    if (spawnFailed || !child.pid || child.exitCode !== null || child.signalCode !== null) {
      return { ok: false, message: '守护进程启动失败，请检查本地私密诊断日志。' }
    }

    bridgeStartedAt = Date.now()
    return { ok: true, message: `已启动 (PID: ${child.pid})` }
  }

  async function stopDaemon(): Promise<{ ok: boolean; message: string }> {
    nativeStopRequested = true
    await daemonStarting?.catch(() => undefined)
    for (const controller of creationControllers.values()) controller.abort(new Error('Bridge stopped'))
    for (const handle of agents.values()) handle.agent.cancel({ kind: 'user' })
    const child = bridgeChild
    if (!child) {
      const recorded = readPid()
      if (recorded !== null && isPidAlive(recorded)) return { ok: false, message: '进程归属不明，未发送任何终止信号。请关闭原宿主或重启设备。' }
      return { ok: true, message: '本实例未运行桥接。' }
    }
    // Only signal the child handle this plugin actually spawned, never a disk PID.
    child.kill()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise(r => setTimeout(r, 200))
    }
    if (child.exitCode === null && child.signalCode === null) return { ok: false, message: '桥接进程尚未退出；请稍后再试。' }
    // These are this child's private, fixed metadata paths, not migrated PIDs.
    for (const file of [pidPath, join(dataDir, 'daemon-port.json')]) {
      try { unlinkSync(file) } catch { /* already removed */ }
    }
    if (bridgeChild === child) bridgeChild = undefined
    return { ok: true, message: '已停止' }
  }

  async function restartDaemon(): Promise<{ ok: boolean; message: string }> {
    await stopDaemon()
    await new Promise(r => setTimeout(r, 300))
    return startDaemon()
  }

  function bridgeConfigPath(): string {
    return join(dataDir, 'config.json')
  }

  function readBridgeConfig(): { workingDirectory: string; model?: string; systemPrompt?: string; notifyRejected?: boolean; usageFooter?: boolean; preventSleep?: boolean; calm?: import('./bridge/config.js').CalmConfig } {
    try {
      const raw = JSON.parse(readFileSync(bridgeConfigPath(), 'utf8')) as {
        workingDirectory?: string
        model?: string
        systemPrompt?: string
        notifyRejected?: boolean | string
        usageFooter?: boolean | string
        preventSleep?: boolean | string
        calm?: import('./bridge/config.js').CalmConfig
      }
      return {
        workingDirectory: raw.workingDirectory || defaultWorkingDirectory(),
        model: raw.model,
        systemPrompt: raw.systemPrompt,
        notifyRejected: raw.notifyRejected === true || raw.notifyRejected === 'true',
        usageFooter: raw.usageFooter === undefined ? undefined : (raw.usageFooter === true || raw.usageFooter === 'true'),
        preventSleep: raw.preventSleep === undefined ? undefined : (raw.preventSleep === true || raw.preventSleep === 'true'),
        calm: raw.calm && typeof raw.calm === 'object' ? raw.calm : undefined,
      }
    } catch {
      return {
        workingDirectory: defaultWorkingDirectory(),
      }
    }
  }

  function saveBridgeConfig(config: { workingDirectory: string; model?: string; systemPrompt?: string; notifyRejected?: boolean; usageFooter?: boolean; preventSleep?: boolean; calm?: import('./bridge/config.js').CalmConfig }): void {
    ensurePrivateDir(dataDir)
    // 合并写回：不覆盖 daemon 侧写入的其他字段（如 usageFooter）。
    let existing: Record<string, unknown> = {}
    try {
      const raw = JSON.parse(readFileSync(bridgeConfigPath(), 'utf8'))
      if (raw && typeof raw === 'object') existing = raw as Record<string, unknown>
    } catch {
      // 首次写入
    }
    const data: Record<string, unknown> = {
      ...existing,
      workingDirectory: config.workingDirectory,
    }
    if (config.model) data.model = config.model
    if (config.systemPrompt) data.systemPrompt = config.systemPrompt
    if (config.notifyRejected !== undefined) data.notifyRejected = config.notifyRejected
    if (config.calm !== undefined) data.calm = config.calm
    if (config.preventSleep !== undefined) data.preventSleep = config.preventSleep
    atomicJson(bridgeConfigPath(), data)
    if (process.platform !== 'win32') {
      chmodSync(bridgeConfigPath(), 0o600)
    }
  }

  async function startSetup(workingDirectory?: string): Promise<Record<string, unknown>> {
    const dir = (workingDirectory?.trim() || readBridgeConfig().workingDirectory || defaultWorkingDirectory()).replace(/^~/, homedir())
    const { qrcodeUrl, qrcodeId } = await startQrLogin()
    const QRCode = await import('qrcode')
    const qrcodeDataUrl = await QRCode.toDataURL(qrcodeUrl, {
      width: 320,
      margin: 4,
    })
    pendingSetup = { qrcodeId, workingDirectory: dir }
    return {
      ok: true,
      qrcodeId,
      qrcodeUrl,
      qrcodeDataUrl,
      workingDirectory: dir,
    }
  }

  async function checkSetupStatus(qrcodeId: string, options?: { autoStart?: boolean }): Promise<Record<string, unknown>> {
    if (!pendingSetup || pendingSetup.qrcodeId !== qrcodeId) {
      return { ok: false, status: 'idle', message: '没有进行中的扫码绑定，请先点击“扫码绑定”。' }
    }

    const setup = pendingSetup
    const stillCurrent = () => !hostDisposed && pendingSetup === setup && (options?.autoStart !== false ||
      (nativeSetup?.qrcodeId === qrcodeId && Date.now() < nativeSetup.expiresAt))
    const result = await checkQrStatus(qrcodeId, dataDir, stillCurrent)
    if (!stillCurrent()) return { ok: false, status: 'idle', message: '扫码绑定已结束，未继续保存授权。' }

    if (result.status === 'confirmed') {
      const config = readBridgeConfig()
      config.workingDirectory = setup.workingDirectory
      saveBridgeConfig(config)
      pendingSetup = undefined

      // A newly bound account only takes effect after the daemon reloads the
      // latest account file. Restart when running, otherwise start it so the
      // user does not have to manually restart after every re-scan.
      const daemonResult = options?.autoStart === false
        ? { ok: true, message: '已绑定，请手动启动桥接。' }
        : daemonRunning() ? await restartDaemon() : await startDaemon()
      return {
        ok: true,
        status: 'confirmed',
        accountId: result.account.accountId,
        workingDirectory: config.workingDirectory,
        daemon: daemonResult.message,
      }
    }

    if (result.status === 'expired') {
      pendingSetup = undefined
      return { ok: false, status: 'expired', message: result.message }
    }

    if (result.status === 'error') {
      return { ok: false, status: 'error', message: result.message, retryable: result.retryable }
    }

    return { ok: true, status: result.status }
  }

  function readDaemonLogs(limit = 100): string {
    try {
      if (!existsSync(daemonLogPath)) return '暂无日志'
      const text = readFileSync(daemonLogPath, 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-limit).join('\n')
    } catch {
      return '读取日志失败'
    }
  }

  async function statusPayload(): Promise<Record<string, unknown>> {
    const accountFiles: string[] = []
    try {
      const accountsDir = join(dataDir, 'accounts')
      if (existsSync(accountsDir)) {
        for (const f of readdirSync(accountsDir)) {
          if (f.endsWith('.json')) accountFiles.push(f)
        }
      }
    } catch {
      // ignore
    }
    return {
      ok: true,
      plugin: name,
      running: daemonRunning(),
      pid: daemonPid() ?? null,
      startedAt: bridgeStartedAt ?? null,
      dataDir,
      apiBase: internalPort ? `http://127.0.0.1:${internalPort}` : null,
      workingDirectory: readBridgeConfig().workingDirectory,
      accounts: accountFiles,
      sessions: [...sessionIds.keys()],
      selectedProject: await selectedProjectPayload(),
      trust: trustPayload(),
    }
  }

  // -------------------------------------------------------------------------
  // Native Desktop control: one local operator, one currently paired owner.
  // No HTTP trampoline, account selector, trust editor or permission mutation.
  // -------------------------------------------------------------------------

  function assertNativeReady(): void {
    if (hostDisposed || internalPort === 0) throw new ControlError('桥接 Host 尚未就绪或正在卸载。', 'unavailable')
  }

  function nativeWorkingDirectory(input: string): string {
    const expanded = input.trim().replace(/^~(?=$|[\\/])/, homedir())
    if (!isAbsolute(expanded)) throw new ControlError('工作目录必须是本机已有目录的绝对路径。')
    const directory = resolve(expanded)
    try {
      if (statSync(directory).isDirectory()) return requireWorkspace(directory)
    } catch { /* Do not echo OS errors, configuration contents or request data. */ }
    throw new ControlError('工作目录不存在或不是可访问的目录。')
  }

  async function nativeDaemonAction(action: 'start' | 'stop' | 'restart'): Promise<{ message: string }> {
    assertNativeReady()
    if (nativeSetup && Date.now() >= nativeSetup.expiresAt) forgetNativeSetup(nativeSetup.qrcodeId)
    if (nativeSetup) throw new ControlError('请先结束扫码绑定，再启动或停止桥接。', 'busy')
    if (action !== 'stop') {
      if (!latestAccountId()) throw new ControlError('请先扫码绑定主人账号。')
      ownerControlKey() // Same owner scope as internal control; never accept a payload target.
    }
    if (nativeDaemonChange) throw new ControlError('桥接进程操作正在进行。', 'busy')
    nativeStopRequested = action === 'stop'
    nativeDaemonChange = true
    try {
      const result = action === 'start' ? await startDaemon() : action === 'stop' ? await stopDaemon() : await restartDaemon()
      if (!result.ok) throw new ControlError('桥接进程操作未成功，请检查本地构建及诊断。', 'operation-failed')
      return { message: result.message }
    } finally { nativeDaemonChange = false }
  }

  function forgetNativeSetup(qrcodeId: string): void {
    if (nativeSetup?.qrcodeId !== qrcodeId) return
    nativeSetup = undefined
    if (pendingSetup?.qrcodeId === qrcodeId) pendingSetup = undefined
  }

  registerNativeControl(ctx, {
    available: () => !hostDisposed,
    status: () => ({
      ready: !hostDisposed && internalPort !== 0,
      running: daemonRunning(),
      paired: !!latestAccountId(),
      ownerOnly: true,
      pid: daemonPid() ?? null,
      startedAt: bridgeStartedAt ?? null,
      workingDirectory: readBridgeConfig().workingDirectory,
      activeSessions: activeSessionIds.size + creating.size,
    }),
    start: () => nativeDaemonAction('start'),
    stop: () => nativeDaemonAction('stop'),
    restart: () => nativeDaemonAction('restart'),
    setWorkspace: (input) => {
      assertNativeReady()
      const workingDirectory = nativeWorkingDirectory(input)
      // Only the default changes. Never rebind another session or broaden its policy.
      saveBridgeConfig({ ...readBridgeConfig(), workingDirectory })
      return { workingDirectory, message: '默认工作目录已保存；请重启桥接后新建会话。已有会话和权限设置保持不变。' }
    },
    startSetup: async (input) => {
      assertNativeReady()
      if (daemonRunning() || activeSessionIds.size || creating.size || pendingPrompts.size) {
        throw new ControlError('请先停止桥接并等待主人会话结束，再扫码绑定。', 'busy')
      }
      const directory = nativeWorkingDirectory(input ?? readBridgeConfig().workingDirectory)
      nativeStopRequested = true
      if (nativeSetup) forgetNativeSetup(nativeSetup.qrcodeId)
      const result = await startSetup(directory)
      if (hostDisposed) { pendingSetup = undefined; throw new ControlError('桥接正在卸载。', 'unavailable') }
      const setup = parseControlValue('setup.start', {
        qrcodeId: result.qrcodeId, qrcodeDataUrl: result.qrcodeDataUrl, workingDirectory: result.workingDirectory,
      })
      nativeSetup = { qrcodeId: setup.qrcodeId, expiresAt: Date.now() + 5 * 60_000 }
      return setup
    },
    pollSetup: async (qrcodeId) => {
      assertNativeReady()
      if (!nativeSetup || nativeSetup.qrcodeId !== qrcodeId || pendingSetup?.qrcodeId !== qrcodeId) {
        throw new ControlError('没有匹配的本机扫码绑定请求。')
      }
      if (Date.now() >= nativeSetup.expiresAt) {
        forgetNativeSetup(qrcodeId)
        return { status: 'expired', message: '二维码已超时，请重新获取。', retryable: false }
      }
      if (daemonRunning()) throw new ControlError('扫码绑定期间桥接必须保持停止。', 'busy')
      const result = await checkSetupStatus(qrcodeId, { autoStart: false })
      const status = result.status as ControlSetupStatus['status']
      const messages: Record<ControlSetupStatus['status'], string> = {
        wait: '等待扫码…', scaned: '已扫码，请在微信中确认。', confirmed: '绑定成功，请手动启动桥接。',
        expired: '二维码已失效，请重新获取。', error: '扫码确认暂不可用，请重试。', idle: '扫码绑定已结束。',
      }
      if (!Object.hasOwn(messages, status)) throw new ControlError('微信返回了无法识别的扫码状态。', 'operation-failed')
      if (status === 'confirmed' || status === 'expired' || status === 'idle' || (status === 'error' && result.retryable !== true)) {
        forgetNativeSetup(qrcodeId)
      }
      // Error/expiry messages originate in the fixed login diagnostic vocabulary,
      // never in an arbitrary response body or raw network exception.
      const message = (status === 'error' || status === 'expired') && typeof result.message === 'string'
        ? result.message : messages[status]
      return { status, message, retryable: result.retryable === true }
    },
    cancelSetup: (qrcodeId) => {
      forgetNativeSetup(qrcodeId)
      return { message: '本机扫码绑定已结束。' }
    },
  })

  // -------------------------------------------------------------------------
  // 信任集管理（P1-2 / M4：面板 + 内部 API）
  // -------------------------------------------------------------------------

  function trustPayload(): Record<string, unknown> {
    const file = loadTrustFile()
    const latest = latestAccountId()
    return {
      mode: 'owner-only',
      bootstrapConsumed: file.bootstrapConsumed === true,
      owner: latest ? ownerUserIdOf(latest) : '',
      notifyRejected: readBridgeConfig().notifyRejected === true,
      trusted: [],
    }
  }

  function trustAdd(_userId: string, _note?: string): { ok: boolean; error?: string } {
    return { ok: false, error: 'Single-owner release: additional users are disabled' }
  }

  function trustRemove(userId: string): { ok: boolean; error?: string } {
    const id = String(userId || '').trim()
    const file = loadTrustFile()
    if (!file.trusted[id]) {
      return { ok: false, error: `${id} 不在信任集中` }
    }
    saveTrustFile(removeTrusted(file, id))
    debugLog('trust remove via panel', { userId: id })
    return { ok: true }
  }

  function trustSetMode(mode: string): { ok: boolean; error?: string } {
    if (mode !== 'owner-only') return { ok: false, error: 'Single-owner release only supports owner-only' }
    saveTrustFile(setTrustMode(loadTrustFile(), mode as TrustMode))
    debugLog('trust mode set via panel', { mode })
    return { ok: true }
  }

  function trustSetNotifyRejected(enabled: boolean): { ok: boolean } {
    const config = readBridgeConfig()
    config.notifyRejected = enabled
    saveBridgeConfig(config)
    debugLog('notifyRejected set via panel', { enabled })
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Optional Web panel routes (same origin, no token)
  // -------------------------------------------------------------------------

  function registerWebRoutes(): void {
    // webServer 的 fiber 可能晚于本插件装配：ctx.get 会静默拿不到（面板路由
    // 全部丢失，面板退化为 SPA 空壳）。ctx.inject 等 webServer 激活后再注册；
    // headless profile 没有 webServer 时回调不会执行——面板不可用但不影响核心桥接。
    ctx.inject(['webServer'], (webCtx: Context) => {
      webCtx.effect(() => {
        const webServer = webCtx.get('webServer') as
          | { register(route: WebRouteLike): () => void }
          | undefined
        if (!webServer) return () => {}
        const disposers = registerRoutesInto(webServer)
        debugLog('web panel routes registered', { count: disposers.length })
        return () => {
          for (const dispose of disposers) dispose()
        }
      })
    })
  }

  function registerRoutesInto(rawWebServer: { register(route: WebRouteLike): () => void }): (() => void)[] {
    const disposers: (() => void)[] = []
    const readPaths = new Set(['status', 'notify/status', 'pending/status', 'logs', 'projects', 'setup/status', 'trust'])
    const webServer = { register(route: WebRouteLike): () => void {
      const suffix = route.path.slice('/dsh-wechat-portable/'.length)
      const methods = suffix === 'config' ? ['GET', 'POST'] : readPaths.has(suffix) ? ['GET'] : ['POST']
      return rawWebServer.register({ ...route, handler: async (req, res) => {
        try {
          assertPanelRequest(req, methods)
          if (req.method === 'POST') await readBody(req)
          res.setHeader('Cache-Control', 'no-store')
          await route.handler(req, res)
        } catch (error) {
          if (!res.headersSent) sendJson(res, error instanceof HttpBoundaryError ? error.status : 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          else res.end()
        }
      } })
    } }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/status',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await statusPayload()))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/notify/status',
      handler: async (_req, res) => {
        const result = await queryNotifyStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/pending/status',
      handler: async (_req, res) => {
        const result = await queryPendingStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      },
    }))

    for (const action of ['start', 'stop', 'restart'] as const) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: `/dsh-wechat-portable/${action}`,
        handler: async (_req, res) => {
          const result = action === 'start' ? await startDaemon()
            : action === 'stop' ? await stopDaemon()
            : await restartDaemon()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        },
      }))
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/logs',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(readDaemonLogs(200))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/projects',
      handler: async (_req, res) => {
        const result = await listProjectSessions()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, items: result }))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/projects/select',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const accountId = typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
          const result = await selectProjectSession(sessionId, accountId)
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: message }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/projects/detach',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const accountId = body && typeof body.accountId === 'string' && body.accountId ? body.accountId : undefined
          const result = await detachProjectSession(accountId)
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: message }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/setup/start',
      handler: async (req, res) => {
        try {
          let workingDirectory: string | undefined
          try {
            const body = await readBody(req)
            workingDirectory = typeof body.workingDirectory === 'string' ? body.workingDirectory : undefined
          } catch {
            // body optional
          }
          const result = await startSetup(workingDirectory)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          // 不让异常冒泡到宿主 web server（会变成裸 HTTP 400，面板只能显示状态码）。
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, status: 'error', message: err instanceof Error ? err.message : String(err), retryable: false }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/setup/status',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
          const qrcodeId = url.searchParams.get('qrcodeId') || ''
          const result = await checkSetupStatus(qrcodeId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, status: 'error', message: err instanceof Error ? err.message : String(err), retryable: false }))
        }
      },
    }))

    // ---- 信任集管理（P1-2 / M4）----

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/trust',
      handler: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...trustPayload() }))
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/trust/add',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const result = trustAdd(String(body.userId || ''), typeof body.note === 'string' ? body.note : undefined)
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, ...trustPayload() }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/trust/remove',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const result = trustRemove(String(body.userId || ''))
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, ...trustPayload() }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      },
    }))

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/trust/config',
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          let result: { ok: boolean; error?: string } = { ok: true }
          if (typeof body.mode === 'string') {
            result = trustSetMode(body.mode)
          }
          if (result.ok && typeof body.notifyRejected === 'boolean') {
            result = trustSetNotifyRejected(body.notifyRejected)
          }
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ...result, ...trustPayload() }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      },
    }))

    // 桥接配置读写（面板「超时安抚」等设置）：GET 读全部配置，POST 按字段合并写回。
    // config.json 由 host 与 daemon 共享，写盘后 daemon 侧最多延迟一个轮询周期生效。
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/dsh-wechat-portable/config',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET' || req.method === undefined) {
            const config = readBridgeConfig()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ok: true,
              workingDirectory: config.workingDirectory,
              model: config.model ?? null,
              usageFooter: config.usageFooter ?? undefined,
              notifyRejected: config.notifyRejected ?? false,
              preventSleep: config.preventSleep ?? false,
              calm: config.calm ?? {},
            }))
            return
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const config = readBridgeConfig()
            if (body.calm !== undefined) {
              if (!body.calm || typeof body.calm !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: 'calm 必须是对象' }))
                return
              }
              // 写盘前清洗（非法字段丢弃），daemon 读取时还会再兜底一次。
              const parsed = parseCalmConfig(body.calm)
              config.calm = parsed ?? {}
            }
            if (typeof body.preventSleep === 'boolean') {
              config.preventSleep = body.preventSleep
            }
            saveBridgeConfig(config)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, calm: config.calm ?? {}, preventSleep: config.preventSleep ?? false }))
            return
          }
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        }
      },
    }))

    return disposers
  }

  // -------------------------------------------------------------------------
  // Model-facing tools
  // -------------------------------------------------------------------------

  /**
   * Query the daemon's proactive-notification throttle status (for the panel).
   */
  async function queryNotifyStatus(): Promise<{ ok: boolean; data?: NotifyStatus; error?: string }> {
    const portPath = join(dataDir, 'daemon-port.json')
    let info: { port?: number; token?: string } | null = null
    try {
      info = JSON.parse(readFileSync(portPath, 'utf8')) as { port?: number; token?: string }
    } catch {
      return { ok: false, error: '守护进程未运行（缺少 daemon-port.json）' }
    }
    if (!info?.port || !info?.token) {
      return { ok: false, error: '守护进程信息不完整' }
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const resp = await fetch(`http://127.0.0.1:${info.port}/notify/status`, {
        headers: { 'x-dsh-bridge-token': info.token },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
      const data = (await resp.json()) as NotifyStatus
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Query the daemon's pending (send-failure) queue status for the panel.
   * 发送失败暂存队列（pending-queue）：数量/字数/最早入队时间。
   */
  async function queryPendingStatus(): Promise<{ ok: boolean; data?: { count: number; chars: number; oldestQueuedAt: number | null }; error?: string }> {
    const portPath = join(dataDir, 'daemon-port.json')
    let info: { port?: number; token?: string } | null = null
    try {
      info = JSON.parse(readFileSync(portPath, 'utf8')) as { port?: number; token?: string }
    } catch {
      return { ok: false, error: '守护进程未运行（缺少 daemon-port.json）' }
    }
    if (!info?.port || !info?.token) {
      return { ok: false, error: '守护进程信息不完整' }
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const resp = await fetch(`http://127.0.0.1:${info.port}/pending/status`, {
        headers: { 'x-dsh-bridge-token': info.token },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
      const data = (await resp.json()) as { ok: boolean; count: number; chars: number; oldestQueuedAt: number | null }
      return { ok: true, data: { count: data.count ?? 0, chars: data.chars ?? 0, oldestQueuedAt: data.oldestQueuedAt ?? null } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Deliver a proactive notification to the bound WeChat account via the
   * daemon's throttled notify endpoint (daemon-port.json).
   * 多用户（P1-2 / M3）：可指定目标用户（发起任务的微信用户本人）；
   * 缺省时由 daemon 回退到最近活跃用户。
   */
  async function sendWechatNotify(message: string, userId?: string): Promise<{ ok: boolean; message: string }> {
    const portPath = join(dataDir, 'daemon-port.json')
    let info: { port?: number; token?: string } | null = null
    try {
      info = JSON.parse(readFileSync(portPath, 'utf8')) as { port?: number; token?: string }
    } catch {
      return { ok: false, message: '守护进程未运行或尚未就绪（缺少 daemon-port.json）。请先执行 wechat_bridge_start 启动守护进程。' }
    }
    if (!info?.port || !info?.token) {
      return { ok: false, message: '守护进程信息不完整，请重启守护进程后重试。' }
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const resp = await fetch(`http://127.0.0.1:${info.port}/notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dsh-bridge-token': info.token,
        },
        body: JSON.stringify(userId ? { message, userId } : { message }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      const data = (await resp.json().catch(() => ({}))) as {
        accepted?: boolean
        reason?: string
        delaySec?: number
        queued?: number
        error?: string
      }
      if (resp.ok && data.accepted) {
        const parts = ['已投递到微信通知队列。']
        if (data.delaySec) parts.push(`预计 ${data.delaySec}s 后发送。`)
        if (data.reason === 'queue-full') parts.push('（通知队列已满，丢弃了一条最旧的通知）')
        if (data.queued && data.queued > 1) parts.push(`当前排队 ${data.queued} 条。`)
        return { ok: true, message: parts.join('') }
      }
      return { ok: false, message: `通知被拒绝：${data.error || data.reason || '未知原因'}` }
    } catch (err) {
      return { ok: false, message: `无法连接守护进程：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /**
   * Push an urgent approval question to the bound WeChat account via the
   * daemon's direct (non-throttled) /approval endpoint. Resolves false when
   * the daemon is unreachable so callers can fall back to other answerers.
   * 多用户：`key` 是审批归属的 session key，解出 userId 后把审批推给本人。
   */
  async function pushApprovalMessage(message: string, key: string): Promise<boolean> {
    const portPath = join(dataDir, 'daemon-port.json')
    let info: { port?: number; token?: string } | null = null
    try {
      info = JSON.parse(readFileSync(portPath, 'utf8')) as { port?: number; token?: string }
    } catch {
      return false
    }
    if (!info?.port || !info?.token) return false
    try {
      const userId = userIdOfKey(key)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const resp = await fetch(`http://127.0.0.1:${info.port}/approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dsh-bridge-token': info.token,
        },
        body: JSON.stringify(userId ? { message, userId } : { message }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      return resp.ok
    } catch {
      return false
    }
  }

  // 微信审批应答器：仅当配置启用时创建；daemon 推送失败/超时均 fail-closed。
  const approvalManager = config.approvalViaWechat
    ? createApprovalManager({
        timeoutMs: config.approvalTimeoutSec * 1000,
        push: pushApprovalMessage,
        log: debugLog,
      })
    : undefined
  // 插件卸载时撤销所有悬而未决的审批（收敛为 cancelled，不留孤儿定时器）。
  ctx.effect(() => () => approvalManager?.dispose())

  function registerTools(): void {
    const simpleOutput = {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true as const },
          message: { type: 'string' as const, required: true as const },
        },
      },
      render: (_args: unknown, value: { ok: boolean; message: string }) => [{
        type: 'text' as const,
        text: value.message,
      }],
    }

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_status',
      description: '查看 DSH 微信桥接状态：守护进程是否运行、PID、数据目录、已绑定账号与活跃会话。',
      parameters: {},
      output: simpleOutput,
      execute: async () => {
        const p = await statusPayload()
        return {
          ok: true,
          message: `运行中: ${p.running}\nPID: ${p.pid ?? '无'}\n数据目录: ${p.dataDir}\n账号: ${(p.accounts as string[]).join(', ') || '无'}\n活跃会话: ${(p.sessions as string[]).join(', ') || '无'}`,
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_list_projects',
      description: '列出 DSH 中可进入/可绑定的项目会话（含项目名、路径、会话 ID）。当用户询问“有哪些项目”“看看我有什么项目”“我要看下项目”“我在哪个项目”“想继续某个项目”“有个任务想做”等意图，或用户描述内容可能对应某个项目时，都应调用此工具查看项目，不要要求用户使用固定句式。',
      parameters: {},
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            message: { type: 'string' as const, required: true as const },
            projects: {
              type: 'array' as const,
              required: true as const,
              items: {
                type: 'object' as const,
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string' as const, required: true as const },
                  workspaceTitle: { type: 'string' as const, required: true as const },
                  path: { type: 'string' as const, required: true as const },
                  live: { type: 'boolean' as const, required: true as const },
                },
              },
            },
          },
        },
        render: (_args: unknown, value: { projects: Array<{ sessionId: string; workspaceTitle: string; path: string; live: boolean }> }) => [{
          type: 'text' as const,
          text: value.projects.length === 0
            ? '当前没有可绑定的项目会话。'
            : `📁 可进入的项目会话（${value.projects.length} 个）：\n` + value.projects.map((p, i) => `${i + 1}. ${p.workspaceTitle} · ${p.path} · ${p.sessionId.slice(-8)}`).join('\n'),
        }],
      },
      execute: async () => {
        const items = await listProjectSessions()
        return {
          ok: true,
          message: `共 ${items.length} 个项目会话`,
          projects: items.map((item) => ({
            sessionId: item.sessionId,
            workspaceTitle: item.workspaceTitle,
            path: item.path,
            live: item.live,
          })),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_select_project',
      description: '进入一个 DSH 项目会话。微信桥接会话中，模型应先调用 wechat_bridge_list_projects 获取 sessionId，再调用本工具切换到对应项目；切换后后续微信对话会记录到该项目。支持用户自然语言模糊指代，例如“进入某某项目”“去这个项目”“继续在 XXX 里做”“我现在要做 XXX”等，模型应根据上下文/项目列表选择对应 sessionId。',
      parameters: {
        sessionId: { type: 'string', description: '要进入的项目会话 ID，来自 wechat_bridge_list_projects 返回的 sessionId。' },
      },
      output: simpleOutput,
      execute: async (args: { sessionId: string }, exec: { agent?: { session?: { id?: unknown } } }) => {
        const result = await selectProjectFromAgent(exec?.agent, args.sessionId)
        if (!result.ok) {
          throw new Error(String(result.error || '进入项目失败'))
        }
        return {
          ok: true,
          message: String(result.message || '已进入项目。'),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_start',
      description: '启动 DSH 微信桥接守护进程。需要先完成微信扫码绑定（wechat_bridge_setup 或 node lib/bridge/main.js setup）。',
      parameters: {},
      output: simpleOutput,
      execute: startDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_stop',
      description: '停止 DSH 微信桥接守护进程。',
      parameters: {},
      output: simpleOutput,
      execute: stopDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_restart',
      description: '重启 DSH 微信桥接守护进程（更新配置或卡死后使用）。',
      parameters: {},
      output: simpleOutput,
      execute: restartDaemon,
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_logs',
      description: '读取 DSH 微信桥接守护进程最近日志（默认 100 行，可通过参数调整）。',
      parameters: {
        lines: { type: 'number', description: '读取最近多少行日志，默认 100。' },
      },
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            logs: { type: 'string' as const, required: true as const },
          },
        },
        render: (_args: unknown, value: { ok: boolean; logs: string }) => [{
          type: 'text',
          text: value.logs || '（空日志）',
        }],
      },
      execute: async (args: { lines?: number }) => ({
        ok: true,
        logs: readDaemonLogs(args.lines && args.lines > 0 ? args.lines : 100),
      }),
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_bridge_setup',
      description: '显示 DSH 微信桥接的扫码绑定方式：在终端运行 node <bridgeScript> setup。该命令会生成二维码并用系统默认应用打开。',
      parameters: {},
      output: {
        schema: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' as const, required: true as const },
            command: { type: 'string' as const, required: true as const },
          },
        },
        render: (_args: unknown, value: { ok: boolean; command: string }) => [{
          type: 'text',
          text: `请在 DSH 所在机器终端执行：\n${value.command}`,
        }],
      },
      execute: async () => ({
        ok: true,
        command: `node "${bridgeScript()}" setup`,
      }),
    }))

    ctx.tools.register(defineTool({
      name: 'wechat_notify',
      description: '主动向绑定微信发送一条通知消息。适用于需要主动告知用户的场景：任务完成、任务失败、需要用户确认或决策、长时间任务结束等。注意：为规避微信风控，主动通知有节流限制（每小时 ≤6 条、每日 ≤50 条，超限自动排队延迟发送），请仅在用户真正需要被通知时调用，不要高频调用，措辞避免完全相同的模板化重复。',
      parameters: {
        message: { type: 'string', description: '要发送给微信的通知内容，简洁明确，避免模板化重复措辞。' },
      },
      output: simpleOutput,
      execute: async (args: { message: string }, exec: { agent?: { session?: { id?: unknown } } }) => {
        // 多用户：把通知推给发起当前任务的微信用户本人（解 agent → session key → userId）。
        const key = accountIdForAgent(exec?.agent)
        const userId = key ? userIdOfKey(key) : ''
        const result = await sendWechatNotify(args.message, userId || undefined)
        if (!result.ok) throw new Error(result.message)
        return { ok: true, message: result.message }
      },
    }))
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ctx.effect(() => {
    // 多用户迁移（幂等）：旧单用户 session-ids.json key → per-user key。
    migrateSessionIdMap()

    const server = createServer((req, res) => {
      handleInternal(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(res, 500, { ok: false, error: message })
      })
    })

    server.listen(config.port, config.host, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        internalPort = address.port
      }
      ctx.logger?.info?.('[dsh-wechat-bridge] internal API listening', {
        host: config.host,
        port: internalPort,
      })
      if (config.autoStart && !nativeStopRequested) {
        startDaemon().then(result => {
          ctx.logger?.info?.('[dsh-wechat-bridge] autoStart', result)
        }).catch(err => {
          ctx.logger?.warn?.('[dsh-wechat-bridge] autoStart failed', { error: String(err) })
        })
      }
    })
    internalServer = server

    registerTools()
    registerWebRoutes()

    // Watchdog: after sleep/wake or an unexpected daemon exit, automatically
    // bring the bridge back instead of requiring the user to click Start.
    let healthTimer: ReturnType<typeof setInterval> | undefined
    if (config.autoStart) {
      healthTimer = setInterval(() => {
        if (nativeStopRequested || nativeDaemonChange || daemonRunning()) return
        startDaemon().then(result => {
          ctx.logger?.info?.('[dsh-wechat-bridge] watchdog auto-start', result)
        }).catch(err => {
          ctx.logger?.warn?.('[dsh-wechat-bridge] watchdog auto-start failed', { error: String(err) })
        })
      }, 15_000)
      healthTimer.unref?.()
    }

    return async () => {
      hostDisposed = true
      nativeSetup = undefined
      pendingSetup = undefined
      if (healthTimer) clearInterval(healthTimer)
      for (const controller of creationControllers.values()) controller.abort(new Error('WeChat bridge unloaded'))
      await Promise.allSettled([...creating.values()])
      approvalManager?.dispose()
      for (const handle of agents.values()) {
        await handle.dispose()
      }
      agents.clear()
      activeSessionIds.clear()
      for (const key of streamClients.keys()) closeStreams(key)
      streamClients.clear()
      streamReplay.clear()
      pendingPrompts.clear()
      if (bridgeChild && bridgeChild.exitCode === null) {
        bridgeChild.kill()
      }
      try {
        server.close()
      } catch {
        // ignore
      }
    }
  })
}
