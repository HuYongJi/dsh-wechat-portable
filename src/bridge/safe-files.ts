import { lstatSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DATA_DIR } from './constants.js'
import { ensurePrivateDir, requireWorkspace } from '../portable/paths.js'

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const MEDIA_BUDGET = 256 * 1024 * 1024
const SEND_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.mp4'])
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function validateOutboundFile(path: string, workspace: string, stateDir: string = DATA_DIR): string {
  if (/^(?:\\\\|\/\/)/.test(path)) throw new Error('Network paths cannot be sent')
  // Native final-path resolution is essential on Windows: some junctions are
  // not reported by lstat/isSymbolicLink or the JS realpath implementation.
  const root = requireWorkspace(workspace)
  const requested = resolve(root, path)
  const canonical = realpathSync.native(requested)
  if (!inside(root, requested) || !inside(root, canonical)) throw new Error('File is outside the selected workspace')
  if (inside(resolve(stateDir), canonical)) throw new Error('Private bridge state cannot be sent')
  const parts = relative(root, requested).split(sep)
  let current = root
  for (const part of parts) {
    if (part.startsWith('.') || /^(credentials|accounts|secrets)$/i.test(part)) throw new Error('Hidden/private paths cannot be sent')
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink() || relative(current, realpathSync.native(current)) !== '') throw new Error('Symbolic links and junctions cannot be sent')
  }
  const stat = statSync(canonical)
  if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES) throw new Error('Only regular files up to 25 MiB can be sent')
  if (!SEND_EXTENSIONS.has(extname(canonical).toLowerCase())) throw new Error('This file type is not allowed for sending')
  return canonical
}

/** The remote filename only chooses a harmless extension, never a disk path. */
export function saveInboundMedia(data: Buffer, remoteName: string, stateDir: string = DATA_DIR): string {
  if (data.byteLength > MAX_MEDIA_BYTES) throw new Error('Attachment exceeds 25 MiB')
  ensurePrivateDir(stateDir)
  const folder = join(stateDir, 'media')
  ensurePrivateDir(folder)
  let existing = 0
  for (const name of readdirSync(folder)) {
    const stat = lstatSync(join(folder, name))
    if (stat.isFile() && !stat.isSymbolicLink()) existing += stat.size
  }
  if (existing + data.byteLength > MEDIA_BUDGET) throw new Error('Private attachment cache is full; review and clear old media locally')
  const suffix = extname(remoteName.replaceAll('\\', '/')).toLowerCase()
  const extension = /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : '.bin'
  const destination = join(folder, `media-${randomUUID()}${extension}`)
  writeFileSync(destination, data, { flag: 'wx', mode: 0o600 })
  return destination
}
