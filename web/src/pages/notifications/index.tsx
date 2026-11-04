// /notifications - every notification of the last 30 days. URL = state: ?filter=all|pending|<category>, ?unread=1,
// ?id=<event>. Desktop: chips + "Unread only", the list by day on the left, the selected one on the right.
// Touch layout: "To handle" / "All" tabs and cards with 44 px buttons; a card opens the event full screen.
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ArrowLeft, CheckCheck, SlidersHorizontal } from 'lucide-react'
import { useFeedEvent, useFeedPages, useFeedSummary, useMarkFeedRead } from '@/lib/queries'
import { byNewest, isPending } from '@/lib/feed'
import type { FeedEvent } from '@/lib/types'
import { useT } from '@/i18n'
import { useCompact } from '@/stores/media'
import { Button, Segmented, Switch, Tooltip } from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { FilterChips, parseFilter, type NotificationFilter } from '@/features/notifications/FilterChips'
import { NotificationItem, NotificationSkeleton } from '@/features/notifications/NotificationItem'
import { AllHandled, NoNotifications, NotificationSections } from '@/features/notifications/NotificationList'
import { NotificationDetail, NotificationMissing } from '@/features/notifications/NotificationDetail'
import { useNotificationActions } from '@/features/notifications/useNotificationActions'

function useEvents(filter: NotificationFilter, unread: boolean) {
  const f = filter === 'all' ? { unread } : filter === 'pending' ? { pending: true, unread } : { category: filter, unread }
  const pages = useFeedPages(f)
  // by time: a folded row moves up with its latest occurrence (the server orders by id)
  const events = React.useMemo(() => (pages.data?.pages.flatMap((p) => p.events) ?? []).sort(byNewest), [pages.data])
  return { pages, events }
}

function MoreButton({ pages }: { pages: ReturnType<typeof useFeedPages> }) {
  const t = useT()
  if (!pages.hasNextPage) return null
  return (
    <div className="flex justify-center p-2">
      <Button variant="ghost" size="sm" loading={pages.isFetchingNextPage} onClick={() => pages.fetchNextPage()}>
        {t('feed.more')}
      </Button>
    </div>
  )
}

