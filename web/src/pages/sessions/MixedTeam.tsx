import * as React from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ChevronDown, Square } from 'lucide-react'
import { useT, type TKey } from '@/i18n'
import { api, errorMessage, seg } from '@/lib/api'
import { Badge, Button, Sensitive, Tooltip, toast } from '@/components/ui'
import { AGENT_NAME, AgentIcon } from '@/features/agents/AgentIcon'
import { cn } from '@/lib/utils'
import { useSessionsUI } from './store'

type Act = { kind: 'read' | 'search' | 'run' | 'edit' | 'web' | 'say' | 'other'; target: string }
type Agent = { id: string; provider: string; role: string; custom_role?: boolean; state: string; started_at: number | null; finished_at: number | null; activity?: Act[]; report?: string | null }
type Team = { phase: string; created?: number; coordinator?: 'claude' | 'codex'; agents: Agent[] }

const ACTIVE = ['launching', 'working', 'synthesizing']
/** The team of this coordinator session is at work (its composer waits, "Stop team" shows). */
export const teamActive = (phase?: string | null) => !!phase && ACTIVE.includes(phase)
const STEPS = ['launching', 'working', 'synthesizing', 'completed'] as const
/** The verb before what a tool call worked on ("Read", "A lu"); `say` and `other` show the text alone. */
const VERB: Partial<Record<Act['kind'], TKey>> = { read: 'teamx.act.read', search: 'teamx.act.search', run: 'teamx.act.run', edit: 'teamx.act.edit', web: 'teamx.act.web' }

/** 75 -> "1:15", 3725 -> "1:02:05". */
const clock = (s: number) => {
  const v = Math.max(0, Math.floor(s))
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), r = String(v % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

/** Stops the whole team (workers and coordinator). The panel, the session header and the locked composer share it:
 *  one request at a time, every "Stop team" button shows it running. */
export function useStopTeam(sid: string) {
  const qc = useQueryClient()
  const mutationKey = ['team-stop', sid]
  const m = useMutation({
    mutationKey,
    mutationFn: () => api.post(`/api/teams/${seg(sid)}/stop`, {}),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['mixed-team', sid] }), qc.invalidateQueries({ queryKey: ['sessions'] })]),
    onError: (error) => toast.error(errorMessage(error)),
  })
  const pending = useIsMutating({ mutationKey }) > 0
  // (the cache, not `pending`: a second click before the next render sends nothing either)
  return { stop: () => { if (!qc.isMutating({ mutationKey })) m.mutate() }, pending }
}

/** "Stop team" of the session header (`compact`: red, its label hides in a narrow header - the tooltip and the
 *  accessible name keep it) and of the locked composer. */
export function StopTeamButton({ sid, compact }: { sid: string; compact?: boolean }) {
  const t = useT()
  const { stop, pending } = useStopTeam(sid)
  const label = t('mixedTeam.stopAll')
  const button = (
    <Button size="sm" variant="outline" aria-label={label} loading={pending} onClick={stop} className={cn('shrink-0', compact && 'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive @max-[34rem]:px-2')} data-testid="team-stop">
      <Square className="size-3.5!" />
      <span className={cn(compact && '@max-[34rem]:sr-only')}>{label}</span>
    </Button>
  )
  return compact ? <Tooltip content={label}>{button}</Tooltip> : button
}

/** The mixed team of a coordinator session: its steps, each worker at work (elapsed time, last actions, the start of
 *  its report) and the synthesis to come. Open while the team works; one line, which opens, once it is over. */
