// The runtime errors of an extension (GET /api/extensions `runtime_errors`: what broke while it ran, in the browser or
// on the server, since its files last changed), shown on its row in Settings -> Extensions, with "Ask for a fix".
import { TriangleAlert } from 'lucide-react'
import { useClearExtensionErrors } from '@/lib/queries'
import { fmtRelative } from '@/lib/format'
import type { Extension } from '@/lib/types'
import { useLang, useT, type TKey } from '@/i18n'
import { Badge, Button } from '@/components/ui'
import { AskFixButton, FixTarget } from './AskFix'

const SHOWN = 3

/** `fix`: show "Ask for a fix" here (false when the row already offers it for a load error). */
export function RuntimeErrors({ ext, fix = true }: { ext: Extension; fix?: boolean }) {
  const t = useT()
  const lang = useLang()
  const clear = useClearExtensionErrors()
  const errs = ext.runtime_errors ?? []
  if (!errs.length) return null
  return (
    <div role="group" aria-label={t('exterr.title', { count: errs.length })} className="mt-1 grid gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3" data-testid="ext-runtime-errors">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_14rem] items-start gap-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <div className="grid min-w-0">
            <span className="text-[13px] font-medium">{t('exterr.title', { count: errs.length })}</span>
            <span className="text-xs text-muted-foreground">{t('exterr.since')}</span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-1.5">
          {fix && <AskFixButton ext={ext} className="h-7" />}
          <Button variant="ghost" size="sm" className="h-7" loading={clear.isPending} onClick={() => clear.mutate(ext.id)}>
            {t('exterr.clear')}
          </Button>
        </div>
      </div>
      <ul className="grid gap-3">
        {errs.slice(0, SHOWN).map((e, i) => (
          <li key={`${e.at}-${i}`} className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{t(`exterr.where.${e.where}` as TKey)}</Badge>
              <time dateTime={new Date(e.at * 1000).toISOString()} title={new Date(e.at * 1000).toLocaleString(lang)}>
                {fmtRelative(e.at, lang)}
              </time>
              {e.count > 1 && <span>· {t('exterr.times', { count: e.count })}</span>}
            </div>
            <p className="font-mono text-[12.5px] [overflow-wrap:anywhere] text-destructive">{e.message}</p>
            {e.stack && (
              <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">{e.stack}</pre>
            )}
          </li>
        ))}
      </ul>
      {errs.length > SHOWN && <p className="text-xs text-muted-foreground">{t('exterr.more', { count: errs.length - SHOWN })}</p>}
      {fix && <FixTarget ext={ext} />}
    </div>
  )
}
