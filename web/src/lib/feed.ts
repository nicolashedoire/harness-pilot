// Pure helpers for the notifications feed (API.md "Feed"). Every field that came with kinds is optional: these
// functions give the same answers from the fields an older server sends (level, read, source, url).
import type { FeedAction, FeedCategory, FeedEvent, FeedLevel } from './types'

export const FEED_CATEGORIES: FeedCategory[] = ['sessions', 'crons', 'system', 'webhooks']

/** Same mapping as the server: sessions, crons, system / security / infra, anything else (webhooks, scripts). */
export function categoryOf(ev: Pick<FeedEvent, 'source' | 'category'>): FeedCategory {
  if (ev.category) return ev.category
  if (ev.source === 'sessions') return 'sessions'
  if (ev.source === 'crons') return 'crons'
  if (ev.source === 'system' || ev.source === 'security' || ev.source === 'infra') return 'system'
  return 'webhooks'
}

export const needsAttention = (level: FeedLevel) => level === 'warning' || level === 'error'

/** "To handle": warning / error, unread, not resolved. */
export function isPending(ev: FeedEvent): boolean {
  if (typeof ev.pending === 'boolean') return ev.pending
  return needsAttention(ev.level) && !ev.read && !ev.resolved_at
}

/** The only `post` actions the web runs (API.md: built-in producers only, these paths only). */
const POST_ALLOWED = [/^\/api\/crons\/[A-Za-z0-9_-]{1,64}\/run$/, /^\/api\/sessions\/[A-Za-z0-9_-]{1,64}\/discussion\/resume$/]
const safeLink = (url: string) => /^\/(?![/\\])/.test(url) || /^https:\/\//.test(url)

/** The event's buttons: its own actions (unsafe ones dropped), or "Open" its url on a server without actions. */
export function eventActions(ev: FeedEvent): FeedAction[] {
  if (Array.isArray(ev.actions))
    return ev.actions.filter((a) => (a.type === 'post' ? POST_ALLOWED.some((r) => r.test(a.url)) : safeLink(a.url))).slice(0, 4)
  return ev.url && (safeLink(ev.url) || /^http:\/\//.test(ev.url)) ? [{ id: 'open', label: 'Open', type: 'link', url: ev.url }] : []
}

/** Latest first; ties (same second) by id. */
export const byNewest = (a: FeedEvent, b: FeedEvent) => b.at - a.at || b.id - a.id

/** Local calendar day of a Unix time in a time zone (YYYY-MM-DD), to group a list by day. */
export function dayKey(at: number, tz?: string): string {
  const d = new Date(at * 1000)
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return d.toISOString().slice(0, 10)
  }
}

export type DayGroup<T> = { key: string; items: T[] }
/** Consecutive items of the same day (the list is newest first). */
export function groupByDay<T extends { at: number }>(items: T[], tz?: string): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  for (const it of items) {
    const key = dayKey(it.at, tz)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(it)
    else out.push({ key, items: [it] })
  }
  return out
}
