// The words of an event: `feed.kind.<kind>.title` (and `.body`) translated with its params, falling back to the
// server's English `title` / `body` (unknown kind, missing translation, missing param, older server). The kinds of
// an optional feature keep their words in that feature's dictionary group (KIND_KEYS), out of the core dictionary.
import * as React from 'react'
import { loadGroups, useLang, useT, type TFn, type TKey, type TVars } from '@/i18n'
import type { Group } from '@/i18n/groups'
import { categoryOf } from '@/lib/feed'
import { fmtDate, fmtDuration, fmtRelative } from '@/lib/format'
import { useSettings } from '@/lib/queries'
import type { FeedAction, FeedCategory, FeedEvent, FeedLevel, FeedParams } from '@/lib/types'
import { topicLabel } from '@/pages/sessions/util'

const LEFT_OVER = /\{[a-z_][a-z0-9_]*\}/

/** Params as translation variables (null dropped) + a few derived ones (`duration`). */
export function paramVars(p?: FeedParams): TVars {
  const out: TVars = {}
  for (const [k, v] of Object.entries(p || {})) if (v != null) out[k] = typeof v === 'boolean' ? String(v) : v
  if (typeof out.duration_s === 'number') out.duration = fmtDuration(out.duration_s)
  return out
}

/** Kind prefix -> its key prefix and dictionary group: `companion.ready` -> `companions.kind.ready.title`. */
const KIND_KEYS: [prefix: string, key: string, group: Group][] = [['companion.', 'companions.kind.', 'companions'], ['pr_queue.', 'prQueue.kind.', 'settings'], ['mission.', 'resident.kind.', 'settings']]

/** The dictionary key of a kind's `title` / `body` / `bodyLimit`. */
function kindKey(kind: string, suffix: string): string {
  const k = KIND_KEYS.find(([p]) => kind.startsWith(p))
  return k ? `${k[1]}${kind.slice(k[0].length)}.${suffix}` : `feed.kind.${kind}.${suffix}`
}

/** Loads the dictionary groups that hold the words of these events (a notice is worded once, when it shows). */
export function loadEventTexts(events: readonly Pick<FeedEvent, 'kind'>[]): Promise<void> {
  const groups = KIND_KEYS.filter(([p]) => events.some((ev) => ev.kind?.startsWith(p))).map(([, , g]) => g)
  return loadGroups(groups)
}

/** A dynamic key translated, or null when it is missing or a param it names is not there. */
function tKey(t: TFn, key: string, vars: TVars): string | null {
  const s = t(key as TKey, vars)
  return !s || s === key || LEFT_OVER.test(s) ? null : s
}

/** Kinds whose body is content (Claude's last text, an error, a customer e-mail): shown as sent. */
const contentBody = (ev: FeedEvent) => !ev.kind || ev.kind === 'custom' || categoryOf(ev) === 'sessions' || categoryOf(ev) === 'webhooks'

export function eventTitle(t: TFn, ev: Pick<FeedEvent, 'kind' | 'title' | 'params'>): string {
  if (!ev.kind || ev.kind === 'custom') return ev.title
  return tKey(t, kindKey(ev.kind, 'title'), paramVars(ev.params)) ?? ev.title
}

/** One line under the title: the kind's translated body, else the body when it is content (a system event's
 *  English explanation stays for the detail). */
export function eventSummary(t: TFn, ev: FeedEvent): string {
  const vars = paramVars(ev.params)
  if (ev.kind && ev.kind !== 'custom') {
    const key = kindKey(ev.kind, ev.kind === 'discussion.paused' && vars.turn_limit != null ? 'bodyLimit' : 'body')
    const s = tKey(t, key, vars)
    if (s) return s
  }
  return contentBody(ev) ? ev.body.split('\n').find((l) => l.trim()) ?? '' : ''
}

export const categoryLabel = (t: TFn, c: FeedCategory) => t(`feed.cat.${c}` as TKey)
export const levelLabel = (t: TFn, l: FeedLevel) => t(`feed.level.${l}` as TKey)
export function actionLabel(t: TFn, a: FeedAction): string {
  return tKey(t, `feed.action.${a.id}`, {}) ?? a.label
}

/** "Crons", "Sessions · acme / website", "stripe" (a webhook shows its own name). */
export function eventOrigin(t: TFn, ev: FeedEvent): string {
  const c = categoryOf(ev)
  if (c === 'webhooks') return ev.source
  const path = typeof ev.params?.path === 'string' ? ev.params.path : null
  return path != null && c === 'sessions' ? `${categoryLabel(t, c)} · ${topicLabel(path, '~')}` : categoryLabel(t, c)
}

/** Every text of an event, memoised per language and time zone. */
export function useEventText() {
  const t = useT()
  const lang = useLang()
  const tz = useSettings().data?.timezone
  return React.useMemo(
    () => ({
      t,
      lang,
      tz,
      date: (at: number, opts?: Intl.DateTimeFormatOptions) => fmtDate(at, lang, tz, opts),
      title: (ev: FeedEvent) => eventTitle(t, ev),
      summary: (ev: FeedEvent) => eventSummary(t, ev),
      origin: (ev: FeedEvent) => eventOrigin(t, ev),
      when: (at: number) => fmtRelative(at, lang),
      level: (l: FeedLevel) => levelLabel(t, l),
      action: (a: FeedAction) => actionLabel(t, a),
    }),
    [t, lang, tz],
  )
}
