// A list of notifications in sections: "To handle" first (with its count), then the activity grouped by day
// (Today, Yesterday, then the date). The centre, the page and the phone list use it with their own item look.
import * as React from 'react'
import { BellOff, Check } from 'lucide-react'
import { dayKey, groupByDay } from '@/lib/feed'
import type { FeedEvent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { useEventText } from './text'

export function SectionTitle({ children, count, tone = 'muted', className }: { children: React.ReactNode; count?: number; tone?: 'muted' | 'attention'; className?: string }) {
  return (
    <h3 className={cn('flex items-center gap-2 px-2 pt-3 pb-1.5 text-xs font-semibold tracking-wide uppercase', tone === 'attention' ? 'text-destructive' : 'text-muted-foreground', className)}>
      {children}
      {count != null && count > 0 && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive/15 px-1 text-[11px] font-semibold tracking-normal text-destructive tabular-nums">{count > 99 ? '99+' : count}</span>
      )}
    </h3>
  )
}

/** "Today", "Yesterday", else "Monday 2 November". */
export function useDayLabel() {
  const t = useT()
  const x = useEventText()
  return React.useCallback(
    (key: string, at: number) => {
      const now = Date.now() / 1000
      if (key === dayKey(now, x.tz)) return t('ncentre.today')
      if (key === dayKey(now - 86400, x.tz)) return t('ncentre.yesterday')
      return x.date(at, { dateStyle: undefined, timeStyle: undefined, weekday: 'long', day: 'numeric', month: 'long' })
    },
    [t, x],
  )
}

export function NotificationSections({
  pending,
  activity,
  renderItem,
  pendingCount,
  className,
  itemsClassName,
}: {
  pending: FeedEvent[]
  activity: FeedEvent[]
  renderItem: (ev: FeedEvent, index: number) => React.ReactNode
  /** Shown next to "To handle" (the server's count can exceed the loaded rows). */
  pendingCount?: number
  className?: string
  itemsClassName?: string
}) {
  const t = useT()
  const x = useEventText()
  const dayLabel = useDayLabel()
  const days = React.useMemo(() => groupByDay(activity, x.tz), [activity, x.tz])
  let n = 0
  return (
    <div className={className}>
      {pending.length > 0 && (
        <section aria-label={t('feed.pending')}>
          <SectionTitle tone="attention" count={pendingCount ?? pending.length}>
            {t('feed.pending')}
          </SectionTitle>
          <div className={itemsClassName}>{pending.map((ev) => renderItem(ev, n++))}</div>
        </section>
      )}
      {days.map((d) => (
        <section key={d.key} aria-label={dayLabel(d.key, d.items[0].at)}>
          <SectionTitle className={pending.length || d !== days[0] ? 'pt-5' : undefined}>{dayLabel(d.key, d.items[0].at)}</SectionTitle>
          <div className={itemsClassName}>{d.items.map((ev) => renderItem(ev, n++))}</div>
        </section>
      ))}
    </div>
  )
}

/** Nothing to handle: the reassuring state of the "To handle" views. */
export function AllHandled({ className }: { className?: string }) {
  const t = useT()
  return (
    <div className={cn('flex flex-col items-center gap-2.5 px-6 py-10 text-center', className)} data-testid="notifications-all-done">
      <span className="flex size-11 items-center justify-center rounded-xl bg-success/12 text-success">
        <Check className="size-[22px]" />
      </span>
      <p className="font-semibold">{t('ncentre.allDone')}</p>
      <p className="max-w-xs text-[13px] text-muted-foreground">{t('ncentre.allDoneDesc')}</p>
    </div>
  )
}

/** No notification at all (or none for the filters). */
export function NoNotifications({ filtered, className }: { filtered?: boolean; className?: string }) {
  const t = useT()
  return (
    <div className={cn('flex flex-col items-center gap-2.5 px-6 py-10 text-center', className)}>
      <span className="flex size-11 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground">
        <BellOff className="size-5" strokeWidth={1.7} />
      </span>
      <p className="font-semibold">{filtered ? t('ncentre.emptyFilter') : t('ncentre.empty')}</p>
      <p className="max-w-xs text-[13px] text-muted-foreground">{filtered ? t('ncentre.emptyFilterDesc') : t('ncentre.emptyDesc')}</p>
    </div>
  )
}
