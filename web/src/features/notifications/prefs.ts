// What this browser shows (Settings -> Notifications -> "What and where", column "Browser"): an in-app notice when
// the tab is in front, a system notification when it is not, a push notification when no tab is open; and which of
// those ring (column "Sound"). Stored per browser in the UI store (`notifyPrefs`, `soundPrefs`, keys `<kind>` or
// `source:<name>`); a missing entry is the default below.
import { categoryOf, needsAttention } from '@/lib/feed'
import type { FeedCategory, FeedHookKind, FeedLevel, FeedSettings, PushPrefs } from '@/lib/types'

export type PrefSubject = { kind?: string; level: FeedLevel; source: string; category?: FeedCategory }

/** Default: what needs attention (warning, error) and the end of a session; every event of a webhook / script. */
export function browserDefault(kind: string | undefined, level: FeedLevel): boolean {
  return kind === 'session.done' || needsAttention(level)
}

export const sourceKey = (source: string) => `source:${source}`

export function browserOn(prefs: Record<string, boolean>, ev: PrefSubject): boolean {
  if (categoryOf(ev) === 'webhooks') return prefs[sourceKey(ev.source)] ?? true
  if (ev.kind && prefs[ev.kind] !== undefined) return prefs[ev.kind]
  return browserDefault(ev.kind, ev.level)
}

/** One row of the "What and where" matrix: several kinds set together (all built-in, one category). `sound`: rings
 *  by default. */
export type PrefRow = { id: string; category: Exclude<FeedCategory, 'webhooks'>; kinds: string[]; level: FeedLevel; sound: boolean; hint?: boolean }

/** The built-in kinds grouped as the user thinks of them (API.md "Kinds"). Kinds not listed here (a newer server)
 *  keep their default. */
export const PREF_ROWS: PrefRow[] = [
  { id: 'session.done', category: 'sessions', kinds: ['session.done'], level: 'success', sound: true },
  { id: 'session.failed', category: 'sessions', kinds: ['session.failed'], level: 'error', sound: true },
  { id: 'discussion.paused', category: 'sessions', kinds: ['discussion.paused'], level: 'warning', sound: true, hint: true },
  { id: 'cron.failed', category: 'crons', kinds: ['cron.failed'], level: 'error', sound: true },
  { id: 'cron.succeeded', category: 'crons', kinds: ['cron.succeeded'], level: 'success', sound: false, hint: true },
  {
    id: 'updates',
    category: 'system',
    kinds: ['update.available', 'update.review', 'update.started', 'update.attention', 'update.broken', 'claude.updated', 'claude.update_failed'],
    level: 'info',
    sound: false,
  },
  { id: 'health', category: 'system', kinds: ['health.issue', 'deps.vulnerable', 'deps.update_failed', 'instance_backup.failed', 'instance_backup.copy_failed'], level: 'warning', sound: true },
  { id: 'security', category: 'system', kinds: ['signin.failed', 'signin.denied', 'webhook.refused', 'backup.restore_held'], level: 'warning', sound: true },
  { id: 'signins', category: 'system', kinds: ['signin.ok'], level: 'info', sound: false },
  { id: 'infra', category: 'system', kinds: ['infra.down', 'infra.up', 'infra.cert_expiring', 'infra.domain_expiring'], level: 'error', sound: true },
]
const ROW_OF_KIND = new Map(PREF_ROWS.flatMap((r) => r.kinds.map((k) => [k, r] as const)))

/** Sales ring by default; the other webhooks and the scripts do not. */
const SALES = /^(stripe|shopify)\./
export const sourceSoundDefault = (hookKind?: FeedHookKind) => hookKind === 'stripe' || hookKind === 'shopify'

/** Rings by default: its row's choice, a sale, or (an older server without kinds) what needs attention. */
export function soundDefault(kind: string | undefined, level: FeedLevel): boolean {
  if (!kind) return needsAttention(level)
  return ROW_OF_KIND.get(kind)?.sound ?? SALES.test(kind)
}

export function soundOn(prefs: Record<string, boolean>, ev: PrefSubject): boolean {
  if (categoryOf(ev) === 'webhooks') return prefs[sourceKey(ev.source)] ?? (ev.kind ? SALES.test(ev.kind) : false)
  if (ev.kind && prefs[ev.kind] !== undefined) return prefs[ev.kind]
  return soundDefault(ev.kind, ev.level)
}

/** Shown state of a row's sound. */
export function rowSound(prefs: Record<string, boolean>, r: PrefRow): boolean {
  return prefs[r.kinds[0]] ?? r.sound
}

/** The source of a row's kinds (for a server that only has per-source Telegram rules). */
export const ROW_SOURCE: Record<string, string> = { sessions: 'sessions', crons: 'crons', updates: 'system', health: 'system', security: 'security', signins: 'security', infra: 'infra' }
export const rowSource = (r: PrefRow) => ROW_SOURCE[r.id] ?? ROW_SOURCE[r.category]

/** Shown state of a row: on when its first kind is (rows are always set as a whole). */
export function rowOn(prefs: Record<string, boolean>, r: PrefRow): boolean {
  const k = r.kinds[0]
  return prefs[k] ?? browserDefault(k, r.level)
}

/** A webhook or script row of the matrix (Settings -> Notifications): its source and, for a webhook, its service. */
export type PushSource = { source: string; hookKind?: FeedHookKind }

/** The webhooks and scripts the matrix lists (a built-in source of the server, e.g. infra, belongs to the System
 *  rows). */
export function pushSources(settings: FeedSettings | undefined): PushSource[] {
  return (settings?.sources ?? [])
    .filter((s) => !s.builtin && categoryOf({ source: s.source }) === 'webhooks')
    .map((s) => ({ source: s.source, hookKind: settings?.hooks.find((h) => h.name === s.source)?.kind }))
}

/** Push preferences of this browser's subscription, as the matrix shows them: the built-in kinds per row, each
 *  webhook / script per source (Browser and Sound columns); the rest (a source that appears later) by level. */
export function pushPrefs(prefs: Record<string, boolean>, sounds: Record<string, boolean>, soundSet: string, external: PushSource[] = []): PushPrefs {
  const kinds: PushPrefs['kinds'] = {}
  const sources: NonNullable<PushPrefs['sources']> = {}
  const audible = soundSet !== 'none'
  for (const r of PREF_ROWS) {
    const enabled = rowOn(prefs, r)
    for (const k of r.kinds) kinds[k] = { enabled, sound: audible && enabled && rowSound(sounds, r) }
  }
  for (const { source, hookKind } of external) {
    const key = sourceKey(source)
    const enabled = prefs[key] ?? true
    sources[source] = { enabled, sound: audible && enabled && (sounds[key] ?? sourceSoundDefault(hookKind)) }
  }
  return { levels: ['warning', 'error'], sound: audible, kinds, sources }
}
