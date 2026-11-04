// The result of a draft's static check (API.md#atelier "Static check": loaded as the server would, code compiled,
// never run): one line, its steps folded under it when something is to read.
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react'
import type { AtelierDraft } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

export function CheckLine({ check, className }: { check: AtelierDraft['check']; className?: string }) {
  const t = useT()
  const errors = check.steps.filter((s) => s.status === 'error')
  const warns = check.steps.filter((s) => s.status === 'warn')
  const status = errors.length ? 'error' : warns.length || check.status === 'warn' ? 'warn' : check.status === 'error' ? 'error' : 'ok'
  const Icon = status === 'ok' ? CircleCheck : status === 'warn' ? TriangleAlert : CircleX
  const text =
    status === 'ok'
      ? t('atelier.check.ok', { count: check.steps.length })
      : status === 'warn'
        ? t('atelier.check.warn', { count: warns.length })
        : t('atelier.check.error', { count: Math.max(1, errors.length) })
  const tone = status === 'ok' ? 'text-success' : status === 'warn' ? 'text-warning' : 'text-destructive'
  const shown = [...errors, ...warns]
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className={cn('size-4 shrink-0', tone)} />
      <span className={cn('min-w-0', status !== 'ok' && 'font-medium', tone)}>{text}</span>
    </span>
  )
  return (
    <div className={cn('text-[13px]', className)} data-testid="atelier-check" data-status={status}>
      {shown.length ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            {line}
            <span className="shrink-0 text-xs text-muted-foreground underline-offset-2 group-open:hidden hover:underline">{t('atelier.check.show')}</span>
          </summary>
          <ul className="mt-2 grid gap-1.5 border-l-2 pl-3">
            {shown.map((s, i) => (
              <li key={i} className="grid gap-0.5">
                <span className={cn('font-medium', s.status === 'error' ? 'text-destructive' : 'text-warning')}>{s.step}</span>
                {s.detail && <span className="font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">{s.detail}</span>}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        line
      )}
    </div>
  )
}
