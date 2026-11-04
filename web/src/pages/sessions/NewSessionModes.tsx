// New session: the agent modes as cards (one agent / several agents) and what the chosen one will do.
// The mode ids are the values the form already sent: 'claude', 'codex', 'swarm' (Claude subagents), 'both' (Claude and
// Codex in turn), 'team' (mixed team) and `plugin:<id>` (an agent engine installed as an extension).
import * as React from 'react'
import { AlertTriangle, Check, Info } from 'lucide-react'
import { useT } from '@/i18n'
import { Badge } from '@/components/ui'
import { OptionCard } from '@/features/common'
import { AGENT_NAME, AgentIcon } from '@/features/agents/AgentIcon'
import { useClaudeStatus } from '@/lib/queries'
import type { AgentProvider } from '@/lib/types'
import { cn } from '@/lib/utils'
import { modelLabel } from './util'

const Pair = ({ sep }: { sep: string }) => (
  <>
    <AgentIcon agent="claude" size={13} label={null} />
    <span aria-hidden className="text-[11px] text-muted-foreground">{sep}</span>
    <AgentIcon agent="codex" size={13} label={null} />
  </>
)

export function ModePicker({ name, value, onChange, plugins, swarmAgents }: { name: string; value: string; onChange: (mode: string) => void; plugins: AgentProvider[]; swarmAgents: string }) {
  const t = useT()
  const card = (id: string, media: React.ReactNode, title: React.ReactNode, description: string, extra?: { badge?: React.ReactNode; className?: string }) => (
    <OptionCard key={id} name={name} value={id} selected={value === id} onSelect={() => onChange(id)} media={media} title={title} description={description} {...extra} />
  )
  const legend = 'pb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase'
  const grid = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2'
  return (
    <>
      <fieldset className="min-w-0">
        <legend className={legend}>{t('modes.one')}</legend>
        <div className={grid}>
          {card('claude', <AgentIcon agent="claude" size={17} label={null} />, AGENT_NAME.claude, t('modes.claude.desc'))}
          {card('codex', <AgentIcon agent="codex" size={17} label={null} />, AGENT_NAME.codex, t('modes.codex.desc'))}
          {plugins.map((p) => card(p.id, <AgentIcon agent="plugin" size={17} label={null} />, p.name, t('modes.plugin.desc')))}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className={legend}>{t('modes.several')}</legend>
        <div className={grid}>
          {card(
            'swarm',
            <>
              <AgentIcon agent="claude" size={15} label={null} />
              <span aria-hidden className="text-[10px] font-semibold text-muted-foreground tabular-nums">×{swarmAgents}</span>
            </>,
            t('modes.swarm.name'),
            t('modes.swarm.desc'),
          )}
          {card('both', <Pair sep="⇄" />, t('modes.both.name'), t('modes.both.desc'))}
          {card('team', <Pair sep="∥" />, t('modes.team.name'), t('modes.team.desc'), { badge: <Badge variant="muted">{t('modes.new')}</Badge>, className: 'col-span-full' })}
        </div>
      </fieldset>
    </>
  )
}

type Tone = 'ok' | 'info' | 'warn'
const MARK: Record<Tone, React.ReactNode> = {
  ok: <Check className="size-3.5 text-success" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
  warn: <AlertTriangle className="size-3.5 text-warning" />,
}

