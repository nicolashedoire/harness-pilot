import * as React from 'react'
import { useT } from '@/i18n'
import { api, errorMessage, isApiError, seg } from '@/lib/api'
import { useCreateTask } from '@/lib/queries/tasks'
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Spinner, Textarea, toast } from '@/components/ui'

type Summary = { summary: string; decisions: string[]; actions: { title: string; notes: string }[]; truncated: boolean; engine?: 'codex' | 'claude'; cost_usd?: number }

// the server's error codes of POST /summary, in the interface language (other errors keep the server's message)
const ERRORS = {
  summary_no_agent: 'summary.err.noAgent', summary_busy: 'summary.err.busy', summary_limit: 'summary.err.limit',
  summary_timeout: 'summary.err.timeout', summary_failed: 'summary.err.failed', summary_unavailable: 'summary.err.failed',
  summary_invalid: 'summary.err.invalid',
} as const

export function SessionSummary({ sid, path, open, onOpenChange }: { sid: string; path: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const createTask = useCreateTask()
  const [data, setData] = React.useState<Summary | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState<number[]>([])
  const [created, setCreated] = React.useState<number[]>([])
  const [memoryOpen, setMemoryOpen] = React.useState(false)
  const [memoryText, setMemoryText] = React.useState('')
  const [memorySaving, setMemorySaving] = React.useState(false)
  const [memorySaved, setMemorySaved] = React.useState(false)
  const generate = async () => {
    setLoading(true); setError(''); setData(null); setSelected([]); setCreated([]); setMemoryOpen(false); setMemorySaved(false)
    try {
      const result = await api.post<Summary>(`/api/sessions/${seg(sid)}/summary`)
      setData(result)
      setMemoryText(Array.from([result.summary, ...(result.decisions.length ? [t('summary.decisions') + ':', ...result.decisions.map((d) => '- ' + d)] : [])].join('\n\n')).slice(0, 12000).join(''))
    }
    catch (e) { setError(isApiError(e) && e.code in ERRORS ? t(ERRORS[e.code as keyof typeof ERRORS]) : errorMessage(e)) } finally { setLoading(false) }
  }
  const saveMemory = async () => {
    if (!memoryText.trim() || memorySaving || memorySaved) return
    setMemorySaving(true)
    try {
      await api.post(`/api/sessions/${seg(sid)}/summary/memory`, { text: memoryText })
      setMemorySaved(true); toast.success(t('summary.memorySaved'))
    } catch (e) { toast.error(errorMessage(e)) }
    finally { setMemorySaving(false) }
  }
  const addTasks = async () => {
    if (!data || creating) return
    setCreating(true)
    try {
      for (const i of selected.filter((n) => !created.includes(n))) {
        const action = data.actions[i]
        await createTask.mutateAsync({ title: action.title, notes: action.notes, topic_path: path || undefined })
        setCreated((old) => [...old, i])
        setSelected((old) => old.filter((n) => n !== i))
      }
      toast.success(t('summary.tasksCreated'))
    } catch { /* the task mutation reports the error; successfully created tasks stay marked */ }
    finally { setCreating(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto md:max-w-2xl">
        <DialogHeader><DialogTitle>{t('summary.title')}</DialogTitle><DialogDescription>{t('summary.description')}</DialogDescription></DialogHeader>
        {!data && <Button type="button" onClick={generate} disabled={loading}>{loading && <Spinner />}{loading ? t('summary.generating') : t('summary.generate')}</Button>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {data && <div className="grid gap-4 text-sm">
          {data.truncated && <p className="rounded-md bg-warning/10 p-2">{t('summary.truncated')}</p>}
          <section><h3 className="mb-1 font-semibold">{t('summary.overview')}</h3><p className="whitespace-pre-wrap">{data.summary}</p>{data.engine && <p className="mt-1 text-xs text-muted-foreground" data-testid="summary-engine">{t('summary.by', { agent: data.engine === 'codex' ? 'Codex' : 'Claude Code' })}</p>}</section>
          <section><h3 className="mb-1 font-semibold">{t('summary.decisions')}</h3>{data.decisions.length ? <ul className="list-disc space-y-1 pl-5">{data.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : <p className="text-muted-foreground">{t('summary.none')}</p>}</section>
          <section><h3 className="mb-1 font-semibold">{t('summary.actions')}</h3><p className="mb-2 text-xs text-muted-foreground">{t('summary.review')}</p>
            {data.actions.length ? <div className="grid gap-2">{data.actions.map((a, i) => <label key={i} className="flex items-start gap-2 rounded-md border p-2"><Checkbox checked={selected.includes(i)} disabled={created.includes(i)} onCheckedChange={(on) => setSelected((old) => on === true ? [...old, i] : old.filter((n) => n !== i))} /><span className="grid gap-1"><span>{a.title}{created.includes(i) && ` · ${t('summary.added')}`}</span>{a.notes && <span className="text-xs text-muted-foreground">{a.notes}</span>}</span></label>)}</div> : <p className="text-muted-foreground">{t('summary.none')}</p>}
          </section>
          <section className="grid gap-2 rounded-md border p-3">
            <h3 className="font-semibold">{t('summary.memory')}</h3>
            <p className="text-xs text-muted-foreground">{t('summary.memoryHelp')}</p>
            {!memoryOpen && <Button type="button" variant="outline" onClick={() => setMemoryOpen(true)}>{t('summary.memoryReview')}</Button>}
            {memoryOpen && <><Textarea aria-label={t('summary.memoryEdit')} maxLength={12000} value={memoryText} onChange={(e) => { setMemoryText(e.target.value); setMemorySaved(false) }} />
              <Button type="button" variant="outline" onClick={saveMemory} disabled={!memoryText.trim() || memorySaving || memorySaved}>{memorySaved ? t('summary.memorySaved') : t('summary.memorySave')}</Button></>}
          </section>
        </div>}
        <DialogFooter>
          {data && <Button variant="outline" onClick={generate} disabled={loading || creating}>{t('summary.regenerate')}</Button>}
          {data && <Button onClick={addTasks} disabled={!selected.length || creating}>{t('summary.createTasks')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
