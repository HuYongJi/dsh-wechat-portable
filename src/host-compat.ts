/** Small, independently testable DSH 0.2 host boundary helpers. */
import type { IncomingMessage } from 'node:http'

export const PANEL_CSRF_HEADER = 'x-dsh-wechat-csrf'
export const MAX_BODY_BYTES = 256 * 1024

export class HttpBoundaryError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export function requireLoopbackHost(host: string): string {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('WeChat bridge must bind to 127.0.0.1 or ::1')
  return host
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function loopbackAuthority(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`)
    return !!authority && url.host === authority && !url.username && !url.password && url.pathname === '/' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch { return false }
}

/** A custom header prevents simple cross-site requests; no wildcard/null/file origins. */
export function assertPanelRequest(req: Pick<IncomingMessage, 'headers' | 'method' | 'socket'>, methods: readonly string[]): void {
  if (!methods.includes(req.method ?? '')) throw new HttpBoundaryError('method not allowed', 405)
  if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpBoundaryError('loopback clients only', 403)
  const host = req.headers.host
  if (typeof host !== 'string' || !loopbackAuthority(host)) throw new HttpBoundaryError('invalid Host', 403)
  if (req.headers[PANEL_CSRF_HEADER] !== '1') throw new HttpBoundaryError('missing CSRF header', 403)
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpBoundaryError('cross-site request refused', 403)
  const origin = req.headers.origin
  if (origin !== undefined) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new HttpBoundaryError('invalid Origin', 403) }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host || parsed.origin !== origin) {
      throw new HttpBoundaryError('cross-origin request refused', 403)
    }
  }
  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpBoundaryError('application/json required', 415)
  }
}

export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpBoundaryError('request body too large', 413)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > limit) throw new HttpBoundaryError('request body too large', 413)
    chunks.push(chunk)
  }
  const parsed: unknown = size === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpBoundaryError('JSON object required', 400)
  return parsed as Record<string, unknown>
}

export function ownerSessionKey(accountId: string, owner: string): string {
  if (!/^[A-Za-z0-9_.@=-]+$/.test(accountId) || !/^[A-Za-z0-9_.@=-]+$/.test(owner)) throw new Error('Invalid owner identity')
  return `${accountId}::${owner}`
}

export function isOwnerSessionKey(key: string, accountId: string, owner: string): boolean {
  try { return key === ownerSessionKey(accountId, owner) } catch { return false }
}

export function safeInitialPermissions(defaults: { sandbox?: unknown; approval?: unknown }): {
  sandbox: 'read-only' | 'workspace-write'; approval: 'ask' | 'never'
} {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(defaults.sandbox))) {
    throw new Error('Cannot resolve default sandbox policy')
  }
  if (defaults.approval !== 'ask' && defaults.approval !== 'never') throw new Error('Cannot resolve default approval policy')
  return { sandbox: defaults.sandbox === 'read-only' ? 'read-only' : 'workspace-write', approval: defaults.approval }
}

/** Never replace a missing/deleted stored preset by the deployment's current default. */
export function persistedPreset(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Stored session has no recoverable agent preset; create a new bridge session explicitly')
  return value
}

export interface AssistantFrameLike {
  type?: string
  attemptId?: string
  chunk?: { type?: string; text?: string }
}
export function assistantTextDelta(frame: AssistantFrameLike): string | undefined {
  return frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string' ? frame.chunk.text : undefined
}

/** Deferred teardown must never run synchronously inside session.append observers. */
export function deferHostTask(task: () => void | Promise<void>, onError: (error: unknown) => void): void {
  setImmediate(() => { void Promise.resolve().then(task).catch(onError) })
}

export interface ReplayEvent { type: string; text?: string; [key: string]: unknown }
export interface ReplayEntry<T> { id: number; event: T }
/** One bounded prompt transcript. Replays cover the prompt-before-SSE-subscribe race. */
export class PromptReplay<T extends ReplayEvent> {
  private entries: ReplayEntry<T>[] = []
  private bytes = 0
  private sequence = 0
  private overflowed = false
  constructor(readonly limit = 1024 * 1024) {}
  reset(): void { this.entries = []; this.bytes = 0; this.overflowed = false }
  push(event: T): ReplayEntry<T> {
    const item = { id: ++this.sequence, event }
    if (this.overflowed) return item
    const size = Buffer.byteLength(JSON.stringify(event))
    if (this.bytes + size > this.limit) {
      this.overflowed = true
      this.entries = []
      this.bytes = 0
      return item
    }
    this.bytes += size
    this.entries.push(item)
    return item
  }
  snapshot(afterId = 0): { overflowed: boolean; entries: ReplayEntry<T>[] } {
    return { overflowed: this.overflowed, entries: this.entries.filter((entry) => entry.id > afterId) }
  }
}
