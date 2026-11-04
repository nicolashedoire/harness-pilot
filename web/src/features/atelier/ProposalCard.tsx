// The `proposal` conversation block (API.md#atelier "Proposal block"): a creation an agent just proposed, drawn from
// GET /api/atelier/drafts/{draft} - never from the block's body, which only names the draft. Violet while it waits:
// what it is, what the agent says it does, what it asks for, its files, its check, a preview run only on demand (a
// block never runs a draft by itself), then Open in the Studio / Ask for a change / Add to the dashboard. A draft not
// registered yet (404: a Codex proposal before its turn ends) waits with the block's title; a decided one shows what
// became of it. The bus topic `atelier` keeps it current.
import * as React from 'react'
import { Link } from 'react-router'
import { CircleCheck, CircleX, Eye, History, Hourglass, MessageSquarePlus, TriangleAlert, WandSparkles } from 'lucide-react'
import { errorMessage, isApiError } from '@/lib/api'
import { useApproveDraft, useAtelierDraft, useRequestDraftChange } from '@/lib/queries'
import type { AtelierDraft } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Badge, Button, Sensitive, Skeleton, Textarea, toast } from '@/components/ui'
import { OriginMark, TypeTile, approveWord, typeLabel } from './parts'
import { PermissionRows } from './Permissions'
import { CheckLine } from './Check'
import { filesSummary } from './Files'
import { DraftPreview, PreviewFrame } from './Preview'

const draftHref = (id: string) => `/atelier/drafts/${encodeURIComponent(id)}`

