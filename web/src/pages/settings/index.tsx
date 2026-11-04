// /settings/:section — left sub-nav grouped under headings, with a search, on desktop; scrollable top tabs on mobile.
// Each section is its own component in ./sections/*.tsx (Telegram/Backup/Claude reuse src/features).
import * as React from 'react'
import { Navigate, NavLink, useNavigate, useParams } from 'react-router'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Input } from '@/components/ui/input'
import { PageHeader, useDocumentTitle } from '@/components/shell/Page'
import { SETTINGS_NAV, SETTINGS_SECTIONS, filterSettingsNav, type SettingsSectionId } from './sections'
import { GeneralSection } from './sections/General'
import { AppearanceSection } from './sections/Appearance'
import { ProfileSection } from './sections/Profile'
import { LicenseSection } from './sections/License'
import { SupportSection } from './sections/Support'
import { FeaturesSection } from './sections/Features'
import { SecuritySection } from './sections/Security'
import { ClaudeSection } from './sections/Claude'
import { CodexSection } from './sections/Codex'
import { PullRequestsSection } from './sections/PullRequests'
import { MissionsSection } from './sections/Missions'
import { CompanionsSection } from './sections/Companions'
import { TelegramSection } from './sections/Telegram'
import { BackupSection } from './sections/Backup'
import { VoiceSection } from './sections/Voice'
import { KeysSection } from './sections/Keys'
import { McpSection } from './sections/Mcp'
import { ExtensionsSection } from './sections/Extensions'
import { BlocksSection } from './sections/Blocks'
import { SystemSection } from './sections/System'
import { TrashSection } from './sections/Trash'
import { ImportSection } from './sections/Import'
import { ProjectsSection } from './sections/Projects'
import { NotificationsSection } from './sections/Notifications'
import { StatsSection } from './sections/Stats'
import { MemorySection } from './sections/Memory'
import { UpdatesSection } from './sections/Updates'

const COMPONENTS: Record<Exclude<SettingsSectionId, 'docs'>, React.ComponentType> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  profile: ProfileSection,
  license: LicenseSection,
  support: SupportSection,
  features: FeaturesSection,
  notifications: NotificationsSection,
  stats: StatsSection,
  memory: MemorySection,
  security: SecuritySection,
  claude: ClaudeSection,
  codex: CodexSection,
  companions: CompanionsSection,
  'pull-requests': PullRequestsSection,
  missions: MissionsSection,
  telegram: TelegramSection,
  voice: VoiceSection,
  backup: BackupSection,
  keys: KeysSection,
  mcp: McpSection,
  extensions: ExtensionsSection,
  blocks: BlocksSection,
  import: ImportSection,
  packs: ProjectsSection,
  trash: TrashSection,
  system: SystemSection,
  updates: UpdatesSection,
}

const FADE_PX = 24 // = scroll-py-6

const href = (id: SettingsSectionId) => (id === 'docs' ? '/docs' : `/settings/${id}`)

