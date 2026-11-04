import * as React from 'react'
import { Bot, Network } from 'lucide-react'
import { useT } from '@/i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Sensitive } from '@/components/ui'
import { loadEarlier, taskStatus, useLogSelect, type Item } from './log'
import { TaskStatusIcon } from './Tasks'
import { fmtTokens } from './util'

type AgentItem = Extract<Item, { kind: 'tool' }>

export function AgentMap({ sid, running, open, onOpenChange }: { sid: string; running: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const items = useLogSelect(sid, (s) => s.items)
  const moreBefore = useLogSelect(sid, (s) => s.moreBefore)
  const loadingEarlier = useLogSelect(sid, (s) => s.loadingEarlier)
  const lastUserAt = useLogSelect(sid, (s) => s.lastUserAt)
  const agents = React.useMemo(() => items.filter((item): item is AgentItem => item.kind === 'tool' && (item.use.name === 'Agent' || item.use.name === 'Task')), [items])
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] overflow-y-auto md:max-w-3xl">
      <DialogHeader><DialogTitle>{t('swarm.map')}</DialogTitle><DialogDescription>{t('swarm.mapHint')}</DialogDescription></DialogHeader>
      <div className="grid gap-4 md:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)] md:items-start">
        <div className="flex items-center gap-2 rounded-lg border bg-card p-3"><Network className="size-4 text-primary" /><span className="font-medium">{t('swarm.coordinator')}</span></div>
        <div className="grid gap-2 border-l-2 border-border pl-4" aria-live="polite">
          {!agents.length && <p className="text-sm text-muted-foreground">{t('swarm.empty')}</p>}
          {agents.map((agent) => {
            const input = agent.use.input && typeof agent.use.input === 'object' ? agent.use.input as Record<string, unknown> : {}
            const title = typeof input.description === 'string' && input.description.trim() ? input.description : agent.use.summary || t('swarm.agent')
            const status = agent.task ? taskStatus(agent.task, running) : agent.result ? (agent.result.is_error ? 'failed' : 'completed') : running && (!lastUserAt || agent.use.at >= lastUserAt) ? 'running' : 'interrupted'
            // A background Agent tool returns an acknowledgement immediately; its final report comes in the
            // task event. Foreground tools instead return the actual answer in the tool result.
            const result = agent.task?.background ? '' : agent.result?.text || ''
            const summary = agent.task?.summary && agent.task.summary !== title ? agent.task.summary : ''
            const report = (result || summary).replace(/\nagentId: [^\n]*(?=\n|$)/g, '').replace(/\n<usage>[\s\S]*?<\/usage>\s*$/g, '').trim()
            return <details key={agent.key} className="rounded-lg border bg-card p-3 text-sm">
              <summary className="flex cursor-pointer items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><Sensitive length={16}><span className="font-medium">{title}</span></Sensitive><span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><TaskStatusIcon status={status} />{t(`tasks.status.${status}`)}</span></summary>
              {status === 'running' && !!agent.task?.activity && <p className="mt-2 text-xs text-muted-foreground">{t('swarm.activity')} <Sensitive length={16}>{agent.task.activity}</Sensitive></p>}
              {!!agent.task?.tokens && <p className="mt-2 text-xs text-muted-foreground">{t('tasks.tokens', { count: fmtTokens(agent.task.tokens) })}</p>}
              {typeof input.prompt === 'string' && <div className="mt-3 grid gap-1"><span className="text-xs font-medium text-muted-foreground">{t('swarm.assignment')}</span><Sensitive block><p className="whitespace-pre-wrap break-words">{input.prompt}</p></Sensitive></div>}
              {report && <div className="mt-3 grid gap-1"><span className="text-xs font-medium text-muted-foreground">{t('swarm.result')}</span><Sensitive block><pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-sans">{report}</pre></Sensitive></div>}
              {!report && <p className="mt-2 text-xs text-muted-foreground">{t('swarm.noResult')}</p>}
            </details>
          })}
        </div>
      </div>
      {moreBefore && <Button variant="outline" disabled={loadingEarlier} onClick={() => void loadEarlier(sid)}>{t('swarm.loadEarlier')}</Button>}
    </DialogContent>
  </Dialog>
}
