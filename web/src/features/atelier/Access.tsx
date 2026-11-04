// What an extension may use now (GET /api/extensions `access`, API.md Permissions -> Access), under what it declares
// on a creation's page: the keys it was granted before permissions existed (amber: nothing limits them until it
// declares them), the reads refused while it ran, and the decision buttons of Settings -> Extensions (Allow / Refuse /
// Ask again / Withdraw: features/extensions/Permissions.tsx).
import { KeyRound, ShieldAlert } from 'lucide-react'
import type { Extension, ExtPermissionRefusal } from '@/lib/types'
import { fmtRelative } from '@/lib/format'
import { useLang, useT, type TKey } from '@/i18n'
import { Sensitive } from '@/components/ui'
import { ExtensionPermissions } from '@/features/extensions/Permissions'

const REASON: Record<ExtPermissionRefusal['reason'], TKey> = {
  undeclared: 'atelier.access.undeclared',
  not_allowed: 'atelier.access.notAllowed',
  refused: 'atelier.access.refused',
}

export function AccessBlock({ ext }: { ext: Extension }) {
  const t = useT()
  const lang = useLang()
  const a = ext.access
  if (!a) return null
  const legacy = a.legacy.secrets.map((s) => s.name)
  return (
    <div className="grid gap-2" data-testid="atelier-access">
      {(a.state === 'legacy' || legacy.length > 0) && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning" data-testid="atelier-legacy">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {legacy.length ? (
              <>
                {t('atelier.access.legacyKeys')}{' '}
                {legacy.map((n, i) => (
                  <code key={n} className="font-mono text-xs">
                    {i > 0 && ', '}
                    <Sensitive length={8}>{n}</Sensitive>
                  </code>
                ))}
                {'. '}
              </>
            ) : (
              <>{t('atelier.access.legacy')} </>
            )}
            <span className="text-muted-foreground">{t('atelier.access.legacyHint')}</span>
          </span>
        </p>
      )}
      {a.denied.length > 0 && (
        <div className="grid gap-1.5 rounded-lg border px-3 py-2 text-[13px]">
          <p className="text-xs font-medium text-muted-foreground">{t('atelier.access.denied')}</p>
          <ul className="grid gap-1">
            {a.denied.map((d) => (
              <li key={`${d.name}:${d.reason}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <KeyRound className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
                <code className="font-mono text-xs">
                  <Sensitive length={8}>{d.name}</Sensitive>
                </code>
                <span className="text-muted-foreground">{t(REASON[d.reason] ?? 'atelier.access.notAllowed')}</span>
                <span className="text-xs text-muted-foreground">
                  · {d.count > 1 ? `${t('atelier.err.times', { count: d.count })} · ` : ''}
                  {fmtRelative(d.at, lang)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ExtensionPermissions ext={ext} summary={false} legacyNote={false} />
    </div>
  )
}
