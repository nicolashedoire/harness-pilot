// What a creation asks for (API.md#atelier `Permissions`, the permissions contract): network hosts, keys and secrets,
// files it reads. A dot per row: muted when it asks for nothing, amber when it does. A creation that declares nothing
// says so in amber: nothing limits what it does.
import { FileText, Globe, KeyRound, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { AtelierPermissions } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Sensitive } from '@/components/ui'

const ROWS: { key: 'network' | 'secrets' | 'read'; label: TKey; none: TKey; icon: LucideIcon }[] = [
  { key: 'network', label: 'atelier.perm.network', none: 'atelier.perm.noNetwork', icon: Globe },
  { key: 'secrets', label: 'atelier.perm.secrets', none: 'atelier.perm.noSecrets', icon: KeyRound },
  { key: 'read', label: 'atelier.perm.read', none: 'atelier.perm.noRead', icon: FileText },
]

/** Does it ask for anything at all (or declare nothing)? */
export const asksSomething = (p: AtelierPermissions | null | undefined) => !p || !p.declared || p.network.length + p.secrets.length + (p.read?.length ?? 0) > 0

export function PermissionRows({ permissions: p, compact, className }: { permissions: AtelierPermissions | null | undefined; compact?: boolean; className?: string }) {
  const t = useT()
  const declared = !!p?.declared
  return (
    <div className={cn('grid gap-2', className)}>
      {!declared && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning" data-testid="atelier-undeclared">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">{t('atelier.perm.undeclared')}</strong> {!compact && t('atelier.perm.undeclaredHint')}
          </span>
        </p>
      )}
      <ul className={cn('grid', compact ? 'gap-x-4 gap-y-1.5 @lg:grid-cols-3' : 'divide-y rounded-lg border')}>
        {ROWS.map((r) => {
          const values = (p?.[r.key] ?? []) as string[]
          const some = values.length > 0
          return (
            <li key={r.key} className={cn('flex items-start gap-2.5 text-[13px]', !compact && 'px-3 py-2.5')} data-testid={`atelier-perm-${r.key}`}>
              <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', !declared ? 'bg-warning/60' : some ? 'bg-warning' : 'bg-muted-foreground/40')} />
              <r.icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="font-medium">{t(r.label)}</span>
                {!declared ? (
                  <span className="text-warning">{t('atelier.perm.notDeclared')}</span>
                ) : some ? (
                  <span className="flex flex-wrap gap-1">
                    {values.map((v) => (
                      <code key={v} className="rounded bg-muted px-1.5 py-px font-mono text-xs break-all">
                        <Sensitive length={10}>{v}</Sensitive>
                      </code>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t(r.none)}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
