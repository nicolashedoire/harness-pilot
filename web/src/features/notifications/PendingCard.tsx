// Dashboard card "To handle": the notifications that need you (4 at most), a link to the centre. The dashboard
// shows it only while there is something to handle.
import * as React from 'react'
import { Bell } from 'lucide-react'
import { byNewest } from '@/lib/feed'
import { useFeed } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Card, CountBadge } from '@/components/ui'
import { useOpenNotifications } from './store'
import { NotificationItem } from './NotificationItem'

/** The events to handle (shared with the dashboard, which decides whether to show the card). */
export function usePendingEvents() {
  const q = useFeed({ pending: true }, 50)
  const events = React.useMemo(() => [...(q.data?.events ?? [])].sort(byNewest), [q.data])
  return { events, count: Math.max(q.data?.pending ?? 0, events.length), ready: !!q.data }
}

export function PendingCard({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const t = useT()
  const open = useOpenNotifications()
  const { events, count } = usePendingEvents()
  return (
    <Card className={cn('mx-card-in min-w-0 gap-0 overflow-hidden border-destructive/30', className)} style={style} data-testid="pending-card">
      <div className="flex h-12 items-center gap-2.5 px-[var(--pad-card)] pt-1">
        <Bell className="size-4 text-destructive" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t('feed.pending')}</h2>
        <CountBadge count={count} tone="attention" title={t('feed.pendingCount', { count })} />
      </div>
      <div className="grid flex-1 content-start gap-0.5 px-2 pb-2">
        {events.slice(0, 4).map((ev) => (
          <NotificationItem key={ev.id} ev={ev} variant="mini" />
        ))}
      </div>
      <button
        type="button"
        onClick={() => open()}
        className="flex h-10 items-center justify-center border-t text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent"
      >
        {t('feed.open')}
      </button>
    </Card>
  )
}
