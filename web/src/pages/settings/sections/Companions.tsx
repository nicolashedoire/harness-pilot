import * as React from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { TriangleAlert } from 'lucide-react'
import { useT } from '@/i18n'
import { api, errorMessage } from '@/lib/api'
import type { AgentProvider } from '@/lib/types'
import { useWorkspace } from '@/lib/queries'
import { Button, EmptyState, FormField, Input, Select, Textarea } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'
import { ProposalDiff } from './ProposalDiff'

type Profile = { id: string; name: string; role: string; provider: string }
type Run = { id: string; title: string; path: string; state: string; error: string | null }
type Decision = { value: 'approved' | 'rejected'; fingerprint: string }
type Review = { target: string | null; session: Run; patch: string; untracked: { path: string; content: string; executable: boolean }[]; fingerprint: string; has_changes: boolean; decision: Decision | null; pull_request: { url: string; fingerprint: string } | null }

export function CompanionsSection() {
  const t = useT(), qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const sid = params.get('run') || ''
  const [selected, setSelected] = React.useState('observer')
  const [name, setName] = React.useState('')
  const [role, setRole] = React.useState('')
  const [provider, setProvider] = React.useState('codex')
  const providers = useQuery({queryKey:['agent-providers'],queryFn:()=>api.get<AgentProvider[]>('/api/agent-providers'),refetchInterval:10000})
  const [path, setPath] = React.useState('')
  const [mission, setMission] = React.useState('')
  const [prTitle, setPrTitle] = React.useState('Improve the platform')
  const [prBody, setPrBody] = React.useState('## Proposed change\n\nReviewed in harness-pilot.\n\n## Verification\n\nSee the companion session for test results.')
  const { data: ws } = useWorkspace()
  const topics = (ws?.projects || []).flatMap((p) => p.topics)
  const list = useQuery({ queryKey: ['companions'], queryFn: () => api.get<{ companions: Profile[]; runs: Run[] }>('/api/companions'), refetchInterval: 3000 })
  const review = useQuery({ queryKey: ['companion-review', sid], queryFn: () => api.get<Review>(`/api/companions/runs/${encodeURIComponent(sid)}/review`), enabled: !!sid, refetchInterval: 3000 })
  const profile = list.data?.companions.find((p) => p.id === selected)
  React.useEffect(() => { setName(profile?.name || ''); setRole(profile?.role || ''); setProvider(profile?.provider || 'codex') }, [selected, profile?.name, profile?.role, profile?.provider])
  const save = useMutation({ mutationFn: () => selected === 'new' ? api.post<Profile>('/api/companions', { name, role, provider }) : api.put<Profile>(`/api/companions/${encodeURIComponent(selected)}`, { name, role, provider }), onSuccess: (p) => { setSelected(p.id); void qc.invalidateQueries({ queryKey: ['companions'] }); toast.success(t('companions.saved')) }, onError: (e) => toast.error(errorMessage(e)) })
  const start = useMutation({ mutationFn: () => api.post<Run>(`/api/companions/${encodeURIComponent(selected)}/runs`, { path, mission }), onSuccess: (r) => { setParams({ run: r.id }); void qc.invalidateQueries({ queryKey: ['companions'] }); toast.success(t('companions.started')) }, onError: (e) => toast.error(errorMessage(e)) })
  const decide = useMutation({ mutationFn: (decision: 'approved' | 'rejected') => api.post<Review>(`/api/companions/runs/${encodeURIComponent(sid)}/decision`, { decision, fingerprint: review.data?.fingerprint }), onSuccess: (r) => { qc.setQueryData(['companion-review', sid], r); void qc.invalidateQueries({ queryKey: ['companions'] }) }, onError: (e) => { toast.error(errorMessage(e)); void review.refetch() } })
  const publish = useMutation({ mutationFn: () => api.post<{url: string}>(`/api/companions/runs/${encodeURIComponent(sid)}/pull-request`, { fingerprint: review.data?.fingerprint, title: prTitle, body: prBody }), onSuccess: () => { void review.refetch(); toast.success(t('companions.prCreated')) }, onError: (e) => toast.error(errorMessage(e)) })
  const dirty = name !== (profile?.name || '') || role !== (profile?.role || '') || provider !== (profile?.provider || 'codex')
  const data = review.data
  // The list could not load at all: its error, translated, instead of a form that cannot work (it polls, so it comes back)
  const unavailable = list.isError && !list.data
  const recorded = data?.decision?.fingerprint === data?.fingerprint ? data?.decision : null
  return <SectionStack>
    <SettingsCard title={t('companions.profile')} description={t('companions.intro')}>
      {unavailable ? (
        <EmptyState compact tone="error" icon={TriangleAlert} title={t('companions.loadError')} description={errorMessage(list.error)} action={<Button variant="outline" size="sm" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : (
        <div className="grid gap-4 text-sm">
          <p className="text-muted-foreground">{t('companions.manual')}</p>
          <FormField label={t('companions.profile')}><Select value={selected} onValueChange={setSelected} options={[...(list.data?.companions.map((p) => ({ value: p.id, label: p.name })) || []), { value: 'new', label: t('companions.new') }]} /></FormField>
          <FormField label={t('companions.name')}><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label={t('companions.role')}><Textarea minRows={4} maxLength={4000} value={role} onChange={(e) => setRole(e.target.value)} /></FormField>
          <FormField label={t('sessions.provider')} hint={t('companions.providerHint')}><Select value={provider} onValueChange={setProvider} options={(providers.data || []).filter(p => p.capabilities.includes('source-edit')).map(p => ({value:p.id,label:p.name}))} /></FormField>
          <div><Button variant="outline" disabled={!name.trim() || !role.trim()} loading={save.isPending} onClick={() => save.mutate()}>{t('companions.save')}</Button></div>
          <FormField label={t('companions.topic')}><Select value={path} onValueChange={setPath} placeholder={t('companions.selectTopic')} options={topics.map((topic) => ({ value: topic.path, label: `${topic.project} / ${topic.name}` }))} /></FormField>
          <FormField label={t('companions.mission')}><Textarea maxLength={6000} value={mission} onChange={(e) => setMission(e.target.value)} /></FormField>
          <div><Button disabled={!path || selected === 'new' || dirty || !providers.data?.some(p => p.id === provider)} loading={start.isPending} onClick={() => start.mutate()}>{t('companions.start')}</Button></div>
          {providers.data && !providers.data.some(p => p.id === provider) && <p role="alert">{t('agentProviders.unavailable')}</p>}
          {dirty && selected !== 'new' && <p role="status" className="text-muted-foreground">{t('companions.saveFirst')}</p>}
        </div>
      )}
    </SettingsCard>
    {!unavailable && <SettingsCard title={t('companions.runs')}>
      <div className="grid gap-3 text-sm">{!list.data?.runs.length && <p className="text-muted-foreground">{t('companions.empty')}</p>}{list.data?.runs.map((r) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><span>{r.title} · {r.state}</span><Button variant="outline" size="sm" onClick={() => setParams({ run: r.id })}>{t('companions.review')}</Button></div>)}</div>
    </SettingsCard>}
    {!!sid && <SettingsCard title={t('companions.review')}>
      {review.isPending && <p>{t('companions.loading')}</p>}
      {review.isError && <EmptyState compact tone="error" icon={TriangleAlert} title={t('companions.error')} description={errorMessage(review.error)} action={<Button variant="outline" size="sm" onClick={() => void review.refetch()}>{t('common.retry')}</Button>} />}
      {data && <div className="grid gap-3 text-sm">
        <p className="font-medium">{data.session.title}</p>
        <Link className="text-primary underline" to={`/sessions?path=${encodeURIComponent(data.session.path)}&session=${encodeURIComponent(sid)}`}>{t('companions.session')}</Link>
        {data.session.state === 'running' ? <p role="status">{t('companions.running')}</p> : <>
          {data.session.error && <p role="alert">{t('companions.failed')} {data.session.error}</p>}
          {!data.has_changes ? <p>{t('companions.nochanges')}</p> : <>
            <h4 className="font-semibold">{t('companions.changes')}</h4>
            <ProposalDiff patch={data.patch} untracked={data.untracked} />
            {recorded && <p role="status">{t('companions.recorded', { decision: t(recorded.value === 'approved' ? 'companions.approved' : 'companions.rejected') })}</p>}
            <div className="flex flex-wrap gap-2"><Button loading={decide.isPending} onClick={() => decide.mutate('approved')}>{t('companions.approve')}</Button><Button variant="outline" disabled={decide.isPending} onClick={() => decide.mutate('rejected')}>{t('companions.reject')}</Button></div>
            {recorded?.value === 'approved' && <div className="grid gap-3 rounded-lg border p-4">
              <h4 className="font-semibold">{t('companions.prTitle')}</h4>
              <p className="text-muted-foreground">{data.target ? t('companions.prTarget', { repo: data.target }) : t('companions.prNoTarget')}</p>
              {data.pull_request?.fingerprint === data.fingerprint ? <a className="text-primary underline" href={data.pull_request.url} target="_blank" rel="noopener noreferrer">{t('companions.prOpen')}</a> : <>
                <FormField label={t('companions.prName')}><Input value={prTitle} maxLength={180} onChange={(e) => setPrTitle(e.target.value)} /></FormField>
                <FormField label={t('companions.prBody')}><Textarea minRows={5} maxLength={12000} value={prBody} onChange={(e) => setPrBody(e.target.value)} /></FormField>
                <div><Button disabled={!data.target || !prTitle.trim()} loading={publish.isPending} onClick={() => publish.mutate()}>{t('companions.prCreate')}</Button></div>
              </>}
            </div>}
          </>}
        </>}
      </div>}
    </SettingsCard>}
  </SectionStack>
}
