import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, CalendarClock, CirclePause, Download, FolderCheck, LockKeyhole, Trash2, Upload } from 'lucide-react'
import { api, errorMessage, isApiError } from '@/lib/api'
import { useLang, useT } from '@/i18n'
import { useSettings } from '@/lib/queries'
import { fmtBytes, fmtDate, fmtRelative } from '@/lib/format'
import { Badge, Button, Checkbox, FormField, Input, Select, Sensitive, Skeleton, confirm } from '@/components/ui'
import { CopyButton } from '@/components/ui/code-block'

type Root = { source: string; archive: string | null; excluded?: string }
type Schedule = { enabled: boolean; frequency: 'off' | 'daily' | 'weekly'; hour: number; keep: number; next_run: number | null; paused: boolean;
  last_success: number | null; error: { code: string; message: string; at: number } | null }
type Status = { max_bytes: number; restore_hold: boolean; integrations_paused?: boolean; roots: Record<string, Root>; export_error?: string; service_resume_errors?: string[]; schedule?: Schedule }
type Snapshot = { id: string; sha256: string; files: number; bytes: number; external_links: string[]; version: string;
  excluded_roots?: Record<string, { source: string; reason: string }> }
type Restored = Snapshot & { destination: string; state: string; launch_command: string; background_services_paused: boolean }
type ExportEntry = { id: string; created: number; archive_bytes: number; files: number | null; scheduled?: boolean }
const queryKey = ['instance-backup'] as const
const exportsKey = ['instance-backup', 'exports'] as const

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

  const leftOut = !status.data.roots.files?.archive && !!status.data.roots.files
  return <div className="grid min-w-0 gap-6">
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>{t('instanceBackup.scope')}</p>
      <p>{t('instanceBackup.excluded')}</p>
      <p>{t('instanceBackup.limit', { mb: Math.floor(status.data.max_bytes / 1048576) })}</p>
      <details className="min-w-0 rounded-lg border p-3" open={leftOut}>
        <summary className="cursor-pointer font-medium text-foreground">{t('instanceBackup.folders')}</summary>
        <dl className="mt-3 grid gap-3">{(['state', 'workspace', 'files'] as const).filter(name => status.data.roots[name]).map(name =>
          <div key={name} className="grid min-w-0 gap-1">
            <dt className="flex flex-wrap items-center gap-2">{t(`instanceBackup.root.${name}`)}
              {status.data.roots[name].archive
                ? <Badge variant="success">{t('instanceBackup.included')}</Badge>
                : <Badge variant="muted">{t('instanceBackup.notIncluded')}</Badge>}</dt>
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
      {status.data.integrations_paused && <div className="grid gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4" role="status">
        <strong className="flex items-center gap-2"><CirclePause className="size-4" />{t('instanceBackup.integrations.paused')}</strong>
        <p className="text-sm">{t('instanceBackup.integrations.body')}</p>
        <div><Button variant="outline" disabled={!!busy} loading={busy === 'resume'} onClick={() => void run('resume', async () => {
          if (!await confirm({ title: t('instanceBackup.integrations.confirmTitle'), description: t('instanceBackup.integrations.confirmBody'),
            confirmText: t('instanceBackup.integrations.resume') })) return
          await api.post('/api/backup/instance/resume-integrations', {})
          await queries.invalidateQueries()
        })}>{t('instanceBackup.integrations.resume')}</Button></div>
      </div>}
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
        {leftOut && <p className="text-sm text-muted-foreground" role="note">{t('instanceBackup.filesLeftOut')}</p>}
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
      <ExportList disabled={!!busy} />
      {status.data.schedule && !status.data.export_error && <ArchiveSchedule schedule={status.data.schedule} disabled={!!busy} />}
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
        {preview.excluded_roots?.files && <p>{t('instanceBackup.archiveLeftOut')}</p>}
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
        {restored.excluded_roots?.files && <p>{t('instanceBackup.archiveLeftOut')}</p>}
        <div className="flex min-w-0 items-start gap-2 rounded bg-muted p-3">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all"><Sensitive>{restored.launch_command}</Sensitive></code>
          <CopyButton text={restored.launch_command} />
        </div>
        <p>{t('instanceBackup.review')}</p>
      </div>}
    </>}
    {error && <p role="alert" className="break-words rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {busy && <p role="status" className="text-sm text-muted-foreground">{t('instanceBackup.working')}</p>}
  </div>
}

