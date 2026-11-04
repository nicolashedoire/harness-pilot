// A Claude Code + Codex conversation that reached its limit (replies or duration): a banner above the thread says
// so, with "Resume" (a new period with the same limits: POST /discussion/resume).
import { Pause, Play } from 'lucide-react'
import { useResumeDiscussion } from '@/lib/queries'
import { fmtDuration } from '@/lib/format'
import type { Session } from '@/lib/types'
import { useT } from '@/i18n'
import { Button } from '@/components/ui'

export const pausedOnLimit = (s: Session | undefined) => !!s?.debate_paused && s.discussion_pause_reason === 'limit'

export function PausedBanner({ session }: { session: Session }) {
  const t = useT()
  const resume = useResumeDiscussion()
  const turns = session.discussion_turns ?? 0
  const limit = session.discussion_turn_limit
  const duration = session.discussion_duration_seconds
  const detail =
    limit && turns >= limit
      ? t('sessions.discussionLimitTurns', { turns, limit })
      : duration
        ? t('sessions.discussionLimitTime', { duration: fmtDuration(duration) })
        : null
  return (
    <div className="mx-auto w-full max-w-(--mx-read,860px) px-3 pt-3">
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3" data-testid="discussion-paused">
        <Pause className="size-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-semibold">{t('sessions.discussionLimitReached')}</p>
          {detail && <p className="mt-0.5 text-[13px] text-muted-foreground">{detail}</p>}
        </div>
        <Button size="sm" onClick={() => resume.mutate(session.id)} loading={resume.isPending}>
          <Play /> {t('notify.resume')}
        </Button>
      </div>
    </div>
  )
}
