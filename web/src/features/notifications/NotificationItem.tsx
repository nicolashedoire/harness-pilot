// One notification, in four looks:
//   row   the centre: icon, title, one line, origin · time, its buttons; a folded group (×12) unfolds its occurrences
//   card  phones: a bordered card with 44 px buttons
//   list  the Notifications page: a selectable line (the detail is on the right)
//   mini  the dashboard card: icon, title, time
// Unread = bold title + dot; "to handle" and unread = a soft background. A click on the row opens it (read + link)
// or selects it (`onSelect`); buttons stay clickable above the row's stretched hit area.
import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { useFeedEvent } from '@/lib/queries'
import { isPending } from '@/lib/feed'
import type { FeedEvent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button, Sensitive, Skeleton, Tooltip } from '@/components/ui'
import { LevelIcon } from './LevelIcon'
import { NotificationActions } from './NotificationActions'
import { useNotificationActions } from './useNotificationActions'
import { eventSummary, eventTitle, useEventText } from './text'

export type ItemVariant = 'row' | 'card' | 'list' | 'mini'

function UnreadDot({ label, className }: { label: string; className?: string }) {
  return <span role="img" aria-label={label} className={cn('mt-1.5 size-2 shrink-0 rounded-full bg-primary', className)} />
}

export function CountChip({ n, className }: { n: number; className?: string }) {
  return <span className={cn('inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums', className)}>×{n}</span>
}

function When({ at }: { at: number }) {
  const x = useEventText()
  return (
    <time dateTime={new Date(at * 1000).toISOString()} title={x.date(at)} className="shrink-0 tabular-nums">
      {x.when(at)}
    </time>
  )
}

/** "Crons · 10 min ago · ×3" */
function Meta({ ev, count, className }: { ev: FeedEvent; count?: boolean; className?: string }) {
  const x = useEventText()
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground', className)}>
      <span className="min-w-0 truncate">
        <Sensitive length={8}>{x.origin(ev)}</Sensitive>
      </span>
      <span aria-hidden>·</span>
      <When at={ev.at} />
      {count && ev.count > 1 && (
        <>
          <span aria-hidden>·</span>
          <span className="tabular-nums">×{ev.count}</span>
        </>
      )}
    </span>
  )
}

