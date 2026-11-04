// Sign the Codex CLI of this server in from the browser (API.md "System": /api/system/codex/login and /auth): a ChatGPT
// account with a one-time code entered on OpenAI's page, or an OpenAI API key handed to Codex. Shown by Settings ->
// Codex and by the wizard's Codex step. Codex keeps the credentials itself; nothing here stores or shows them again.
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, KeyRound, LogOut, PlugZap, RefreshCw, UserRound } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/i18n'
import { Badge, Button, CodeBlock, CopyButton, FormField, SecretInput, Skeleton, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, confirm } from '@/components/ui'
import { Callout, Steps } from '../common'
import { useCodexStatus, type CodexState } from './CodexStatus'

export type CodexLogin = {
  state: 'none' | 'starting' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  url: string | null
  code: string | null
  expires_at: number | null
  started_at: number | null
  error: string | null
}

const LOGIN_KEY = ['codex-login'] as const
const running = (s?: CodexLogin) => s?.state === 'starting' || s?.state === 'waiting'

/** After a sign-in change: the status everywhere (cron editor, new session, wizard). */
function useSignedInChanged() {
  const qc = useQueryClient()
  return React.useCallback(
    (status?: Partial<CodexState>) => {
      if (status && 'installed' in status) qc.setQueryData(['codex-status'], { installed: status.installed, authenticated: status.authenticated, reason: status.reason, method: status.method })
      void qc.invalidateQueries({ queryKey: ['codex-status'] })
      void qc.invalidateQueries({ queryKey: ['onboarding'] })
    },
    [qc],
  )
}

function useClock(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** ChatGPT account: start `codex login --device-auth` on the server, show its page and code, follow it until it ends. */
function DeviceSignIn({ onDone }: { onDone: () => void }) {
  const t = useT()
  const qc = useQueryClient()
  const changed = useSignedInChanged()
  // a flow seen running here (started here, or already running when the page opened): its end is shown
  const [watching, setWatching] = React.useState(false)
  const flow = useQuery({
    queryKey: LOGIN_KEY,
    queryFn: () => api.get<CodexLogin>('/api/system/codex/login'),
    refetchInterval: (q) => (running(q.state.data) ? 2000 : false),
  })
  const start = useMutation({
    mutationFn: () => api.post<CodexLogin>('/api/system/codex/login'),
    onSuccess: (r) => {
      setWatching(true)
      qc.setQueryData(LOGIN_KEY, r)
    },
  })
  const cancel = useMutation({
    mutationFn: () => api.del<CodexLogin>('/api/system/codex/login'),
    onSuccess: (r) => qc.setQueryData(LOGIN_KEY, r),
  })
  const s = flow.data
  React.useEffect(() => {
    if (running(s)) setWatching(true)
  }, [s])
  React.useEffect(() => {
    if (watching && s?.state === 'succeeded') {
      setWatching(false)
      changed()
      onDone()
    }
  }, [watching, s?.state, changed, onDone])
  const now = useClock(s?.state === 'waiting')
  if (flow.isPending) return <Skeleton className="h-10 w-48" />

  if (s?.state === 'waiting' && s.url && s.code) {
    const left = s.expires_at ? s.expires_at * 1000 - now : null
    return (
      <div className="grid gap-4" data-testid="codex-device">
        <Steps
          items={[
            <div className="grid gap-1.5">
              <span>{t('codex.stepOpen')}</span>
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit max-w-full items-center gap-1.5 text-sm font-medium [overflow-wrap:anywhere]">
                {s.url.replace(/^https:\/\//, '')} <ExternalLink className="size-3.5 shrink-0" />
              </a>
            </div>,
            <div className="grid gap-1.5">
              <span>{t('codex.stepCode')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-lg font-semibold tracking-[0.15em] select-all" data-testid="codex-code">
                  {s.code}
                </code>
                <CopyButton text={s.code} label={t('codex.copyCode')} />
                {left !== null && <span className="text-xs text-muted-foreground tabular-nums">{left > 0 ? t('codex.expiresIn', { time: mmss(left) }) : t('codex.expiring')}</span>}
              </div>
            </div>,
            <span className="inline-flex items-center gap-2">
              <Spinner className="text-muted-foreground" /> {t('codex.stepWait')}
            </span>,
          ]}
        />
        <p className="text-xs text-muted-foreground">{t('codex.codeWarning')}</p>
        <Button variant="outline" size="sm" className="w-fit" loading={cancel.isPending} onClick={() => cancel.mutate()}>
          {t('common.cancel')}
        </Button>
      </div>
    )
  }

  const ended = watching && s && (s.state === 'failed' || s.state === 'expired')
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('codex.deviceIntro')}</p>
      {ended && (
        <Callout tone="error" title={s.state === 'expired' ? t('codex.expired') : t('codex.failed')}>
          {s.state === 'expired' ? t('codex.expiredDesc') : `${s.error || ''} ${t('codex.failedHint')}`.trim()}
        </Callout>
      )}
      {start.isError && <Callout tone="error" title={t('codex.failed')}>{errorMessage(start.error)}</Callout>}
      <div className="flex flex-wrap items-center gap-3">
        <Button loading={start.isPending || running(s)} onClick={() => start.mutate()} data-testid="codex-get-code">
          {ended ? <RefreshCw /> : <PlugZap />} {ended ? t('codex.newCode') : t('codex.getCode')}
        </Button>
        {(start.isPending || s?.state === 'starting') && <span className="text-[13px] text-muted-foreground">{t('codex.asking')}</span>}
      </div>
    </div>
  )
}

/** OpenAI API key: handed to `codex login --with-api-key` on the server, never kept by the page. */
function ApiKeySignIn({ onDone }: { onDone: () => void }) {
  const t = useT()
  const changed = useSignedInChanged()
  const [value, setValue] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const save = useMutation({ mutationFn: (v: string) => api.post<{ ok: true } & CodexState>('/api/system/codex/auth', { value: v }) })
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v = value.trim()
    if (!v) return setError(t('codex.pasteFirst'))
    setError(null)
    save.mutate(v, {
      onSuccess: (r) => {
        setValue('')
        changed(r)
        onDone()
      },
      onError: (err) => setError(errorMessage(err)),
    })
  }
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <p className="text-sm text-muted-foreground">{t('codex.apiKeyIntro')}</p>
      <Steps
        items={[
          <span>
            {t('codex.apiStep1')}{' '}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
              platform.openai.com
            </a>
          </span>,
          <span>{t('codex.apiStep2')}</span>,
        ]}
      />
      <FormField label={t('codex.keyLabel')} error={error || undefined} hint={t('codex.keyHint')}>
        <SecretInput value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-…" data-testid="codex-key" />
      </FormField>
      <Button type="submit" className="w-fit" loading={save.isPending}>
        <KeyRound /> {t('codex.saveKey')}
      </Button>
    </form>
  )
}

