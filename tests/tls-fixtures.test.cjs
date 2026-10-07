'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { X509Certificate, createPrivateKey } = require('node:crypto')
const root = join(__dirname, '..')
const certificateFile = 'tests/fixtures/localhost-test-cert.pem'
const privateKeyFile = 'tests/fixtures/localhost-test-key.pem'
const fingerprint = '0D:E7:74:04:95:C3:9F:DF:0A:DF:B4:F0:CC:CA:2B:39:28:EC:AC:38:4C:B1:77:A2:73:55:99:A7:1B:71:85:22'

test('required TLS fixtures are the intentionally public localhost-only pair', () => {
  const cert = new X509Certificate(readFileSync(join(root, certificateFile)))
  const key = createPrivateKey(readFileSync(join(root, privateKeyFile)))
  assert.equal(cert.fingerprint256, fingerprint)
  assert.equal(cert.subject, 'CN=localhost')
  assert.equal(cert.issuer, cert.subject)
  assert.equal(cert.subjectAltName, 'DNS:localhost')
  assert.ok(cert.verify(cert.publicKey))
  assert.ok(cert.checkPrivateKey(key))
  assert.equal(cert.checkHost('localhost'), 'localhost')
  assert.equal(cert.checkHost('example.com'), undefined)
  assert.equal(cert.checkIP('127.0.0.1'), undefined, 'hostname mismatch regressions require a DNS-only SAN')
})

test('only the two exact public fixture paths escape the PEM ignore policy', () => {
  const rules = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map(line => line.trim())
  assert.ok(rules.includes('*.pem'))
  assert.ok(rules.includes('*.key'))
  assert.deepEqual(rules.filter(rule => rule.startsWith('!') && /pem|key|fixtures/.test(rule)).sort(),
    [`!/${certificateFile}`, `!/${privateKeyFile}`].sort())
})

test('fixture documentation identifies the public key pair and deployment prohibition', () => {
  const text = readFileSync(join(__dirname, 'fixtures', 'README.md'), 'utf8')
  assert.ok(text.includes(fingerprint))
  assert.ok(text.includes('intentionally public'))
  assert.ok(text.includes('must never be used in deployment'))
  assert.ok(text.includes('never in the plugin installation tarball'))
})

test('package publication keeps all test fixtures outside the installable tarball', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.files, ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md', 'docs/portable'])
  for (const entry of Object.values(pkg.exports)) {
    assert.ok(!JSON.stringify(entry).includes('fixtures'))
  }
})
