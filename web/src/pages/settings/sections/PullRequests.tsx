import * as React from 'react'
import { useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, GitPullRequest, Pause, Play, RefreshCw, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useT, tDyn } from '@/i18n'
import { api, errorMessage, isApiError } from '@/lib/api'
import { Button, Checkbox, EmptyState, FormField, Input, Select } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'
import { ProposalDiff } from './ProposalDiff'

type Snapshot = { head: string; base_ref: string; base_sha: string; title: string; body: string; draft: boolean; open: boolean; merged: boolean }
type QueueItem = { id: string; url: string; repo: string; number: number; method: string; dependencies: string[]; state: string; reason: string; checked_at: number; snapshot?: Snapshot; approval?: { head: string; at: number } }
type Queue = { paused: boolean; github_cli_available: boolean; items: QueueItem[] }
type Review = { item: QueueItem; snapshot: Snapshot; patch: string; fingerprint: string; dependencies: [string, string | null][] }

export function PullRequestsSection() {
  const t = useT(), qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const ident = params.get('item') || ''
  const [url, setUrl] = React.useState(params.get('url') || '')
  const [dependencies, setDependencies] = React.useState<string[]>([])
  const [method, setMethod] = React.useState('merge')
  const list = useQuery({ queryKey: ['pr-queue'], queryFn: () => api.get<Queue>('/api/pr-queue'), refetchInterval: 5000 })
  const review = useQuery({ queryKey: ['pr-review', ident], queryFn: () => api.get<Review>(`/api/pr-queue/${encodeURIComponent(ident)}/preview`), enabled: !!ident, staleTime: 0 })
  const current = list.data?.items.find((i) => i.id === ident)
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['pr-queue'] }); void qc.invalidateQueries({ queryKey: ['pr-review'] }) }
  const message = (e: unknown) => isApiError(e) ? tDyn(t, `prQueue.reason.${e.code}`, errorMessage(e)) : errorMessage(e)
  const failure = (e: unknown) => { toast.error(message(e)); refresh() }
  const add = useMutation({ mutationFn: () => api.post<QueueItem>('/api/pr-queue', { url, dependencies, method }), onSuccess: (item) => { setUrl(''); setDependencies([]); setParams({ item: item.id }); refresh() }, onError: failure })
  const pause = useMutation({ mutationFn: (paused: boolean) => api.put<Queue>('/api/pr-queue/pause', { paused }), onSuccess: (data) => qc.setQueryData(['pr-queue'], data), onError: failure })
  const check = useMutation({ mutationFn: () => api.post<Queue>('/api/pr-queue/refresh'), onSuccess: (data) => qc.setQueryData(['pr-queue'], data), onError: failure })
  const action = useMutation({ mutationFn: ({ id, kind, fingerprint }: { id: string; kind: 'approve' | 'cancel' | 'retry'; fingerprint?: string }) => api.post<Queue>(`/api/pr-queue/${id}/${kind}`, kind === 'approve' ? { fingerprint } : undefined), onSuccess: (data) => { qc.setQueryData(['pr-queue'], data); refresh() }, onError: failure })
  const data = review.data
  const approveAllowed = !!data && !!current && !['cancelled', 'closed', 'merged', 'merging', 'merge_requested'].includes(current.state) && data.snapshot.open && !data.snapshot.draft && !data.snapshot.merged && data.dependencies.every(([, head]) => !!head)
  const selected = (id: string) => list.data?.items.find((i) => i.id === id)
  const label = (item: QueueItem) => `${item.repo} #${item.number}`
  return <SectionStack>
    <SettingsCard title={t(list.data?.paused !== false ? 'prQueue.paused' : 'prQueue.active')} description={t('prQueue.intro')} actions={list.data && <>
      <Button variant="outline" size="sm" loading={check.isPending} onClick={() => check.mutate()}><RefreshCw className="size-4" />{t('prQueue.refresh')}</Button>
      <Button variant={list.data.paused ? 'default' : 'outline'} size="sm" loading={pause.isPending} onClick={() => pause.mutate(!list.data!.paused)}>{list.data.paused ? <Play className="size-4" /> : <Pause className="size-4" />}{t(list.data.paused ? 'prQueue.resume' : 'prQueue.pause')}</Button>
    </>}>
      <div className="grid gap-3 text-sm text-muted-foreground">
        <p>{t('prQueue.control')}</p>
        <p>{t('prQueue.refreshHint')}</p>
        {list.isPending && <p role="status">{t('prQueue.loading')}</p>}
        {list.isError && <p role="alert">{message(list.error)}</p>}
        {list.data && !list.data.github_cli_available && <p role="alert">{t('prQueue.noCli')}</p>}
      </div>
    </SettingsCard>
    {list.data && <SettingsCard title={t('prQueue.add')}>
      <form className="grid gap-4 text-sm" onSubmit={(e) => { e.preventDefault(); add.mutate() }}>
        <FormField label={t('prQueue.url')}><Input type="url" required maxLength={1000} value={url} placeholder="https://github.com/owner/repository/pull/42" onChange={(e) => setUrl(e.target.value)} /></FormField>
        <FormField label={t('prQueue.method')}><Select value={method} onValueChange={setMethod} options={[{ value: 'merge', label: t('prQueue.merge') }, { value: 'squash', label: t('prQueue.squash') }]} /></FormField>
        <fieldset className="grid gap-2"><legend className="mb-2 font-medium">{t('prQueue.dependencies')}</legend><p className="text-muted-foreground">{t('prQueue.dependencyHint')}</p>
          <div className="grid max-h-52 gap-2 overflow-auto">{list.data.items.filter((i) => !['cancelled', 'closed'].includes(i.state)).map((i) => <label key={i.id} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2"><Checkbox checked={dependencies.includes(i.id)} onCheckedChange={(checked) => setDependencies((old) => checked ? [...old, i.id] : old.filter((id) => id !== i.id))} /><span className="min-w-0 break-all">{label(i)}</span></label>)}</div>
        </fieldset>
        <div><Button type="submit" loading={add.isPending} disabled={!url.trim() || !list.data.github_cli_available}>{t('prQueue.add')}</Button></div>
      </form>
    </SettingsCard>}
    <SettingsCard title={t('prQueue.items')}>
      {!list.data?.items.length ? <EmptyState compact icon={GitPullRequest} title={t('prQueue.empty')} description={t('prQueue.emptyHint')} /> : <div className="grid gap-3">{list.data.items.map((i) => <div key={i.id} className={`grid gap-3 rounded-lg border p-4 text-sm ${ident === i.id ? 'border-primary/60 bg-primary/5' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><a className="break-all font-medium text-primary hover:underline" href={i.url} target="_blank" rel="noopener noreferrer">{label(i)}</a><p className="mt-1 break-words">{i.snapshot?.title || (data?.item.id === i.id ? data.snapshot.title : t('prQueue.notFetched'))}</p></div><span className="rounded-full border bg-muted/50 px-2.5 py-1 text-xs">{tDyn(t, `prQueue.state.${i.state}`, i.state)}</span></div>
        <p className="text-muted-foreground">{tDyn(t, `prQueue.reason.${i.reason}`, t('prQueue.reason.github_failed'))}</p>
        {!!i.dependencies.length && <p className="break-words text-xs text-muted-foreground">{t('prQueue.after', { names: i.dependencies.map((id) => { const dep = selected(id); return dep ? label(dep) : id }).join(', ') })}</p>}
        {i.approval && <p className="flex items-center gap-2 text-xs"><Check className="size-3.5 text-success" />{t('prQueue.approved', { sha: i.approval.head.slice(0, 12) })}</p>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setParams({ item: i.id })}>{t('prQueue.review')}</Button>
          {i.state === 'merge_failed' && <Button variant="outline" size="sm" loading={action.isPending} onClick={() => action.mutate({ id: i.id, kind: 'retry' })}>{t('prQueue.retry')}</Button>}
          {!['merged', 'cancelled', 'merging', 'merge_requested'].includes(i.state) && <Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: i.id, kind: 'cancel' })}>{t('prQueue.cancel')}</Button>}
        </div>
      </div>)}</div>}
    </SettingsCard>
    {!!ident && <SettingsCard title={t('prQueue.review')}>
      {review.isFetching && <p role="status" className="text-sm text-muted-foreground">{t('prQueue.loading')}</p>}
      {review.isError && <EmptyState compact tone="error" icon={TriangleAlert} title={t('prQueue.reviewError')} description={message(review.error)} action={<div className="flex flex-wrap gap-3"><Button variant="outline" size="sm" onClick={() => void review.refetch()}>{t('common.retry')}</Button>{current && <a className="self-center text-primary underline" href={current.url} target="_blank" rel="noopener noreferrer">{t('prQueue.openGitHub')}</a>}</div>} />}
      {data && !review.isFetching && !review.isError && <div className="grid gap-4 text-sm">
        <div className="grid gap-2"><h4 className="font-semibold">{data.snapshot.title}</h4><a className="text-primary underline" href={data.item.url} target="_blank" rel="noopener noreferrer">{t('prQueue.openGitHub')}</a><p className="break-all font-mono text-xs text-muted-foreground">{data.snapshot.head} → {data.snapshot.base_ref} ({data.snapshot.base_sha.slice(0, 12)})</p></div>
        <p className="rounded-lg border bg-muted/30 p-3 text-muted-foreground">{t('prQueue.approvalHint')}</p>
        {!!data.dependencies.length && <ul className="grid list-inside list-disc gap-1 text-muted-foreground">{data.dependencies.map(([id, head]) => <li key={id} className="break-all">{selected(id) ? label(selected(id)!) : id} · {head ? head.slice(0, 12) : t('prQueue.unreviewed')}</li>)}</ul>}
        <ProposalDiff patch={data.patch} untracked={[]} />
        <div className="flex flex-wrap gap-2"><Button disabled={!approveAllowed} loading={action.isPending} onClick={() => action.mutate({ id: ident, kind: 'approve', fingerprint: data.fingerprint })}>{t('prQueue.approve')}</Button><Button variant="outline" onClick={() => void review.refetch()}>{t('prQueue.reload')}</Button></div>
      </div>}
    </SettingsCard>}
  </SectionStack>
}
