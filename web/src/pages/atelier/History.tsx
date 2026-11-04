// The list's History (GET /api/atelier/drafts?status=all): every proposal of the last 30 days and what became of it -
// waiting, approved as vN, refused (and why), replaced by a newer one. A side sheet (bottom sheet on a phone),
// opened by ?history=1.
import { Link } from 'react-router'
import { History as HistoryIcon, TriangleAlert } from 'lucide-react'
import { useAtelierDrafts } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import type { AtelierDraft } from '@/lib/types'
import { fmtRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLang, useT } from '@/i18n'
import { EmptyState, Sensitive, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton } from '@/components/ui'
import { OriginMark, TypeTile } from '@/features/atelier/parts'
import { draftHref } from './links'

const OUTCOME: Record<AtelierDraft['status'], string> = {
  pending: 'border-draft/30 bg-draft/10 text-draft',
  approved: 'border-success/25 bg-success/12 text-success',
  rejected: 'border-destructive/25 bg-destructive/12 text-destructive',
  superseded: 'border-transparent bg-muted text-muted-foreground',
}

export function HistorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT()
  const q = useAtelierDrafts('all', open)
  const drafts = q.data?.drafts ?? []
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('atelier.history.title')}</SheetTitle>
          <SheetDescription>{t('atelier.history.desc')}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {q.isPending ? (
            <div className="grid gap-2" aria-busy>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : q.isError ? (
            <EmptyState compact tone="error" icon={TriangleAlert} title={t('atelier.history.failed')} description={errorMessage(q.error)} />
          ) : !drafts.length ? (
            <EmptyState compact icon={HistoryIcon} title={t('atelier.history.empty')} description={t('atelier.history.emptyDesc')} />
          ) : (
            <ul className="grid gap-1" aria-label={t('atelier.history.title')}>
              {drafts.map((d) => (
                <HistoryRow key={d.id} draft={d} onOpen={() => onOpenChange(false)} />
              ))}
            </ul>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function HistoryRow({ draft: d, onOpen }: { draft: AtelierDraft; onOpen: () => void }) {
  const t = useT()
  const lang = useLang()
  const label =
    d.status === 'approved'
      ? d.decided?.by === 'auto'
        ? t('atelier.history.auto', { n: d.decided?.version ?? 0 })
        : t('atelier.history.approved', { n: d.decided?.version ?? 0 })
      : t(`atelier.draft.${d.status}`)
  const at = d.decided?.at ?? d.created
  return (
    <li>
      <Link to={draftHref(d.id)} onClick={onOpen} className="flex items-start gap-3 rounded-lg px-2 py-2.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" data-status={d.status}>
        <TypeTile type={d.type} pending={d.status === 'pending'} className="size-8" />
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">
              <Sensitive length={12}>{d.name}</Sensitive>
            </span>
            <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium', OUTCOME[d.status])}>{label}</span>
          </span>
          {d.status === 'rejected' && d.decided?.reason && (
            <span className="truncate text-xs text-muted-foreground">
              <Sensitive length={16}>{d.decided.reason}</Sensitive>
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <OriginMark agent={d.origin.agent} size={13} />
            <span className="truncate">
              {d.change === 'update' ? t('atelier.history.update') : t('atelier.history.new')} · {fmtRelative(at, lang)}
            </span>
          </span>
        </span>
      </Link>
    </li>
  )
}
