// The notifications centre: a panel that slides out of the sidebar (desktop layout; phones use the page). Header
// (mark all read, settings, close), the type filter, "To handle" on top, then the activity by day, a link to the
// full page. Non-modal dialog: Esc and a click outside close it, the focus goes in on open and back to the sidebar
// entry on close, a click on another sidebar entry closes it and navigates in one go.
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useLocation, useNavigate } from 'react-router'
import { CheckCheck, Settings2, X } from 'lucide-react'
import { useFeed, useFeedSummary, useMarkFeedRead } from '@/lib/queries'
import { byNewest, isPending } from '@/lib/feed'
import { useT } from '@/i18n'
import { Button, Tooltip } from '@/components/ui'
import { useNotificationCenter } from './store'
import { FilterChips, type NotificationFilter } from './FilterChips'
import { NotificationItem, NotificationSkeleton } from './NotificationItem'
import { NoNotifications, NotificationSections } from './NotificationList'

/** Right edge of the sidebar: the panel opens next to it. */
function useSidebarEdge(open: boolean) {
  const [left, setLeft] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!open) return
    const measure = () => setLeft(document.querySelector('[data-sidebar]')?.getBoundingClientRect().right ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])
  return left
}

/** "To handle" + the latest activity of a filter. */
export function useCentreLists(filter: NotificationFilter) {
  const category = filter === 'all' || filter === 'pending' ? null : filter
  const pendingQ = useFeed({ category, pending: true }, 50)
  const recentQ = useFeed({ category }, 40)
  return React.useMemo(() => {
    // by time: a folded row moves up with its latest occurrence (the server orders by id)
    const pending = [...(pendingQ.data?.events ?? [])].sort(byNewest)
    const ids = new Set(pending.map((e) => e.id))
    const activity = (recentQ.data?.events ?? []).filter((e) => !ids.has(e.id) && !isPending(e)).sort(byNewest)
    const head = recentQ.data
    const pendingCount = (category ? head?.categories?.[category]?.pending : head?.pending) ?? pending.length
    return { pending, activity, pendingCount: Math.max(pendingCount, pending.length), loading: pendingQ.isPending || recentQ.isPending, error: pendingQ.isError && recentQ.isError }
  }, [pendingQ.data, recentQ.data, pendingQ.isPending, recentQ.isPending, pendingQ.isError, recentQ.isError, category])
}

export default function NotificationCenter() {
  const t = useT()
  const navigate = useNavigate()
  const open = useNotificationCenter((s) => s.open)
  const setOpen = useNotificationCenter((s) => s.setOpen)
  const left = useSidebarEdge(open)
  const [filter, setFilter] = React.useState<NotificationFilter>('all')
  const lists = useCentreLists(filter)
  const { data: summary } = useFeedSummary()
  const read = useMarkFeedRead()
  const location = useLocation()
  const panel = React.useRef<HTMLDivElement>(null)

  // Any navigation closes it (a link of a notification, the sidebar).
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) return void (first.current = false)
    setOpen(false)
  }, [location.pathname, location.search, setOpen])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
      <DialogPrimitive.Portal>
        <div aria-hidden className="fixed inset-y-0 right-0 z-40 bg-overlay data-[state=closed]:animate-overlay-out data-[state=open]:animate-overlay-in" data-state={open ? 'open' : 'closed'} style={{ left }} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // the panel itself takes the focus (Tab goes on to its buttons): no tooltip popping on the first one
          ref={panel}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            panel.current?.focus()
          }}
          tabIndex={-1}
          onInteractOutside={(e) => {
            // the sidebar entry toggles it itself
            if ((e.target as HTMLElement | null)?.closest?.('[data-tour="nav-notifications"]')) e.preventDefault()
          }}
          className="fixed inset-y-0 z-40 flex w-[420px] max-w-[calc(100vw-80px)] flex-col border-r bg-popover pt-[var(--safe-top)] text-popover-foreground shadow-pop outline-none data-[state=closed]:animate-sheet-left-out data-[state=open]:animate-sheet-left"
          style={{ left }}
          data-testid="notification-center"
        >
          <div className="flex items-center gap-1 px-4 pt-4 pb-3">
            <DialogPrimitive.Title className="flex-1 text-base font-semibold tracking-tight">{t('feed.title')}</DialogPrimitive.Title>
            <Tooltip content={t('ncentre.markAllRead')}>
              <Button variant="ghost" size="icon-sm" disabled={!summary?.unread} onClick={() => read.mutate({ all: true })} aria-label={t('ncentre.markAllRead')}>
                <CheckCheck />
              </Button>
            </Tooltip>
            <Tooltip content={t('feed.settings')}>
              <Button variant="ghost" size="icon-sm" onClick={() => go('/settings/notifications')} aria-label={t('feed.settings')}>
                <Settings2 />
              </Button>
            </Tooltip>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('ncentre.close')}>
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <FilterChips value={filter} onChange={setFilter} className="border-b px-4 pb-3" />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
            {lists.loading ? (
              <NotificationSkeleton rows={6} />
            ) : !lists.pending.length && !lists.activity.length ? (
              <NoNotifications filtered={filter !== 'all'} />
            ) : (
              <NotificationSections
                pending={lists.pending}
                activity={lists.activity}
                pendingCount={lists.pendingCount}
                itemsClassName="grid gap-1"
                renderItem={(ev) => <NotificationItem key={ev.id} ev={ev} />}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => go(filter === 'all' ? '/notifications' : `/notifications?filter=${filter}`)}
            className="h-12 shrink-0 border-t pb-[var(--safe-bottom)] text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent"
          >
            {t('ncentre.seeAll')}
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