/** The occurrences of a folded group, loaded when it unfolds. */
function Occurrences({ ev }: { ev: FeedEvent }) {
  const x = useEventText()
  const { data, isPending: loading } = useFeedEvent(ev.id)
  if (loading)
    return (
      <div className="grid gap-1.5 py-1" aria-busy>
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    )
  const list = data?.occurrences ?? []
  if (!list.length) return null
  return (
    <ul className="mx-unfold relative z-10 grid gap-1 border-l pl-3 text-[13px]">
      {list.map((o, i) => {
        const sub = { ...ev, ...o, params: o.params ?? ev.params }
        return (
          <li key={`${o.at}-${i}`} className="flex min-w-0 gap-2">
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{x.date(o.at, { dateStyle: undefined, timeStyle: 'short' })}</span>
            <span className="min-w-0 flex-1 truncate">
              <Sensitive length={12}>{eventSummary(x.t, sub) || eventTitle(x.t, sub)}</Sensitive>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function NotificationItem({ ev, variant = 'row', selected, onSelect, style }: { ev: FeedEvent; variant?: ItemVariant; selected?: boolean; onSelect?: (ev: FeedEvent) => void; style?: React.CSSProperties }) {
  const x = useEventText()
  const t = x.t
  const actions = useNotificationActions()
  const [expanded, setExpanded] = React.useState(false)
  const pending = isPending(ev)
  const folded = ev.count > 1 && !pending
  const title = x.title(ev)
  const summary = x.summary(ev)
  const click = () => (onSelect ? onSelect(ev) : actions.open(ev))
  const common = { 'data-testid': 'notification', 'data-level': ev.level, 'data-pending': pending || undefined, 'data-kind': ev.kind, style }

  if (variant === 'mini')
    return (
      <button type="button" onClick={click} className="flex w-full min-w-0 gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring" {...common}>
        <LevelIcon level={ev.level} kind={ev.kind} className="mt-0.5 size-4" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={cn('truncate text-[13px]', !ev.read && 'font-medium')}>
            <Sensitive length={12}>{title}</Sensitive>
          </span>
          <span className="text-xs text-muted-foreground">
            <When at={ev.at} />
          </span>
        </span>
      </button>
    )

  if (variant === 'list')
    return (
      <button
        type="button"
        onClick={click}
        aria-current={selected || undefined}
        className={cn('relative flex w-full min-w-0 gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring', selected && 'bg-accent hover:bg-accent')}
        {...common}
      >
        {selected && <span aria-hidden className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-primary" />}
        <LevelIcon level={ev.level} kind={ev.kind} className="mt-0.5 size-[17px]" />
        <span className="grid min-w-0 flex-1 gap-1">
          <span className={cn('line-clamp-2 leading-snug', !ev.read ? 'font-semibold' : 'text-foreground/90')}>
            <Sensitive length={14}>{title}</Sensitive>
          </span>
          <Meta ev={ev} count />
        </span>
        {!ev.read && <UnreadDot label={t('feed.unread')} />}
      </button>
    )

  const card = variant === 'card'
  return (
    <article
      className={cn(
        'group/n relative flex gap-2.5 transition-colors',
        card ? 'flex-col gap-2 rounded-xl border bg-card p-3.5' : 'rounded-lg p-2.5 hover:bg-accent/60',
        !card && pending && !ev.read && 'bg-muted/70',
      )}
      {...common}
    >
      <div className={cn('flex min-w-0 flex-1 gap-2.5', card && 'items-start')}>
        <LevelIcon level={ev.level} kind={ev.kind} className={cn('mt-px', card && 'size-[19px]')} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <button
            type="button"
            onClick={click}
            className="grid min-w-0 gap-1 text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            <span className={cn('flex min-w-0 items-center gap-2 leading-snug', card && 'text-[15px]', !ev.read ? 'font-semibold' : 'text-foreground/90')}>
              <span className="line-clamp-2 min-w-0">
                <Sensitive length={14}>{title}</Sensitive>
              </span>
              {folded && <CountChip n={ev.count} />}
            </span>
            {summary && (
              <span className={cn('line-clamp-2 break-words text-muted-foreground', card ? 'text-sm' : 'text-[13px]')}>
                <Sensitive length={16}>{summary}</Sensitive>
              </span>
            )}
            <Meta ev={ev} count={!folded} className={card ? 'text-[13px]' : undefined} />
          </button>
          {!card && <NotificationActions ev={ev} className="relative z-10 mt-0.5" />}
          {folded && expanded && <Occurrences ev={ev} />}
        </div>
        {folded && !card ? (
          <Tooltip content={expanded ? t('feed.collapse') : t('feed.expand')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative z-10 -my-0.5 size-7 text-muted-foreground"
              aria-expanded={expanded}
              aria-label={expanded ? t('feed.collapse') : t('feed.expand')}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
            </Button>
          </Tooltip>
        ) : (
          !ev.read && <UnreadDot label={t('feed.unread')} className={card ? 'mt-2' : undefined} />
        )}
      </div>
      {card && <NotificationActions ev={ev} layout="touch" className="relative z-10 mt-1" />}
    </article>
  )
}

export function NotificationSkeleton({ rows = 5, variant = 'row' }: { rows?: number; variant?: ItemVariant }) {
  return (
    <div className={cn('grid', variant === 'card' ? 'gap-2.5' : 'gap-1 p-1')} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn('flex gap-2.5 p-2.5', variant === 'card' && 'rounded-xl border bg-card p-3.5')}>
          <Skeleton className="size-[18px] rounded-full" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-4" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  )
}
