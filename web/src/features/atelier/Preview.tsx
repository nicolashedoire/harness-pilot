// A draft drawn with the user's real data, in a dashed, hatched frame that says "not installed": a card widget as the
// dashboard draws it (its card() run by POST /api/atelier/drafts/{id}/preview), an HTML widget in its sandboxed frame
// (/ext/_drafts/<id>/widget-frame, its maxxing.api() going to the draft's own handle()), and for a page, a block or an
// agent engine why it is not run before approval (API.md "Live preview").
import * as React from 'react'
import { AppWindow, Blocks, Bot, RefreshCw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useDraftPreview } from '@/lib/queries'
import { errorMessage, seg } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Card, NamedIcon, Sensitive, Skeleton, SkeletonText, StatusDot, Tooltip } from '@/components/ui'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { BlockView } from '@/pages/dashboard/blocks'
import { HtmlWidget } from '@/pages/dashboard/HtmlWidget'

/** The dashed frame with diagonal hatching: what is inside is not installed. */
export function PreviewFrame({ children, className, ...rest }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('relative flex min-h-56 items-center justify-center rounded-xl border-2 border-dashed border-border p-4 sm:p-6', className)}
      style={{ backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in oklab, var(--border) 45%, transparent) 10px 11px)' }}
      {...rest}
    >
      {children}
    </div>
  )
}

const NONE: Record<string, { icon: LucideIcon; text: TKey }> = {
  page: { icon: AppWindow, text: 'atelier.preview.page' },
  block: { icon: Blocks, text: 'atelier.preview.block' },
  agent: { icon: Bot, text: 'atelier.preview.agent' },
}

/** `run`: run the draft now (the validation screen); false shows nothing until the user asks (the proposal card). */
export function DraftPreview({ draft, name, icon, run = true, className }: { draft: string; name: string; icon: string | null; run?: boolean; className?: string }) {
  const t = useT()
  const q = useDraftPreview(draft, run)
  const [errors, setErrors] = React.useState<string[]>([])
  const p = q.data
  return (
    <div className={cn('grid gap-2', className)}>
      <PreviewFrame data-testid="atelier-preview" className={cn(run && 'max-sm:pt-12')}>
        {run && (q.isSuccess || q.isError) && (p?.kind !== 'none') && (
          <Tooltip content={t('atelier.preview.refresh')}>
            <Button
              variant="outline"
              size="icon-sm"
              className="absolute top-2 right-2 bg-background"
              onClick={() => {
                setErrors([])
                void q.refetch()
              }}
              disabled={q.isFetching}
              aria-label={t('atelier.preview.refresh')}
            >
              <RefreshCw className={cn(q.isFetching && 'motion-safe:animate-spin')} />
            </Button>
          </Tooltip>
        )}
        {q.isPending ? (
          <Card className="w-full max-w-md gap-4 p-[var(--pad-card)]" aria-busy>
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-4 w-28" />
            </div>
            <SkeletonText lines={3} />
          </Card>
        ) : q.isError ? (
          <Failure message={errorMessage(q.error)} />
        ) : p?.kind === 'card' ? (
          p.card ? (
            <Card className="w-full max-w-md min-w-0 gap-0 overflow-hidden">
              <div className="flex h-12 items-center gap-2.5 px-[var(--pad-card)] pt-1">
                <NamedIcon name={icon || 'puzzle'} className="size-4 text-muted-foreground" />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
                  <Sensitive length={10}>{p.card.title || name}</Sensitive>
                </h3>
                {p.card.status && p.card.status !== 'ok' && <StatusDot tone={p.card.status} label={p.card.status} />}
              </div>
              <div className="grid gap-5 px-[var(--pad-card)] pt-2 pb-[var(--pad-card)]">
                {(Array.isArray(p.card.blocks) ? p.card.blocks : []).map((b, i) => (
                  <ErrorBoundary key={i}>
                    <BlockView block={b} />
                  </ErrorBoundary>
                ))}
              </div>
            </Card>
          ) : (
            <Failure message={p.error || t('atelier.preview.empty')} trace={p.trace} />
          )
        ) : p?.kind === 'html' ? (
          <Card className="w-full max-w-xl min-w-0 overflow-hidden p-2">
            <HtmlWidget
              key={q.dataUpdatedAt}
              id={draft}
              src={p.url}
              frameUrl={p.url}
              apiBase={`/api/atelier/drafts/${seg(draft)}/api`}
              height={p.height || 260}
              title={name}
              onError={(message) => setErrors((e) => (e.includes(message) || e.length >= 5 ? e : [...e, message]))}
            />
          </Card>
        ) : p?.kind === 'none' ? (
          <NotRun reason={p.reason} />
        ) : null}
      </PreviewFrame>
      {errors.length > 0 && (
        <ul className="grid gap-1 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive" aria-label={t('atelier.preview.errors')}>
          {errors.map((e) => (
            <li key={e} className="flex items-start gap-2 font-mono text-xs break-all">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Failure({ message, trace }: { message: string; trace?: string[] }) {
  const t = useT()
  return (
    <div className="grid w-full max-w-md gap-2 rounded-xl border border-destructive/30 bg-card p-4 text-[13px]" role="alert">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {t('atelier.preview.failed')}
      </p>
      <p className="font-mono text-xs break-all">{message}</p>
      {!!trace?.length && <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{trace.join('\n')}</pre>}
    </div>
  )
}

function NotRun({ reason }: { reason: string }) {
  const t = useT()
  const n = NONE[reason] ?? NONE.page
  return (
    <div className="grid max-w-sm justify-items-center gap-3 rounded-xl bg-card/90 p-5 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground">
        <n.icon className="size-5" aria-hidden />
      </span>
      <p className="text-[13px] text-muted-foreground">{t(n.text)}</p>
    </div>
  )
}
