import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

// CI may expose TEMP through a Windows 8.3 alias or a linked ancestor. Tests that
// exercise strict state-directory boundaries must start from the canonical root;
// intentional symlinks/junctions created by the tests remain subject to rejection.
export function testEnvironment(env = process.env, temporaryDirectory = tmpdir()) {
  const canonical = realpathSync.native(temporaryDirectory)
  return { ...env, TEMP: canonical, TMP: canonical, TMPDIR: canonical }
}
