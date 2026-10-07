/** Browser-safe, strict wire contract shared by the Host and Client descriptors. */
import type { InvocationDescriptor, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

export const CONTROL_PACKAGE = 'dsh-wechat-portable'
export const CONTROL_NAMESPACE = 'wechatPortableControl'
export const MAX_CONTROL_REQUEST_BYTES = 16 * 1024
export const MAX_CONTROL_RESPONSE_BYTES = 256 * 1024

export const CONTROL_ACTIONS = [
  'status', 'start', 'stop', 'restart', 'workspace.set', 'setup.start', 'setup.status', 'setup.cancel',
] as const
export type ControlAction = typeof CONTROL_ACTIONS[number]
export type ControlRequest =
  | { action: 'status' | 'start' | 'stop' | 'restart' }
  | { action: 'workspace.set'; workingDirectory: string }
  | { action: 'setup.start'; workingDirectory?: string }
  | { action: 'setup.status' | 'setup.cancel'; qrcodeId: string }

export const CONTROL_ERROR_CODES = ['invalid-request', 'forbidden', 'unavailable', 'busy', 'operation-failed'] as const
export type ControlErrorCode = typeof CONTROL_ERROR_CODES[number]
export class ControlError extends Error {
  constructor(message: string, readonly code: ControlErrorCode = 'invalid-request') {
    super(message)
    this.name = 'ControlError'
  }
}

export interface ControlStatus {
  ready: boolean
  running: boolean
  paired: boolean
  ownerOnly: true
  pid: number | null
  startedAt: number | null
  workingDirectory: string
  activeSessions: number
}
export interface ControlMessage { message: string }
export interface ControlWorkspace extends ControlMessage { workingDirectory: string }
export interface ControlSetup {
  qrcodeId: string
  qrcodeDataUrl: string
  workingDirectory: string
}
export interface ControlSetupStatus {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error' | 'idle'
  message: string
  retryable: boolean
}
export interface ControlValues {
  status: ControlStatus
  start: ControlMessage
  stop: ControlMessage
  restart: ControlMessage
  'workspace.set': ControlWorkspace
  'setup.start': ControlSetup
  'setup.status': ControlSetupStatus
  'setup.cancel': ControlMessage
}
export type ControlResponse<Action extends ControlAction = ControlAction> =
  | { ok: true; value: ControlValues[Action] }
  | { ok: false; error: { code: ControlErrorCode; message: string } }

/** Limit both UTF-16 length (before allocation) and actual UTF-8 wire bytes. */
function boundedString(value: unknown, maxBytes: number, message: string): string {
  if (typeof value !== 'string' || value.length > maxBytes || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new ControlError(message)
  }
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ControlError('Expected a JSON object')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ControlError('Unexpected payload field')
  }
}

function workingDirectory(value: unknown): string {
  const text = boundedString(value, 4096, 'Workspace must be a path of at most 4096 bytes').trim()
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new ControlError('Workspace must be a nonempty path without control characters')
  return text
}

function qrcodeId(value: unknown): string {
  const text = boundedString(value, 4096, 'Invalid QR request identifier')
  if (!text || /[\u0000-\u0020\u007f]/.test(text)) throw new ControlError('Invalid QR request identifier')
  return text
}

function controlAction(value: unknown): ControlAction {
  if (typeof value !== 'string' || !(CONTROL_ACTIONS as readonly string[]).includes(value)) {
    throw new ControlError('Unsupported native control action')
  }
  return value as ControlAction
}

export function parseControlRequest(actionValue: unknown, payloadValue: unknown): ControlRequest {
  const action = controlAction(actionValue)
  const text = boundedString(payloadValue, MAX_CONTROL_REQUEST_BYTES, 'Native control payload exceeds 16 KiB or is not a string')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ControlError('Malformed native control JSON') }
  const payload = record(parsed)
  switch (action) {
    case 'status': case 'start': case 'stop': case 'restart':
      exactKeys(payload, [])
      return { action }
    case 'workspace.set':
      exactKeys(payload, ['workingDirectory'])
      return { action, workingDirectory: workingDirectory(payload.workingDirectory) }
    case 'setup.start':
      exactKeys(payload, ['workingDirectory'])
      return Object.hasOwn(payload, 'workingDirectory')
        ? { action, workingDirectory: workingDirectory(payload.workingDirectory) }
        : { action }
    case 'setup.status': case 'setup.cancel':
      exactKeys(payload, ['qrcodeId'])
      return { action, qrcodeId: qrcodeId(payload.qrcodeId) }
  }
}

