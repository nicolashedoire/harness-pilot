import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FolderCheck, LockKeyhole, Upload } from 'lucide-react'
import { api, errorMessage, isApiError } from '@/lib/api'
import { useT } from '@/i18n'
import { Button, FormField, Input, Sensitive, Skeleton } from '@/components/ui'

type Status = { max_bytes: number; restore_hold: boolean; roots: Record<string, { source: string }>; export_error?: string; service_resume_errors?: string[] }
type Snapshot = { id: string; sha256: string; files: number; bytes: number; external_links: string[]; version: string }
type Restored = Snapshot & { destination: string; state: string; launch_command: string; background_services_paused: boolean }
const queryKey = ['instance-backup'] as const

export function InstanceBackupPanel() {
  const t = useT()
  const queries = useQueryClient()
  const status = useQuery({ queryKey, queryFn: () => api.get<Status>('/api/backup/instance') })
  const [exportPhrase, setExportPhrase] = React.useState('')
  const [importPhrase, setImportPhrase] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [exported, setExported] = React.useState<Snapshot | null>(null)
  const [preview, setPreview] = React.useState<Snapshot | null>(null)
  const [restored, setRestored] = React.useState<Restored | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const message = (cause: unknown) => {
    if (isApiError(cause)) {
      if (cause.code === 'decrypt_failed') return t('instanceBackup.error.decrypt')
      if (['sessions_active', 'crons_active', 'snapshot_busy', 'busy'].includes(cause.code)) return t('instanceBackup.error.busy')
      if (['source_changed', 'changed', 'preview_required'].includes(cause.code)) return t('instanceBackup.error.changed')
      if (cause.code === 'too_large') return t('instanceBackup.error.large')
    }
    return errorMessage(cause)
  }

  const run = async (operation: string, action: () => Promise<void>) => {
    setBusy(operation)
    setError('')
    try { await action() } catch (cause) { setError(message(cause)) } finally { setBusy(null) }
  }
  if (status.isLoading) return <Skeleton className="h-48" />
  if (!status.data) return <p role="alert" className="text-sm text-destructive">{errorMessage(status.error)}</p>

  return <div className="grid min-w-0 gap-6">
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>{t('instanceBackup.scope')}</p>
      <p>{t('instanceBackup.excluded')}</p>
      <p>{t('instanceBackup.limit', { mb: Math.floor(status.data.max_bytes / 1048576) })}</p>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer font-medium text-foreground">{t('instanceBackup.folders')}</summary>
        <dl className="mt-3 grid gap-2">{(['state', 'workspace', 'files'] as const).filter(name => status.data.roots[name]).map(name =>
          <div key={name} className="grid min-w-0 gap-1"><dt>{t(`instanceBackup.root.${name}`)}</dt>
            <dd className="break-all font-mono text-xs"><Sensitive>{status.data.roots[name].source}</Sensitive></dd></div>)}</dl>
      </details>
    </div>
    {!!status.data.service_resume_errors?.length && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{t('instanceBackup.resumeError')}</p>}
    {status.data.restore_hold ? <div className="grid gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4" role="status">
      <strong>{t('instanceBackup.hold')}</strong>
      <p className="text-sm">{t('instanceBackup.holdBody')}</p>
      <div><Button disabled={!!busy} loading={busy === 'activate'} onClick={() => void run('activate', async () => {
        await api.post('/api/backup/instance/activate', {})
        await queries.invalidateQueries()
      })}>{t('instanceBackup.activate')}</Button></div>
    </div> : <>
      {status.data.export_error && <p role="alert" className="text-sm text-destructive">{status.data.export_error}</p>}
      <form className="grid gap-3" onSubmit={event => {
        event.preventDefault()
        void run('export', async () => {
          setExported(await api.post<Snapshot>('/api/backup/instance/export', { passphrase: exportPhrase }))
          setExportPhrase('')
          await queries.invalidateQueries({ queryKey })
        })
      }}>
        <h4 className="flex items-center gap-2 font-medium"><LockKeyhole className="size-4" />{t('instanceBackup.export')}</h4>
        <FormField label={t('instanceBackup.passphrase')} hint={t('instanceBackup.passphraseHint')}>
          <Input type="password" autoComplete="off" minLength={12} maxLength={1024} required value={exportPhrase}
            onChange={event => setExportPhrase(event.target.value)} disabled={!!busy} />
        </FormField>
        <div><Button type="submit" disabled={!!busy || exportPhrase.length < 12 || !!status.data.export_error} loading={busy === 'export'}>
          <Download />{t('instanceBackup.create')}
        </Button></div>
      </form>
      {exported && <div className="grid gap-3 rounded-lg border p-4 text-sm" role="status">
        <strong>{t('instanceBackup.ready')}</strong>
        <p>{t('instanceBackup.counts', { count: exported.files, mb: (exported.bytes / 1048576).toFixed(1) })}</p>
        {!!exported.external_links.length && <p>{t('instanceBackup.external', { count: exported.external_links.length })}</p>}
        <div><Button asChild variant="outline"><a href={`/api/backup/instance/download/${exported.id}`}><Download />{t('instanceBackup.download')}</a></Button></div>
      </div>}
      <form className="grid gap-3 border-t pt-5" onSubmit={event => {
        event.preventDefault()
        if (!file) return
        const body = new FormData()
        body.append('file', file)
        body.append('passphrase', importPhrase)
        void run('preview', async () => {
          setPreview(await api.post<Snapshot>('/api/backup/instance/preview', body))
          setRestored(null)
        })
      }}>
        <h4 className="flex items-center gap-2 font-medium"><Upload className="size-4" />{t('instanceBackup.import')}</h4>
        <FormField label={t('instanceBackup.archive')}><Input type="file" accept=".pilotbackup" required disabled={!!busy} onChange={event => {
          setFile(event.target.files?.[0] || null)
          setPreview(null)
          setRestored(null)
        }} /></FormField>
        <FormField label={t('instanceBackup.existingPhrase')}><Input type="password" autoComplete="off" required minLength={12} maxLength={1024}
          disabled={!!busy} value={importPhrase} onChange={event => { setImportPhrase(event.target.value); setPreview(null) }} /></FormField>
        <div><Button type="submit" variant="outline" disabled={!!busy || !file || importPhrase.length < 12} loading={busy === 'preview'}>
          {t('instanceBackup.inspect')}
        </Button></div>
      </form>
      {preview && !restored && <div className="grid gap-3 rounded-lg border p-4 text-sm" role="status">
        <strong>{t('instanceBackup.preview')}</strong>
        <p>{t('instanceBackup.counts', { count: preview.files, mb: (preview.bytes / 1048576).toFixed(1) })}</p>
        <p>{t('instanceBackup.separate')}</p>
        {!!preview.external_links.length && <div><p>{t('instanceBackup.external', { count: preview.external_links.length })}</p>
          <ul className="max-h-32 overflow-auto break-all">{preview.external_links.slice(0, 20).map(path => <li key={path}><Sensitive>{path}</Sensitive></li>)}</ul></div>}
        <div><Button disabled={!!busy} loading={busy === 'restore'} onClick={() => void run('restore', async () => {
          setRestored(await api.post<Restored>('/api/backup/instance/restore', { id: preview.id, sha256: preview.sha256 }))
          setImportPhrase('')
        })}><FolderCheck />{t('instanceBackup.restore')}</Button></div>
      </div>}
      {restored && <div className="grid gap-3 rounded-lg border border-success/30 p-4 text-sm" role="status">
        <strong>{t('instanceBackup.restored')}</strong>
        <p>{t('instanceBackup.restoredBody')}</p>
        <code className="overflow-x-auto rounded bg-muted p-3"><Sensitive>{restored.launch_command}</Sensitive></code>
        <p>{t('instanceBackup.review')}</p>
      </div>}
    </>}
    {error && <p role="alert" className="break-words rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {busy && <p role="status" className="text-sm text-muted-foreground">{t('instanceBackup.working')}</p>}
  </div>
}
