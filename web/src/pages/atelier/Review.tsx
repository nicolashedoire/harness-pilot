// /atelier/drafts/<id> - the validation screen of a draft (GET /api/atelier/drafts/{id}). Left: the draft run with the
// user's real data in an isolated frame (POST .../preview, the user opened the screen to review it), the result of
// its static check, what the agent says it does. Right: what it asks for, its files and their diff against the active
// version, then Refuse / Ask for a change / Turn on. Nothing runs for real before the approval.
import * as React from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowLeft, ChevronRight, CircleCheck, CircleX, History, MessageSquarePlus, SearchX, TriangleAlert } from 'lucide-react'
import { api, errorMessage, isApiError, seg } from '@/lib/api'
import { useApproveDraft, useAtelier, useAtelierDraft, useRejectDraft, useRequestDraftChange } from '@/lib/queries'
import type { AtelierDraft, AtelierDraftDetail } from '@/lib/types'
import { fmtDate, fmtRelative } from '@/lib/format'
import { useLang, useT, type TKey } from '@/i18n'
import { useCompact } from '@/stores/media'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  Sensitive,
  Skeleton,
  SkeletonText,
  Textarea,
  toast,
} from '@/components/ui'
import { Page } from '@/components/shell/Page'
import { OriginMark, TypeTile, approveWord, sessionHref, typeLabel } from '@/features/atelier/parts'
import { PermissionRows } from '@/features/atelier/Permissions'
import { DraftPreview } from '@/features/atelier/Preview'
import { CheckLine } from '@/features/atelier/Check'
import { FileReview, filesSummary } from '@/features/atelier/Files'
import { draftHref } from './links'

/** The agent's name in a sentence ("Proposed by Claude"). */
export function agentWord(t: (k: TKey) => string, agent: string | null | undefined) {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  if (agent?.startsWith('plugin:')) return agent.slice(7)
  if (agent === 'user') return t('atelier.origin.you')
  return t('atelier.origin.anAgent')
}

