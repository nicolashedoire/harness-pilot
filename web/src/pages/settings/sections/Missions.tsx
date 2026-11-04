import * as React from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Pause, Play, Plus, Square, TriangleAlert } from 'lucide-react'
import { useT, useLang, tDyn } from '@/i18n'
import { api, errorMessage, isApiError } from '@/lib/api'
import { fmtNumber } from '@/lib/format'
import type { AgentProvider } from '@/lib/types'
import { useWorkspace } from '@/lib/queries'
import { Badge, Button, Checkbox, EmptyState, FormField, Input, Select, Textarea, confirm } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'

type Role = { id: string; name: string; role: string; provider?: string }
type Step = { id: string; title: string; role: string; instruction: string; after: string[]; state?: string; session?: string; error?: string }
type Mission = { id: string; title: string; path: string; goal: string; phase: string; plan_fingerprint: string; reason: string; steps: Step[]; max_runs: number; max_seconds: number; max_tokens: number; tokens: number; spent_seconds: number; active_since: number | null; launches: { session?: string }[]; cycle: number; max_cycles: number; next_cycle: number | null; planner: Step | null }
const initialStep = (): Step => ({ id: 'step-1', title: '', role: 'observer', instruction: '', after: [] })

function PlanEditor({ mission, roles, engineOf, onSave, pending }: { mission: Mission; roles: Role[]; engineOf: (role: string) => string; onSave: (steps: Step[], start: boolean) => void; pending: boolean }) {
  const t = useT()
  const [steps, setSteps] = React.useState<Step[]>(() => mission.steps.length ? mission.steps.map((s) => ({ ...s })) : [initialStep()])
  const update = (index: number, values: Partial<Step>) => setSteps((old) => old.map((s, i) => i === index ? { ...s, ...values } : s))
  return <form className="grid gap-4 text-sm" onSubmit={(e) => { e.preventDefault(); onSave(steps.map(({ id, title, role, instruction, after }) => ({ id, title, role, instruction, after })), (e.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement && ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value === 'start') }}>
    <p className="text-muted-foreground">{t('resident.planHint')}</p>
    {steps.map((step, i) => <fieldset key={step.id} className="grid gap-3 rounded-lg border p-4"><legend className="px-1 font-medium">{t('resident.step', { n: i + 1 })}</legend>
      <FormField label={t('resident.stepTitle')}><Input required maxLength={120} value={step.title} onChange={(e) => update(i, { title: e.target.value })} /></FormField>
      <FormField label={t('resident.role')} hint={t('resident.engine', { name: engineOf(step.role) })}><Select value={step.role} onValueChange={(role) => update(i, { role })} options={roles.map((r) => ({ value: r.id, label: r.name }))} /></FormField>
      <FormField label={t('resident.instruction')}><Textarea required maxLength={2000} minRows={3} value={step.instruction} onChange={(e) => update(i, { instruction: e.target.value })} /></FormField>
      {i > 0 && <fieldset className="grid gap-2"><legend className="mb-2 text-muted-foreground">{t('resident.dependencies')}</legend>{steps.slice(0, i).map((dep, n) => <label className="flex min-h-10 cursor-pointer items-center gap-3" key={dep.id}><Checkbox checked={step.after.includes(dep.id)} onCheckedChange={(checked) => update(i, { after: checked ? [...step.after, dep.id] : step.after.filter((id) => id !== dep.id) })} /><span className="min-w-0 break-words">{dep.title || t('resident.step', { n: n + 1 })}</span></label>)}</fieldset>}
      {steps.length > 1 && <div><Button variant="ghost" size="sm" onClick={() => setSteps((old) => old.filter((s) => s.id !== step.id).map((s) => ({ ...s, after: s.after.filter((id) => id !== step.id) })))}>{t('resident.removeStep')}</Button></div>}
    </fieldset>)}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={steps.length >= 8} onClick={() => { const id = 'step-' + Date.now().toString(36); setSteps((old) => [...old, { ...initialStep(), id }]) }}><Plus className="size-4" />{t('resident.addStep')}</Button><Button type="submit" value="save" variant="outline" loading={pending}>{t('resident.savePlan')}</Button><Button type="submit" value="start" loading={pending}><Play className="size-4" />{t('resident.start')}</Button></div>
  </form>
}

export function MissionsSection() {
  const t = useT(), lang = useLang(), qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const ident = params.get('mission') || ''
  const [title, setTitle] = React.useState(''), [path, setPath] = React.useState(''), [goal, setGoal] = React.useState('')
  const [runs, setRuns] = React.useState(8), [minutes, setMinutes] = React.useState(60), [tokens, setTokens] = React.useState(1000000)
  const [concurrent, setConcurrent] = React.useState('1'), [interval, setInterval] = React.useState(0), [cycles, setCycles] = React.useState(1)
  const { data: ws } = useWorkspace()
  const topics = (ws?.projects || []).flatMap((p) => p.topics)
  const list = useQuery({ queryKey: ['missions'], queryFn: () => api.get<Mission[]>('/api/missions'), refetchInterval: 2000 })
  const profiles = useQuery({ queryKey: ['companions'], queryFn: () => api.get<{ companions: Role[] }>('/api/companions') })
  const providers = useQuery({ queryKey: ['agent-providers'], queryFn: () => api.get<AgentProvider[]>('/api/agent-providers'), refetchInterval: 10000 })
  const roleOf = (id: string) => profiles.data?.companions.find((r) => r.id === id)
  const engineOf = (id: string) => { const provider = roleOf(id)?.provider || 'codex'; return providers.data?.find((p) => p.id === provider)?.name || provider }
  const data = list.data?.find((m) => m.id === ident)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['missions'] })
  const message = (e: unknown) => isApiError(e) ? tDyn(t, `resident.error.${e.code}`, errorMessage(e)) : errorMessage(e)
  const failure = (e: unknown) => { toast.error(message(e)); refresh() }
  const create = useMutation({ mutationFn: () => api.post<Mission>('/api/missions', { title, path, goal, max_runs: runs, max_minutes: minutes, max_tokens: tokens, concurrent: Number(concurrent), interval_minutes: interval, max_cycles: cycles }), onSuccess: (m) => { setParams({ mission: m.id }); setTitle(''); setGoal(''); refresh() }, onError: failure })
  const control = useMutation({ mutationFn: ({ id, action, fingerprint }: { id: string; action: 'start' | 'pause' | 'stop' | 'plan'; fingerprint?: string }) => api.post(`/api/missions/${id}/control`, { action, fingerprint }), onSuccess: refresh, onError: failure })
  const save = useMutation({ mutationFn: async ({ steps, start }: { steps: Step[]; start: boolean }) => { const saved = await api.put<Mission>(`/api/missions/${ident}/plan`, { steps }); if (start) await api.post(`/api/missions/${ident}/control`, { action: 'start', fingerprint: saved.plan_fingerprint }) }, onSuccess: refresh, onError: failure })
  const skip = useMutation({ mutationFn: (step: string) => api.post(`/api/missions/${ident}/steps/${step}/skip`), onSuccess: refresh, onError: failure })
  const editable = !!data && ['draft', 'plan_review', 'paused'].includes(data.phase) && !data.steps.some((s) => s.session)
  const stateText = (state: string) => tDyn(t, `resident.state.${state}`, state)
  return <SectionStack>
    <SettingsCard title={t('resident.create')} description={t('resident.intro')}>
      <form className="grid gap-4 text-sm" onSubmit={(e) => { e.preventDefault(); create.mutate() }}>
        <FormField label={t('resident.title')}><Input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></FormField>
        <FormField label={t('resident.topic')}><Select value={path} onValueChange={setPath} placeholder={t('companions.selectTopic')} options={topics.map((topic) => ({ value: topic.path, label: `${topic.project} / ${topic.name}` }))} /></FormField>
        <FormField label={t('resident.goal')}><Textarea required minRows={3} maxLength={2000} value={goal} onChange={(e) => setGoal(e.target.value)} /></FormField>
        <div className="grid gap-3 sm:grid-cols-2"><FormField label={t('resident.maxRuns')}><Input type="number" required min={1} max={32} value={runs} onChange={(e) => setRuns(e.target.valueAsNumber)} /></FormField><FormField label={t('resident.maxMinutes')}><Input type="number" required min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.valueAsNumber)} /></FormField></div>
        <details className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">{t('resident.moreLimits')}</summary><div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FormField label={t('resident.maxTokens')}><Input type="number" required min={1} max={100000000} value={tokens} onChange={(e) => setTokens(e.target.valueAsNumber)} /></FormField>
          <FormField label={t('resident.parallel')}><Select value={concurrent} onValueChange={setConcurrent} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }]} /></FormField>
          <FormField label={t('resident.interval')}><Input type="number" required min={0} max={10080} value={interval} onChange={(e) => setInterval(e.target.valueAsNumber)} /></FormField>
          <FormField label={t('resident.cycles')}><Input type="number" required min={1} max={32} value={cycles} onChange={(e) => setCycles(e.target.valueAsNumber)} /></FormField>
          <p className="text-muted-foreground sm:col-span-2">{t('resident.limitHint')}</p>
        </div></details>
        <div><Button type="submit" disabled={!path || !title.trim() || !goal.trim()} loading={create.isPending}>{t('resident.createDraft')}</Button></div>
      </form>
    </SettingsCard>
    <SettingsCard title={t('resident.list')}>
      {list.isError ? <EmptyState compact tone="error" icon={TriangleAlert} title={t('resident.loadError')} description={message(list.error)} action={<Button variant="outline" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} /> : !list.data?.length ? <p className="text-sm text-muted-foreground">{t('resident.empty')}</p> : <div className="grid gap-2">{list.data.map((m) => <button key={m.id} onClick={() => setParams({ mission: m.id })} className={`flex min-h-12 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${m.id === ident ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/50'}`}><span className="min-w-0 break-words font-medium">{m.title}</span><span className="text-xs text-muted-foreground">{stateText(m.phase)}</span></button>)}</div>}
    </SettingsCard>
    {data && <SettingsCard title={data.title} description={data.goal} key={data.id}>
      <div className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-3"><Badge variant="outline">{stateText(data.phase)}</Badge><span className="text-xs text-muted-foreground">{t('resident.progress', { runs: data.launches.length, max: data.max_runs, cycle: data.cycle, cycles: data.max_cycles })}</span></div>
        {!!data.reason && <p role="status" className="text-muted-foreground">{tDyn(t, `resident.reason.${data.reason}`, data.reason)}</p>}
        <p className="text-xs text-muted-foreground">{t('resident.usage', { count: fmtNumber(data.tokens, lang), max: fmtNumber(data.max_tokens, lang), minutes: Math.round(data.max_seconds / 60), elapsed: Math.floor((data.spent_seconds + (data.active_since ? Math.max(0, Date.now() / 1000 - data.active_since) : 0)) / 60) })}</p>
        <div className="flex flex-wrap gap-2">
          {editable && !data.planner && <Button variant="outline" loading={control.isPending} onClick={() => control.mutate({ id: data.id, action: 'plan' })}>{t('resident.askArchitect')}</Button>}
          {!editable && ['draft', 'plan_review', 'paused'].includes(data.phase) && !!data.steps.length && <Button loading={control.isPending} onClick={() => control.mutate({ id: data.id, action: 'start', fingerprint: data.plan_fingerprint })}><Play className="size-4" />{t('resident.start')}</Button>}
          {['active', 'planning'].includes(data.phase) && <Button variant="outline" loading={control.isPending} onClick={() => control.mutate({ id: data.id, action: 'pause' })}><Pause className="size-4" />{t('resident.pause')}</Button>}
          {!['completed', 'stopped', 'budget'].includes(data.phase) && <Button variant="outline" disabled={control.isPending} onClick={async () => { if (await confirm({ title: t('resident.stopConfirm'), description: t('resident.stopConfirmDesc'), destructive: true, confirmText: t('resident.stop') })) control.mutate({ id: data.id, action: 'stop' }) }}><Square className="size-4" />{t('resident.stop')}</Button>}
        </div>
        {data.planner?.session && <Link className="text-primary underline" to={`/sessions?path=${encodeURIComponent(data.path)}&session=${encodeURIComponent(data.planner.session)}`}>{t('resident.plannerSession')}</Link>}
        {editable && <>
          <Link className="text-primary underline" to="/settings/companions">{t('resident.adoptRole')}</Link>
          {profiles.isError ? <p role="alert">{message(profiles.error)}</p> : <PlanEditor key={data.id + ':' + data.phase} mission={data} roles={profiles.data?.companions || []} engineOf={engineOf} onSave={(steps, start) => save.mutate({ steps, start })} pending={save.isPending} />}
        </>}
        {!editable && data.steps.map((s, i) => <div key={s.id} className="grid gap-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{i + 1}. {s.title}</h4><span className="text-xs text-muted-foreground">{s.state === 'complete' && <Check className="mr-1 inline size-3 text-success" />}{stateText(s.state || 'pending')}</span></div>
          <p className="text-xs text-muted-foreground">{roleOf(s.role)?.name || s.role} · {t('resident.engine', { name: engineOf(s.role) })}</p><details className="text-muted-foreground"><summary className="cursor-pointer text-xs">{t('resident.instruction')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{s.instruction}</p></details>
          {!!roleOf(s.role)?.role && <details className="text-muted-foreground"><summary className="cursor-pointer text-xs">{t('resident.roleInstructions')}</summary><p className="mt-2 whitespace-pre-wrap break-words">{roleOf(s.role)?.role}</p></details>}
          {!!s.after.length && <p className="text-xs text-muted-foreground">{t('resident.after', { names: s.after.map((id) => data.steps.find((d) => d.id === id)?.title || id).join(', ') })}</p>}
          <div className="flex flex-wrap gap-3">{s.session && <><Link className="text-primary underline" to={`/sessions?path=${encodeURIComponent(data.path)}&session=${encodeURIComponent(s.session)}`}>{t('resident.session')}</Link><Link className="text-primary underline" to={`/settings/companions?run=${encodeURIComponent(s.session)}`}>{t('resident.review')}</Link></>}
            {data.phase === 'paused' && ['failed', 'interrupted', 'rejected'].includes(s.state || '') && <Button variant="outline" size="sm" loading={skip.isPending} onClick={() => skip.mutate(s.id)}>{t('resident.skip')}</Button>}
          </div>
        </div>)}
      </div>
    </SettingsCard>}
  </SectionStack>
}