export default function ProposalCard({ draft: id, title }: { draft: string; title?: string }) {
  const t = useT()
  const q = useAtelierDraft(id)
  const shell = 'mx-block not-prose my-3 grid gap-3 rounded-xl border p-4 max-sm:p-3'
  if (q.isPending)
    return (
      <div className={cn(shell, 'border-draft/30 bg-draft/5')} aria-busy data-testid="proposal-card">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-16 rounded-lg" />
      </div>
    )
  if (q.isError || !q.data)
    return isApiError(q.error, 'not_found') ? (
      // registered when the agent's turn ends (Codex): the bus topic `atelier` brings it
      <div className={cn(shell, 'border-dashed border-draft/40 bg-draft/5')} data-testid="proposal-card" data-state="waiting">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Hourglass className="size-4 text-draft" aria-hidden />
          <Sensitive length={12}>{title || t('atelier.card.untitled')}</Sensitive>
        </p>
        <p className="text-[13px] text-muted-foreground">{t('atelier.card.waiting')}</p>
      </div>
    ) : (
      <div className={cn(shell, 'border-destructive/30 bg-destructive/5')} role="alert" data-testid="proposal-card">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <TriangleAlert className="size-4" aria-hidden />
          {t('atelier.card.loadFailed')}
        </p>
        <p className="text-[13px] text-muted-foreground">{errorMessage(q.error)}</p>
        <Button variant="outline" size="sm" className="w-fit" loading={q.isFetching} onClick={() => q.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  return <Loaded detail={q.data} />
}

function Loaded({ detail }: { detail: NonNullable<ReturnType<typeof useAtelierDraft>['data']> }) {
  const t = useT()
  const d = detail.draft
  const pending = d.status === 'pending'
  const approve = useApproveDraft()
  const [preview, setPreview] = React.useState(false)
  const [asking, setAsking] = React.useState(false)
  const blocked = d.check.status === 'error'
  return (
    <section
      aria-label={t('atelier.card.label', { name: d.name })}
      // a container: the conversation column decides its layout, not the window
      className={cn('@container mx-block not-prose my-3 grid min-w-0 gap-3 rounded-xl border p-4 max-sm:p-3', pending ? 'border-draft/35 bg-draft/5' : 'bg-card')}
      data-testid="proposal-card"
      data-state={d.status}
    >
      <header className="flex min-w-0 items-start gap-3">
        <TypeTile type={d.type} pending={pending} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className={cn('flex items-center gap-1.5 text-xs font-medium', pending ? 'text-draft' : 'text-muted-foreground')}>
            <WandSparkles className="size-3.5" aria-hidden />
            {pending ? t('atelier.card.kicker') : t('atelier.card.kickerDone')}
          </p>
          <h4 className="truncate text-[15px] font-semibold tracking-tight">
            <Sensitive length={12}>{d.name}</Sensitive>
          </h4>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <OriginMark agent={d.origin.agent} size={13} />
            <span>{typeLabel(t, d.type)}</span>
            <span aria-hidden>·</span>
            <span>{d.change === 'update' && detail.active_version ? t('atelier.review.updateOf', { version: detail.active_version }) : t('atelier.review.newOne')}</span>
            <span aria-hidden>·</span>
            {/* once decided the diff is against what runs now: say how many files it had */}
            <span>{pending ? filesSummary(t, d.files) : t('atelier.card.files', { count: d.files.count })}</span>
          </p>
        </div>
      </header>

      {!pending && <Outcome draft={d} />}

      {d.summary && (
        <Sensitive block>
          <p className="line-clamp-3 text-sm leading-relaxed whitespace-pre-line">{d.summary}</p>
        </Sensitive>
      )}

      {pending &&
        (preview ? (
          <DraftPreview draft={d.id} name={d.name} icon={d.icon} />
        ) : (
          // the mini preview: nothing runs until the user asks (API.md "Live preview")
          <PreviewFrame className="min-h-24 p-3 sm:p-3">
            <Button variant="outline" size="sm" className="bg-background" onClick={() => setPreview(true)}>
              <Eye /> {t('atelier.card.preview')}
            </Button>
          </PreviewFrame>
        ))}

      {pending && (
        <div className="grid gap-2">
          <PermissionRows permissions={d.permissions} compact />
          <CheckLine check={d.check} />
        </div>
      )}

      {pending && asking && <AskChange draft={d} onDone={() => setAsking(false)} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="max-sm:order-3">
          <Link to={draftHref(d.id)}>{t('atelier.card.open')}</Link>
        </Button>
        {pending && !asking && (
          <Button variant="outline" size="sm" onClick={() => setAsking(true)} className="max-sm:order-2">
            <MessageSquarePlus /> {t('atelier.review.askChange')}
          </Button>
        )}
        {pending && (
          <Button
            size="sm"
            className="ml-auto max-sm:order-1 max-sm:ml-0 max-sm:w-full"
            loading={approve.isPending}
            disabled={blocked}
            data-testid="proposal-approve"
            onClick={() =>
              approve.mutate(
                { id: d.id, base: detail.active_version },
                {
                  onSuccess: (r) => toast.success(t('atelier.review.approved', { name: d.name, version: r.version })),
                  onError: (e) => toast.error(isApiError(e, 'stale') ? t('atelier.review.staleNow') : errorMessage(e)),
                },
              )
            }
          >
            <CircleCheck /> {approveWord(t, d)}
          </Button>
        )}
      </div>
      {pending && blocked && <p className="text-xs text-destructive">{t('atelier.review.blocked')}</p>}
    </section>
  )
}

/** What became of it: approved as vN, refused, replaced by a newer proposal. */
function Outcome({ draft: d }: { draft: AtelierDraft }) {
  const t = useT()
  if (d.status === 'approved')
    return (
      <p className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge variant="success">
          <CircleCheck /> {t('atelier.history.approved', { n: d.decided?.version ?? 0 })}
        </Badge>
        <Link to={`/atelier/extension/${encodeURIComponent(d.target)}`} className="font-medium text-primary hover:underline">
          {t('atelier.review.seeCreation')}
        </Link>
      </p>
    )
  if (d.status === 'rejected')
    return (
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Badge variant="destructive">
          <CircleX /> {t('atelier.draft.rejected')}
        </Badge>
        {d.decided?.reason && <Sensitive>{d.decided.reason}</Sensitive>}
      </p>
    )
  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
      <Badge variant="muted">
        <History /> {t('atelier.draft.superseded')}
      </Badge>
      {d.superseded_by && (
        <Link to={draftHref(d.superseded_by)} className="font-medium text-primary hover:underline">
          {t('atelier.review.seeNewer')}
        </Link>
      )}
    </p>
  )
}

/** Ask for a change, inline: sent to the session the draft came from (POST .../request-change). */
function AskChange({ draft, onDone }: { draft: AtelierDraft; onDone: () => void }) {
  const t = useT()
  const send = useRequestDraftChange()
  const [message, setMessage] = React.useState('')
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!message.trim()) return
        send.mutate(
          { id: draft.id, message: message.trim() },
          {
            onSuccess: (r) => {
              toast.success(t(r.created ? 'atelier.change.sentNew' : r.queued ? 'atelier.change.queued' : 'atelier.change.sent'))
              onDone()
            },
          },
        )
      }}
    >
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, 4000))}
        minRows={2}
        maxRows={8}
        placeholder={t('atelier.change.placeholder')}
        aria-label={t('atelier.change.label')}
        autoFocus
      />
      {send.error && <p className="text-xs text-destructive">{errorMessage(send.error)}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" loading={send.isPending} disabled={!message.trim()}>
          {t('atelier.change.send')}
        </Button>
      </div>
    </form>
  )
}
