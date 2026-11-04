/** A frame may address only its own API; reject browser/server URL normalization ambiguities. */
export function pageApiPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.startsWith('//') || /^[a-z]+:/i.test(raw)) throw new Error('Invalid extension path')
  const path = raw.replace(/^\//, '')
  if (!path) return ''
  return path.split('/').map((part) => {
    let decoded = part
    for (let i = 0; i < 6 && decoded.includes('%'); i++) {
      try { decoded = decodeURIComponent(decoded) } catch { throw new Error('Invalid extension path') }
    }
    if (!decoded || ['.', '..'].includes(decoded.trim()) || /[\\/%?#\x00-\x1f\x7f]/.test(decoded)) throw new Error('Invalid extension path')
    return encodeURIComponent(decoded)
  }).join('/')
}

export function pageAppRoute(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(raw)) throw new Error('Invalid app route')
  const url = new URL(raw, location.origin)
  if (url.origin !== location.origin || /^\/(api|ext)(\/|$)/.test(url.pathname)) throw new Error('Invalid app route')
  return url.pathname + url.search + url.hash
}