export function MixedTeam({ sid }: { sid: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [busy, setBusy] = React.useState('')
  const [open, setOpen] = React.useState<boolean | null>(null)
  const openSession = useSessionsUI((s) => s.openSession)
  const { data } = useQuery({
    queryKey: ['mixed-team', sid],
    queryFn: () => api.get<Team>(`/api/teams/${seg(sid)}`),
    // polled only while the team works (the server re-reads a worker's log only when it changed)
    refetchInterval: (q) => (!q.state.data || ACTIVE.includes(q.state.data.phase) ? 2000 : false),
  })
  const running = !!data?.agents.some((a) => a.state === 'running')
  const [now, setNow] = React.useState(() => Date.now() / 1000)
  React.useEffect(() => {
    if (!running) return
    setNow(Date.now() / 1000)
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [running])
  const team = useStopTeam(sid)
  const stopAgent = async (agent: string) => {
    setBusy(agent)
    try {
      await api.post(`/api/teams/${seg(sid)}/agents/${seg(agent)}/stop`, {})
      await qc.invalidateQueries({ queryKey: ['mixed-team', sid] })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  if (!data) return null
  const active = ACTIVE.includes(data.phase)
  const shown = open ?? active
  const over = data.phase === 'stopped' || data.phase === 'error'
  const reached = over ? -1 : STEPS.indexOf(data.phase as (typeof STEPS)[number])
  const ready = data.agents.filter((a) => a.state !== 'running').length
  const lead = data.coordinator === 'codex' ? 'codex' : 'claude'
  const footer = t(data.phase === 'synthesizing' || data.phase === 'completed' || over ? (`teamx.footer.${data.phase}` as TKey) : 'teamx.footer.wait', { agent: lead === 'codex' ? 'Codex' : 'Claude' })
  return (
    <section className="mx-auto grid w-full max-w-(--mx-read,860px) gap-2 px-3 py-2" aria-label={t('mixedTeam.title')}>
      <div className="@container max-h-[50dvh] overflow-y-auto rounded-xl border bg-card">
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5', shown && 'border-b')}>
          <button type="button" className="flex min-w-0 items-center gap-1.5 rounded-md text-left text-sm font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-expanded={shown} onClick={() => setOpen(!shown)}>
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !shown && '-rotate-90')} />
            {t('mixedTeam.title')}
          </button>
          {over && <Badge className="ml-auto" variant={data.phase === 'error' ? 'destructive' : 'muted'}>{t(`mixedTeam.phase.${data.phase}` as TKey)}</Badge>}
          {/* stopped or failed: the badge says it (which step it reached is not kept) */}
          {!over && <ol className="ml-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" aria-label={t('teamx.steps')}>
            {STEPS.map((step, i) => {
              const done = i < reached || (step === 'completed' && reached === i)
              const current = i === reached && !done
              return (
                <li key={step} className="flex items-center gap-1.5" aria-current={current ? 'step' : undefined}>
                  {i > 0 && <span aria-hidden className="h-0.5 w-3 bg-border" />}
                  <span aria-hidden className={cn('flex size-4 items-center justify-center rounded-full border-2', done ? 'border-success bg-success/15 text-success' : current ? 'border-primary ring-3 ring-primary/20' : 'border-border')}>
                    {done && <Check className="size-2.5" strokeWidth={3} />}
                  </span>
                  <span className={cn(done ? 'text-success' : current ? 'font-medium text-foreground' : 'text-muted-foreground', !current && '@max-md:sr-only')}>{t(`teamx.step.${step}` as TKey)}</span>
                </li>
              )
            })}
          </ol>}
          {active && (
            <Button size="sm" variant="outline" disabled={!!busy} loading={team.pending} onClick={team.stop}>
              <Square />
              {t('mixedTeam.stopAll')}
            </Button>
          )}
        </div>
        {shown && (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-px bg-border">
              {data.agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} now={now} canStop={data.phase === 'working' && agent.state === 'running'} busy={!!busy || team.pending} onStop={() => void stopAgent(agent.id)} onOpen={() => openSession(agent.id)} />
              ))}
            </div>
            <div className="flex items-center gap-2 border-t px-3 py-2.5 text-[13px] text-muted-foreground">
              <AgentIcon agent={lead} size={15} label={null} />
              <span className="min-w-0 flex-1">{footer}</span>
              {(data.phase === 'launching' || data.phase === 'working') && <span className="shrink-0 text-xs tabular-nums">{t('teamx.footer.ready', { count: ready, total: data.agents.length })}</span>}
            </div>
          </>
        )}
      </div>
      {active && (
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <Bell className="size-3.5 shrink-0" />
          {t('teamx.notice')}
        </p>
      )}
    </section>
  )
}

function AgentCard({ agent, now, canStop, busy, onStop, onOpen }: { agent: Agent; now: number; canStop: boolean; busy: boolean; onStop: () => void; onOpen: () => void }) {
  const t = useT()
  const codex = agent.provider === 'codex'
  const running = agent.state === 'running'
  const timed = running || agent.state === 'idle'
  const elapsed = timed && agent.started_at ? clock((agent.finished_at ?? now) - agent.started_at) : ''
  const acts = agent.activity || []
  const tone = running ? 'bg-primary/10 text-primary' : agent.state === 'idle' ? 'bg-success/12 text-success' : agent.state === 'error' ? 'bg-destructive/12 text-destructive' : 'bg-muted text-muted-foreground'
  // the start of its report, as plain text (no Markdown marks, no blank lines)
  const report = !running && agent.report ? agent.report.replace(/[*_`#>]+/g, '').replace(/\n\s*\n/g, '\n').trim() : ''
  return (
    <div className="grid content-start gap-2.5 bg-card p-3">
      <div className="flex items-center gap-2">
        <AgentIcon agent={codex ? 'codex' : 'claude'} size={18} label={null} />
        <strong className="text-sm">{codex ? AGENT_NAME.codex : AGENT_NAME.claude}</strong>
        <span className={cn('ml-auto flex h-5.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px]', tone)}>
          {running && <span aria-hidden className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />}
          {t(`mixedTeam.state.${agent.state}` as TKey)}
          {elapsed && <span className="font-mono tabular-nums">· {elapsed}</span>}
        </span>
      </div>
      <p className="line-clamp-3 text-xs break-words text-muted-foreground">{agent.custom_role ? <Sensitive length={16}>{agent.role}</Sensitive> : t(codex ? 'mixedTeam.codexRole' : 'mixedTeam.claudeRole')}</p>
      {report ? (
        <Sensitive block>
          <div className="rounded-lg bg-background px-3 py-2">
            <p className="line-clamp-5 text-[13px] leading-relaxed break-words whitespace-pre-line text-foreground/90">{report}</p>
          </div>
        </Sensitive>
      ) : acts.length > 0 || running ? (
        <ul className="grid gap-1.5 rounded-lg bg-background p-2.5 text-xs text-muted-foreground">
          {acts.length === 0 && (
            <li className="flex items-baseline gap-2">
              <span aria-hidden className="text-primary">●</span>
              {t('teamx.starting')}
            </li>
          )}
          {acts.map((a, i) => {
            const current = running && i === acts.length - 1
            const verb = VERB[a.kind]
            return (
              <li key={i} className="flex min-w-0 items-baseline gap-2">
                <span aria-hidden className={cn('shrink-0', current ? 'text-primary' : 'text-success')}>{current ? '●' : '✓'}</span>
                <span className={cn('min-w-0 truncate', current && 'text-foreground')}>
                  {verb && <>{t(verb)} </>}
                  <Sensitive length={16}>{verb ? <code className="font-mono text-[11.5px] text-foreground/85">{a.target}</code> : a.target}</Sensitive>
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={onOpen}>{t('mixedTeam.open')}</Button>
        {canStop && <Button size="sm" variant="ghost" disabled={busy} onClick={onStop}>{t('mixedTeam.stopAgent')}</Button>}
      </div>
    </div>
  )
}
