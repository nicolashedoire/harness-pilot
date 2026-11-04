// /atelier/<kind>/<id> - one creation (GET /api/atelier/{kind}/{id}): its state, what to do when it is broken (ask the
// agent for a fix, or go back to the last version that worked), what it does and asks for, and its versions. Themes,
// skills, customizations and cron jobs are not versioned here: their page says where they are managed.
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, ChevronRight, Ellipsis, ExternalLink, FileCheck2, History, MessageSquarePlus, Power, PowerOff, SearchX, TriangleAlert, Undo2, WandSparkles } from 'lucide-react'
import { errorMessage, isApiError } from '@/lib/api'
import { useAcceptChanges, useAtelierItem, useAtelierSettings, useExtensions, useRollback, useToggleCreation } from '@/lib/queries'
import type { AtelierError, AtelierEvent, AtelierItem, AtelierItemDetail, AtelierVersion, Extension } from '@/lib/types'
import { fmtBytes, fmtDate, fmtRelative } from '@/lib/format'
import { useLang, useT, type TKey } from '@/i18n'
import { useCompact } from '@/stores/media'
import {
  Button,
  confirm,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Sensitive,
  Skeleton,
  SkeletonText,
  toast,
  useMask,
} from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { AskFixButton, FixTarget } from '@/features/extensions/AskFix'
import { Origin, StatePill, TypeTile, VersionTag, pillState, typeLabel } from '@/features/atelier/parts'
import { PermissionRows } from '@/features/atelier/Permissions'
import { AccessBlock } from '@/features/atelier/Access'
import { VersionTimeline } from '@/features/atelier/Versions'
import { draftHref, liveHref } from './links'
import { useAskChange } from './RowAction'

const KINDS = new Set(['extension', 'theme', 'skill', 'customization', 'cron'])

export function CreationDetail() {
  const t = useT()
  const touch = useCompact()
  const navigate = useNavigate()
  const { kind = '', id = '' } = useParams()
  const { data, isPending, isError, error, refetch, isFetching } = useAtelierItem(kind, id)
  const back = (
    <Button variant="ghost" size="icon" onClick={() => navigate('/atelier')} aria-label={t('atelier.backToList')}>
      <ArrowLeft />
    </Button>
  )
  const page = (body: React.ReactNode, width: 'wide' | 'narrow' = 'wide') => (
    <Page title={t('nav.atelier')} leading={touch ? back : undefined} width={width} bodyClassName="max-md:px-3 max-md:pt-3">
      {body}
    </Page>
  )
  if (!KINDS.has(kind) || (isError && isApiError(error, 'not_found')))
    return page(
      <EmptyState
        icon={SearchX}
        title={t('atelier.missing')}
        description={t('atelier.missingDesc')}
        action={
          <Button variant="outline" asChild>
            <Link to="/atelier">{t('atelier.backToList')}</Link>
          </Button>
        }
      />,
      'narrow',
    )
  if (isPending) return page(<DetailSkeleton />)
  if (isError || !data)
    return page(
      <EmptyState
        tone="error"
        icon={TriangleAlert}
        title={t('atelier.detail.loadFailed')}
        description={errorMessage(error)}
        action={
          <Button variant="outline" loading={isFetching} onClick={() => refetch()}>
            {t('common.retry')}
          </Button>
        }
      />,
      'narrow',
    )
  return page(<DetailBody detail={data} />)
}

