import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicJson, requireWorkspace } from './paths.js'

export const SETTINGS_FORMAT = 'dsh-wechat-portable-settings'
export const SETTINGS_VERSION = 1
export const MAX_SETTINGS_BYTES = 16 * 1024
export interface PortableSettings {
  usageFooter?: boolean
  notifyRejected?: boolean
  calm?: { enabled?: boolean; silenceMs?: number; intervalMs?: number; maxCount?: number }
}
export interface SettingsEnvelope {
  format: typeof SETTINGS_FORMAT
  schemaVersion: 1
  settings: PortableSettings
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an invalid prototype`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported settings key: ${key}`)
}
function settings(value: unknown): PortableSettings {
  const source = record(value, 'settings')
  keys(source, ['usageFooter', 'notifyRejected', 'calm'])
  const result: PortableSettings = {}
  for (const key of ['usageFooter', 'notifyRejected'] as const) {
    if (source[key] === undefined) continue
    if (typeof source[key] !== 'boolean') throw new Error(`${key} must be boolean`)
    result[key] = source[key]
  }
  if (source.calm !== undefined) {
    const calm = record(source.calm, 'calm')
    keys(calm, ['enabled', 'silenceMs', 'intervalMs', 'maxCount'])
    result.calm = {}
    if (calm.enabled !== undefined) {
      if (typeof calm.enabled !== 'boolean') throw new Error('calm.enabled must be boolean')
      result.calm.enabled = calm.enabled
    }
    for (const key of ['silenceMs', 'intervalMs', 'maxCount'] as const) {
      if (calm[key] === undefined) continue
      const value = calm[key]
      const [min, max] = key === 'maxCount' ? [0, 100] : [60_000, 86_400_000]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid calm.${key}`)
      result.calm[key] = value
    }
  }
  return result
}

/** Construct from a positive whitelist. Paths, free text and all identity/state are excluded. */
export function exportSettings(localConfig: unknown): SettingsEnvelope {
  const local = record(localConfig, 'local config')
  const candidate: Record<string, unknown> = {}
  for (const key of ['usageFooter', 'notifyRejected'] as const) {
    if (local[key] !== undefined) candidate[key] = local[key]
  }
  if (local.calm !== undefined) {
    const localCalm = record(local.calm, 'calm')
    candidate.calm = Object.fromEntries(['enabled', 'silenceMs', 'intervalMs', 'maxCount']
      .filter(key => localCalm[key] !== undefined).map(key => [key, localCalm[key]]))
  }
  return { format: SETTINGS_FORMAT, schemaVersion: 1, settings: settings(candidate) }
}

export function parseSettings(text: string): SettingsEnvelope {
  if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large')
  const parsed = record(JSON.parse(text), 'settings envelope')
  keys(parsed, ['format', 'schemaVersion', 'settings'])
  if (parsed.format !== SETTINGS_FORMAT || parsed.schemaVersion !== SETTINGS_VERSION) throw new Error('Unsupported settings format/version')
  return { format: SETTINGS_FORMAT, schemaVersion: 1, settings: settings(parsed.settings) }
}

function readConfig(dataDir: string): Record<string, unknown> {
  const file = join(dataDir, 'config.json')
  if (!existsSync(file)) return {}
  return record(JSON.parse(readFileSync(file, 'utf8')), 'local config')
}

export function writeSettingsExport(dataDir: string, destination: string): SettingsEnvelope {
  const target = resolve(destination)
  const rel = relative(resolve(dataDir), target)
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('Save shareable settings outside the private state directory')
  const envelope = exportSettings(readConfig(dataDir))
  // Never overwrite an arbitrary user file or follow a pre-existing symlink.
  writeFileSync(target, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return envelope
}

/** Import only config, never accounts, trust, sessions, endpoints, permissions or code. */
export function importSettings(dataDir: string, text: string, workspace: string, confirm = false): SettingsEnvelope {
  const envelope = parseSettings(text)
  const selectedWorkspace = requireWorkspace(workspace)
  if (!confirm) return envelope
  if (existsSync(join(dataDir, 'daemon.pid')) || existsSync(join(dataDir, 'daemon-port.json'))) {
    throw new Error('Stop the bridge before importing; do not remove live process files')
  }
  const previous = readConfig(dataDir)
  const next = {
    ...previous,
    ...envelope.settings,
    workingDirectory: selectedWorkspace,
    ...(envelope.settings.calm ? { calm: { ...(typeof previous.calm === 'object' && previous.calm !== null ? previous.calm : {}), ...envelope.settings.calm } } : {}),
  }
  atomicJson(join(dataDir, 'config.json'), next)
  return envelope
}
