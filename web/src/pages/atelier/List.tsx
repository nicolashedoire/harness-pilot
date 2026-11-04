// The Atelier list: the drafts waiting for the user on top (banner), filter chips by kind with their counts, a text
// filter, then every creation with its state, where it comes from, its version and the next thing to do with it.
// Desktop: a table. Touch layout: one card per creation.
import * as React from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { History, Search, TriangleAlert, WandSparkles, X } from 'lucide-react'
import { useAtelier } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import type { AtelierItem, AtelierKind } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { useCompact } from '@/stores/media'
import { Button, EmptyState, Input, Sensitive, Skeleton, Tooltip } from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { ATELIER_KINDS, KindTile, Origin, StatePill, VersionTag, kindLabel } from '@/features/atelier/parts'
import { RowAction } from './RowAction'
import { createHref, itemHref } from './links'

type Filter = 'all' | AtelierKind
const parseKind = (v: string | null): Filter => (ATELIER_KINDS.includes(v as AtelierKind) ? (v as AtelierKind) : 'all')

/** Case and accents ignored. */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Drafts first (oldest waiting first), then broken ones, then the rest by name. */
const RANK: Record<string, number> = { draft: 0, error: 1, review: 2 }
function byAttention(a: AtelierItem, b: AtelierItem) {
  const ra = RANK[a.state] ?? 3, rb = RANK[b.state] ?? 3
  if (ra !== rb) return ra - rb
  if (ra === 0) return (a.origin?.at ?? 0) - (b.origin?.at ?? 0)
  return a.name.localeCompare(b.name)
}