export function DraftReview() {
  const t = useT()
  const touch = useCompact()
  const navigate = useNavigate()
  const { id = '' } = useParams()
  const { data, isPending, isError, error, refetch, isFetching } = useAtelierDraft(id)
  const list = useAtelier()
  const approve = useApproveDraft()
  const [dialog, setDialog] = React.useState<'reject' | 'change' | null>(null)

  /** After a decision: the next draft waiting, else the list. */
  const next = () => {
    const other = list.data?.items.find((it) => it.pending && it.pending.draft !== id)
    navigate(other?.pending ? draftHref(other.pending.draft) : '/atelier', { replace: true })
  }
  const back = (
    <Button variant="ghost" size="icon" onClick={() => navigate('/atelier')} aria-label={t('atelier.backToList')}>
      <ArrowLeft />
    </Button>
  )

  if (isPending)
    return (
      <Page title={t('nav.atelier')} leading={touch ? back : undefined} width="wide">
        <ReviewSkeleton />
      </Page>
    )
  if (isError || !data)
    return (
      <Page title={t('nav.atelier')} leading={touch ? back : undefined} width="narrow">
        {isApiError(error, 'not_found') ? (
          <EmptyState
            icon={SearchX}
            title={t('atelier.review.missing')}
            description={t('atelier.review.missingDesc')}
            action={
              <Button variant="outline" asChild>
                <Link to="/atelier">{t('atelier.backToList')}</Link>
              </Button>
            }
          />
        ) : (
          <EmptyState
            tone="error"
            icon={TriangleAlert}
            title={t('atelier.review.loadFailed')}
            description={errorMessage(error)}
            action={
              <Button variant="outline" loading={isFetching} onClick={() => refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
      </Page>
    )

  const d = data.draft
  const pending = d.status === 'pending'
  const blocked = d.check.status === 'error'
  const onApprove = () =>
    approve.mutate(
      { id: d.id, base: data.active_version },
      {
        onSuccess: (r) => {
          toast.success(t('atelier.review.approved', { name: d.name, version: r.version }))
          next()
        },
        onError: (e) => {
          if (isApiError(e, 'stale')) {
            toast.error(t('atelier.review.staleNow'))
            void refetch()
          } else toast.error(errorMessage(e))
        },
      },
    )
  const decide = (
    <DecisionButtons
      draft={d}
      blocked={blocked}
      approving={approve.isPending}
      onApprove={onApprove}
      onReject={() => setDialog('reject')}
      onChange={() => setDialog('change')}
    />
  )

  return (
    <Page title={t('nav.atelier')} leading={touch ? back : undefined} width="wide" bodyClassName="max-md:px-3 max-md:pt-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <ReviewHeader detail={data} />

        {data.stale && pending && (
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-[13px] text-warning" role="status">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('atelier.review.stale', { version: data.active_version ?? 0 })}
          </p>
        )}
        {!pending && <Outcome draft={d} />}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            <section className="grid gap-3" aria-labelledby="atelier-preview-title">
              <h3 id="atelier-preview-title" className="text-sm font-semibold">
                {t('atelier.review.preview')}
              </h3>
              {pending ? (
                <DraftPreview draft={d.id} name={d.name} icon={d.icon} />
              ) : (
                <p className="rounded-xl border border-dashed px-4 py-8 text-center text-[13px] text-muted-foreground">{t('atelier.review.noPreview')}</p>
              )}
              <CheckLine check={d.check} />
            </section>

            <section className="grid gap-2" aria-labelledby="atelier-summary-title">
              <h3 id="atelier-summary-title" className="text-sm font-semibold">
                {t('atelier.review.summary')}
              </h3>
              {d.summary ? (
                <Sensitive block>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{d.summary}</p>
                </Sensitive>
              ) : (
                <p className="text-sm text-muted-foreground">{t('atelier.review.noSummary')}</p>
              )}
              {d.change_requests.length > 0 && <ChangeRequests requests={d.change_requests} />}
            </section>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            <section className="grid gap-3" aria-labelledby="atelier-asks-title">
              <h3 id="atelier-asks-title" className="text-sm font-semibold">
                {t('atelier.review.asks')}
              </h3>
              <PermissionRows permissions={d.permissions} />
            </section>

            <section className="grid gap-3" aria-labelledby="atelier-files-title">
              <h3 id="atelier-files-title" className="text-sm font-semibold">
                {t('atelier.files.title')} · <span className="font-normal text-muted-foreground">{filesSummary(t, d.files)}</span>
              </h3>
              <FileReview
                files={data.files}
                loadFile={async (path) => (await api.get<{ content: string | null }>(`/api/atelier/drafts/${seg(d.id)}/file`, { path })).content}
              />
            </section>

            {pending && (
              <p className="text-xs leading-relaxed text-muted-foreground md:hidden">
                {d.change === 'update' && data.active_version ? t('atelier.review.footUpdate', { version: data.active_version }) : t('atelier.review.footNew')}
              </p>
            )}
            {pending && (
              // stays in sight at the bottom of the column while the files are read
              <div className="sticky bottom-0 z-10 -mx-2 grid gap-3 border-t bg-background px-2 pt-3 pb-4 max-md:hidden">
                {decide}
                <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <History className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {d.change === 'update' && data.active_version ? t('atelier.review.footUpdate', { version: data.active_version }) : t('atelier.review.footNew')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* touch layout: the decision stays at hand at the bottom of the screen */}
        {pending && (
          <div className="sticky bottom-0 z-10 -mx-3 border-t bg-background px-3 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] md:hidden">{decide}</div>
        )}
      </div>

      <RejectDialog open={dialog === 'reject'} onOpenChange={(o) => setDialog(o ? 'reject' : null)} draft={d} onDone={next} />
      <ChangeDialog open={dialog === 'change'} onOpenChange={(o) => setDialog(o ? 'change' : null)} draft={d} />
    </Page>
  )
}

/** Breadcrumb, name with its type and version, who proposed it, where and when. */
function ReviewHeader({ detail }: { detail: AtelierDraftDetail }) {
  const t = useT()
  const lang = useLang()
  const d = detail.draft
  const o = d.origin
  const crumb = d.status === 'pending' ? t('atelier.review.crumb') : t(`atelier.draft.${d.status}` as TKey)
  return (
    <header className="grid gap-2">
      <nav aria-label={t('atelier.review.breadcrumb')} className="flex items-center gap-1 text-[13px] text-muted-foreground">
        <Link to="/atelier" className="hover:text-foreground hover:underline">
          {t('nav.atelier')}
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span aria-current="page">{crumb}</span>
      </nav>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TypeTile type={d.type} pending={d.status === 'pending'} />
        <h2 className="min-w-0 text-xl font-semibold tracking-tight break-words">
          <Sensitive length={12}>{d.name}</Sensitive>
        </h2>
        <Badge variant="muted">{typeLabel(t, d.type)}</Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {d.change === 'update' && detail.active_version ? t('atelier.review.updateOf', { version: detail.active_version }) : t('atelier.review.newOne')}
        </span>
      </div>
      <p className="min-w-0 text-[13px] leading-relaxed text-muted-foreground">
        <span className="mr-1.5 inline-flex align-[-3px]">
          <OriginMark agent={o.agent} size={15} />
        </span>
        {t('atelier.review.proposedBy', { agent: agentWord(t, o.agent) })}
        {o.session && (
          <>
            {' '}
            {t('atelier.review.in')}{' '}
            <Link to={sessionHref(o)} className="font-medium text-foreground hover:underline">
              {t('atelier.q.open')}
              <Sensitive length={12}>{o.session_title || t('atelier.origin.untitled')}</Sensitive>
              {t('atelier.q.close')}
            </Link>
          </>
        )}
        {o.at && (
          <span title={fmtDate(o.at, lang)} className="whitespace-nowrap">
            {' · '}
            {fmtRelative(o.at, lang)}
          </span>
        )}
      </p>
    </header>
  )
}

function DecisionButtons({ draft, blocked, approving, onApprove, onReject, onChange }: { draft: AtelierDraft; blocked: boolean; approving: boolean; onApprove: () => void; onReject: () => void; onChange: () => void }) {
  const t = useT()
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)]">
        <Button variant="ghost" onClick={onReject} className="text-destructive hover:bg-destructive/10 hover:text-destructive max-md:order-2">
          {t('atelier.review.reject')}
        </Button>
        <Button variant="outline" onClick={onChange} className="max-md:order-3">
          <MessageSquarePlus className="max-md:hidden" /> <span className="truncate">{t('atelier.review.askChange')}</span>
        </Button>
        <Button onClick={onApprove} loading={approving} disabled={blocked} className="ml-auto max-md:order-1 max-md:col-span-2 max-md:ml-0" data-testid="atelier-approve">
          <CircleCheck /> {approveWord(t, draft)}
        </Button>
      </div>
      {blocked && <p className="text-xs text-destructive">{t('atelier.review.blocked')}</p>}
    </div>
  )
}

/** A draft already decided: approved (as vN), refused, or replaced by a newer proposal. */
function Outcome({ draft: d }: { draft: AtelierDraft }) {
  const t = useT()
  const lang = useLang()
  const when = d.decided?.at ? fmtDate(d.decided.at, lang) : ''
  if (d.status === 'approved')
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-[13px] text-success" role="status">
        <CircleCheck className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t(d.decided?.by === 'auto' ? 'atelier.review.wasAuto' : 'atelier.review.wasApproved', { version: d.decided?.version ?? 0, date: when })}</span>
        <Link to={`/atelier/extension/${encodeURIComponent(d.target)}`} className="font-medium underline-offset-2 hover:underline">
          {t('atelier.review.seeCreation')}
        </Link>
      </p>
    )
  if (d.status === 'rejected')
    return (
      <p className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive" role="status">
        <CircleX className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">
          {t('atelier.review.wasRejected', { date: when })}
          {d.decided?.reason && (
            <>
              {' '}
              <Sensitive>« {d.decided.reason} »</Sensitive>
            </>
          )}
        </span>
      </p>
    )
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2.5 text-[13px] text-muted-foreground" role="status">
      <History className="size-4 shrink-0" aria-hidden />
      <span className="flex-1">{t('atelier.review.wasSuperseded')}</span>
      {d.superseded_by && (
        <Link to={draftHref(d.superseded_by)} className="font-medium text-foreground underline-offset-2 hover:underline">
          {t('atelier.review.seeNewer')}
        </Link>
      )}
    </p>
  )
}

