// Code blocks: terminal output (command, exit code, duration) and unified diffs.
import * as React from 'react'
import { Download, FileCode2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Badge, Button, CopyButton, Sensitive } from '@/components/ui'
import { openFileViewer } from '@/features/files/viewerStore'
import { DiffTable, parseDiff } from '@/components/ui/diff'
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

/* ------------------------------------------------------------------ diff (components/ui/diff.tsx) */
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
        <DiffTable rows={parsed.rows} className={size === 'panel' ? 'max-h-[75vh]' : 'max-h-[480px]'} />
      </Sensitive>
    </BlockShell>
  )
}