/** "What will happen" with the chosen mode: the steps, what is guaranteed, what is not possible, the accounts used. */
export function ModePanel({ mode, adapter, swarmAgents, teamRoles, className }: { mode: string; adapter?: AgentProvider; swarmAgents: string; teamRoles?: { claude: string | null; codex: string | null }; className?: string }) {
  const t = useT()
  const { data: claude } = useClaudeStatus()
  const plugin = mode.startsWith('plugin:')
  const attach: [Tone, string] = [plugin && !adapter?.capabilities.includes('attachments') ? 'warn' : 'ok', plugin && !adapter?.capabilities.includes('attachments') ? t('agentProviders.textOnly') : t('modes.attach')]
  let title: string = AGENT_NAME.claude
  let points: [Tone, string][] = []
  let facts: [string, string][] = []
  if (plugin) {
    title = adapter?.name || mode.slice(7)
    points = adapter ? [['ok', t('modes.plugin.p1', { name: adapter.name })], attach] : [['warn', t('agentProviders.unavailable')]]
  } else if (mode === 'codex') {
    title = AGENT_NAME.codex
    points = [['ok', t('modes.codex.p1')], ['info', t('modes.single.perms')], attach]
    facts = [[t('modes.fact.subscription'), 'ChatGPT']]
  } else if (mode === 'swarm') {
    title = t('modes.swarm.name')
    points = [['ok', t('modes.swarm.p1')], ['info', t('modes.swarm.p2')], ['info', t('modes.swarm.p3')], ['warn', t('modes.swarm.p4')]]
    facts = [[t('modes.fact.subscription'), 'Claude'], [t('modes.fact.subagents'), swarmAgents]]
  } else if (mode === 'both') {
    title = t('modes.both.name')
    points = [['ok', t('modes.both.p1')], ['ok', t('modes.both.p2')], ['info', t('modes.both.p3')], attach]
    facts = [[t('modes.fact.subscriptions'), 'Claude + ChatGPT']]
  } else if (mode === 'team') {
    title = t('modes.team.name')
    points = [['ok', t('modes.team.p1')], ['ok', t('modes.team.p2')], ['ok', t('modes.team.p3')], ['ok', t('modes.team.attach')], ['info', t('modes.team.p4')]]
    const def = claude?.default_model
    facts = [
      [t('modes.fact.subscriptions'), 'Claude + ChatGPT'],
      ...(def ? [[t('modes.fact.coordinator'), modelLabel(def, claude?.models)] as [string, string]] : []),
      [t('modes.fact.sessions'), t('modes.fact.teamSessions')],
    ]
  } else {
    points = [['ok', t('modes.claude.p1')], ['info', t('modes.single.perms')], attach]
    facts = [[t('modes.fact.subscription'), 'Claude']]
  }
  return (
    <aside aria-label={t('modes.panel')} className={cn('grid content-start gap-4 rounded-xl border bg-card p-4', className)}>
      <div>
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{t('modes.panel')}</div>
        <h2 className="mt-1 text-[15px] font-semibold">{title}</h2>
      </div>
      {mode === 'team' && <TeamFlow roles={teamRoles} />}
      <ul className="grid gap-2 text-[13px]">
        {/* keyed by rank: the texts are empty while their dictionary group loads */}
        {points.map(([tone, text], i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-0.5 shrink-0">{MARK[tone]}</span>
            <span className="min-w-0">{text}</span>
          </li>
        ))}
      </ul>
      {facts.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-[12.5px]">
          {facts.map(([k, v], i) => (
            <React.Fragment key={i}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="text-right">{v}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {mode === 'team' && <p className="text-xs leading-relaxed text-muted-foreground">{t('modes.team.footer')}</p>}
    </aside>
  )
}

/** The mixed team at a glance: the mission, two analyses side by side (their role as typed, once changed), the synthesis. */
function TeamFlow({ roles }: { roles?: { claude: string | null; codex: string | null } }) {
  const t = useT()
  const joints = (
    <div aria-hidden className="flex h-4 justify-around">
      <span className="w-0.5 bg-border" />
      <span className="w-0.5 bg-border" />
    </div>
  )
  return (
    <div className="grid text-[13px]">
      <div className="rounded-lg border bg-background px-3 py-2">{t('modes.team.mission')}</div>
      {joints}
      <div className="grid grid-cols-2 gap-2">
        {(['claude', 'codex'] as const).map((a) => (
          <div key={a} className="rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5 font-semibold">
              <AgentIcon agent={a} size={14} label={null} />
              {a === 'claude' ? 'Claude' : 'Codex'}
            </div>
            <div className="mt-1 line-clamp-3 text-xs leading-snug break-words text-muted-foreground">{roles?.[a]?.trim() || t(a === 'claude' ? 'mixedTeam.claudeRole' : 'mixedTeam.codexRole')}</div>
          </div>
        ))}
      </div>
      {joints}
      <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
        <AgentIcon agent="claude" size={14} label={null} />
        {t('modes.team.synthesis')}
      </div>
    </div>
  )
}