function DetailBody({ detail }: { detail: AtelierItemDetail }) {
  const t = useT()
  const { item: it, versions } = detail
  const rollback = useRollback()
  const { data: settings } = useAtelierSettings()
  const { data: exts } = useExtensions()
  const ext = it.kind === 'extension' ? exts?.find((e) => e.id === it.id) : undefined
  const error = it.error ?? detail.health.error
  const versioned = it.kind === 'extension'
  const canRollback = versioned && it.actions.includes('rollback')
  /** The newest older version that worked: where "Back to vN" goes. */
  const lastGood = versions.find((v) => !v.active && v.health === 'ok' && v.restorable) ?? null

  const doRollback = async (v: AtelierVersion) => {
    const active = versions.find((x) => x.active)?.n
    const ok = await confirm({
      title: t('atelier.rollback.title', { n: v.n }),
      description: active ? t('atelier.rollback.desc', { n: v.n, active }) : t('atelier.rollback.descNone', { n: v.n }),
      confirmText: t('atelier.rollback.confirm', { n: v.n }),
    })
    if (!ok) return
    rollback.mutate({ kind: it.kind, id: it.id, version: v.n }, { onSuccess: () => toast.success(t('atelier.rollback.done', { name: it.name, n: v.n })) })
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <DetailHeader item={it} />
      <Notices item={it} detail={detail} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          {error && it.state === 'error' && (
            <ErrorCard
              item={it}
              error={error}
              ext={ext}
              lastGood={canRollback ? lastGood : null}
              rollingBack={rollback.isPending ? (rollback.variables?.version ?? null) : null}
              onRollback={doRollback}
            />
          )}

          <section className="grid gap-2" aria-labelledby="atelier-about-title">
            <h3 id="atelier-about-title" className="text-sm font-semibold">
              {t('atelier.review.summary')}
            </h3>
            {it.origin?.summary ? (
              <Sensitive block>
                <p className="text-sm leading-relaxed whitespace-pre-line">{it.origin.summary}</p>
              </Sensitive>
            ) : (
              <p className="text-sm text-muted-foreground">{t('atelier.review.noSummary')}</p>
            )}
            <Origin origin={it.origin} withDate className="mt-1" />
          </section>

          {(detail.permissions || ext?.access) && (
            <section className="grid gap-3" aria-labelledby="atelier-asks-title">
              <h3 id="atelier-asks-title" className="text-sm font-semibold">
                {t('atelier.review.asks')}
              </h3>
              {detail.permissions && <PermissionRows permissions={detail.permissions} />}
              {ext?.access && <AccessBlock ext={ext} />}
            </section>
          )}

          {detail.files.length > 0 && (
            <section className="grid gap-3" aria-labelledby="atelier-files-title">
              <h3 id="atelier-files-title" className="text-sm font-semibold">
                {t('atelier.files.title')} · <span className="font-normal text-muted-foreground">{t('atelier.detail.filesOf', { n: it.version ?? 0, count: detail.files.length })}</span>
              </h3>
              <ul className="grid overflow-hidden rounded-lg border">
                {detail.files.map((f) => (
                  <li key={f.path} className="flex min-h-9 items-center gap-2.5 border-b px-3 py-1.5 text-[13px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      <Sensitive length={14}>{f.path}</Sensitive>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <section className="grid gap-4" aria-labelledby="atelier-versions-title">
            <h3 id="atelier-versions-title" className="text-sm font-semibold">
              {t('atelier.v.title')}
            </h3>
            {versions.length ? (
              <div className="rounded-xl border bg-card p-4">
                <VersionTimeline
                  kind={it.kind}
                  id={it.id}
                  versions={versions}
                  canRollback={canRollback}
                  rollingBack={rollback.isPending ? (rollback.variables?.version ?? null) : null}
                  onRollback={doRollback}
                />
              </div>
            ) : (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-[13px] text-muted-foreground">
                {versioned ? t('atelier.v.none') : t(`atelier.v.notVersioned.${it.kind}` as TKey)}
              </p>
            )}
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <History className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {versioned ? t('atelier.v.survives') : t('atelier.v.survivesOther')}
                {versioned && settings && <> {t('atelier.v.keep', { days: settings.keep_days, count: settings.keep_versions })}</>}
              </span>
            </p>
          </section>
          {detail.history.length > 0 && <HistoryList events={detail.history} />}
        </div>
      </div>
    </div>
  )
}

/** Breadcrumb, name, state, version; Open, Disable / Turn on and a "…" menu. */
function DetailHeader({ item: it }: { item: AtelierItem }) {
  const t = useT()
  const mask = useMask()
  const navigate = useNavigate()
  const toggle = useToggleCreation()
  const accept = useAccept(it)
  const askChange = useAskChange()
  const live = liveHref(it)
  const canToggle = it.kind === 'extension' && (it.actions.includes('disable') || it.actions.includes('enable'))
  const on = it.actions.includes('disable')
  return (
    <header className="grid gap-3">
      <nav aria-label={t('atelier.review.breadcrumb')} className="flex items-center gap-1 text-[13px] text-muted-foreground">
        <Link to="/atelier" className="hover:text-foreground hover:underline">
          {t('nav.atelier')}
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span aria-current="page">{typeLabel(t, it.type)}</span>
      </nav>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <TypeTile type={it.type} pending={!!it.pending} />
        <h2 className="min-w-0 text-xl font-semibold tracking-tight break-words">
          <Sensitive length={12}>{it.name}</Sensitive>
        </h2>
        <StatePill state={pillState({ ...it, pending: null })} />
        <VersionTag version={it.version} label={it.version_label} />
        {it.version_label && <span className="font-mono text-xs text-muted-foreground/70">{it.version_label}</span>}
        <div className="ml-auto flex items-center gap-2 max-sm:w-full">
          {live && (
            <Button variant="outline" size="sm" onClick={() => navigate(live)} className="max-sm:flex-1">
              <ExternalLink /> {t('atelier.open')}
            </Button>
          )}
          {canToggle && (
            <Button variant="outline" size="sm" loading={toggle.isPending} onClick={() => toggle.mutate({ id: it.id, enabled: !on })} className="max-sm:flex-1">
              {on ? <PowerOff /> : <Power />} {on ? t('atelier.disable') : t('atelier.enable')}
            </Button>
          )}
          {it.kind === 'extension' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('atelier.more', { name: mask(it.name, 8) })}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => askChange(it)}>
                  <MessageSquarePlus /> {t('atelier.askChange')}
                </DropdownMenuItem>
                {it.unreviewed && (
                  <DropdownMenuItem onSelect={() => void accept.run()}>
                    <FileCheck2 /> {t('atelier.accept.action')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  )
}

/** Accept files changed outside the Atelier as a new version (asks first). */
function useAccept(it: AtelierItem) {
  const t = useT()
  const accept = useAcceptChanges()
  return {
    pending: accept.isPending,
    run: async () => {
      const ok = await confirm({ title: t('atelier.accept.title'), description: t('atelier.accept.desc'), confirmText: t('atelier.accept.action') })
      if (ok) accept.mutate({ kind: it.kind, id: it.id }, { onSuccess: (r) => toast.success(t('atelier.accept.done', { n: r.version })) })
    },
  }
}

/** A draft waiting, files changed outside the Atelier, a conflict after an update. */
function Notices({ item: it, detail }: { item: AtelierItem; detail: AtelierItemDetail }) {
  const t = useT()
  const lang = useLang()
  const accept = useAccept(it)
  const live = liveHref(it)
  return (
    <>
      {it.pending && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-draft/30 bg-draft/8 px-4 py-3" role="status">
          <WandSparkles className="size-4 shrink-0 text-draft" aria-hidden />
          <p className="min-w-0 flex-[1_1_16rem] text-[13px]">
            <strong className="font-semibold">{it.pending.change === 'new' ? t('atelier.detail.pendingNew') : t('atelier.detail.pendingUpdate')}</strong>{' '}
            <span className="text-muted-foreground">{fmtRelative(it.pending.at, lang)}</span>
          </p>
          <Button size="sm" variant="outline" asChild className="border-draft/40 text-draft hover:bg-draft/10 hover:text-draft max-sm:w-full">
            <Link to={draftHref(it.pending.draft)}>{t('atelier.review')}</Link>
          </Button>
        </div>
      )}
      {it.unreviewed && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px]" role="status">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-[1_1_16rem]">
            <strong className="font-semibold text-warning">{t('atelier.detail.unreviewed', { n: it.version ?? 0 })}</strong>{' '}
            <span className="text-muted-foreground">{t('atelier.detail.unreviewedHint')}</span>
          </p>
          <Button size="sm" variant="outline" loading={accept.pending} onClick={() => void accept.run()} className="max-sm:w-full">
            <FileCheck2 /> {t('atelier.accept.action')}
          </Button>
        </div>
      )}
      {it.state === 'review' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13px]" role="status">
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-[1_1_16rem]">
            <strong className="font-semibold text-warning">{t(it.kind === 'customization' ? 'atelier.detail.reviewCustom' : 'atelier.detail.reviewExt')}</strong>
            {(it.error ?? detail.health.error)?.message && (
              <span className="mt-1 block font-mono text-xs text-muted-foreground">{(it.error ?? detail.health.error)!.message}</span>
            )}
          </p>
          {live && (
            <Button size="sm" variant="outline" asChild className="max-sm:w-full">
              <Link to={live}>{t('atelier.seeConflict')}</Link>
            </Button>
          )}
        </div>
      )}
    </>
  )
}

const WHERE: Record<AtelierError['where'], TKey> = {
  load: 'atelier.err.load',
  card: 'atelier.err.card',
  api: 'atelier.err.api',
  widget: 'atelier.err.widget',
  page: 'atelier.err.page',
  run: 'atelier.err.run',
  check: 'atelier.err.check',
}

/** It is broken: what failed, where, the stack when the browser recorded one; ask for a fix or go back to the last
 *  version that worked. */
function ErrorCard({
  item: it,
  error,
  ext,
  lastGood,
  rollingBack,
  onRollback,
}: {
  item: AtelierItem
  error: AtelierError
  ext: Extension | undefined
  lastGood: AtelierVersion | null
  rollingBack: number | null
  onRollback: (v: AtelierVersion) => void
}) {
  const t = useT()
  const lang = useLang()
  // the browser's record of the same error carries its stack (GET /api/extensions runtime_errors)
  const seen = ext?.runtime_errors?.find((e) => e.message === error.message) ?? ext?.runtime_errors?.[0]
  // a browser stack starts with the message itself: shown once
  const lines = (seen?.stack ?? '').split('\n')
  if (seen && lines[0]?.trim() === seen.message.trim()) lines.shift()
  const stack = lines.join('\n').trim()
  const target = ext ?? (it.kind === 'extension' ? { id: it.id, origin: it.origin?.session ? { id: it.origin.session, title: it.origin.session_title ?? '', path: it.origin.session_path ?? '' } : null } : null)
  return (
    <section className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4" aria-labelledby="atelier-error-title" data-testid="atelier-error">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="grid min-w-0 gap-1">
          <h3 id="atelier-error-title" className="text-sm font-semibold">
            {t('atelier.err.title')}
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {t(WHERE[error.where] ?? 'atelier.err.card')}
            {error.at && <> · {fmtRelative(error.at, lang)}</>}
            {error.count > 1 && <> · {t('atelier.err.times', { count: error.count })}</>}
          </p>
        </div>
      </div>
      <Sensitive block>
        <div className="grid gap-1.5 rounded-lg bg-background/80 p-3">
          <p className="font-mono text-[12.5px] [overflow-wrap:anywhere] text-destructive">{error.message}</p>
          {stack && <pre className="max-h-40 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">{stack}</pre>}
        </div>
      </Sensitive>
      <div className="flex flex-wrap items-center gap-2">
        {target && <AskFixButton ext={target} error={seen ? { message: seen.message, stack: seen.stack } : { message: error.message }} />}
        {lastGood && (
          <Button size="sm" variant="outline" loading={rollingBack === lastGood.n} disabled={rollingBack != null} onClick={() => onRollback(lastGood)}>
            <Undo2 /> {t('atelier.err.backTo', { n: lastGood.n })}
          </Button>
        )}
      </div>
      {target && <FixTarget ext={target} />}
    </section>
  )
}

const EVENT: Record<AtelierEvent['action'], TKey> = {
  approve: 'atelier.ev.approve',
  auto: 'atelier.ev.auto',
  reject: 'atelier.ev.reject',
  rollback: 'atelier.ev.rollback',
  accept: 'atelier.ev.accept',
  direct: 'atelier.ev.direct',
  migrate: 'atelier.ev.migrate',
  propose: 'atelier.ev.propose',
  request_change: 'atelier.ev.requestChange',
}

/** Everything that happened to it, newest first (folded). */
function HistoryList({ events }: { events: AtelierEvent[] }) {
  const t = useT()
  const lang = useLang()
  return (
    <details className="group rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-3 text-[13px] font-medium outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 [&::-webkit-details-marker]:hidden">
        <History className="size-4 text-muted-foreground" aria-hidden />
        <span className="flex-1">{t('atelier.detail.history', { count: events.length })}</span>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
      </summary>
      <ul className="grid gap-2 border-t px-4 py-3">
        {events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="min-w-0 flex-1">
              {t(EVENT[e.action] ?? 'atelier.ev.approve', { n: e.version ?? 0 })}
              {e.draft && (
                <>
                  {' · '}
                  <Link to={draftHref(e.draft)} className="text-primary hover:underline">
                    {t('atelier.ev.proposal')}
                  </Link>
                </>
              )}
            </span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(e.at * 1000).toISOString()}>
              {fmtDate(e.at, lang)}
            </time>
          </li>
        ))}
      </ul>
    </details>
  )
}

function DetailSkeleton() {
  return (
    <div className="grid gap-6" aria-busy>
      <div className="grid gap-3">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-32" />
          <SkeletonText lines={3} />
          <Skeleton className="h-32 rounded-lg" />
        </div>
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    </div>
  )
}
