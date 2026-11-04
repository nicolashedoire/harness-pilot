import * as React from 'react'
import { useT } from '@/i18n'
import { api, errorMessage, seg } from '@/lib/api'
import { useCreateTask } from '@/lib/queries/tasks'
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Spinner, toast } from '@/components/ui'

type Summary = { summary: string; decisions: string[]; actions: { title: string; notes: string }[]; truncated: boolean }

export function SessionSummary({ sid, path, open, onOpenChange }: { sid: string; path: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT()
  const createTask = useCreateTask()
  const [data, setData] = React.useState<Summary | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState<number[]>([])
  const [created, setCreated] = React.useState<number[]>([])
  const generate = async () => {
    setLoading(true); setError(''); setData(null); setSelected([]); setCreated([])
    try { setData(await api.post<Summary>(`/api/sessions/${seg(sid)}/summary`)) }
    catch (e) { setError(errorMessage(e)) } finally { setLoading(false) }
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
          <section><h3 className="mb-1 font-semibold">{t('summary.overview')}</h3><p className="whitespace-pre-wrap">{data.summary}</p></section>
          <section><h3 className="mb-1 font-semibold">{t('summary.decisions')}</h3>{data.decisions.length ? <ul className="list-disc space-y-1 pl-5">{data.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : <p className="text-muted-foreground">{t('summary.none')}</p>}</section>
          <section><h3 className="mb-1 font-semibold">{t('summary.actions')}</h3><p className="mb-2 text-xs text-muted-foreground">{t('summary.review')}</p>
            {data.actions.length ? <div className="grid gap-2">{data.actions.map((a, i) => <label key={i} className="flex items-start gap-2 rounded-md border p-2"><Checkbox checked={selected.includes(i)} disabled={created.includes(i)} onCheckedChange={(on) => setSelected((old) => on === true ? [...old, i] : old.filter((n) => n !== i))} /><span className="grid gap-1"><span>{a.title}{created.includes(i) && ` · ${t('summary.added')}`}</span>{a.notes && <span className="text-xs text-muted-foreground">{a.notes}</span>}</span></label>)}</div> : <p className="text-muted-foreground">{t('summary.none')}</p>}
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
