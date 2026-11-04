// Primary navigation — single source for the sidebar, the mobile tab bar, the palette and shortcuts.
import { Clock, FolderOpen, GitBranch, LayoutDashboard, ListChecks, MessagesSquare, Network, Settings, UsersRound, type LucideIcon } from 'lucide-react'
import type { TKey } from '@/i18n'
import { useSettings } from '@/lib/queries'

export type NavItem = { to: string; label: TKey; /** label in the mobile tab bar when `label` is too long */ short?: TKey; icon: LucideIcon; /** g + key */ key: string; end?: boolean }

/** Look of a sidebar navigation entry (pages and the Notifications entry). */
export const navItemClass = (active: boolean, collapsed: boolean) =>
  [
    'mx-boot-item group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    active ? 'bg-accent text-foreground' : '',
    // rail: 44 px squares (touch-sized, like the mock-ups)
    collapsed ? 'mx-auto size-11 justify-center rounded-[10px] px-0' : '',
  ].join(' ')

/** `data-tour` id of a nav item (guided tour targets): nav-dashboard, nav-sessions… */
export const navTourId = (n: NavItem) => `nav-${n.to === '/' ? 'dashboard' : n.to.slice(1)}`

export const NAV: NavItem[] = [
  { to: '/', label: 'nav.dashboard', short: 'nav.home', icon: LayoutDashboard, key: 'd', end: true },
  { to: '/sessions', label: 'nav.sessions', icon: MessagesSquare, key: 's' },
  { to: '/files', label: 'nav.files', icon: FolderOpen, key: 'f' },
  { to: '/tasks', label: 'nav.tasks', icon: ListChecks, key: 't' },
  { to: '/crons', label: 'nav.crons', icon: Clock, key: 'c' },
  { to: '/settings', label: 'nav.settings', icon: Settings, key: ',' },
]

/** Pages of optional features (Settings -> Features), inserted before Settings when switched on. Not in the mobile
 *  tab bar (no room). */
const FEATURE_NAV: (NavItem & { setting: 'git_page' | 'infra_page' | 'team_page'; defaultOn: boolean })[] = [
  { to: '/team', label: 'nav.team', icon: UsersRound, key: 'm', setting: 'team_page', defaultOn: false },
  { to: '/git', label: 'nav.git', icon: GitBranch, key: 'b', setting: 'git_page', defaultOn: false },
  { to: '/infra', label: 'nav.infra', icon: Network, key: 'i', setting: 'infra_page', defaultOn: false },
]

/** NAV plus the feature pages switched on (sidebar, palette, shortcuts). */
export function useNav(): NavItem[] {
  const { data: s } = useSettings()
  const extra = FEATURE_NAV.filter((n) => (s ? !!s[n.setting] : n.defaultOn))
  return extra.length ? [...NAV.slice(0, -1), ...extra, NAV[NAV.length - 1]] : NAV
}
