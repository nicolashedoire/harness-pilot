import * as React from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@/i18n'
import { api, errorMessage } from '@/lib/api'
import { useWorkspace } from '@/lib/queries'
import { Button, Input } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'
import { ProposalDiff } from './ProposalDiff'
import { ArchitectureMap } from './ArchitectureMap'

type Profile = { id: string; name: string; role: string }
type Run = { id: string; title: string; path: string; state: string; error: string | null }
type Decision = { value: 'approved' | 'rejected'; fingerprint: string }
type Review = { session: Run; patch: string; untracked: { path: string; content: string }[]; fingerprint: string; has_changes: boolean; decision: Decision | null }
const field = 'w-full rounded-md border border-input bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function CompanionsSection() {
  const t = useT(), qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const sid = params.get('run') || ''
  const [selected, setSelected] = React.useState('observer')
  const [name, setName] = React.useState('')
  const [role, setRole] = React.useState('')
  const [path, setPath] = React.useState('')
  const [mission, setMission] = React.useState('')
  const { data: ws } = useWorkspace()
  const topics = (ws?.projects || []).flatMap((p) => p.topics)
  const list = useQuery({ queryKey: ['companions'], queryFn: () => api.get<{ companions: Profile[]; runs: Run[] }>('/api/companions'), refetchInterval: 3000 })
  const review = useQuery({ queryKey: ['companion-review', sid], queryFn: () => api.get<Review>(`/api/companions/runs/${encodeURIComponent(sid)}/review`), enabled: !!sid, refetchInterval: 3000 })
  const profile = list.data?.companions.find((p) => p.id === selected)
  React.useEffect(() => { setName(profile?.name || ''); setRole(profile?.role || '') }, [selected, profile?.name, profile?.role])
  const save = useMutation({ mutationFn: () => selected === 'new' ? api.post<Profile>('/api/companions', { name, role }) : api.put<Profile>(`/api/companions/${encodeURIComponent(selected)}`, { name, role }), onSuccess: (p) => { setSelected(p.id); void qc.invalidateQueries({ queryKey: ['companions'] }); toast.success(t('companions.saved')) }, onError: (e) => toast.error(errorMessage(e)) })
  const start = useMutation({ mutationFn: () => api.post<Run>(`/api/companions/${encodeURIComponent(selected)}/runs`, { path, mission }), onSuccess: (r) => { setParams({ run: r.id }); void qc.invalidateQueries({ queryKey: ['companions'] }); toast.success(t('companions.started')) }, onError: (e) => toast.error(errorMessage(e)) })
  const decide = useMutation({ mutationFn: (decision: 'approved' | 'rejected') => api.post<Review>(`/api/companions/runs/${encodeURIComponent(sid)}/decision`, { decision, fingerprint: review.data?.fingerprint }), onSuccess: (r) => { qc.setQueryData(['companion-review', sid], r); void qc.invalidateQueries({ queryKey: ['companions'] }) }, onError: (e) => { toast.error(errorMessage(e)); void review.refetch() } })
  const data = review.data
  const recorded = data?.decision?.fingerprint === data?.fingerprint ? data?.decision : null
  return <SectionStack>
    <SettingsCard title={t('companions.profile')} description={t('companions.intro')}>
      <div className="grid gap-4 text-sm">
        <p className="text-muted-foreground">{t('companions.manual')}</p>
        {list.isError && <p role="alert">{errorMessage(list.error)}</p>}
        <label className="grid gap-1">{t('companions.profile')}<select className={field} value={selected} onChange={(e) => setSelected(e.target.value)}>{list.data?.companions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="new">{t('companions.new')}</option></select></label>
        <label className="grid gap-1">{t('companions.name')}<Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label className="grid gap-1">{t('companions.role')}<textarea className={field} rows={4} maxLength={4000} value={role} onChange={(e) => setRole(e.target.value)} /></label>
        <div><Button variant="outline" disabled={!name.trim() || !role.trim()} loading={save.isPending} onClick={() => save.mutate()}>{t('companions.save')}</Button></div>
        <label className="grid gap-1">{t('companions.topic')}<select className={field} value={path} onChange={(e) => setPath(e.target.value)}><option value="">{t('companions.selectTopic')}</option>{topics.map((topic) => <option key={topic.path} value={topic.path}>{topic.project} / {topic.name}</option>)}</select></label>
        <label className="grid gap-1">{t('companions.mission')}<textarea className={field} rows={3} maxLength={6000} value={mission} onChange={(e) => setMission(e.target.value)} /></label>
        <div><Button disabled={!path || selected === 'new'} loading={start.isPending} onClick={() => start.mutate()}>{t('companions.start')}</Button></div>
      </div>
    </SettingsCard>
    <SettingsCard title={t('companions.runs')}>
      <div className="grid gap-3 text-sm">{!list.data?.runs.length && <p className="text-muted-foreground">{t('companions.empty')}</p>}{list.data?.runs.map((r) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><span>{r.title} · {r.state}</span><Button variant="outline" size="sm" onClick={() => setParams({ run: r.id })}>{t('companions.review')}</Button></div>)}</div>
    </SettingsCard>
    {!!sid && <SettingsCard title={t('companions.review')}>
      {review.isPending && <p>{t('companions.loading')}</p>}
      {review.isError && <p role="alert">{t('companions.error')} {errorMessage(review.error)}</p>}
      {data && <div className="grid gap-3 text-sm">
        <p className="font-medium">{data.session.title}</p>
        <Link className="text-primary underline" to={`/sessions?path=${encodeURIComponent(data.session.path)}&session=${encodeURIComponent(sid)}`}>{t('companions.session')}</Link>
        <ArchitectureMap sid={sid} />
        {data.session.state === 'running' ? <p role="status">{t('companions.running')}</p> : <>
          {data.session.error && <p role="alert">{t('companions.failed')} {data.session.error}</p>}
          {!data.has_changes ? <p>{t('companions.nochanges')}</p> : <>
            <h4 className="font-semibold">{t('companions.changes')}</h4>
            <ProposalDiff patch={data.patch} untracked={data.untracked} />
            {recorded && <p role="status">{t('companions.recorded', { decision: t(recorded.value === 'approved' ? 'companions.approved' : 'companions.rejected') })}</p>}
            <div className="flex flex-wrap gap-2"><Button loading={decide.isPending} onClick={() => decide.mutate('approved')}>{t('companions.approve')}</Button><Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>{t('companions.reject')}</Button></div>
          </>}
        </>}
      </div>}
    </SettingsCard>}
  </SectionStack>
}
