// The files of a draft or a version (API.md#atelier `DraftFile`): a list with what happened to each one (added,
// changed, removed; the unchanged ones folded), and the diff of the one picked, drawn by the shared diff table.
import * as React from 'react'
import { ChevronDown, FileCode2 } from 'lucide-react'
import type { AtelierDraftFile } from '@/lib/types'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Sensitive } from '@/components/ui'
import { DiffTable, parseDiff } from '@/components/ui/diff'

const MARK: Record<AtelierDraftFile['status'], { letter: string; cls: string; label: TKey }> = {
  added: { letter: 'A', cls: 'bg-success/12 text-success', label: 'atelier.files.added' },
  changed: { letter: 'M', cls: 'bg-warning/12 text-warning', label: 'atelier.files.changed' },
  removed: { letter: 'D', cls: 'bg-destructive/12 text-destructive', label: 'atelier.files.removed' },
  same: { letter: '=', cls: 'bg-muted text-muted-foreground', label: 'atelier.files.same' },
}

/** "3 added, 1 changed" (the counts that are not 0). */
export function filesSummary(t: (k: TKey, v?: Record<string, number>) => string, f: { added: number; changed: number; removed: number }) {
  const parts = (['added', 'changed', 'removed'] as const).filter((k) => f[k] > 0).map((k) => t(`atelier.files.n.${k}` as TKey, { count: f[k] }))
  return parts.length ? parts.join(', ') : t('atelier.files.none')
}

export function FileReview({ files, loadFile }: { files: AtelierDraftFile[]; loadFile?: (path: string) => Promise<string | null> }) {
  const t = useT()
  const changed = files.filter((f) => f.status !== 'same')
  const same = files.filter((f) => f.status === 'same')
  const [showSame, setShowSame] = React.useState(false)
  const [picked, setPicked] = React.useState<string | null>(changed[0]?.path ?? files[0]?.path ?? null)
  const listed = showSame ? [...changed, ...same] : changed
  const file = files.find((f) => f.path === picked) ?? null
  return (
    <div className="grid gap-3">
      <ul className="grid overflow-hidden rounded-lg border" aria-label={t('atelier.files.title')}>
        {listed.map((f) => {
          const m = MARK[f.status]
          const on = f.path === picked
          return (
            <li key={f.path} className="border-b last:border-b-0">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setPicked(f.path)}
                className={cn('flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:min-h-11', on && 'bg-accent')}
              >
                <span role="img" aria-label={t(m.label)} className={cn('flex size-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold', m.cls)}>
                  {m.letter}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  <Sensitive length={14}>{f.path}</Sensitive>
                </span>
                {f.size != null && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtBytes(f.size)}</span>}
              </button>
            </li>
          )
        })}
        {same.length > 0 && (
          <li>
            <button type="button" onClick={() => setShowSame(!showSame)} aria-expanded={showSame} className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:min-h-11">
              <ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', !showSame && '-rotate-90')} aria-hidden />
              {t('atelier.files.sameCount', { count: same.length })}
            </button>
          </li>
        )}
      </ul>
      {file && <FileDiff key={file.path} file={file} loadFile={loadFile} />}
    </div>
  )
}

function FileDiff({ file, loadFile }: { file: AtelierDraftFile; loadFile?: (path: string) => Promise<string | null> }) {
  const t = useT()
  const parsed = React.useMemo(() => (file.diff ? parseDiff(file.diff) : null), [file.diff])
  const [whole, setWhole] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border bg-card" aria-label={file.path} data-testid="atelier-diff">
      <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[13px]">
        <FileCode2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 font-mono text-xs font-medium break-all">
          <Sensitive length={14}>{file.path}</Sensitive>
        </span>
        {parsed && (
          <span className="font-mono text-xs tabular-nums">
            <span className="text-success">+{parsed.add}</span> <span className="text-destructive">−{parsed.del}</span>
          </span>
        )}
      </header>
      {whole != null ? (
        <Sensitive block>
          <pre className="max-h-[32rem] overflow-auto p-3 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{whole}</pre>
        </Sensitive>
      ) : file.binary ? (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('atelier.files.binary')}</p>
      ) : file.status === 'same' ? (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('atelier.files.unchanged')}</p>
      ) : parsed ? (
        <Sensitive block>
          <DiffTable rows={parsed.rows} className="max-h-[32rem]" />
        </Sensitive>
      ) : (
        <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('atelier.files.noDiff')}</p>
      )}
      {file.truncated && whole == null && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="flex-1">{t('atelier.files.truncated')}</span>
          {loadFile && (
            <Button
              variant="outline"
              size="sm"
              loading={loading}
              onClick={async () => {
                setLoading(true)
                try {
                  setWhole((await loadFile(file.path)) ?? t('atelier.files.tooLarge'))
                } finally {
                  setLoading(false)
                }
              }}
            >
              {t('atelier.files.whole')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
