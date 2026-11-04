// The versions of a creation (API.md#atelier `Version`), newest first, as a timeline: a node per version (the active
// one filled), what the agent said it did, who made it, in which session, when and how it was approved, whether it
// worked while it was active; "Changes" opens what that version changed, "Back here" makes an older one active again.
import * as React from 'react'
import { Link } from 'react-router'
import { FileDiff, Undo2 } from 'lucide-react'
import { useAtelierVersion } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import type { AtelierVersion } from '@/lib/types'
import { fmtDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLang, useT, type TKey } from '@/i18n'
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Sensitive, SkeletonText } from '@/components/ui'
import { OriginMark, sessionHref } from './parts'
import { FileReview, filesSummary } from './Files'

const APPROVAL: Record<string, TKey> = {
  user: 'atelier.v.byYou',
  auto: 'atelier.v.byAuto',
  migration: 'atelier.v.byMigration',
}

/** The server's notes are English; the known ones are said in the UI language, an approval already says the rest. */
function noteText(t: (k: TKey, v?: Record<string, string | number>) => string, v: AtelierVersion): string | null {
  const n = v.note?.trim()
  if (!n) return null
  let m: RegExpExecArray | null
  if ((m = /^(?:rollback to|from) v(\d+)$/i.exec(n))) return t('atelier.v.fromN', { n: Number(m[1]) })
  if (/^pinned from a conversation$/i.test(n)) return t('atelier.v.pinned')
  if (/^changed outside the atelier/i.test(n)) return v.approval.by === 'user' ? t('atelier.v.outsideAccepted') : t('atelier.v.outside')
  if (/^existed before the atelier$/i.test(n)) return v.approval.by === 'migration' ? null : t('atelier.v.byMigration')
  return n
}

export function VersionTimeline({
  kind,
  id,
  versions,
  canRollback,
  rollingBack,
  onRollback,
}: {
  kind: string
  id: string
  versions: AtelierVersion[]
  canRollback: boolean
  rollingBack: number | null
  onRollback: (v: AtelierVersion) => void
}) {
  const t = useT()
  const lang = useLang()
  const [changes, setChanges] = React.useState<AtelierVersion | null>(null)
  return (
    <>
      <ol className="grid" aria-label={t('atelier.v.title')}>
        {versions.map((v, i) => {
          const last = i === versions.length - 1
          const approval = v.approval.by ? APPROVAL[v.approval.by] : 'atelier.v.byNobody'
          const note = noteText(t, v)
          return (
            <li key={v.n} className={cn('relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3', !last && 'pb-6')} data-active={v.active || undefined} data-testid={`atelier-version-${v.n}`}>
              {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[0.5625rem] w-px bg-border" />}
              <span
                aria-hidden
                className={cn(
                  'relative mt-0.5 flex size-5 items-center justify-center rounded-full border-2 bg-background',
                  v.active ? 'border-primary bg-primary ring-4 ring-primary/15' : v.health === 'error' ? 'border-destructive' : 'border-border',
                )}
              >
                {v.active && <span className="size-1.5 rounded-full bg-primary-foreground" />}
              </span>
              <div className="grid min-w-0 gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold tabular-nums">{`v${v.n}`}</span>
                  {v.active && <Badge variant="default">{t('atelier.v.active')}</Badge>}
                  {!v.active && v.health === 'ok' && <span className="text-xs text-success">{t('atelier.v.worked')}</span>}
                  {v.health === 'error' && (
                    <span className="text-xs text-destructive" title={v.error?.message}>
                      {t('atelier.v.broke')}
                    </span>
                  )}
                </div>
                {v.origin.summary && (
                  <Sensitive block>
                    <p className="text-[13px] leading-relaxed">{v.origin.summary}</p>
                  </Sensitive>
                )}
                {note && <p className="text-xs text-muted-foreground">{note}</p>}
                <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                  {v.origin.agent !== 'unknown' && (
                    <span className="mr-1 inline-flex align-[-3px]">
                      <OriginMark agent={v.origin.agent} size={14} />
                    </span>
                  )}
                  {v.origin.session && (
                    <>
                      <Link to={sessionHref(v.origin)} className="font-medium text-foreground hover:underline">
                        <Sensitive length={10}>{v.origin.session_title || t('atelier.origin.untitled')}</Sensitive>
                      </Link>
                      {' · '}
                    </>
                  )}
                  <time dateTime={new Date(v.at * 1000).toISOString()}>{fmtDate(v.at, lang)}</time>
                  {' · '}
                  <span className={cn(v.approval.by == null && 'text-warning')}>{t(approval)}</span>
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
                  <button type="button" onClick={() => setChanges(v)} className="inline-flex min-h-7 items-center gap-1 rounded text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-10">
                    <FileDiff className="size-3.5" aria-hidden />
                    {t('atelier.v.changes')}
                  </button>
                  {!v.active &&
                    canRollback &&
                    (v.restorable ? (
                      <Button size="sm" variant="outline" className="h-7 max-md:h-10" loading={rollingBack === v.n} disabled={rollingBack != null} onClick={() => onRollback(v)}>
                        <Undo2 /> {t('atelier.v.backHere')}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('atelier.v.notKept')}</span>
                    ))}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <ChangesDialog kind={kind} id={id} version={changes} onClose={() => setChanges(null)} />
    </>
  )
}

/** What a version changed against the one before it. */
function ChangesDialog({ kind, id, version, onClose }: { kind: string; id: string; version: AtelierVersion | null; onClose: () => void }) {
  const t = useT()
  const q = useAtelierVersion(kind, id, version?.n ?? null)
  const against = q.data?.against ?? (version?.base || null)
  const rows = q.data?.files ?? []
  const counts = { added: rows.filter((f) => f.status === 'added').length, changed: rows.filter((f) => f.status === 'changed').length, removed: rows.filter((f) => f.status === 'removed').length }
  return (
    <Dialog open={!!version} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('atelier.v.changesOf', { n: version?.n ?? 0 })}</DialogTitle>
          <DialogDescription>
            {against ? t('atelier.v.against', { n: against }) : t('atelier.v.first')}
            {q.data && <> · {filesSummary(t, counts)}</>}
          </DialogDescription>
        </DialogHeader>
        {q.isPending ? <SkeletonText lines={6} /> : q.isError ? <p className="text-sm text-destructive">{errorMessage(q.error)}</p> : <FileReview key={version?.n} files={rows} />}
      </DialogContent>
    </Dialog>
  )
}
