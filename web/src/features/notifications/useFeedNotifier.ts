// Notices for the new events of the feed that this browser shows (Settings -> Notifications, "Browser" column):
// a failed cron, a refused webhook, a sale... Session events are left to useDoneNotifier (it watches the sessions
// list, which knows what is on screen). The feed list is the one the centre shows (kept fresh by the bus "feed");
// an event is new when its id is above the highest one seen (a fold grows an old row: no second notice).
import * as React from 'react'
import { useLocation } from 'react-router'
import { useFeed } from '@/lib/queries'
import { categoryOf } from '@/lib/feed'
import type { FeedEvent } from '@/lib/types'
import { useUI } from '@/stores/ui'
import { useT } from '@/i18n'
import { isAway, showSystemNotification } from '@/features/notify/useDoneNotifier'
import { browserOn, soundOn } from './prefs'
import { playNotificationSound } from './sound'
import { notifyToast } from './toast'
import { useNotificationCenter, useOpenNotifications } from './store'
import { eventSummary, eventTitle, actionLabel } from './text'
import { useNotificationActions } from './useNotificationActions'
import { visibleActions } from './NotificationActions'

/** Events posted while the page was away (a reconnect) are not news any more. */
const FRESH_S = 10 * 60
const MAX_NOTICES = 3

export function useFeedNotifier() {
  const t = useT()
  const { data } = useFeed({}, 40)
  const prefs = useUI((s) => s.notifyPrefs)
  const { pathname } = useLocation()
  const actions = useNotificationActions()
  const openCentre = useOpenNotifications()
  const seen = React.useRef<number | null>(null)
  // read at fire time: these change identity on every render
  const live = React.useRef({ prefs, pathname, actions, openCentre, t })
  live.current = { prefs, pathname, actions, openCentre, t }

  React.useEffect(() => {
    if (!data) return
    const top = data.events.reduce((m, e) => Math.max(m, e.id), 0)
    if (seen.current == null) {
      seen.current = top
      return
    }
    const last = seen.current
    seen.current = Math.max(last, top)
    const { prefs, pathname, actions, openCentre, t } = live.current
    const now = Date.now() / 1000
    const fresh = data.events
      .filter((e) => e.id > last && !e.read && now - e.at < FRESH_S && categoryOf(e) !== 'sessions' && browserOn(prefs, e))
      .sort((a, b) => a.id - b.id)
    if (!fresh.length) return
    const { pushOn, soundPrefs } = useUI.getState()
    const away = isAway()
    if (away && pushOn) return // the service worker shows the server's push, with its sound
    // one sound for the burst (the most severe level wins, see sound.ts)
    let rings = false
    for (const ev of fresh) if (soundOn(soundPrefs, ev)) rings = playNotificationSound(ev.level) || rings
    // already looking at the notifications: the list shows them
    if (!away && (useNotificationCenter.getState().open || pathname.startsWith('/notifications'))) return
    const shown = fresh.slice(-MAX_NOTICES)
    for (const ev of shown) {
      const title = eventTitle(t, ev)
      const body = eventSummary(t, ev)
      if (away) {
        if (showSystemNotification(title, body, () => actions.open(ev), `feed-${ev.id}`, rings)) continue
      }
      notifyToast({
        level: ev.level,
        kind: ev.kind,
        title,
        body,
        id: `feed-${ev.id}`,
        actions: noticeActions(ev, actions, t).concat(fresh.length > MAX_NOTICES && ev === shown[0] ? [{ label: t('feed.open'), onClick: () => openCentre() }] : []).slice(0, 2),
      })
    }
  }, [data])
}

/** Up to two buttons: the event's own actions, else "Open" its page. */
function noticeActions(ev: FeedEvent, actions: ReturnType<typeof useNotificationActions>, t: ReturnType<typeof useT>) {
  const list = visibleActions(ev, 'detail').map((a) => ({ label: actionLabel(t, a), onClick: () => actions.act(ev, a) }))
  if (list.length) return list.slice(0, 2)
  return ev.url ? [{ label: t('feed.action.open'), onClick: () => actions.open(ev) }] : []
}