function SignInForm({ onDone }: { onDone: () => void }) {
  const t = useT()
  const [tab, setTab] = React.useState<'device' | 'api_key'>('device')
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
      <TabsList className="w-full sm:w-auto">
        <TabsTrigger value="device" className="flex-1">
          <UserRound /> {t('codex.tabChatgpt')}
        </TabsTrigger>
        <TabsTrigger value="api_key" className="flex-1">
          <KeyRound /> {t('codex.tabApiKey')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="device">
        <DeviceSignIn onDone={onDone} />
      </TabsContent>
      <TabsContent value="api_key">
        <ApiKeySignIn onDone={onDone} />
      </TabsContent>
      <div className="mt-5 grid gap-2 border-t pt-4 text-[13px] text-muted-foreground">
        <span>{t('codex.terminal')}</span>
        <CodeBlock inline code="codex login" className="max-w-xs" />
      </div>
    </Tabs>
  )
}

/** Status + sign-in (when signed out, or to use another account) + sign-out. */
export function CodexConnect() {
  const t = useT()
  const qc = useQueryClient()
  const q = useCodexStatus()
  const changed = useSignedInChanged()
  const [switching, setSwitching] = React.useState(false)
  const logout = useMutation({ mutationFn: () => api.del<{ ok: true } & CodexState>('/api/system/codex/auth'), onSuccess: (r) => changed(r) })
  const done = React.useCallback(() => setSwitching(false), [])
  const stopSwitching = () => {
    setSwitching(false)
    // keep the current account: a code still waiting must not sign another one in later
    if (running(qc.getQueryData<CodexLogin>(LOGIN_KEY))) void api.del<CodexLogin>('/api/system/codex/login').then((r) => qc.setQueryData(LOGIN_KEY, r))
  }
  if (q.isPending) return <Skeleton className="h-[74px] rounded-lg" />
  const s = q.data
  const check = (
    <Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>
      {t('codex.check')}
    </Button>
  )
  if (q.isError || !s || s.authenticated === null) return <Callout tone="info" title={t('codex.unknown')} action={check} />
  if (!s.installed)
    return (
      <Callout tone="error" title={t('codex.notInstalled')} action={check}>
        <span className="grid gap-2">
          {t('codex.installHint')}
          <CodeBlock inline code="npm install -g @openai/codex" className="max-w-sm" />
        </span>
      </Callout>
    )
  return (
    <div className="grid gap-5" data-testid="codex-connect">
      <Callout tone={s.authenticated ? 'success' : 'warning'} title={s.authenticated ? t('codex.connected') : t('codex.notConnected')}>
        {s.authenticated && s.method && <Badge variant="outline">{t(s.method === 'chatgpt' ? 'codex.method.chatgpt' : 'codex.method.api_key')}</Badge>}
      </Callout>
      {logout.isError && <Callout tone="error" title={t('codex.signOutFailed')}>{errorMessage(logout.error)}</Callout>}
      {s.authenticated && !switching && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setSwitching(true)}>
            <RefreshCw /> {t('codex.switch')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            loading={logout.isPending}
            onClick={async () => {
              if (await confirm({ title: t('codex.signOutTitle'), description: t('codex.signOutDesc'), destructive: true, confirmText: t('codex.signOut') })) logout.mutate()
            }}
          >
            <LogOut /> {t('codex.signOut')}
          </Button>
        </div>
      )}
      {(!s.authenticated || switching) && (
        <div className="rounded-lg border p-4 md:p-5">
          <SignInForm onDone={done} />
          {switching && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={stopSwitching}>
              {t('codex.keepAccount')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
