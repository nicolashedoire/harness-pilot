// "Change limits" of a Claude Code + Codex conversation (PATCH /api/sessions/{id}/discussion, API.md "Discussion
// periods"): maximum replies and duration of the current period, empty = no limit. Opened from the paused banner;
// it can also be opened from anywhere that has the session (e.g. the session menu): <ChangeLimitsDialog session
// open onOpenChange />. While the conversation is paused, "Save and resume" applies them and resumes at once.
import * as React from 'react'
import { api, seg } from '@/lib/api'
import { qk, useMut, useResumeDiscussion, useSetSessionCache } from '@/lib/queries'
import type { Session } from '@/lib/types'
import { useT } from '@/i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from '@/components/ui'

type LimitsBody = { turn_limit?: number | null; duration_minutes?: number | null }

export function useDiscussionLimits() {
  const set = useSetSessionCache()
  return useMut(({ id, ...b }: LimitsBody & { id: string }) => api.patch<Session>(`/api/sessions/${seg(id)}/discussion`, b), {
    onSuccess: set,
    invalidate: [qk.sessions.all],
  })
}

/** '' = no limit; else a whole number in [1, max]. */
const valid = (v: string, max: number) => v.trim() === '' || (Number.isInteger(+v) && +v >= 1 && +v <= max)
const value = (v: string) => (v.trim() === '' ? null : +v)

export function ChangeLimitsDialog({ session, open, onOpenChange }: { session: Session; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const save = useDiscussionLimits()
  const resume = useResumeDiscussion()
  const initial = {
    turns: session.discussion_turn_limit ? String(session.discussion_turn_limit) : '',
    minutes: session.discussion_duration_seconds ? String(Math.round(session.discussion_duration_seconds / 60)) : '',
  }
  const [turns, setTurns] = React.useState('')
  const [minutes, setMinutes] = React.useState('')
  // the session's limits each time it opens
  React.useEffect(() => {
    if (!open) return
    setTurns(initial.turns)
    setMinutes(initial.minutes)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening
  }, [open])
  const ok = valid(turns, 200) && valid(minutes, 1440)
  const busy = save.isPending || resume.isPending
  const apply = async (andResume: boolean) => {
    // only what was changed: a duration that is not a whole number of minutes stays as it is
    const body: LimitsBody = {}
    if (turns.trim() !== initial.turns) body.turn_limit = value(turns)
    if (minutes.trim() !== initial.minutes) body.duration_minutes = value(minutes)
    await save.mutateAsync({ id: session.id, ...body })
    if (andResume) await resume.mutateAsync(session.id)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('convx.limitsTitle')}</DialogTitle>
          <DialogDescription>{t('convx.limitsDesc', { turns: session.discussion_turns ?? 0 })}</DialogDescription>
        </DialogHeader>
        <form
          id="mx-discussion-limits"
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (ok && !busy) void apply(!!session.debate_paused).catch(() => {})
          }}
        >
          <FormField label={t('sessions.discussionTurnLimit')}>
            <Input type="number" inputMode="numeric" min={1} max={200} value={turns} onChange={(e) => setTurns(e.target.value)} placeholder={t('sessions.discussionUnlimited')} autoFocus />
          </FormField>
          <FormField label={t('sessions.discussionDuration')}>
            <Input type="number" inputMode="numeric" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder={t('sessions.discussionUnlimited')} />
          </FormField>
          {!ok && (
            <p className="col-span-2 text-xs text-destructive" role="alert">
              {t('sessions.discussionLimitsInvalid')}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {session.debate_paused ? (
            <>
              <Button variant="outline" disabled={!ok || busy} loading={save.isPending && !resume.isPending} onClick={() => void apply(false).catch(() => {})}>
                {t('common.save')}
              </Button>
              <Button type="submit" form="mx-discussion-limits" disabled={!ok || busy} loading={resume.isPending}>
                {t('convx.saveResume')}
              </Button>
            </>
          ) : (
            <Button type="submit" form="mx-discussion-limits" disabled={!ok} loading={save.isPending}>
              {t('common.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