export default function NotificationsPage() {
  const t = useT()
  const touch = useCompact()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data: summary } = useFeedSummary()
  const read = useMarkFeedRead()
  const actions = useNotificationActions()
  const filter = params.has('filter') ? parseFilter(params.get('filter')) : touch ? 'pending' : 'all'
  const unread = params.get('unread') === '1'
  const id = Number(params.get('id')) || null
  const { pages, events } = useEvents(filter, unread && !touch)

  const set = (patch: Record<string, string | null>, replace = false) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) v == null ? p.delete(k) : p.set(k, v)
    setParams(p, { replace })
  }
  // A notification opened (clicked, or a link to it): it is read.
  const listed = id != null ? events.find((e) => e.id === id) : undefined
  const { data: fetched, isPending: fetching } = useFeedEvent(id, id != null && !listed && !pages.isPending)
  const opened: FeedEvent | undefined = listed ?? fetched ?? undefined
  React.useEffect(() => {
    if (opened && !opened.read) actions.markRead(opened)
  }, [opened?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Desktop: the first one is shown while nothing is picked (not marked read: nobody opened it).
  const shown = opened ?? (!touch && id == null ? events[0] : undefined)
  const select = (ev: FeedEvent) => set({ id: String(ev.id) })

  const markAll = (
    <Tooltip content={touch ? t('feed.markAllRead') : null}>
      <Button variant="outline" size={touch ? 'icon' : 'sm'} disabled={!summary?.unread} onClick={() => read.mutate({ all: true })} aria-label={t('feed.markAllRead')}>
        <CheckCheck /> {!touch && t('feed.markAllRead')}
      </Button>
    </Tooltip>
  )
  const settings = (
    <Tooltip content={t('feed.settings')}>
      <Button variant="outline" size="icon-sm" onClick={() => navigate('/settings/notifications')} aria-label={t('feed.settings')} className="max-md:hidden">
        <SlidersHorizontal />
      </Button>
    </Tooltip>
  )

  // ---- touch layout: one event full screen
  if (touch && id != null)
    return (
      <Page
        title={t('feed.title')}
        leading={
          <Button variant="ghost" size="icon" onClick={() => (window.history.length > 1 ? navigate(-1) : set({ id: null }))} aria-label={t('feed.back')}>
            <ArrowLeft />
          </Button>
        }
        width="narrow"
      >
        {opened ? <NotificationDetail ev={opened} onDeleted={() => set({ id: null }, true)} /> : fetching || pages.isPending ? <NotificationSkeleton rows={3} /> : <NotificationMissing />}
      </Page>
    )

  // ---- touch layout: tabs and cards
  if (touch) {
    const tab = filter === 'pending' ? 'pending' : 'all'
    const pending = tab === 'all' ? events.filter(isPending) : []
    const activity = tab === 'all' ? events.filter((e) => !isPending(e)) : events
    const card = (ev: FeedEvent) => <NotificationItem key={ev.id} ev={ev} variant="card" onSelect={select} />
    return (
      <Page title={t('feed.title')} actions={markAll} width="narrow" bodyClassName="max-md:px-3 max-md:pt-2">
        <Segmented
          value={tab}
          onChange={(k) => set({ filter: k, id: null }, true)}
          aria-label={t('feed.filters')}
          className="mb-3 grid w-full grid-cols-2"
          options={[
            {
              value: 'pending',
              label: (
                <>
                  {t('feed.pending')}
                  {!!summary?.pending && (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[11px] font-semibold text-destructive-foreground tabular-nums">{summary.pending}</span>
                  )}
                </>
              ),
            },
            { value: 'all', label: t('feed.all') },
          ]}
        />
        <div className="grid gap-2.5">
          {pages.isPending ? (
            <NotificationSkeleton rows={4} variant="card" />
          ) : !events.length ? (
            tab === 'pending' ? <AllHandled /> : <NoNotifications />
          ) : tab === 'pending' ? (
            events.map(card)
          ) : (
            <NotificationSections pending={pending} activity={activity} renderItem={card} itemsClassName="grid gap-2.5" pendingCount={summary?.pending} />
          )}
          <MoreButton pages={pages} />
        </div>
        <Button variant="outline" className="mt-4 h-12 w-full max-md:h-12" onClick={() => navigate('/settings/notifications')}>
          <SlidersHorizontal /> {t('feed.settings')}
        </Button>
      </Page>
    )
  }

  // ---- desktop: chips, list, detail
  return (
    <Page
      title={t('feed.title')}
      description={t('feed.pageDesc')}
      actions={
        <>
          {markAll}
          {settings}
        </>
      }
      width="wide"
    >
      <div className="mb-4 flex flex-wrap items-center gap-3 border-b pb-4">
        <FilterChips value={filter} onChange={(f) => set({ filter: f === 'all' ? null : f, id: null })} withPending pendingCount={summary?.pending} />
        <label className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
          <Switch checked={unread} onCheckedChange={(v) => set({ unread: v ? '1' : null, id: null })} aria-label={t('feed.unreadOnly')} />
          {t('feed.unreadOnly')}
        </label>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(320px,440px)_minmax(0,1fr)]">
        <section aria-label={t('feed.title')} className="min-w-0 lg:border-r lg:pr-4">
          {pages.isPending ? (
            <NotificationSkeleton rows={8} variant="list" />
          ) : !events.length ? (
            filter === 'pending' ? <AllHandled /> : <NoNotifications filtered={filter !== 'all' || unread} />
          ) : (
            <NotificationSections
              pending={[]}
              activity={events}
              itemsClassName="grid gap-0.5"
              renderItem={(ev) => <NotificationItem key={ev.id} ev={ev} variant="list" selected={shown?.id === ev.id} onSelect={select} />}
            />
          )}
          <MoreButton pages={pages} />
          {filter === 'pending' && <p className="px-2 pt-3 text-xs leading-relaxed text-muted-foreground">{t('feed.pendingHint')}</p>}
        </section>
        <div className="min-w-0 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)]">
          {shown ? (
            <NotificationDetail key={shown.id} ev={shown} onDeleted={() => set({ id: null }, true)} />
          ) : id != null && !fetching && !pages.isPending ? (
            <NotificationMissing />
          ) : events.length ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t('feed.pick')}</p>
          ) : null}
        </div>
      </div>
    </Page>
  )
}
