// Plan mode UI: the one-line notice on top of the composer when Claude's plan waits for the user's validation, and the
// small "plan mode" chip of the composer toolbar. The server side is `plan_mode` / `plan_ready` on the
// session (read-only turns, then POST /plan/approve).
import * as React from 'react'
import { Check, ListChecks, X } from 'lucide-react'
import { useApprovePlan, usePatchSession } from '@/lib/queries'
import type { Session } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Button, Checkbox, Tooltip } from '@/components/ui'
import { usePending } from './store'

/** Validates the plan: plan mode goes off and Claude implements it (the message shows in the thread at once). */
export function useApprove(sid: string) {
  const t = useT()
  const approve = useApprovePlan()
  const run = React.useCallback(() => {
    const text = t('plan.approvedMessage')
    const { add, remove } = usePending.getState()
    const lid = add(sid, { text, attachments: [], queued: false })
    approve.mutate({ id: sid, text }, { onError: () => remove(sid, lid) })
  }, [sid, t, approve])
  return [run, approve.isPending] as const
}

/** Tucked on top of the composer: Claude's plan is ready - validate it, or adjust it (as many times as needed). */
export function PlanNotice({ session, onAdjust }: { session: Session; onAdjust: () => void }) {
  const t = useT()
  const [approve, approving] = useApprove(session.id)
  const patch = usePatchSession()
  return (
    <>
      <ListChecks className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{t('plan.readyTitle')}</span> · {t('plan.readyHint')}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Tooltip content={t('plan.leaveTip')}>
          <button
            type="button"
            onClick={() => patch.mutate({ id: session.id, plan_mode: false })}
            disabled={patch.isPending}
            aria-label={t('plan.leave')}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3.5" />
          </button>
        </Tooltip>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onAdjust}>
          {t('plan.adjust')}
        </Button>
        <Button size="sm" className="h-6 px-2.5 text-xs" onClick={approve} loading={approving}>
          <Check className="size-3.5" /> {t('plan.approve')}
        </Button>
      </span>
    </>
  )
}

/** Composer toolbar: plan mode is on (click: off). */
export function PlanChip({ session }: { session: Session }) {
  const t = useT()
  const patch = usePatchSession()
  return (
    <Tooltip content={t('plan.chipTip')}>
      <button
        type="button"
        aria-label={t('plan.chip')}
        onClick={() => patch.mutate({ id: session.id, plan_mode: false })}
        className={cn(
          'inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-primary/12 px-2 text-xs font-medium whitespace-nowrap text-primary transition-colors hover:bg-primary/20',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
      >
        <ListChecks className="size-3.5" /> <span className="@max-sm:hidden">{t('plan.chip')}</span>
      </button>
    </Tooltip>
  )
}

/** Composer toolbar: plan mode on / off for the next turns (a checkbox chip, like the mock-ups). */
export function PlanToggle({ session }: { session: Session }) {
  const t = useT()
  const patch = usePatchSession()
  const id = `plan-${session.id}`
  return (
    <Tooltip content={session.plan_mode ? t('plan.toggleOff') : t('plan.toggleOn')}>
      <label
        htmlFor={id}
        className={cn(
          'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:h-9',
          session.plan_mode && 'text-foreground',
        )}
        data-testid="plan-toggle"
      >
        <Checkbox id={id} checked={session.plan_mode} onCheckedChange={(v) => patch.mutate({ id: session.id, plan_mode: v === true })} className="size-3.5 [&_svg]:size-3" />
        <span className="@max-[22rem]:sr-only">{t('plan.toggle')}</span>
      </label>
    </Tooltip>
  )
}

/** End of the thread when the plan of a plan-mode turn waits: approve it (Claude implements it), adjust it in the
 *  composer, or reject it (plan mode goes off, nothing is changed). */
export function PlanCard({ session, onEdit }: { session: Session; onEdit: () => void }) {
  const t = useT()
  const [approve, approving] = useApprove(session.id)
  const patch = usePatchSession()
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" aria-label={t('conv.plan.title')} data-testid="plan-card">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-primary" />
        <span className="font-semibold">{t('conv.plan.title')}</span>
        <span className="text-xs text-muted-foreground">{t('conv.plan.mode')}</span>
      </div>
      <p className="text-[13px] text-muted-foreground">{t('conv.plan.hint')}</p>
      {(session.provider === 'discussion' || session.provider === 'debate') && <p className="text-[13px] text-muted-foreground">{t('convx.planDuo')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={approve} loading={approving}>
          <Check /> {t('conv.plan.approve')}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          {t('conv.plan.edit')}
        </Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => patch.mutate({ id: session.id, plan_mode: false })} loading={patch.isPending}>
          {t('conv.plan.reject')}
        </Button>
      </div>
    </section>
  )
}