export function AtelierList() {
  const t = useT()
  const touch = useCompact()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const kind = parseKind(params.get('kind'))
  const q = params.get('q') ?? ''
  const { data, isPending, isError, error, refetch, isFetching } = useAtelier()

  const items = React.useMemo(() => [...(data?.items ?? [])].sort(byAttention), [data])
  const counts = React.useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: items.length }
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1
    return c
  }, [items])
  const drafts = items.filter((it) => it.state === 'draft' || it.draft_id)
  const needle = fold(q.trim())
  const shown = items.filter(
    (it) => (kind === 'all' || it.kind === kind) && (!needle || fold(`${it.name} ${it.description} ${it.origin?.session_title ?? ''}`).includes(needle)),
  )

  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) v == null || v === '' ? p.delete(k) : p.set(k, v)
    setParams(p, { replace: true })
  }

  const actions = (
    <>
      <Tooltip content={touch ? t('atelier.history') : null}>
        <Button variant="outline" size={touch ? 'icon' : 'sm'} onClick={() => navigate('/atelier/history')} aria-label={t('atelier.history')}>
          <History />
          <span className="max-md:hidden">{t('atelier.history')}</span>
        </Button>
      </Tooltip>
      <Tooltip content={touch ? t('atelier.create') : null}>
        <Button size={touch ? 'icon' : 'sm'} onClick={() => navigate(createHref(t('atelier.createPrompt')))} aria-label={t('atelier.create')} data-testid="atelier-create">
          <WandSparkles />
          <span className="max-md:hidden">{t('atelier.create')}</span>
        </Button>
      </Tooltip>
    </>
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
            <Button onClick={() => navigate(createHref(t('atelier.createPrompt')))}>
              <WandSparkles /> {t('atelier.create')}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {drafts.length > 0 && <PendingBanner drafts={drafts} />}

          <div className="flex flex-wrap items-center gap-3">
            <KindChips value={kind} counts={counts} onChange={(k) => set({ kind: k === 'all' ? null : k })} className="max-md:-mx-3 max-md:w-[calc(100%+1.5rem)] max-md:flex-nowrap max-md:overflow-x-auto max-md:px-3 max-md:pb-1" />
            <div className="relative ml-auto w-full sm:w-64">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => set({ q: e.target.value })} placeholder={t('atelier.filter')} aria-label={t('atelier.filter')} className="h-8 pl-8 max-md:h-10" />
              {q && (
                <button type="button" onClick={() => set({ q: null })} aria-label={t('atelier.clearFilter')} className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
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

/** "2 creations are waiting for your validation", their names, Review (the first one). */
function PendingBanner({ drafts }: { drafts: AtelierItem[] }) {
  const t = useT()
  const first = drafts[0]
  return (
    <section aria-label={t('atelier.banner.label')} className="flex flex-wrap items-center gap-3 rounded-xl border border-draft/30 bg-draft/8 px-4 py-3 max-md:px-3" data-testid="atelier-pending">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-draft/15 text-draft">
        <WandSparkles className="size-4.5" />
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-sm font-semibold">{t('atelier.banner.title', { count: drafts.length })}</p>
        <p className="truncate text-[13px] text-muted-foreground">
          <Sensitive length={18}>{drafts.map((d) => d.name).join(' · ')}</Sensitive>
        </p>
      </div>
      <Button size="sm" variant="outline" asChild className="border-draft/40 text-draft hover:bg-draft/10 hover:text-draft max-md:w-full">
        <Link to={itemHref(first)}>{t('atelier.review')}</Link>
      </Button>
    </section>
  )
}

function KindChips({ value, counts, onChange, className }: { value: Filter; counts: Partial<Record<Filter, number>>; onChange: (f: Filter) => void; className?: string }) {
  const t = useT()
  const chips: { id: Filter; label: string }[] = [{ id: 'all', label: t('atelier.kind.all') }, ...ATELIER_KINDS.map((k) => ({ id: k, label: kindLabel(t, k, true) }))]
  return (
    <div role="group" aria-label={t('atelier.kinds')} className={cn('flex flex-wrap gap-1.5', className)}>
      {chips.map((c) => {
        const on = value === c.id
        const n = counts[c.id] ?? 0
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(c.id)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-md:h-10 max-md:px-3.5 max-md:text-[13px] pointer-coarse:h-10',
              on ? 'bg-foreground font-semibold text-background' : 'border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {c.label}
            <span className={cn('tabular-nums', on ? 'text-background/70' : 'text-muted-foreground/80')}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

const pendingRow = (it: AtelierItem) => it.state === 'draft' || !!it.draft_id

function CreationTable({ items }: { items: AtelierItem[] }) {
  const t = useT()
  const navigate = useNavigate()
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full table-fixed border-collapse text-sm" aria-label={t('nav.atelier')}>
        <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-14 py-2 pl-4 font-medium">
              <span className="sr-only">{t('atelier.col.kind')}</span>
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">{t('atelier.col.name')}</th>
            <th scope="col" className="w-[13.5rem] py-2 pr-4 font-medium">{t('atelier.col.state')}</th>
            <th scope="col" className="w-56 py-2 pr-4 font-medium max-lg:hidden">{t('atelier.col.origin')}</th>
            <th scope="col" className="w-16 py-2 pr-4 font-medium">{t('atelier.col.version')}</th>
            <th scope="col" className="w-36 py-2 pr-4 text-right font-medium">
              <span className="sr-only">{t('atelier.col.action')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((it) => (
            <tr
              key={`${it.kind}:${it.id}`}
              onClick={(e) => {
                // the row opens the creation; its links and buttons keep their own action
                if ((e.target as HTMLElement).closest('a,button,[role=menuitem]')) return
                navigate(itemHref(it))
              }}
              className={cn('cursor-pointer transition-colors hover:bg-accent/50', pendingRow(it) && 'bg-draft/5 hover:bg-draft/10')}
              data-state={it.state}
            >
              <td className="py-3 pl-4 align-middle">
                <KindTile kind={it.kind} className={cn(pendingRow(it) && 'border-draft/30 bg-draft/10 text-draft')} />
              </td>
              <td className="min-w-0 py-3 pr-4 align-middle">
                <Link to={itemHref(it)} className="block truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none">
                  <Sensitive length={14}>{it.name}</Sensitive>
                </Link>
                {it.description && (
                  <p className="truncate text-[13px] text-muted-foreground">
                    <Sensitive length={24}>{it.description}</Sensitive>
                  </p>
                )}
              </td>
              <td className="py-3 pr-4 align-middle">
                <StatePill state={it.state} className="max-w-full [&>span:last-child]:truncate" />
              </td>
              <td className="py-3 pr-4 align-middle max-lg:hidden">
                <Origin origin={it.origin} />
              </td>
              <td className="py-3 pr-4 align-middle">
                <VersionTag version={it.version} />
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
    <li className={cn('grid gap-3 rounded-xl border bg-card p-3.5', pendingRow(it) && 'border-draft/30 bg-draft/5')} data-state={it.state}>
      <div className="flex items-start gap-3">
        <KindTile kind={it.kind} className={cn(pendingRow(it) && 'border-draft/30 bg-draft/10 text-draft')} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <Link to={itemHref(it)} className="flex min-w-0 items-baseline gap-2 font-medium">
            <span className="truncate">
              <Sensitive length={14}>{it.name}</Sensitive>
            </span>
            <VersionTag version={it.version} />
          </Link>
          {it.description && (
            <p className="line-clamp-2 text-[13px] text-muted-foreground">
              <Sensitive length={24}>{it.description}</Sensitive>
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatePill state={it.state} />
        <Origin origin={it.origin} className="min-w-0 flex-1" />
      </div>
      <div className="flex justify-end empty:hidden">
        <RowAction item={it} wide />
      </div>
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
