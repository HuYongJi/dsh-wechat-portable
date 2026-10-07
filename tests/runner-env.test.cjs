'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { testEnvironment } = require('../scripts/test-env.mjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-env-'))
after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('dsh-test-env-'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('test child temp roots are canonical without mutating the supplied environment', () => {
  const target = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(target)
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const input = Object.freeze({ TEMP: alias, TMP: alias, TMPDIR: alias, SYNTHETIC_VALUE: 'keep' })
  const result = testEnvironment(input, alias)
  const canonical = fs.realpathSync.native(target)
  assert.deepEqual(result, { TEMP: canonical, TMP: canonical, TMPDIR: canonical, SYNTHETIC_VALUE: 'keep' })
  assert.equal(input.TEMP, alias)
  assert.notEqual(result, input)
  assert.equal(fs.realpathSync.native(alias), canonical, 'normalization must not remove the link fixture')
  assert.notEqual(path.resolve(alias), canonical)
})

test('isolated Node processes see canonical temp paths while retaining ordinary environment', () => {
  const env = testEnvironment({ ...process.env, SYNTHETIC_VALUE: 'keep' }, root)
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    assert.equal(os.tmpdir(), fs.realpathSync.native(os.tmpdir()));
    assert.equal(process.env.SYNTHETIC_VALUE, 'keep');
  `], { stdio: 'inherit', env, shell: false })
  assert.ifError(child.error)
  assert.equal(child.status, 0)
})
