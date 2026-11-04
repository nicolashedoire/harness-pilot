// Runtime errors of extensions, reported to the server (POST /api/extensions/{id}/errors) so the agent that fixes the
// extension can read them (Settings -> Extensions shows them on the extension's row). Called by the HTML widget host
// (errors the frame's bridge forwards) and the page host (errors attributed to /ext/<id>/). Best effort, never throws:
// the same message is sent once per extension and page load, and at most MAX_PER_EXT in all.
import { api, isApiError, seg } from '@/lib/api'

export type ExtErrorWhere = 'widget' | 'page'
const MAX_PER_EXT = 10
const sent = new Map<string, Set<string>>()

export function reportExtensionError(id: string, where: ExtErrorWhere, message: string, stack = '') {
  const msg = String(message || '').trim() || 'Error'
  const seen = sent.get(id) ?? new Set<string>()
  const key = `${where}\n${msg}`
  if (seen.has(key) || seen.size >= MAX_PER_EXT) return
  seen.add(key)
  sent.set(id, seen)
  api.post(`/api/extensions/${seg(id)}/errors`, { where, message: msg.slice(0, 2000), stack: String(stack || '').slice(0, 8000) }).catch(() => {
    /* reporting is best effort */
  })
}

/** An error thrown at the page by its own `ctx.api()`: the server already recorded a failing handle() (500). */
export function serverRecorded(e: unknown) {
  return isApiError(e) && (e.status >= 500 || e.status === 0)
}

/** Message and stack of anything thrown. */
export function describe(e: unknown): { message: string; stack: string } {
  if (e instanceof Error) return { message: `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`, stack: e.stack || '' }
  try {
    return { message: typeof e === 'string' ? e : JSON.stringify(e), stack: '' }
  } catch {
    return { message: String(e), stack: '' }
  }
}

export function __resetReported() {
  sent.clear()
}
