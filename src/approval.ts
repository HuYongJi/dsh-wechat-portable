/** Owner-scoped, single-use, fail-closed WeChat approval lifecycle. */
import { randomBytes } from 'node:crypto'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface ApprovalRequestLike {
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}
export type ApprovalNext = () => Promise<ApprovalOutcome>
export interface ApprovalManagerDeps {
  timeoutMs: number
  push: (text: string, key: string) => Promise<boolean>
  log?: (message: string, data?: unknown) => void
}
export interface ApprovalDecisionResult {
  ok: boolean
  reason?: 'no-pending' | 'stale-decision'
  toolName?: string
}
interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  toolName: string
  id: string
  signal?: AbortSignal
  onAbort?: () => void
}
export interface ApprovalManager {
  handleRequest(accountId: string, req: ApprovalRequestLike, next: ApprovalNext): Promise<ApprovalOutcome>
  decide(accountId: string, approved: boolean, approvalId?: string): ApprovalDecisionResult
  hasPending(accountId: string): boolean
  dispose(): void
}
export function formatApprovalText(req: ApprovalRequestLike, timeoutMs: number, approvalId: string): string {
  return [
    '⚠️ DSH 任务需要你的批准', '',
    `工具：${req.toolName.slice(0, 200)}`,
    `原因：${req.reason?.trim().slice(0, 6000) || '（未提供说明）'}`, '',
    `回复 /yes ${approvalId} 批准，/no ${approvalId} 拒绝。`,
    `${Math.max(1, Math.ceil(timeoutMs / 60_000))} 分钟内未回复将自动拒绝；此审批码仅可使用一次。`,
  ].join('\n')
}
export function createApprovalManager(deps: ApprovalManagerDeps): ApprovalManager {
  if (!Number.isFinite(deps.timeoutMs) || deps.timeoutMs <= 0) throw new Error('Invalid approval timeout')
  const pending = new Map<string, PendingApproval>()
  const log = deps.log ?? (() => {})
  let disposed = false

  function settle(accountId: string, entry: PendingApproval, outcome: ApprovalOutcome): void {
    if (pending.get(accountId) !== entry) return
    pending.delete(accountId)
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
  }

  async function handleRequest(accountId: string, req: ApprovalRequestLike, _next: ApprovalNext): Promise<ApprovalOutcome> {
    if (disposed || req.signal?.aborted) return 'cancelled'
    // No GUI fallback: a second request cannot steal an outstanding phone decision.
    if (pending.has(accountId)) return 'rejected'
    let entry!: PendingApproval
    const result = new Promise<ApprovalOutcome>((resolve) => {
      entry = {
        resolve, toolName: req.toolName, id: randomBytes(12).toString('hex'), signal: req.signal,
        timer: setTimeout(() => {
          settle(accountId, entry, 'rejected')
          log('approval timed out', { accountId, toolName: req.toolName })
        }, deps.timeoutMs),
      }
    })
    pending.set(accountId, entry)
    if (req.signal) {
      entry.onAbort = () => settle(accountId, entry, 'cancelled')
      req.signal.addEventListener('abort', entry.onAbort, { once: true })
      // Covers an abort between the initial check and listener registration.
      if (req.signal.aborted) entry.onAbort()
    }
    if (pending.get(accountId) === entry) {
      // Delivery is not awaited: a hung network push must not defeat timeout/cancellation.
      void Promise.resolve().then(() => {
        if (pending.get(accountId) !== entry) return false
        return deps.push(formatApprovalText(req, deps.timeoutMs, entry.id), accountId)
      }).then((delivered) => {
        if (!delivered) settle(accountId, entry, 'unavailable')
      }, () => settle(accountId, entry, 'unavailable'))
    }
    return result
  }

  function decide(accountId: string, approved: boolean, approvalId?: string): ApprovalDecisionResult {
    const entry = pending.get(accountId)
    if (!entry) return { ok: false, reason: 'no-pending' }
    if (approvalId !== entry.id) return { ok: false, reason: 'stale-decision' }
    settle(accountId, entry, approved === true ? 'allowed-once' : 'rejected')
    log('approval decided via wechat', { accountId, toolName: entry.toolName, approved })
    return { ok: true, toolName: entry.toolName }
  }
  function dispose(): void {
    disposed = true
    for (const [accountId, entry] of [...pending]) settle(accountId, entry, 'cancelled')
  }
  return { handleRequest, decide, hasPending: (accountId) => pending.has(accountId), dispose }
}