export default function SettingsPage() {
  const t = useT()
  const navigate = useNavigate()
  const { section = 'general' } = useParams()
  const [query, setQuery] = React.useState('')
  const menu = React.useMemo(() => filterSettingsNav(t, query), [t, query])
  // where the highlight sits: the active section's group and row in the (filtered) menu; none when filtered out
  const at = React.useMemo(() => {
    let row = 0
    for (const [group, g] of menu.entries())
      for (const s of g.items) {
        if (s.id === section) return { group, row }
        row++
      }
    return null
  }, [menu, section])
  const meta = SETTINGS_SECTIONS.find((s) => s.id === section)
  useDocumentTitle(meta ? `${t(meta.label)} · ${t('nav.settings')}` : t('nav.settings'))
  const tabs = React.useRef<HTMLUListElement>(null)
  const side = React.useRef<HTMLDivElement>(null)
  // Desktop list taller than the window: fade the edge it can still scroll to, so a cut item reads as "more below".
  const [edges, setEdges] = React.useState({ top: false, bottom: false })
  const measure = React.useCallback(() => {
    const nav = side.current
    if (!nav) return
    const top = nav.scrollTop > 1
    const bottom = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }))
  }, [])
  React.useEffect(() => {
    const nav = side.current
    if (!nav) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(nav)
    return () => ro.disconnect()
  }, [measure, section, menu])
  // phones: the next section slides in from the side of its tab (decided once per section change, so a
  // re-render during the animation does not cut it)
  const slide = React.useRef({ section, cls: '' })
  if (slide.current.section !== section) {
    const from = SETTINGS_SECTIONS.findIndex((s) => s.id === slide.current.section)
    const to = SETTINGS_SECTIONS.findIndex((s) => s.id === section)
    slide.current = { section, cls: from < 0 || to < 0 ? '' : to > from ? 'max-md:animate-[mx-slide-x-r_240ms_cubic-bezier(0.22,1,0.36,1)]' : 'max-md:animate-[mx-slide-x-l_240ms_cubic-bezier(0.22,1,0.36,1)]' }
  }
  React.useEffect(() => {
    // Keep the active mobile tab visible (horizontal scroll only, never moves the page).
    const ul = tabs.current
    const el = ul?.querySelector<HTMLElement>('[data-active]')
    if (ul && el) ul.scrollTo({ left: el.offsetLeft - ul.clientWidth / 2 + el.clientWidth / 2, behavior: 'smooth' })
    // Desktop list taller than the window: it scrolls on its own; keep the active section in it (never moves the page).
    const nav = side.current
    const item = nav?.querySelector<HTMLElement>('[aria-current=page]')
    if (nav && item && nav.scrollHeight > nav.clientHeight) {
      const at = item.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop
      const top = at - FADE_PX, bottom = at + item.offsetHeight + FADE_PX // clear of the fades
      if (top < nav.scrollTop) nav.scrollTop = top
      else if (bottom > nav.scrollTop + nav.clientHeight) nav.scrollTop = bottom - nav.clientHeight
    }
  }, [section])
  if (!meta || section === 'docs') return <Navigate to={section === 'docs' ? '/docs' : '/settings/general'} replace />
  const Cmp = COMPONENTS[section as Exclude<SettingsSectionId, 'docs'>]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={t('nav.settings')} sensitiveTitle={t('nav.settings')} />
      {/* Mobile tabs */}
      <nav aria-label={t('nav.settings')} className="sticky top-[calc(var(--header-h)+var(--safe-top))] z-10 -mt-px border-b bg-background md:hidden">
        <ul ref={tabs} className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none]">
          {SETTINGS_NAV.flatMap((g, gi) => [
            ...(gi ? [<li key={`sep-${gi}`} aria-hidden className="mx-1 my-2 w-px shrink-0 bg-border" />] : []),
            ...g.items.map((s) => (
              <li key={s.id} className="shrink-0">
                <NavLink
                  to={href(s.id)}
                  data-active={s.id === section || undefined}
                  className={({ isActive }) =>
                    cn('flex h-9 max-md:h-10 pointer-coarse:h-10 items-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors duration-200', s.id === 'support' && 'text-primary', isActive && 'bg-secondary text-foreground', isActive && s.id === 'support' && 'text-primary')
                  }
                >
                  {t(s.label)}
                </NavLink>
              </li>
            )),
          ])}
        </ul>
      </nav>
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-10 px-4 py-6 md:px-6 md:py-8">
        <nav
          aria-label={t('nav.settings')}
          className="sticky top-[calc(var(--header-h)+2rem)] -m-1 hidden max-h-[calc(100dvh-var(--header-h)-4rem-var(--safe-bottom))] w-58 shrink-0 flex-col gap-1 self-start p-1 md:flex"
        >
          <div className="relative shrink-0">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const first = menu[0]?.items[0]
                if (e.key === 'Enter' && query.trim() && first) navigate(href(first.id))
                else if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
              placeholder={t('setnav.search')}
              aria-label={t('setnav.search')}
              className="pl-8"
            />
          </div>
          <div
            ref={side}
            onScroll={measure}
            style={{ maskImage: edges.top || edges.bottom ? `linear-gradient(to bottom, ${edges.top ? 'transparent' : '#000'}, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), ${edges.bottom ? 'transparent' : '#000'})` : undefined }}
            className="-mx-1 -mb-1 min-h-0 scroll-py-6 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]"
          >
            {menu.length ? (
              // Group heading h-7 + gap-0.5 = --head; the highlight slides to the active section (items are h-9, h-10 on touch, + gap-0.5).
              <div className="relative grid gap-0.5 [--head:1.875rem] [--row:2.375rem] pointer-coarse:[--row:2.625rem]">
                {at && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-9 pointer-coarse:h-10 rounded-md bg-accent transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                    style={{ transform: `translateY(calc(${at.group + 1} * var(--head) + ${at.row} * var(--row)))` }}
                  />
                )}
                {menu.map((g) => (
                  <div key={g.group?.id ?? 'end'} role={g.group ? 'group' : undefined} aria-labelledby={g.group ? `setnav-${g.group.id}` : undefined} className="grid gap-0.5">
                    {g.group ? (
                      <div id={`setnav-${g.group.id}`} className="flex h-7 items-end px-2.5 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted-foreground/80 uppercase">
                        {t(g.group.label)}
                      </div>
                    ) : (
                      <div aria-hidden className="flex h-7 items-center px-2.5">
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <ul className="grid gap-0.5">
                      {g.items.map((s) => (
                        <li key={s.id}>
                          <NavLink
                            to={href(s.id)}
                            className={({ isActive }) =>
                              cn(
                                'relative flex h-9 pointer-coarse:h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                                isActive && 'font-medium text-foreground hover:bg-transparent',
                                s.id === 'support' && 'font-medium text-primary hover:text-primary',
                              )
                            }
                          >
                            <s.icon className="size-4 shrink-0" />
                            <span className="truncate">{t(s.label)}</span>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-2.5 py-2 text-sm text-muted-foreground">{t('setnav.none')}</p>
            )}
          </div>
        </nav>
        <div className={cn('min-w-0 flex-1', slide.current.cls)} key={section}>
          <div className="mx-rise mb-6 grid gap-1">
            <h2 className="text-xl font-semibold tracking-tight">{t(meta.label)}</h2>
            <p className="text-sm text-muted-foreground">{t(meta.description)}</p>
          </div>
          <Cmp />
        </div>
      </div>
    </div>
  )
}
