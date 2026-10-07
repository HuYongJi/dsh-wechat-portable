#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './paths.js'
import { importSettings, MAX_SETTINGS_BYTES, writeSettingsExport } from './settings.js'

const HELP = `dsh-wechat-portable (configuration utility; never installs or starts DSH)
  doctor [--profile desktop] [--data-dir ABSOLUTE_PATH]
  export FILE [--profile desktop] [--data-dir ABSOLUTE_PATH]
  import FILE --workspace ABSOLUTE_PATH [--confirm] [--profile desktop] [--data-dir ABSOLUTE_PATH]

Export shares only display/notification preferences. Tokens, account IDs, sessions,
logs, file paths, model credentials and free-text prompts are never exported.
Import previews by default. --confirm writes only the stopped bridge's config;
choose a workspace on this device and scan WeChat again when setting up a new device.
`

function main(): void {
  const args = process.argv.slice(2)
  function option(name: string): string | undefined {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
    args.splice(index, 2)
    return value
  }
  const dataOverride = option('--data-dir')
  const profile = option('--profile')
  const workspace = option('--workspace')
  const confirmAt = args.indexOf('--confirm')
  const confirm = confirmAt >= 0
  if (confirm) args.splice(confirmAt, 1)
  const [command, file, ...rest] = args
  if (!command || command === '--help' || command === 'help') { console.log(HELP); return }
  if (rest.length || args.some(arg => arg.startsWith('--'))) throw new Error('Unknown or duplicate argument')
  const env = profile ? { ...process.env, DSH_PROFILE: profile, DSH_PROFILE_DIR: undefined } : process.env
  const dataDir = resolveDataDir(dataOverride, env)
  if (command === 'doctor' && !file && !workspace && !confirm) {
    const accounts = join(dataDir, 'accounts')
    console.log(JSON.stringify({
      package: 'dsh-wechat-portable', expectedDsh: '0.2.0-rc.2', node: process.versions.node,
      dataDir, configured: existsSync(join(dataDir, 'config.json')),
      pairedLocally: existsSync(accounts) && readdirSync(accounts).some(name => name.endsWith('.json')),
      runningMarkerPresent: existsSync(join(dataDir, 'daemon.pid')),
      note: 'File checks only; this does not prove a live WeChat connection or running DSH version.',
    }, null, 2))
    return
  }
  if (command === 'export' && file && !workspace && !confirm) {
    writeSettingsExport(dataDir, file)
    console.log('Settings exported. No credentials, account identity, paths or conversation state included.')
    return
  }
  if (command === 'import' && file && workspace) {
    if (statSync(file).size > MAX_SETTINGS_BYTES) throw new Error('Settings file is too large')
    const result = importSettings(dataDir, readFileSync(file, 'utf8'), workspace, confirm)
    console.log(JSON.stringify({ operation: confirm ? 'imported' : 'preview-only', settings: result.settings,
      next: confirm ? 'Review local workspace/model, then pair WeChat locally. No process was started.' : 'Repeat with --confirm to write these preferences after stopping the bridge.' }, null, 2))
    return
  }
  throw new Error('Invalid command. Run dsh-wechat-portable --help')
}
try { main() } catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
