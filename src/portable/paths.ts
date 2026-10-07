import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export function profileName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DSH_PROFILE || 'default'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Invalid DSH profile name')
  return value
}

export function resolveDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const custom = override?.trim() || env.DSH_WECHAT_PORTABLE_DATA_DIR || env.DSH_BRIDGE_DATA_DIR
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const profileDir = env.DSH_PROFILE_DIR || join(home, 'profiles', profileName(env))
  const target = custom || join(profileDir, 'wechat-portable')
  if (!isAbsolute(target) || /^(?:\\\\|\/\/)/.test(target)) throw new Error('State directory must be an absolute local path, not a network share')
  const absolute = resolve(target)
  if (absolute === parse(absolute).root) throw new Error('The filesystem root cannot be a state directory')
  return absolute
}

export function defaultWorkingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'workspaces', 'wechat-portable', profileName(env))
}

/** Windows uses the current user's inherited ACL; never change machine/user ACLs here. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink() || relative(resolve(path), realpathSync.native(path)) !== '') throw new Error('State directories must not be symbolic links or junctions')
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

/** Atomic same-directory replacement; credentials are private from first creation. */
export function atomicJson(path: string, data: unknown): void {
  ensurePrivateDir(dirname(path))
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing to overwrite a symbolic link')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path)
}

export function requireWorkspace(path: string): string {
  if (!isAbsolute(path) || /^(?:\\\\|\/\/)/.test(path)) throw new Error('Choose an absolute local workspace on this device')
  const canonical = realpathSync.native(path)
  if (canonical === parse(canonical).root) throw new Error('Choose a dedicated workspace, not the filesystem root')
  if (!lstatSync(canonical).isDirectory()) throw new Error('Workspace must be an existing directory')
  return canonical
}