function textField(value: unknown): string {
  return boundedString(value, 4096, 'Invalid native control response text')
}
function booleanField(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ControlError('Invalid native control response flag')
  return value
}
function nullableNumber(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ControlError('Invalid native control response number')
  return value
}

/** Strict positive output whitelist: never serialize account files, tokens, logs or QR URLs. */
export function parseControlValue<Action extends ControlAction>(action: Action, value: unknown): ControlValues[Action] {
  const data = record(value)
  let result: ControlValues[ControlAction]
  switch (action) {
    case 'status': {
      exactKeys(data, ['ready', 'running', 'paired', 'ownerOnly', 'pid', 'startedAt', 'workingDirectory', 'activeSessions'])
      if (data.ownerOnly !== true || typeof data.activeSessions !== 'number' || !Number.isSafeInteger(data.activeSessions) || data.activeSessions < 0) {
        throw new ControlError('Invalid native control owner status')
      }
      result = { ready: booleanField(data.ready), running: booleanField(data.running), paired: booleanField(data.paired), ownerOnly: true,
        pid: nullableNumber(data.pid), startedAt: nullableNumber(data.startedAt), workingDirectory: textField(data.workingDirectory), activeSessions: data.activeSessions }
      break
    }
    case 'workspace.set':
      exactKeys(data, ['message', 'workingDirectory'])
      result = { message: textField(data.message), workingDirectory: textField(data.workingDirectory) }
      break
    case 'setup.start': {
      exactKeys(data, ['qrcodeId', 'qrcodeDataUrl', 'workingDirectory'])
      const image = boundedString(data.qrcodeDataUrl, 200 * 1024, 'Invalid QR image')
      if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new ControlError('Invalid QR image')
      result = { qrcodeId: qrcodeId(data.qrcodeId), qrcodeDataUrl: image, workingDirectory: textField(data.workingDirectory) }
      break
    }
    case 'setup.status':
      exactKeys(data, ['status', 'message', 'retryable'])
      if (typeof data.status !== 'string' || !['wait', 'scaned', 'confirmed', 'expired', 'error', 'idle'].includes(data.status)) throw new ControlError('Invalid QR status')
      result = { status: data.status as ControlSetupStatus['status'], message: textField(data.message), retryable: booleanField(data.retryable) }
      break
    default:
      exactKeys(data, ['message'])
      result = { message: textField(data.message) }
  }
  return result as ControlValues[Action]
}

export function encodeControlResponse(response: ControlResponse): string {
  return boundedString(JSON.stringify(response), MAX_CONTROL_RESPONSE_BYTES, 'Native control response exceeds 256 KiB')
}

export function decodeControlResponse<Action extends ControlAction>(action: Action, value: unknown): ControlValues[Action] {
  const text = boundedString(value, MAX_CONTROL_RESPONSE_BYTES, 'Invalid native control response size')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ControlError('Malformed native control response') }
  const data = record(parsed)
  if (data.ok === false) {
    exactKeys(data, ['ok', 'error'])
    const error = record(data.error)
    exactKeys(error, ['code', 'message'])
    if (typeof error.code !== 'string' || !(CONTROL_ERROR_CODES as readonly string[]).includes(error.code)) throw new ControlError('Invalid native control error code')
    throw new ControlError(textField(error.message), error.code as ControlErrorCode)
  }
  exactKeys(data, ['ok', 'value'])
  if (data.ok !== true) throw new ControlError('Invalid native control response')
  return parseControlValue(action, data.value)
}

function stringSchema(maxBytes: number): TypertSchema<string> {
  return { parse: (value) => boundedString(value, maxBytes, 'Native control wire value must be a bounded string') }
}

/** Hand-authored strict 0.2 descriptor; no SRC reflection or arbitrary JSON dispatch. */
export const CONTROL_DESCRIPTOR: InvocationDescriptor = {
  id: `${CONTROL_PACKAGE}#${CONTROL_NAMESPACE}/request`,
  service: CONTROL_NAMESPACE,
  namespace: CONTROL_NAMESPACE,
  method: 'request',
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'action', wire: 'action', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${CONTROL_PACKAGE}#${CONTROL_NAMESPACE}/request:action`, create: () => ({ parse: controlAction }),
    } },
    { name: 'payloadJson', wire: 'payloadJson', source: 'json', codec: {
      mode: 'strict', typeSymbol: `${CONTROL_PACKAGE}#${CONTROL_NAMESPACE}/request:payloadJson`, create: () => stringSchema(MAX_CONTROL_REQUEST_BYTES),
    } },
  ],
  result: { mode: 'strict', typeSymbol: `${CONTROL_PACKAGE}#${CONTROL_NAMESPACE}/request:result`, create: () => stringSchema(MAX_CONTROL_RESPONSE_BYTES) },
}
