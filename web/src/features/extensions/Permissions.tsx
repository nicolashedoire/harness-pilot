// What an extension declares it uses (manifest "permissions") and what the user allowed (GET /api/extensions `access`),
// on its row in Settings -> Extensions, the prompt a dashboard card shows when card() waits for a key, and the one an
// HTML widget shows before its frame may reach a declared site.
// Allow / Refuse / Ask again: POST /api/extensions/{id}/consent (docs/dev/API.md, Permissions).
import { Globe, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useExtensionConsent } from '@/lib/queries'
import type { Extension, ExtPermissionRefusal } from '@/lib/types'
import { useT } from '@/i18n'
import { Badge, Button } from '@/components/ui'

/** The keys, sites and files an extension declares, what waits for the user, and the buttons to decide. */
export function ExtensionPermissions({ ext }: { ext: Extension }) {
  const t = useT()
  const consent = useExtensionConsent()
  const a = ext.access
  if (!a || (ext.type !== 'widget' && ext.type !== 'page')) return null
  const p = ext.permissions
  const busy = (d: string) => consent.isPending && consent.variables?.decision === d
  const decide = (decision: 'always' | 'deny' | 'reset') => consent.mutate({ id: ext.id, decision })
  const keys = [...a.secrets.map((s) => s.name), ...(a.network ?? []).map((n) => n.host)]
  const legacy = a.legacy.secrets.map((s) => s.name)
  const legacySites = (a.legacy.network ?? []).map((n) => n.host)
  const askKeys = a.secrets.filter((s) => s.status === 'pending').map((s) => s.name)
  const askSites = (a.network ?? []).filter((n) => n.status === 'pending').map((n) => n.host)
  return (
    <div className="grid gap-1.5 text-[13px]" data-testid="ext-permissions">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        {a.state === 'declared' ? (
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
        )}
        {a.state !== 'declared' && <Badge variant="outline">{t('ext.perm.notDeclared')}</Badge>}
        {a.state === 'declared' && p && !p.network.length && !p.secrets.length && !p.read.length && <span>{t('ext.perm.nothing')}</span>}
        {a.state === 'declared' && p && (
          <>
            {p.secrets.length > 0 && <span>{t('ext.perm.keys', { names: p.secrets.join(', ') })}</span>}
            {p.network.length > 0 && <span>{t('ext.perm.network', { hosts: p.network.join(', ') })}</span>}
            {p.read.length > 0 && <span>{t('ext.perm.read', { paths: p.read.join(', ') })}</span>}
          </>
        )}
        {a.refused && <Badge variant="muted">{t('ext.perm.refused')}</Badge>}
      </div>
      {a.state === 'legacy' && (
        <div className="grid gap-0.5 text-xs text-muted-foreground">
          <p>{legacy.length ? t('ext.perm.legacyKeys', { names: legacy.join(', ') }) : t('ext.perm.legacy')}</p>
          {legacySites.length > 0 && <p>{t('ext.perm.legacySites', { hosts: legacySites.join(', ') })}</p>}
          {a.network_open && ext.type === 'widget' && <p>{t('ext.perm.networkOpen')}</p>}
        </div>
      )}
      {a.state === 'undeclared' && <p className="text-xs text-muted-foreground">{t('ext.perm.undeclared')}</p>}
      {a.pending && !a.refused && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
          {askKeys.length ? <KeyRound className="size-3.5 shrink-0 text-warning" aria-hidden /> : <Globe className="size-3.5 shrink-0 text-warning" aria-hidden />}
          <span className="grid min-w-0 flex-1">
            {askKeys.length > 0 && <span>{t('ext.perm.asks', { names: askKeys.join(', ') })}</span>}
            {askSites.length > 0 && <span>{t('ext.perm.asksSites', { hosts: askSites.join(', ') })}</span>}
          </span>
          <Button size="sm" loading={busy('always')} onClick={() => decide('always')}>
            {t('ext.perm.allow')}
          </Button>
          <Button variant="ghost" size="sm" loading={busy('deny')} onClick={() => decide('deny')}>
            {t('ext.perm.refuse')}
          </Button>
        </div>
      )}
      {(a.refused || (a.state === 'declared' && keys.length > 0 && !a.pending)) && (
        <Button variant="link" size="sm" className="h-auto w-fit p-0 text-xs" loading={busy('reset')} onClick={() => decide('reset')}>
          {a.refused ? t('ext.perm.askAgain') : t('ext.perm.revoke')}
        </Button>
      )}
    </div>
  )
}

/** A dashboard card whose card() waits for a key: what it asks, Allow / Refuse. Other refusals show as errors. */
export function CardConsent({ id, refusal }: { id: string; refusal: ExtPermissionRefusal }) {
  const t = useT()
  const consent = useExtensionConsent()
  const busy = (d: string) => consent.isPending && consent.variables?.decision === d
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-center" data-testid="card-consent">
      <KeyRound className="size-5 text-warning" aria-hidden />
      <p className="text-[13px] text-muted-foreground">{t('ext.perm.cardAsks', { name: refusal.name })}</p>
      <div className="flex gap-2">
        <Button size="sm" loading={busy('always')} onClick={() => consent.mutate({ id, decision: 'always' })}>
          {t('ext.perm.allow')}
        </Button>
        <Button variant="ghost" size="sm" loading={busy('deny')} onClick={() => consent.mutate({ id, decision: 'deny' })}>
          {t('ext.perm.refuse')}
        </Button>
      </div>
    </div>
  )
}

/** An HTML widget whose declared sites wait for the user: Always allow / Allow once / Refuse, before the frame loads. */
export function FrameConsent({ id, hosts, onGrant, onDecided }: { id: string; hosts: string[]; onGrant: (grant: string) => void; onDecided: () => void }) {
  const t = useT()
  const consent = useExtensionConsent()
  const busy = (d: string) => consent.isPending && consent.variables?.decision === d
  return (
    <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-center" data-testid="frame-consent">
      <Globe className="size-5 text-warning" aria-hidden />
      <p className="text-[13px] text-muted-foreground">{t('ext.perm.frameAsks', { hosts: hosts.join(', ') })}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" loading={busy('always')} onClick={() => consent.mutate({ id, decision: 'always' }, { onSuccess: onDecided })}>
          {t('ext.perm.allow')}
        </Button>
        <Button variant="outline" size="sm" loading={busy('once')} onClick={() => consent.mutate({ id, decision: 'once' }, { onSuccess: (r) => (r.grant ? onGrant(r.grant) : onDecided()) })}>
          {t('ext.perm.once')}
        </Button>
        <Button variant="ghost" size="sm" loading={busy('deny')} onClick={() => consent.mutate({ id, decision: 'deny' }, { onSuccess: onDecided })}>
          {t('ext.perm.refuse')}
        </Button>
      </div>
    </div>
  )
}
