// Code blocks: terminal output (command, exit code, duration) and unified diffs.
import * as React from 'react'
import { Download, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Badge, Button, CopyButton, Sensitive } from '@/components/ui'
import { openFileViewer } from '@/features/files/viewerStore'
import { BlockShell, downloadText, fileName, useDataMenu } from '../shell'
import type { RendererProps } from './types'

const COLLAPSED_LINES = 24

/* ------------------------------------------------------------------ terminal */
export function TerminalBlock({ block, size, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const d = block.data as { title?: string; command?: string; output: string; exit_code?: number; duration_ms?: number; cwd?: string }
  const lines = React.useMemo(() => d.output.replace(/\n$/, '').split('\n'), [d.output])
  const [all, setAll] = React.useState(size === 'panel')
  const long = lines.length > COLLAPSED_LINES
  const shown = all || !long ? d.output.replace(/\n$/, '') : lines.slice(-COLLAPSED_LINES).join('\n')
  const ok = d.exit_code == null ? null : d.exit_code === 0
  const name = fileName(d.title || d.command || '', 'terminal')
  const menu = useDataMenu(block.raw, name, onRaw)
  const secs = d.duration_ms != null ? (d.duration_ms < 1000 ? `${Math.round(d.duration_ms)} ms` : `${(d.duration_ms / 1000).toFixed(1)} s`) : null
  return (
    <BlockShell
      icon="terminal"
      title={
        d.command ? (
          <span className="font-mono text-[13px] font-medium">
            <span className="text-muted-foreground select-none">$ </span>
            <Sensitive>{d.command}</Sensitive>
          </span>
        ) : (
          <Sensitive>{d.title || t('blocks.type.terminal')}</Sensitive>
        )
      }
      meta={d.cwd ? <Sensitive>{d.cwd}</Sensitive> : undefined}
      headerExtra={
        <span className="flex shrink-0 items-center gap-1.5">
          {ok != null && <Badge variant={ok ? 'success' : 'destructive'}>{t('blocks.terminal.code', { code: d.exit_code ?? 0 })}</Badge>}
          {secs && <span className="text-xs text-muted-foreground tabular-nums">{secs}</span>}
        </span>
      }
      onOpenBeside={onOpenBeside}
      menu={menu}
      bodyClassName="p-0"
    >
      <div className="group relative">
        <CopyButton text={d.output} className="absolute top-1.5 right-1.5 z-[1] bg-popover opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100" />
        {long && !all && (
          <button type="button" onClick={() => setAll(true)} className="block w-full border-b bg-muted/30 px-4 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
            {t('blocks.terminal.earlier', { count: lines.length - COLLAPSED_LINES })}
          </button>
        )}
        <Sensitive block>
          <pre className={cn('overflow-auto bg-muted/30 px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', size === 'panel' ? 'max-h-[75vh]' : 'max-h-[440px]')}>{shown}</pre>
        </Sensitive>
      </div>
      <div className="flex justify-end border-t px-3 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => downloadText(`${name}.txt`, d.output)}>
          <Download /> {t('blocks.action.download')}
        </Button>
      </div>
    </BlockShell>
  )
}

/* ------------------------------------------------------------------ diff */
type DiffRow = { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'file' | 'note'; text: string; old?: number; new?: number }

export function parseDiff(diff: string): { rows: DiffRow[]; add: number; del: number; path: string } {
  const rows: DiffRow[] = []
  let o = 0, n = 0, add = 0, del = 0, path = ''
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+++ ')) {
      path = line.slice(4).replace(/^b\//, '').trim()
      rows.push({ kind: 'file', text: line })
    } else if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
      rows.push({ kind: 'file', text: line })
    } else if (line.startsWith('+')) {
      add++
      rows.push({ kind: 'add', text: line.slice(1), new: n++ })
    } else if (line.startsWith('-')) {
      del++
      rows.push({ kind: 'del', text: line.slice(1), old: o++ })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line })
    } else {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, old: o ? o++ : undefined, new: n ? n++ : undefined })
    }
  }
  return { rows, add, del, path }
}

export function DiffBlock({ block, size, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const d = block.data as { title?: string; path?: string; diff: string }
  const parsed = React.useMemo(() => parseDiff(d.diff), [d.diff])
  const path = d.path || parsed.path
  const base = path ? path.split('/').pop() || path : ''
  const name = fileName(d.title || base, 'change')
  const menu = useDataMenu(block.raw, name, onRaw)
  return (
    <BlockShell
      icon="file-diff"
      title={<Sensitive>{d.title || base || t('blocks.type.diff')}</Sensitive>}
      meta={
        <span className="tabular-nums">
          <span className="text-success">+{parsed.add}</span> <span className="text-destructive">−{parsed.del}</span>
        </span>
      }
      source={path && path !== base ? <Sensitive>{path}</Sensitive> : undefined}
      onOpenBeside={onOpenBeside}
      menu={menu}
      bodyClassName="p-0"
      footer={
        <>
          {path.startsWith('/') && (
            <Button variant="outline" size="sm" onClick={() => openFileViewer(path)}>
              <FileCode2 /> {t('blocks.diff.openFile')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => downloadText(`${name}.diff`, d.diff, 'text/x-diff')}>
            <Download /> {t('blocks.action.download')}
          </Button>
        </>
      }
    >
      <Sensitive block>
        <div className={cn('overflow-auto font-mono text-[12.5px] leading-[1.6]', size === 'panel' ? 'max-h-[75vh]' : 'max-h-[480px]')}>
          <table className="w-full border-collapse">
            <tbody>
              {parsed.rows.map((r, i) =>
                r.kind === 'file' ? null : r.kind === 'hunk' || r.kind === 'note' ? (
                  <tr key={i} className="bg-muted/40 text-muted-foreground">
                    <td colSpan={4} className="px-3 py-0.5 text-[11.5px]">
                      {r.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={cn(r.kind === 'add' && 'bg-success/10', r.kind === 'del' && 'bg-destructive/10')}>
                    <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">{r.old ?? ''}</td>
                    <td className="w-10 px-2 text-right text-muted-foreground/70 tabular-nums select-none">{r.new ?? ''}</td>
                    <td className={cn('w-4 text-center select-none', r.kind === 'add' && 'text-success', r.kind === 'del' && 'text-destructive')}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</td>
                    <td className="pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.text || ' '}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </Sensitive>
    </BlockShell>
  )
}
