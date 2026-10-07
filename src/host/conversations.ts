import type { DshProjectSession } from '../bridge/dsh-client.js'
import type { Session } from '../bridge/session.js'

export interface ConversationDeps {
  assertOwner(key: string): void
  current(key: string): string | undefined
  list(): Promise<DshProjectSession[]>
  isLive(id: string): boolean
  dispose(key: string): Promise<void>
  stop(key: string): Promise<void>
  bind(key: string, id: string): void
  create(key: string, input: { cwd: string; model?: string }): Promise<string>
  validateNew(input: { cwd: string; model?: string }): void
  readLocal(key: string): Session
  writeLocal(key: string, session: Session): void
  defaultDirectory(): string
}

/** All changes are serialized against other control requests and incoming prompts. */
export function createConversationManager(deps: ConversationDeps) {
  const changing = new Set<string>()
  async function change<T>(key: string, operation: () => Promise<T>): Promise<T> {
    deps.assertOwner(key)
    if (changing.has(key)) throw new Error('会话正在切换，请稍后重试。')
    changing.add(key)
    try { return await operation() }
    finally { changing.delete(key) }
  }
  function empty(previous: Session, cwd = previous.workingDirectory): Session {
    return { ...previous, sdkSessionId: undefined, previousSdkSessionId: undefined,
      workingDirectory: cwd, state: 'idle', chatHistory: [] }
  }
  return {
    busy: (key: string) => changing.has(key),
    async list(key: string): Promise<DshProjectSession[]> {
      deps.assertOwner(key)
      const current = deps.current(key)
      const items = await deps.list()
      return items.map((item) => ({ ...item, current: item.sessionId === current }))
    },
    stop: (key: string) => change(key, async () => {
      await deps.stop(key)
      return { ok: true }
    }),
    create: (key: string) => change(key, async () => {
      const previous = deps.readLocal(key)
      const oldId = deps.current(key)
      const input = { cwd: previous.workingDirectory || deps.defaultDirectory(), model: previous.model }
      deps.validateNew(input) // Refuse bad model/workspace before releasing the old session.
      await deps.dispose(key)
      try {
        const sessionId = await deps.create(key, input)
        deps.writeLocal(key, empty(previous, input.cwd))
        return { ok: true, sessionId }
      } catch (error) {
        // A failed creation must never make the old conversation unreachable.
        await deps.dispose(key)
        if (oldId) deps.bind(key, oldId)
        deps.writeLocal(key, { ...previous, state: 'idle' })
        throw error
      }
    }),
    clear: (key: string, reset = false) => change(key, async () => {
      const previous = deps.readLocal(key)
      await deps.dispose(key)
      const next = empty(previous, reset ? deps.defaultDirectory() : previous.workingDirectory)
      if (reset) { next.model = undefined; next.maxHistoryLength = 100 }
      deps.writeLocal(key, next)
      return { ok: true }
    }),
    select: (key: string, id: string) => change(key, async () => {
      const item = (await deps.list()).find((candidate) => candidate.sessionId === id)
      if (!item) throw new Error('指定会话不存在或不属于任何项目，请刷新 /sessions。')
      if (deps.current(key) === id) return { ok: true, selectedSessionId: id, project: item, daemon: '已经在该会话中。' }
      if (deps.isLive(id)) throw new Error('该会话当前正在 DSH 中打开，请先在电脑端关闭后再切换。')
      const previous = deps.readLocal(key)
      const oldId = deps.current(key)
      await deps.dispose(key)
      try {
        deps.bind(key, id)
        deps.writeLocal(key, empty(previous, item.cwd || item.path))
      } catch (error) {
        await deps.dispose(key)
        if (oldId) deps.bind(key, oldId)
        deps.writeLocal(key, { ...previous, state: 'idle' })
        throw error
      }
      return { ok: true, selectedSessionId: id, project: item, daemon: '后续消息将继续该会话，无需重启桥接。' }
    }),
    detach: (key: string) => change(key, async () => {
      const previous = deps.readLocal(key)
      await deps.dispose(key)
      deps.writeLocal(key, empty(previous, deps.defaultDirectory()))
      return { ok: true, daemon: '后续消息将开始新会话，历史会话未删除。' }
    }),
  }
}