function ChangeRequests({ requests }: { requests: AtelierDraft['change_requests'] }) {
  const t = useT()
  const lang = useLang()
  return (
    <div className="mt-2 grid gap-2">
      <h4 className="text-xs font-medium text-muted-foreground">{t('atelier.review.yourRequests')}</h4>
      <ul className="grid gap-2">
        {requests.map((r, i) => (
          <li key={i} className="rounded-lg border bg-muted/30 px-3 py-2 text-[13px]">
            <Sensitive block>
              <p className="whitespace-pre-line">{r.message}</p>
            </Sensitive>
            <p className="mt-1 text-xs text-muted-foreground">{fmtRelative(r.at, lang)}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RejectDialog({ open, onOpenChange, draft, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; draft: AtelierDraft; onDone: () => void }) {
  const t = useT()
  const reject = useRejectDraft()
  const [reason, setReason] = React.useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('atelier.reject.title')}</DialogTitle>
          <DialogDescription>{t('atelier.reject.desc')}</DialogDescription>
        </DialogHeader>
        <FormField label={t('atelier.reject.reason')} hint={t('atelier.reject.reasonHint')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, 500))} minRows={2} maxRows={6} />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            loading={reject.isPending}
            onClick={() =>
              reject.mutate(
                { id: draft.id, reason: reason.trim() || undefined },
                {
                  onSuccess: () => {
                    onOpenChange(false)
                    toast.success(t('atelier.reject.done', { name: draft.name }), t('atelier.reject.doneDesc'))
                    onDone()
                  },
                },
              )
            }
          >
            {t('atelier.review.reject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangeDialog({ open, onOpenChange, draft }: { open: boolean; onOpenChange: (o: boolean) => void; draft: AtelierDraft }) {
  const t = useT()
  const navigate = useNavigate()
  const send = useRequestDraftChange()
  const [message, setMessage] = React.useState('')
  const where = draft.origin.session_title
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!message.trim()) return
            send.mutate(
              { id: draft.id, message: message.trim() },
              {
                onSuccess: (r) => {
                  onOpenChange(false)
                  setMessage('')
                  toast.action(t(r.created ? 'atelier.change.sentNew' : r.queued ? 'atelier.change.queued' : 'atelier.change.sent'), undefined, {
                    label: t('atelier.change.open'),
                    onClick: () => navigate(sessionHref({ session: r.session.id, session_path: r.session.path })),
                  })
                },
              },
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('atelier.review.askChange')}</DialogTitle>
            <DialogDescription>{where ? t('atelier.change.desc', { session: where }) : t('atelier.change.descNew')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('atelier.change.label')} error={send.error ? errorMessage(send.error) : undefined}>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, 4000))} minRows={3} maxRows={10} placeholder={t('atelier.change.placeholder')} autoFocus />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={send.isPending} disabled={!message.trim()}>
              {t('atelier.change.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ReviewSkeleton() {
  return (
    <div className="grid gap-6" aria-busy>
      <div className="grid gap-2">
        <Skeleton className="h-4 w-40" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-6 w-56" />
        </div>
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-64 rounded-xl" />
          <SkeletonText lines={3} />
        </div>
        <div className="grid content-start gap-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-36 rounded-lg" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    </div>
  )
}

