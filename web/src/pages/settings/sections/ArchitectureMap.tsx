import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '@/lib/api'
import { useT } from '@/i18n'
import { Diagram } from '@/components/ui/diagram'

type Graph = { nodes: string[]; edges: { from: string; to: string }[] }

/** An overview of the strongest package links; the full file map remains available to the agent. */
function overview(graph: Graph): string {
  const group = (name: string) => {
    const parts = name.split('/')
    return parts.slice(0, parts[0] === 'web' ? 4 : 3).join('/')
  }
  const links = new Map<string, number>()
  for (const edge of graph.edges) {
    const from = group(edge.from), to = group(edge.to)
    if (from === to) continue
    const key = `${from}\n${to}`
    links.set(key, (links.get(key) || 0) + 1)
  }
  const scores = new Map<string, number>()
  for (const [key, count] of links) for (const side of key.split('\n')) scores.set(side, (scores.get(side) || 0) + count)
  const names = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name]) => name)
  const ids = new Map(names.map((name, i) => [name, `n${i}`]))
  const lines = ['flowchart LR', ...names.map((name) => `  ${ids.get(name)}["${name.replace(/[^a-zA-Z0-9_./-]/g, '_')}"]`)]
  for (const [key] of links) {
    const [a, b] = key.split('\n')
    if (ids.has(a) && ids.has(b)) lines.push(`  ${ids.get(a)} --> ${ids.get(b)}`)
  }
  return lines.join('\n')
}

export function ArchitectureMap({ sid }: { sid: string }) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const q = useQuery({ queryKey: ['companion-architecture', sid], queryFn: () => api.get<Graph>(`/api/companions/runs/${encodeURIComponent(sid)}/architecture`), enabled: open })
  return <details onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-lg border p-3">
    <summary className="cursor-pointer font-medium">{t('companions.architecture')}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t('companions.architectureDesc')}</p>
    {q.isError && <p role="alert">{errorMessage(q.error)}</p>}
    {q.data && (q.data.edges.length ? <Diagram code={overview(q.data)} /> : <p>{t('companions.architectureEmpty')}</p>)}
  </details>
}
