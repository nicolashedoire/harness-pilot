// Settings -> Notifications -> "External sources": the webhooks (Stripe, Shopify, GitHub, JSON) with their state
// ("Secret missing · events refused" + "Add the secret"), URL, and menu (test, secret, new URL, delete); the
// scripts that posted (`pilot feed post`); "Add a webhook". `?hook=<id>` opens that hook's secret (the action of a
// "webhook refused" notification).
import * as React from 'react'
import { useSearchParams } from 'react-router'
import { FlaskConical, KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCreateHook, useDeleteHook, useFeedSettings, usePatchHook, useSettings, useTestHook } from '@/lib/queries'
import type { FeedHook, FeedHookKind } from '@/lib/types'
import { categoryOf } from '@/lib/feed'
import { useT, type TKey } from '@/i18n'
import {
  Badge,
  Button,
  confirm,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FormField,
  Input,
  Select,
  Sensitive,
  Skeleton,
  toast,
} from '@/components/ui'
import { Callout } from '@/features/common'
import { SettingsCard } from '@/pages/settings/sections/ui'

const SERVICE: Record<FeedHookKind, string> = { stripe: 'Stripe', shopify: 'Shopify', github: 'GitHub', generic: 'JSON' }
const needsSecret = (h: FeedHook) => !h.has_secret && h.kind !== 'generic'