/** The encrypted archives kept in the server's data folder: download again, or delete once copied elsewhere. */
function ExportList({ disabled }: { disabled: boolean }) {
  const t = useT()
  const lang = useLang()
  const { data: settings } = useSettings()
  const queries = useQueryClient()
  const exports = useQuery({ queryKey: exportsKey, queryFn: () => api.get<ExportEntry[]>('/api/backup/instance/exports') })
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const remove = async (entry: ExportEntry) => {
    if (!await confirm({ title: t('instanceBackup.exports.deleteTitle'), description: t('instanceBackup.exports.deleteBody'),
      destructive: true, confirmText: t('common.delete') })) return
    setDeleting(entry.id)
    setError('')
    try {
      await api.del(`/api/backup/instance/exports/${entry.id}`)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeleting(null)
      await queries.invalidateQueries({ queryKey: exportsKey })
    }
  }
  return <div className="grid min-w-0 gap-3 border-t pt-5">
    <h4 className="flex items-center gap-2 font-medium"><Archive className="size-4" />{t('instanceBackup.exports.title')}</h4>
    <p className="text-sm text-muted-foreground">{t('instanceBackup.exports.hint')}</p>
    {exports.isLoading ? <Skeleton className="h-12" /> : !exports.data?.length
      ? <p className="text-sm text-muted-foreground">{exports.error ? errorMessage(exports.error) : t('instanceBackup.exports.empty')}</p>
      : <ul className="divide-y rounded-lg border">{exports.data.map(entry =>
        <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
          <span className="font-medium tabular-nums" title={fmtDate(entry.created, lang, settings?.timezone)}>{fmtRelative(entry.created, lang)}</span>
          {entry.scheduled && <Badge variant="muted">{t('instanceBackup.schedule.badge')}</Badge>}
          <span className="min-w-0 flex-1 text-muted-foreground">
            {fmtBytes(entry.archive_bytes)}{entry.files != null && ` · ${t('instanceBackup.exports.files', { count: entry.files })}`}
          </span>
          <Button asChild size="sm" variant="outline"><a href={`/api/backup/instance/download/${entry.id}`}><Download />{t('instanceBackup.download')}</a></Button>
          <Button size="icon-sm" variant="ghost" disabled={disabled || !!deleting} loading={deleting === entry.id}
            aria-label={t('instanceBackup.exports.delete', { date: fmtDate(entry.created, lang, settings?.timezone) })}
            title={t('common.delete')} onClick={() => void remove(entry)}><Trash2 /></Button>
        </li>)}</ul>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
  </div>
}

/** Scheduled archives: frequency, hour and how many to keep. The passphrase is never stored: the server keeps a key
 *  derived from it, once the owner agrees. */
function ArchiveSchedule({ schedule, disabled }: { schedule: Schedule; disabled: boolean }) {
  const t = useT()
  const lang = useLang()
  const { data: settings } = useSettings()
  const queries = useQueryClient()
  const [frequency, setFrequency] = React.useState<string>(schedule.enabled ? schedule.frequency : 'daily')
  const [hour, setHour] = React.useState(String(schedule.hour))
  const [keep, setKeep] = React.useState(String(schedule.keep))
  const [phrase, setPhrase] = React.useState('')
  const [again, setAgain] = React.useState('')
  const [consent, setConsent] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const keepCount = Number(keep)
  const needsPhrase = !schedule.enabled || phrase.length > 0
  const ready = Number.isInteger(keepCount) && keepCount >= 1 && keepCount <= 30
    && (!needsPhrase || (phrase.length >= 12 && phrase === again && consent))
  const at = (ts: number) => fmtDate(ts, lang, settings?.timezone)
  const run = async (operation: string, action: () => Promise<unknown>) => {
    setBusy(operation)
    setError('')
    try {
      await action()
      setPhrase('')
      setAgain('')
      setConsent(false)
      await queries.invalidateQueries({ queryKey })
    } catch (cause) { setError(errorMessage(cause)) } finally { setBusy(null) }
  }
  const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
  return <form className="grid min-w-0 gap-3 border-t pt-5" onSubmit={event => {
    event.preventDefault()
    void run('save', () => api.put('/api/backup/instance/schedule', { frequency, hour: Number(hour), keep: keepCount,
      ...(needsPhrase ? { passphrase: phrase, store_key: consent } : {}) }))
  }}>
    <h4 className="flex flex-wrap items-center gap-2 font-medium"><CalendarClock className="size-4" />{t('instanceBackup.schedule.title')}
      {schedule.enabled && <Badge variant={schedule.paused ? 'muted' : 'success'}>{t(schedule.paused ? 'instanceBackup.schedule.paused' : 'instanceBackup.schedule.on')}</Badge>}</h4>
    <p className="text-sm text-muted-foreground">{t('instanceBackup.schedule.hint')}</p>
    {schedule.enabled && <div className="grid gap-1 text-sm" role="status">
      {schedule.next_run != null && <p>{t('instanceBackup.schedule.next', { date: at(schedule.next_run) })}</p>}
      {schedule.paused && <p className="text-muted-foreground">{t('instanceBackup.schedule.pausedHint')}</p>}
      {schedule.last_success != null && <p className="text-muted-foreground">{t('instanceBackup.schedule.last', { date: at(schedule.last_success) })}</p>}
    </div>}
    {schedule.error && <p role="alert" className="break-words rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
      {t('instanceBackup.schedule.failed', { date: at(schedule.error.at), message: schedule.error.message })}</p>}
    <div className="grid gap-3 sm:grid-cols-3">
      <FormField label={t('instanceBackup.schedule.frequency')}>
        <Select value={frequency} onValueChange={setFrequency} disabled={disabled || !!busy} options={[
          { value: 'daily', label: t('instanceBackup.schedule.daily') }, { value: 'weekly', label: t('instanceBackup.schedule.weekly') }]} />
      </FormField>
      <FormField label={t('instanceBackup.schedule.hour')} hint={settings?.timezone}>
        <Select value={hour} onValueChange={setHour} disabled={disabled || !!busy} options={hours} />
      </FormField>
      <FormField label={t('instanceBackup.schedule.keep')} hint={t('instanceBackup.schedule.keepHint')}>
        <Input type="number" inputMode="numeric" min={1} max={30} required value={keep} disabled={disabled || !!busy}
          onChange={event => setKeep(event.target.value)} />
      </FormField>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label={t('instanceBackup.passphrase')} hint={schedule.enabled ? t('instanceBackup.schedule.keepPhrase') : undefined}>
        <Input type="password" autoComplete="off" minLength={12} maxLength={1024} required={!schedule.enabled} value={phrase}
          disabled={disabled || !!busy} onChange={event => setPhrase(event.target.value)} />
      </FormField>
      <FormField label={t('instanceBackup.schedule.again')}
        error={again && phrase !== again ? t('instanceBackup.schedule.mismatch') : undefined}>
        <Input type="password" autoComplete="off" maxLength={1024} required={needsPhrase} value={again}
          disabled={disabled || !!busy || !needsPhrase} onChange={event => setAgain(event.target.value)} />
      </FormField>
    </div>
    {needsPhrase && <label className="flex cursor-pointer items-start gap-3 text-sm">
      <Checkbox className="mt-0.5" checked={consent} disabled={disabled || !!busy} onCheckedChange={checked => setConsent(checked === true)} />
      <span className="min-w-0">{t('instanceBackup.schedule.consent')}</span>
    </label>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={disabled || !!busy || !ready} loading={busy === 'save'}>
        {t(schedule.enabled ? 'instanceBackup.schedule.save' : 'instanceBackup.schedule.enable')}</Button>
      {schedule.enabled && <Button type="button" variant="outline" disabled={disabled || !!busy} loading={busy === 'off'} onClick={() => void (async () => {
        if (!await confirm({ title: t('instanceBackup.schedule.offTitle'), description: t('instanceBackup.schedule.offBody'),
          confirmText: t('instanceBackup.schedule.off') })) return
        await run('off', () => api.del('/api/backup/instance/schedule'))
      })()}>{t('instanceBackup.schedule.off')}</Button>}
    </div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
  </form>
}
