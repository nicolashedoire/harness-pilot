// The Atelier's entry of the rail and of the touch app menu, with how many proposals wait for the user's approval.
// The count stays light: it is not asked before the browser is idle (never on the first paint), it reads the feed's
// `atelier.proposed` rows (one per waiting draft, resolved once decided: GET /api/feed?kind=atelier.proposed, one small
// query) instead of the Atelier's list, and its key is in the `feed` domain, so the bus topic `feed` refreshes it.
import * as React from 'react'
import { NavLink } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FeedList } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { CountBadge, CountDot, Tooltip } from '@/components/ui'
import { navItemClass, navTourId, type NavItem } from './nav'

export const ATELIER_PENDING_KEY = ['feed', 'atelier-pending'] as const

/** True once the browser is idle (or after 2.5 s): work that must not compete with the first paint. */
function useIdle(): boolean {
  const [idle, setIdle] = React.useState(false)
  React.useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => setIdle(true), { timeout: 2500 })
      return () => w.cancelIdleCallback?.(h)
    }
    const h = setTimeout(() => setIdle(true), 1200)
    return () => clearTimeout(h)
  }, [])
  return idle
}

/** Proposals waiting for the user's approval (0 until the browser is idle, or on a server without the kind filter:
 *  the rows are filtered here too). */
export function useAtelierPendingCount(): number {
  const idle = useIdle()
  const { data } = useQuery({
    queryKey: ATELIER_PENDING_KEY,
    queryFn: async () => {
      const l = await api.get<FeedList>('/api/feed', { kind: 'atelier.proposed', limit: 50 })
      return l.events.filter((e) => e.kind === 'atelier.proposed' && !e.resolved_at).length
    },
    enabled: idle,
    staleTime: 60_000,
  })
  return data ?? 0
}

/** The sidebar entry, after the extension pages (nav.ts ATELIER_NAV). */
export function AtelierNavItem({ item, collapsed, active, prefetch }: { item: NavItem; collapsed: boolean; active: boolean; prefetch: React.HTMLAttributes<HTMLAnchorElement> }) {
  const t = useT()
  const label = t(item.label)
  const pending = useAtelierPendingCount()
  const title = pending ? t('nav.atelierPending', { count: pending }) : undefined
  return (
    <Tooltip content={collapsed ? (title ? `${label} · ${title}` : label) : null} side="right">
      <NavLink to={item.to} {...prefetch} data-tour={navTourId(item)} className={navItemClass(active, collapsed)}>
        {active && <span aria-hidden className={cn('absolute w-[3px] rounded-r-full bg-primary', collapsed ? 'top-3 bottom-3 -left-2.5' : 'top-2 bottom-2 -left-3')} />}
        <item.icon className={cn('size-[18px] shrink-0', active && 'text-primary')} strokeWidth={active ? 2.2 : 1.9} />
        {!collapsed && <span className="flex-1 truncate">{label}</span>}
        {collapsed ? (
          pending > 0 && (
            <span className="absolute top-0.5 right-1 flex size-4 items-center justify-center">
              <CountDot tone="draft" />
            </span>
          )
        ) : (
          // kept mounted so the counter can animate out when the last proposal is decided
          <span className="empty:hidden">
            <CountBadge count={pending} tone="draft" title={title} />
          </span>
        )}
        {title && <span className="sr-only">{title}</span>}
      </NavLink>
    </Tooltip>
  )
}

/** The counter of the touch app menu's tile. */
export function AtelierTileBadge() {
  const t = useT()
  const pending = useAtelierPendingCount()
  return <CountBadge count={pending} tone="draft" className="absolute top-2 right-2" title={pending ? t('nav.atelierPending', { count: pending }) : undefined} />
}
