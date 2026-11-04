// Session notifications of this browser (Settings -> Notifications, "Browser" column of the Sessions rows).
// Watches the live sessions list (kept fresh by the global bus) and fires when a session goes from running to
// idle/error, or when a Claude Code + Codex discussion pauses on its limit:
// - tab hidden or window not focused → a system notification (click = open the session), unless this browser has
//   a push subscription: the service worker shows the server's push then (no double notification);
// - tab visible → an in-app notice with its buttons, unless that session is already open on screen.
// Cron sessions never notify (their reports go to Telegram), nor do the workers of a mixed team on their assignment
// (`team_turn`: the team notifies once, when its coordinator's synthesis ends). The other kinds of events come from
// the feed (features/notifications/useFeedNotifier.ts), which leaves the session ones to this hook.
import * as React from 'react'
import { appIconSrc } from '@/lib/accent'
import { useNavigate } from 'react-router'
import { useResumeDiscussion, useSessions } from '@/lib/queries'
import type { FeedLevel, Session } from '@/lib/types'
import { useUI } from '@/stores/ui'
import { useT } from '@/i18n'
import { useSessionsUI } from '@/pages/sessions/store'
import { browserOn, soundOn } from '@/features/notifications/prefs'
import { notifyToast } from '@/features/notifications/toast'
import { playNotificationSound } from '@/features/notifications/sound'

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** `silent`: the page plays its own sound (features/notifications/sound.ts), the system must not add one. */
export function showSystemNotification(title: string, body: string, onClick?: () => void, tag?: string, silent = false) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false
  try {
    const icon = appIconSrc()
    const n = new Notification(title, { body, tag, icon, badge: icon, silent })
    n.onclick = () => {
      window.focus()
      onClick?.()
      n.close()
    }
    return true
  } catch {
    return false // e.g. Android Chrome requires a service worker notification: the toast covers it
  }
}

/** The user is not looking at this tab. */
export const isAway = () => document.hidden || !document.hasFocus()

type Seen = { state: Session['state']; paused: boolean }
type Change = { s: Session; kind: 'session.done' | 'session.failed' | 'discussion.paused'; level: FeedLevel }

const isConversation = (s: Session) => s.provider === 'discussion' || s.provider === 'debate'
const limitPause = (s: Session) => !!s.debate_paused && s.discussion_pause_reason === 'limit'

/** What changed between two passes: finished / failed turns, discussions paused by their limit. */
function changes(before: Map<string, Seen>, now: Session[]): Change[] {
  const out: Change[] = []
  for (const s of now) {
    const b = before.get(s.id)
    if (!b || s.source === 'cron' || s.team_turn) continue
    if (!b.paused && limitPause(s)) out.push({ s, kind: 'discussion.paused', level: 'warning' })
    else if (b.state === 'running' && s.state !== 'running') {
      if (s.state === 'error') out.push({ s, kind: 'session.failed', level: 'error' })
      // a discussion's agents take turns: only its pause on a limit (above) or an error is worth a notice
      else if (!isConversation(s)) out.push({ s, kind: 'session.done', level: 'success' })
    }
  }
  return out
}

export function useDoneNotifier() {
  const t = useT()
  const navigate = useNavigate()
  const resume = useResumeDiscussion()
  const prefs = useUI((s) => s.notifyPrefs)
  const on = React.useCallback((kind: string, level: FeedLevel) => browserOn(prefs, { kind, level, source: 'sessions' }), [prefs])
  const enabled = on('session.done', 'success') || on('session.failed', 'error') || on('discussion.paused', 'warning')
  const { data } = useSessions(undefined, false, enabled)
  const prev = React.useRef<Map<string, Seen> | null>(null)
  // read at fire time (a new mutation object every render must not re-run the diff)
  const resumeRef = React.useRef(resume.mutate)
  resumeRef.current = resume.mutate

  React.useEffect(() => {
    if (!enabled) {
      prev.current = null // turned back on later: start from the current states, never from stale ones
      return
    }
    if (!data) return
    const before = prev.current
    prev.current = new Map(data.map((s) => [s.id, { state: s.state, paused: limitPause(s) }]))
    if (!before) return
    const list = changes(before, data).filter((c) => on(c.kind, c.level))
    if (!list.length) return
    const { pushOn, soundPrefs } = useUI.getState()
    const away = isAway()
    const onScreen = (id: string) => location.pathname.startsWith('/sessions') && useSessionsUI.getState().cols.some((c) => c.kind === 'session' && c.id === id)
    for (const { s, kind, level } of list) {
      const open = () => navigate(`/sessions?path=${encodeURIComponent(s.path)}&session=${s.id}`)
      const title = kind === 'session.failed' ? t('notify.failedTitle') : kind === 'discussion.paused' ? t('notify.pausedTitle') : t('notify.doneTitle')
      const body = kind === 'discussion.paused' ? t('notify.pausedBody', { title: s.title }) : s.title
      const actions = [
        ...(kind === 'discussion.paused' ? [{ label: t('notify.resume'), onClick: () => resumeRef.current(s.id) }] : []),
        { label: t('notify.open'), onClick: open },
      ]
      const notice = () => notifyToast({ level, kind, title, body, actions, id: `mx-session-${s.id}` })
      if (away && pushOn) continue // the service worker shows the server's push, with its sound
      if (!away && onScreen(s.id)) continue
      // a new event: its sound, whether the tab is in front (notice) or not (system notification, kept silent)
      const rings = soundOn(soundPrefs, { kind, level, source: 'sessions' }) && playNotificationSound(level)
      if (!away || !showSystemNotification(title, kind === 'session.done' && s.last_text ? `${s.title} - ${s.last_text.slice(0, 120)}` : body, open, `mx-session-${s.id}`, rings)) notice()
    }
  }, [data, enabled, navigate, t, on])
}
