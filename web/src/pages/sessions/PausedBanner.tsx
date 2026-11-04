// A Claude Code + Codex conversation that reached its limit (replies or duration): a banner above the thread says
// so and when it paused ("Paused at 03:12 · limit of 20 replies"), with "Change limits" (ChangeLimitsDialog) and
// "Resume" (POST /discussion/resume: a new period while a limit is still reached, else the period goes on - API.md
// "Discussion periods"). The thread ends with the same date as a separator (PauseSeparator), for either pause.
import * as React from 'react'
import { Pause, Play, SlidersHorizontal } from 'lucide-react'
import { useResumeDiscussion, useSettings } from '@/lib/queries'
import { fmtDate, fmtDuration } from '@/lib/format'
import type { Session } from '@/lib/types'
import { useLang, useT } from '@/i18n'
import { Button } from '@/components/ui'
import { ChangeLimitsDialog } from './ChangeLimitsDialog'

export const pausedOnLimit = (s: Session | undefined) => !!s?.debate_paused && s.discussion_pause_reason === 'limit'

/** The limit the current period has reached, if any (the limits may have changed since it paused). */
function reachedLimit(s: Session): 'turns' | 'time' | null {
  const limit = s.discussion_turn_limit
  const duration = s.discussion_duration_seconds
  if (limit && (s.discussion_turns ?? 0) >= limit) return 'turns'
  if (duration && (s.discussion_elapsed ?? 0) >= duration) return 'time'
  return null
}

/** "03:12" today, else with the date. */
function pauseTime(at: number, lang: string, tz?: string) {
  const today = new Date(at * 1000).toDateString() === new Date().toDateString()
  return fmtDate(at, lang, tz, today ? { dateStyle: undefined, timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' })
}

/** When it paused and which limit it reached: ["Paused at 03:12", "limit of 20 replies"]. */
function usePauseDetail(session: Session): string[] {
  const t = useT()
  const lang = useLang()
  const tz = useSettings().data?.timezone
  const onLimit = pausedOnLimit(session)
  const reached = onLimit ? reachedLimit(session) : null
  const at = session.discussion_paused_at
  return [
    at != null && t('notifx.pausedAt', { time: pauseTime(at, lang, tz) }),
    reached === 'turns' && t('notifx.limitTurns', { limit: session.discussion_turn_limit ?? 0 }),
    reached === 'time' && t('notifx.limitTime', { duration: fmtDuration(session.discussion_duration_seconds) }),
    onLimit && !reached && !!session.discussion_turn_limit && t('notifx.progress', { turns: session.discussion_turns ?? 0, limit: session.discussion_turn_limit }),
  ].filter((x): x is string => !!x)
}

/** End of a paused discussion's thread: "Paused at 03:12 · limit of 20 replies" between two hairlines. */
export function PauseSeparator({ session }: { session: Session }) {
  const detail = usePauseDetail(session)
  if (!session.debate_paused || session.discussion_paused_at == null) return null
  return (
    <div role="separator" aria-label={detail.join(' · ')} className="flex w-full items-center gap-3 text-xs text-muted-foreground" data-testid="pause-separator">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="inline-flex items-center gap-1.5 text-center tabular-nums">
        <Pause className="size-3.5 shrink-0" /> {detail.join(' · ')}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

export function PausedBanner({ session }: { session: Session }) {
  const t = useT()
  const resume = useResumeDiscussion()
  const [editing, setEditing] = React.useState(false)
  const onLimit = pausedOnLimit(session)
  const reached = onLimit ? reachedLimit(session) : null
  const detail = usePauseDetail(session)
  return (
    <div className="mx-auto w-full max-w-[calc(var(--mx-read,740px)+3rem)] px-6 pt-3 max-md:px-4">
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3" data-testid="discussion-paused">
        <Pause className="size-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-semibold">{t(onLimit ? 'sessions.discussionLimitReached' : 'sessions.discussionPaused')}</p>
          {detail.length > 0 && <p className="mt-0.5 text-[13px] text-muted-foreground">{detail.join(' · ')}</p>}
          {onLimit && <p className="mt-0.5 text-xs text-muted-foreground">{t(reached ? 'notifx.newPeriod' : 'notifx.continues')}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <SlidersHorizontal /> {t('notifx.change')}
          </Button>
          <Button size="sm" onClick={() => resume.mutate(session.id)} loading={resume.isPending}>
            <Play /> {t('notify.resume')}
          </Button>
        </div>
      </div>
      <ChangeLimitsDialog session={session} open={editing} onOpenChange={setEditing} />
    </div>
  )
}
