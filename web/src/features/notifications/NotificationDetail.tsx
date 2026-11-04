// One notification in full (the Notifications page): level, origin, date, title, its actions + "Ask harness-pilot",
// "Mark as handled", "Mark as read", delete; the facts it carries; its text (a cron's output, Claude's last
// answer...); the occurrences folded into it.
import * as React from 'react'
import { BellOff, MessageSquarePlus, Trash2 } from 'lucide-react'
import { useDeleteFeedEvent, useFeedEvent, useResolveFeed } from '@/lib/queries'
import { categoryOf, isPending } from '@/lib/feed'
import { fmtDuration } from '@/lib/format'
import type { FeedEvent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge, Button, EmptyState, Sensitive, Tooltip } from '@/components/ui'
import { topicLabel } from '@/pages/sessions/util'
import { LEVEL_STYLE, LevelBadge } from './LevelIcon'
import { NotificationActions } from './NotificationActions'
import { useNotificationActions } from './useNotificationActions'
import { eventSummary, eventTitle, useEventText } from './text'

function Facts({ ev }: { ev: FeedEvent }) {
  const x = useEventText()
  const t = x.t
  const p = ev.params || {}
  const rows: [string, React.ReactNode][] = [[t('ncentre.meta.source'), ev.source]]
  if (typeof p.path === 'string') rows.push([t('ncentre.meta.where'), topicLabel(p.path, '~')])
  if (p.code != null) rows.push([t('ncentre.meta.code'), String(p.code)])
  if (typeof p.duration_s === 'number') rows.push([t('ncentre.meta.duration'), fmtDuration(p.duration_s)])
  if (ev.count > 1) {
    rows.push([t('ncentre.meta.count'), String(ev.count)])
    if (ev.first_at) rows.push([t('ncentre.meta.first'), x.date(ev.first_at)])
  }
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 rounded-xl border bg-card px-4.5 py-4 max-sm:grid-cols-1">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="mt-0.5 truncate">
            <Sensitive length={8}>{v}</Sensitive>
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function NotificationDetail({ ev, onDeleted }: { ev: FeedEvent; onDeleted?: () => void }) {
  const x = useEventText()
  const t = x.t
  const { data: detail } = useFeedEvent(ev.id)
  const e: FeedEvent = detail ? { ...ev, ...detail } : ev
  const occurrences = detail?.occurrences ?? []
  const actions = useNotificationActions()
  const resolve = useResolveFeed()
  const del = useDeleteFeedEvent()
  const pending = isPending(e)
  const title = eventTitle(t, e)
  const summary = eventSummary(t, e)
  const output = categoryOf(e) === 'crons'
  const body = e.body.trim()

  return (
    <article aria-labelledby="mx-notification-title" className="grid min-w-0 content-start gap-5" data-testid="notification-detail">
      <div className="grid gap-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <LevelBadge level={e.level} />
          <Badge variant="outline" className="h-6 px-2 font-normal">
            <Sensitive length={8}>{x.origin(e)}</Sensitive>
          </Badge>
          {e.resolved_at && (
            <Badge variant="success" className="h-6 px-2">
              {t('ncentre.resolved')}
            </Badge>
          )}
          <span className="text-muted-foreground">
            {x.date(e.at)} · {x.when(e.at)}
          </span>
        </div>
        <h2 id="mx-notification-title" className="text-xl leading-snug font-semibold tracking-tight break-words">
          <Sensitive length={16}>{title}</Sensitive>
        </h2>
        {summary && summary !== body && (
          <p className="text-muted-foreground">
            <Sensitive length={16}>{summary}</Sensitive>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NotificationActions ev={e} layout="detail" />
        <Button variant="outline" onClick={() => actions.ask(e)}>
          <MessageSquarePlus /> {t('ncentre.ask')}
        </Button>
        {pending && e.kind !== undefined && (
          <Button variant="ghost" onClick={() => resolve.mutate([e.id])} loading={resolve.isPending}>
            {t('ncentre.resolve')}
          </Button>
        )}
        {!e.read && (
          <Button variant="ghost" onClick={() => actions.markRead(e)}>
            {t('ncentre.markRead')}
          </Button>
        )}
        <Tooltip content={t('common.delete')}>
          <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label={t('common.delete')} loading={del.isPending} onClick={() => del.mutate(e.id, { onSuccess: onDeleted })}>
            <Trash2 />
          </Button>
        </Tooltip>
      </div>

      <Facts ev={e} />

      {body && (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{output ? t('ncentre.output') : t('ncentre.message')}</h3>
          {output ? (
            <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
              <Sensitive block>{body}</Sensitive>
            </pre>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-line break-words">
              <Sensitive block>{body}</Sensitive>
            </p>
          )}
        </section>
      )}

      {occurrences.length > 1 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">
            {t('ncentre.occurrences')} <span className="font-normal text-muted-foreground">· {e.count}</span>
          </h3>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {occurrences.map((o, i) => {
              const sub = { ...e, ...o, params: o.params ?? e.params }
              const d = sub.params?.duration_s
              return (
                <li key={`${o.at}-${i}`} className="flex min-w-0 items-start gap-3 px-4 py-2.5 text-sm">
                  <span aria-hidden className={cn('mt-[7px] size-[7px] shrink-0 rounded-full bg-current', LEVEL_STYLE[e.level].text)} />
                  <span className="min-w-12 shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">{x.date(o.at, { dateStyle: undefined, timeStyle: 'short' })}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <Sensitive length={12}>{eventSummary(t, sub) || eventTitle(t, sub)}</Sensitive>
                  </span>
                  {typeof d === 'number' && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDuration(d)}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </article>
  )
}

export function NotificationMissing() {
  const t = useEventText().t
  return <EmptyState icon={BellOff} title={t('ncentre.notFound')} description={t('ncentre.notFoundDesc')} />
}
