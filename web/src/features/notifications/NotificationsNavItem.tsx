// Sidebar entry "Notifications": opens the centre. Its badge: the count to handle (red), else a dot for unread
// activity, else nothing. Collapsed sidebar: the icon and a dot.
import { Bell } from 'lucide-react'
import { useLocation } from 'react-router'
import { useFeedSummary } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { CountBadge, CountDot, Tooltip } from '@/components/ui'
import { navItemClass } from '@/components/shell/nav'
import { useNotificationCenter, useOpenNotifications } from './store'

/** The words of the badge: "4 to handle", "3 unread" or null. */
export function useNotificationBadge() {
  const t = useT()
  const { data } = useFeedSummary()
  const pending = data?.pending ?? 0
  const unread = data?.unread ?? 0
  const status = pending ? t('feed.pendingCount', { count: pending }) : unread ? t('feed.unreadCount', { count: unread }) : null
  return { pending, unread, status }
}

export function NotificationsNavItem({ collapsed }: { collapsed: boolean }) {
  const t = useT()
  const open = useNotificationCenter((s) => s.open)
  const openCenter = useOpenNotifications()
  const { pathname } = useLocation()
  const { pending, unread, status } = useNotificationBadge()
  const active = open || pathname.startsWith('/notifications')
  const label = t('feed.title')
  return (
    <Tooltip content={collapsed ? (status ? `${label} · ${status}` : label) : null} side="right">
      <button
        type="button"
        onClick={() => openCenter(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tour="nav-notifications"
        data-testid="nav-notifications"
        className={cn(navItemClass(active, collapsed), 'w-full')}
      >
        {active && <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full bg-primary" />}
        <Bell className={cn('size-[18px] shrink-0', active && 'text-primary')} strokeWidth={active ? 2.2 : 1.9} />
        {collapsed ? <span className="sr-only">{label}</span> : <span className="flex-1 truncate text-left">{label}</span>}
        {status && <span className="sr-only">{status}</span>}
        {collapsed ? (
          (pending > 0 || unread > 0) && (
            <span className="absolute top-0.5 right-1 flex size-4 items-center justify-center">
              <CountDot tone={pending ? 'attention' : 'notice'} />
            </span>
          )
        ) : (
          <>
            {/* kept mounted so it can animate out when everything is handled */}
            <span aria-hidden className="flex items-center empty:hidden">
              <CountBadge count={pending} tone="attention" title={status ?? undefined} />
            </span>
            {!pending && unread > 0 && <CountDot tone="notice" className="mr-1.5" />}
          </>
        )}
      </button>
    </Tooltip>
  )
}
