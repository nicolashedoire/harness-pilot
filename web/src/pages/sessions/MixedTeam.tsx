import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Square } from 'lucide-react'
import { useT } from '@/i18n'
import { api, errorMessage, seg } from '@/lib/api'
import { Button, toast } from '@/components/ui'
import { useSessionsUI } from './store'

type Team = { phase: string; agents: { id: string; provider: string; role: string; state: string }[] }

export function MixedTeam({ sid }: { sid: string }) {
  const t = useT()
  const qc = useQueryClient()
  const [busy, setBusy] = React.useState('')
  const openSession = useSessionsUI((s) => s.openSession)
  const { data } = useQuery({ queryKey: ['mixed-team', sid], queryFn: () => api.get<Team>(`/api/teams/${seg(sid)}`), refetchInterval: 1500 })
  const action = async (agent?: string) => {
    setBusy(agent || 'all')
    try {
      const endpoint = agent ? `/api/teams/${seg(sid)}/agents/${seg(agent)}/stop` : `/api/teams/${seg(sid)}/stop`
      await api.post(endpoint, {})
      await qc.invalidateQueries({ queryKey: ['mixed-team', sid] })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  if (!data) return null
  const active = ['launching', 'working', 'synthesizing'].includes(data.phase)
  return <section className="mx-auto grid w-full max-w-(--mx-read,860px) gap-2 px-3 py-3" aria-label={t('mixedTeam.title')}>
    <div className="flex items-center gap-2"><Bot className="size-4 text-primary" /><strong className="text-sm">{t('mixedTeam.title')}</strong><span className="text-xs text-muted-foreground">{t(`mixedTeam.phase.${data.phase}` as 'mixedTeam.phase.working')}</span>{active && <Button className="ml-auto" size="sm" variant="outline" disabled={!!busy} onClick={() => void action()}><Square />{t('mixedTeam.stopAll')}</Button>}</div>
    <div className="grid gap-2 sm:grid-cols-2">{data.agents.map((agent) => <div key={agent.id} className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-center gap-2"><strong>{agent.provider === 'codex' ? 'Codex' : 'Claude Code'}</strong><span className="ml-auto text-xs text-muted-foreground">{t(`mixedTeam.state.${agent.state}` as 'mixedTeam.state.idle')}</span></div>
      <p className="mt-2 text-xs text-muted-foreground">{agent.provider === 'codex' ? t('mixedTeam.codexRole') : t('mixedTeam.claudeRole')}</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => openSession(agent.id)}>{t('mixedTeam.open')}</Button>{data.phase === 'working' && agent.state === 'running' && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void action(agent.id)}>{t('mixedTeam.stopAgent')}</Button>}</div>
    </div>)}</div>
  </section>
}
