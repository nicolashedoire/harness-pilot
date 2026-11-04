// The Atelier list (GET /api/atelier): the drafts waiting for the user on top (banner), filter chips by type with
// their counts, a text filter, then every creation with its state, where it comes from, its version and the next
// thing to do with it, in the server's order (drafts, broken, to review, changed outside, then the newest changes).
// Desktop: a table. Touch layout: one card per creation.
import * as React from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Search, TriangleAlert, WandSparkles, X } from 'lucide-react'
import { useAtelier } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import type { AtelierItem, AtelierType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { useCompact } from '@/stores/media'
import { Badge, Button, EmptyState, Input, Sensitive, Skeleton, Tooltip } from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { Origin, StatePill, TypeTile, VersionTag, pillState, typeLabel } from '@/features/atelier/parts'
import { RowAction } from './RowAction'
import { itemHref, newSessionHref } from './links'

/** The chips: one per group of types. Agents and cron jobs only show when there are some. */
const FILTERS = {
  widgets: ['widget', 'html_widget', 'pin'],
  pages: ['page'],
  blocks: ['block'],
  themes: ['theme'],
  skills: ['skill'],
  customizations: ['customization'],
  agents: ['agent'],
  crons: ['cron'],
} satisfies Record<string, AtelierType[]>
type Filter = 'all' | keyof typeof FILTERS
const OPTIONAL = new Set<Filter>(['agents', 'crons'])
const parseFilter = (v: string | null): Filter => (v && v in FILTERS ? (v as Filter) : 'all')
const inFilter = (f: Filter, it: AtelierItem) => f === 'all' || (FILTERS[f] as readonly string[]).includes(it.type)

/** Case and accents ignored. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** The origin that matters on the row: the waiting draft's while there is one. */
const rowOrigin = (it: AtelierItem) => it.pending?.origin ?? it.origin
/** The one-line description: the error when broken, else what the agent said it did. */
const rowSummary = (it: AtelierItem) => (it.state === 'error' && !it.pending && it.error ? it.error.message : rowOrigin(it)?.summary || '')

export function AtelierList() {
  const t = useT()
  const touch = useCompact()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filter = parseFilter(params.get('show'))
  const q = params.get('q') ?? ''
  const { data, isPending, isError, error, refetch, isFetching } = useAtelier()

  const items = React.useMemo(() => data?.items ?? [], [data])
  const counts = React.useMemo(() => {
    const c = Object.fromEntries((['all', ...Object.keys(FILTERS)] as Filter[]).map((f) => [f, items.filter((it) => inFilter(f, it)).length])) as Record<Filter, number>
    return c
  }, [items])
  const waiting = items.filter((it) => it.pending)
  const needle = fold(q.trim())
  const shown = items.filter((it) => inFilter(filter, it) && (!needle || fold(`${it.name} ${it.id} ${rowSummary(it)} ${rowOrigin(it)?.session_title ?? ''}`).includes(needle)))

  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) v == null || v === '' ? p.delete(k) : p.set(k, v)
    setParams(p, { replace: true })
  }
  const create = () => navigate(newSessionHref(t('atelier.createPrompt')))

  const actions = (
    <Tooltip content={touch ? t('atelier.create') : null}>
      <Button size={touch ? 'icon' : 'sm'} onClick={create} aria-label={t('atelier.create')}>
        <WandSparkles />
        <span className="max-md:hidden">{t('atelier.create')}</span>
      </Button>
    </Tooltip>
  )

  return (
    <Page title={t('nav.atelier')} description={t('atelier.subtitle')} actions={actions} bodyClassName="max-md:px-3 max-md:pt-3">
      <p className="mb-4 text-[13px] text-muted-foreground md:hidden">{t('atelier.subtitle')}</p>

      {isPending ? (
        <ListSkeleton touch={touch} />
      ) : isError ? (
        <EmptyState
          tone="error"
          icon={TriangleAlert}
          title={t('atelier.loadFailed')}
          description={errorMessage(error)}
          action={
            <Button variant="outline" loading={isFetching} onClick={() => refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !items.length ? (
        <EmptyState
          icon={WandSparkles}
          title={t('atelier.empty')}
          description={t('atelier.emptyDesc')}
          action={
            <Button onClick={create}>
              <WandSparkles /> {t('atelier.create')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {waiting.length > 0 && <PendingBanner items={waiting} />}

          <div className="flex flex-wrap items-center gap-3">
            <FilterChips value={filter} counts={counts} onChange={(f) => set({ show: f === 'all' ? null : f })} className="max-md:-mx-3 max-md:w-[calc(100%+1.5rem)] max-md:flex-nowrap max-md:overflow-x-auto max-md:px-3 max-md:pb-1" />
            <div className="relative ml-auto w-full sm:w-64">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => set({ q: e.target.value })} placeholder={t('atelier.filter')} aria-label={t('atelier.filter')} className="h-8 pl-8 max-md:h-10" />
              {q && (
                <button
                  type="button"
                  onClick={() => set({ q: null })}
                  aria-label={t('atelier.clearFilter')}
                  className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground before:absolute before:-inset-2.5 before:content-[''] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>

          {!shown.length ? (
            <EmptyState compact icon={Search} title={t('atelier.noMatch')} description={t('atelier.noMatchDesc')} className="rounded-xl border" />
          ) : touch ? (
            <ul className="grid gap-2.5" aria-label={t('nav.atelier')}>
              {shown.map((it) => (
                <CreationCard key={`${it.kind}:${it.id}`} item={it} />
              ))}
            </ul>
          ) : (
            <CreationTable items={shown} />
          )}

          <p className="px-1 text-xs leading-relaxed text-muted-foreground">{t('atelier.footer')}</p>
        </div>
      )}
    </Page>
  )
}

/** "2 creations are waiting for your approval", their names, Review (the first one). */
function PendingBanner({ items }: { items: AtelierItem[] }) {
  const t = useT()
  return (
    <section aria-label={t('atelier.banner.label')} className="flex flex-wrap items-center gap-3 rounded-xl border border-draft/30 bg-draft/8 px-4 py-3 max-md:px-3" data-testid="atelier-pending">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-draft/15 text-draft">
        <WandSparkles className="size-4.5" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm font-semibold">{t('atelier.banner.title', { count: items.length })}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          <Sensitive length={18}>{items.map((d) => d.name).join(' · ')}</Sensitive>
        </p>
      </div>
      <Button size="sm" variant="outline" asChild className="border-draft/40 text-draft hover:bg-draft/10 hover:text-draft max-md:w-full">
        <Link to={itemHref(items[0])}>{t('atelier.review')}</Link>
      </Button>
    </section>
  )
}

function FilterChips({ value, counts, onChange, className }: { value: Filter; counts: Record<Filter, number>; onChange: (f: Filter) => void; className?: string }) {
  const t = useT()
  const ids = (['all', ...Object.keys(FILTERS)] as Filter[]).filter((f) => !OPTIONAL.has(f) || counts[f] > 0 || value === f)
  return (
    <div role="group" aria-label={t('atelier.filters')} className={cn('flex flex-wrap gap-1.5', className)}>
      {ids.map((id) => {
        const on = value === id
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:h-10 max-md:px-3.5 max-md:text-[13px] pointer-coarse:h-10',
              on ? 'bg-foreground font-semibold text-background' : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {t(`atelier.filter.${id}` as TKey)}
            <span className={cn('tabular-nums', on ? 'text-background/70' : 'text-muted-foreground/80')}>{counts[id]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Name, then what it does (or its error); "changed outside the Studio" when its files moved without a review. */
function NameCell({ item: it, clamp }: { item: AtelierItem; clamp?: boolean }) {
  const t = useT()
  const summary = rowSummary(it)
  const broken = it.state === 'error' && !it.pending && !!it.error
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <Link to={itemHref(it)} className="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none">
          <Sensitive length={14}>{it.name}</Sensitive>
        </Link>
        {it.unreviewed && (
          <Tooltip content={t('atelier.unreviewedHint')}>
            <Badge variant="warning" className="shrink-0">
              {t('atelier.unreviewed')}
            </Badge>
          </Tooltip>
        )}
      </span>
      <p className={cn('text-[13px]', clamp ? 'line-clamp-2' : 'truncate', broken ? 'font-mono text-xs text-destructive' : 'text-muted-foreground')}>
        {summary ? <Sensitive length={24}>{summary}</Sensitive> : typeLabel(t, it.type)}
      </p>
    </div>
  )
}

function CreationTable({ items }: { items: AtelierItem[] }) {
  const t = useT()
  const navigate = useNavigate()
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full table-fixed border-collapse text-sm" aria-label={t('nav.atelier')}>
        <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-14 py-2 pl-4 font-medium">
              <span className="sr-only">{t('atelier.col.type')}</span>
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">{t('atelier.col.name')}</th>
            <th scope="col" className="w-[13.5rem] py-2 pr-4 font-medium">{t('atelier.col.state')}</th>
            <th scope="col" className="w-56 py-2 pr-4 font-medium max-lg:hidden">{t('atelier.col.origin')}</th>
            <th scope="col" className="w-16 py-2 pr-4 font-medium">{t('atelier.col.version')}</th>
            <th scope="col" className="w-40 py-2 pr-4 text-right font-medium">
              <span className="sr-only">{t('atelier.col.action')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((it) => (
            <tr
              key={`${it.kind}:${it.id}`}
              onClick={(e) => {
                // the row opens the creation; its links, buttons and menu keep their own action
                if ((e.target as HTMLElement).closest('a,button,[role=menuitem]')) return
                navigate(itemHref(it))
              }}
              className={cn('cursor-pointer transition-colors hover:bg-accent/50', it.pending && 'bg-draft/5 hover:bg-draft/10')}
              data-state={pillState(it)}
            >
              <td className="py-3 pl-4 align-middle">
                <TypeTile type={it.type} pending={!!it.pending} />
              </td>
              <td className="py-3 pr-4 align-middle">
                <NameCell item={it} />
              </td>
              <td className="py-3 pr-4 align-middle">
                <StatePill state={pillState(it)} />
              </td>
              <td className="py-3 pr-4 align-middle max-lg:hidden">
                <Origin origin={rowOrigin(it)} />
              </td>
              <td className="py-3 pr-4 align-middle">
                <VersionTag version={it.version} label={it.version_label} />
              </td>
              <td className="py-3 pr-4 text-right align-middle">
                <RowAction item={it} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CreationCard({ item: it }: { item: AtelierItem }) {
  return (
    <li className={cn('grid gap-3 rounded-xl border bg-card p-3.5', it.pending && 'border-draft/30 bg-draft/5')} data-state={pillState(it)}>
      <div className="flex items-start gap-3">
        <TypeTile type={it.type} pending={!!it.pending} />
        <div className="min-w-0 flex-1">
          <NameCell item={it} clamp />
        </div>
        {it.version != null && <VersionTag version={it.version} label={it.version_label} className="pt-0.5" />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatePill state={pillState(it)} />
        <Origin origin={rowOrigin(it)} className="min-w-0 flex-1" />
        {!it.pending && it.state !== 'error' && it.state !== 'review' && <RowAction item={it} />}
      </div>
      {(it.pending || it.state === 'error' || it.state === 'review') && <RowAction item={it} wide />}
    </li>
  )
}

function ListSkeleton({ touch }: { touch: boolean }) {
  return (
    <div className="grid gap-4" aria-busy>
      <div className="flex flex-wrap items-center gap-1.5">
        {[64, 84, 64, 64, 72, 64, 120].map((w, i) => (
          <Skeleton key={i} className="h-7 rounded-full max-md:h-10" style={{ width: w }} />
        ))}
        <Skeleton className="ml-auto h-8 w-64 max-sm:w-full" />
      </div>
      {touch ? (
        <div className="grid gap-2.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Skeleton className="h-9 rounded-none" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex h-[65px] items-center gap-4 border-t px-4">
              <Skeleton className="size-9 rounded-lg" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-6 w-24 rounded-full" />
              <Skeleton className="h-8 w-40 max-lg:hidden" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="h-8 w-24" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
