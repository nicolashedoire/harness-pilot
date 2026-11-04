// The server's VAPID public key (API.md "Web Push": `public_key`, base64url) as the browser needs it, and whether a
// browser subscription was made with it. No imports: the unit tests load this file with plain Node.

/** base64url -> bytes (the `applicationServerKey` of PushManager.subscribe). */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A subscription made with another server key gets every push refused by its push service (403): the server's key
 *  was made again (its key file lost or damaged). A browser that does not say which key it used counts as a match. */
export function sameServerKey(subscriptionKey: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!subscriptionKey) return true
  const a = new Uint8Array(subscriptionKey)
  const b = keyBytes(publicKey)
  return a.length === b.length && a.every((x, i) => x === b[i])
}
