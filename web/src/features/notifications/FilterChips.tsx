// The type filter: All · (To handle) · Sessions · Crons · System · Webhooks - one choice at a time.
import { FEED_CATEGORIES } from '@/lib/feed'
import type { FeedCategory } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { categoryLabel } from './text'

export type NotificationFilter = 'all' | 'pending' | FeedCategory

export const parseFilter = (v: string | null): NotificationFilter => (v === 'pending' || FEED_CATEGORIES.includes(v as FeedCategory) ? (v as NotificationFilter) : 'all')

export function FilterChips({
  value,
  onChange,
  pendingCount,
  withPending,
  className,
}: {
  value: NotificationFilter
  onChange: (f: NotificationFilter) => void
  /** Adds the "To handle" chip (with this count). */
  withPending?: boolean
  pendingCount?: number
  className?: string
}) {
  const t = useT()
  const chips: { id: NotificationFilter; label: string }[] = [
    { id: 'all', label: t('ncentre.all') },
    ...(withPending ? [{ id: 'pending' as const, label: t('feed.pending') }] : []),
    ...FEED_CATEGORIES.map((c) => ({ id: c, label: categoryLabel(t, c) })),
  ]
  return (
    <div role="group" aria-label={t('ncentre.filters')} className={cn('flex flex-wrap gap-1.5', className)} data-testid="notification-filters">
      {chips.map((c) => {
        const on = value === c.id
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(c.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:h-10 max-md:px-3.5 max-md:text-[13px] pointer-coarse:h-10',
              on ? 'bg-foreground font-semibold text-background' : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {c.label}
            {c.id === 'pending' && !!pendingCount && (
              <span className={cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums', on ? 'bg-destructive text-destructive-foreground' : 'bg-destructive/15 text-destructive')}>
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