function HookRow({ hook, onSecret }: { hook: FeedHook; onSecret: () => void }) {
  const t = useT()
  const test = useTestHook()
  const patch = usePatchHook()
  const del = useDeleteHook()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" data-testid="feed-source" data-source={hook.name}>
      <div className="grid min-w-0 flex-1 basis-64 gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            <Sensitive length={8}>{hook.name}</Sensitive>
          </span>
          <Badge variant="muted">{SERVICE[hook.kind]}</Badge>
          {needsSecret(hook) && <Badge variant="warning">{t('nset.secretMissing')}</Badge>}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <code className="truncate font-mono text-[11px]">
            <Sensitive length={24}>{hook.url}</Sensitive>
          </code>
          <CopyButton text={hook.url} className="size-6" />
        </span>
      </div>
      {needsSecret(hook) && (
        <Button variant="outline" size="sm" onClick={onSecret}>
          {t('feed.action.add_secret')}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('nset.more', { name: hook.name })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => test.mutate(hook.id, { onSuccess: () => toast.success(t('nset.hook.testSent')) })}>
            <FlaskConical /> {t('nset.hook.test')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onSecret}>
            <KeyRound /> {hook.has_secret ? t('nset.hook.changeSecret') : t('nset.hook.setSecret')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              if (await confirm({ title: t('nset.hook.regenerate'), description: t('nset.hook.regenerateDesc'), confirmText: t('nset.hook.regenerate') })) patch.mutate({ id: hook.id, regenerate: true })
            }}
          >
            <RefreshCw /> {t('nset.hook.regenerate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={async () => {
              if (await confirm({ title: t('nset.hook.delete', { name: hook.name }), description: t('nset.hook.deleteDesc'), destructive: true, confirmText: t('common.delete') }))
                del.mutate(hook.id)
            }}
          >
            <Trash2 /> {t('common.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function SourcesCard() {
  const t = useT()
  const { data, isPending } = useFeedSettings()
  const { data: settings } = useSettings()
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = React.useState(false)
  const [secretFor, setSecretFor] = React.useState<string | null>(null)
  const publicOk = /^https:\/\//.test(settings?.public_url || '')
  const hooks = data?.hooks ?? []
  const scripts = (data?.sources ?? []).filter((s) => !s.builtin && categoryOf({ source: s.source }) === 'webhooks' && !hooks.some((h) => h.name === s.source))
  // a "webhook refused" notification links here with ?hook=<id>
  const linked = params.get('hook')
  React.useEffect(() => {
    if (!linked || !data) return
    if (data.hooks.some((h) => h.id === linked)) setSecretFor(linked)
    const p = new URLSearchParams(params)
    p.delete('hook')
    setParams(p, { replace: true })
  }, [linked, data]) // eslint-disable-line react-hooks/exhaustive-deps
  const secretHook = hooks.find((h) => h.id === secretFor)

  return (
    <SettingsCard
      title={t('nset.sources')}
      description={t('nset.sourcesDesc')}
      actions={
        <Button size="sm" onClick={() => setAdding(true)} data-testid="add-hook">
          <Plus /> {t('nset.hook.add')}
        </Button>
      }
    >
      {!publicOk && (
        <Callout tone="warning" className="mb-3">
          {t('nset.hook.notPublic')}
        </Callout>
      )}
      {isPending || !data ? (
        <div className="grid gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : !hooks.length && !scripts.length ? (
        <p className="text-[13px] text-muted-foreground">{t('nset.noHooks')}</p>
      ) : (
        <ul className="divide-y border-t" data-testid="feed-sources">
          {hooks.map((h) => (
            <HookRow key={h.id} hook={h} onSecret={() => setSecretFor(h.id)} />
          ))}
          {scripts.map((s) => (
            <li key={s.source} className="flex items-center gap-2 py-3" data-testid="feed-source" data-source={s.source}>
              <span className="truncate text-sm font-medium">
                <Sensitive length={8}>{s.label}</Sensitive>
              </span>
              <Badge variant="muted">{t('nset.hook.script')}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t('nset.hook.cliHint')}</p>
      {adding && <AddHookDialog onClose={() => setAdding(false)} />}
      {secretHook && <SecretDialog hook={secretHook} onClose={() => setSecretFor(null)} />}
    </SettingsCard>
  )
}

function SecretDialog({ hook, onClose }: { hook: FeedHook; onClose: () => void }) {
  const t = useT()
  const patch = usePatchHook()
  const [v, setV] = React.useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('nset.hook.secretTitle', { name: hook.name })}</DialogTitle>
          <DialogDescription>{t(`nset.hook.secretHelp.${hook.kind}` as TKey)}</DialogDescription>
        </DialogHeader>
        <Input value={v} onChange={(e) => setV(e.target.value)} placeholder={t('nset.hook.secretPlaceholder')} autoComplete="off" autoFocus />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={patch.isPending} disabled={!v.trim()} onClick={() => patch.mutate({ id: hook.id, secret: v.trim() }, { onSuccess: onClose })}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AddHookDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const create = useCreateHook()
  const [kind, setKind] = React.useState<FeedHookKind>('stripe')
  const [name, setName] = React.useState('stripe')
  const [secret, setSecret] = React.useState('')
  const [made, setMade] = React.useState<FeedHook | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const kinds: FeedHookKind[] = ['stripe', 'shopify', 'github', 'generic']
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="hook-dialog">
        <DialogHeader>
          <DialogTitle>{made ? t('nset.hook.ready') : t('nset.hook.add')}</DialogTitle>
          <DialogDescription>{made ? t(`nset.hook.where.${made.kind}` as TKey) : t('nset.hook.addDesc')}</DialogDescription>
        </DialogHeader>
        {made ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all" data-testid="hook-url">
                {made.url}
              </code>
              <CopyButton text={made.url} />
            </div>
            {needsSecret(made) && <Callout tone="warning">{t('nset.hook.noSecretWarn')}</Callout>}
          </div>
        ) : (
          <form
            className="grid gap-4"
            id="hook-form"
            onSubmit={(e) => {
              e.preventDefault()
              setErr(null)
              create.mutate({ name, kind, secret: secret.trim() || undefined }, { onSuccess: setMade, onError: (x) => setErr(x.message) })
            }}
          >
            <FormField label={t('nset.hook.service')}>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as FeedHookKind)
                  if (kinds.includes(name as FeedHookKind) || name === 'webhook') setName(v === 'generic' ? 'webhook' : v)
                }}
                options={kinds.map((k) => ({ value: k, label: t(`nset.hook.service.${k}`) }))}
                aria-label={t('nset.hook.service')}
              />
            </FormField>
            <FormField label={t('nset.hook.sourceName')} hint={t('nset.hook.sourceNameHint')} error={err || undefined}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" data-testid="hook-name" />
            </FormField>
            <FormField label={t('nset.hook.secret')} hint={t(`nset.hook.secretHelp.${kind}`)}>
              <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t('nset.hook.secretPlaceholder')} autoComplete="off" />
            </FormField>
          </form>
        )}
        <DialogFooter>
          {made ? (
            <Button onClick={onClose}>{t('common.done')}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form="hook-form" loading={create.isPending} disabled={!name.trim()}>
                {t('nset.hook.create')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
