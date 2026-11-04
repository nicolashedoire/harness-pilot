// Unit tests of the push key helpers (src/features/notifications/pushKey). Run: npm test (plain Node, no dependency).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { keyBytes, sameServerKey } from '../src/features/notifications/pushKey'

/** A server key as GET /api/push gives it: base64url (no padding) of an uncompressed P-256 point. */
async function serverKey(): Promise<{ b64: string; raw: ArrayBuffer }> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const raw = await webcrypto.subtle.exportKey('raw', pair.publicKey)
  return { b64: Buffer.from(raw).toString('base64url'), raw }
}

test('keyBytes decodes base64url without padding', async () => {
  const { b64, raw } = await serverKey()
  const bytes = keyBytes(b64)
  assert.equal(bytes.length, 65)
  assert.equal(bytes[0], 4) // uncompressed point
  assert.deepEqual([...bytes], [...new Uint8Array(raw)])
  assert.deepEqual([...keyBytes('-_8')], [0xfb, 0xff])
})

test('a subscription made with the current server key is kept', async () => {
  const { b64, raw } = await serverKey()
  assert.equal(sameServerKey(raw, b64), true)
  assert.equal(sameServerKey(new Uint8Array(raw).slice().buffer, b64), true)
})

test('a subscription made with a key the server no longer has is replaced', async () => {
  const before = await serverKey()
  const now = await serverKey()
  assert.equal(sameServerKey(before.raw, now.b64), false)
  assert.equal(sameServerKey(new Uint8Array(64).buffer, now.b64), false)
})

test('a browser that does not say which key it used counts as a match', async () => {
  const { b64 } = await serverKey()
  assert.equal(sameServerKey(null, b64), true)
  assert.equal(sameServerKey(undefined, b64), true)
})
