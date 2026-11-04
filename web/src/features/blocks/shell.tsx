// The anatomy every block shares (header: type icon, title, source · body · footer actions), the fallback cards
// (turned off, not installed, raw data, error, permission) and the helpers the renderers use (send to the
// conversation after a confirmation, downloads, CSV).
import * as React from 'react'
import { ArrowRight, Braces, Copy, Download, EllipsisVertical, PanelRight, Undo2 } from 'lucide-react'
import { cn, copyText } from '@/lib/utils'
import { useT } from '@/i18n'
import { errorMessage } from '@/lib/api'
import { api, seg } from '@/lib/api'
import type { Session } from '@/lib/types'
import { useSendMessage } from '@/lib/queries/sessions'
import {
  Button,
  CopyButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NamedIcon,
  Sensitive,
  Tooltip,
  confirm,
  toast,
  useMask,
} from '@/components/ui'
import { resolveSessionId, useBlockHost } from './host'

/** `in-thread` (in a message) or `panel` (the side drawer: taller charts, every table row). */
export type BlockSize = 'in-thread' | 'panel'

export type MenuAction = { label: string; icon?: React.ReactNode; onSelect: () => void }

export function BlockShell({
  icon,
  title,
  source,
  meta,
  headerExtra,
  onOpenBeside,
  menu,
  footer,
  children,
  bodyClassName,
  className,
  tone = 'default',
}: {
  icon: string
  title: React.ReactNode
  source?: React.ReactNode
  meta?: React.ReactNode
  headerExtra?: React.ReactNode
  onOpenBeside?: () => void
  menu?: MenuAction[]
  footer?: React.ReactNode
  children: React.ReactNode
  bodyClassName?: string
  className?: string
  tone?: 'default' | 'dashed' | 'warning' | 'error'
}) {
  const t = useT()
  return (
    <section
      className={cn(
        'mx-block not-prose @container my-3 min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground',
        tone === 'dashed' && 'border-dashed bg-card/60',
        tone === 'warning' && 'border-warning/40 bg-warning/5',
        tone === 'error' && 'border-destructive/40 bg-destructive/5',
        className,
      )}
    >
      <header className="flex min-h-12 items-center gap-2.5 border-b px-4 py-2">
        <NamedIcon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <h3 className="min-w-24 truncate text-[14px] font-semibold tracking-tight">{title}</h3>
          {meta && <span className="min-w-0 truncate text-xs text-muted-foreground">{meta}</span>}
        </div>
        {source && <span className="hidden max-w-[40%] truncate text-xs text-muted-foreground @2xl:inline">{source}</span>}
        {headerExtra}
        {onOpenBeside && (
          <Tooltip content={t('blocks.action.openBeside')}>
            <Button variant="ghost" size="icon-sm" aria-label={t('blocks.action.openBeside')} onClick={onOpenBeside} data-mx-open-beside>
              <PanelRight />
            </Button>
          </Tooltip>
        )}
        {menu && menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('common.more')}>
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menu.map((m) => (
                <DropdownMenuItem key={m.label} onSelect={m.onSelect}>
                  {m.icon}
                  {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      <div className={cn('min-w-0 p-4', bodyClassName)}>{children}</div>
      {footer && <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-4 py-2.5">{footer}</footer>}
    </section>
  )
}

/** The usual "…" entries: copy the data, download it as JSON, show it raw. */
export function useDataMenu(raw: string, name: string, onRaw?: () => void): MenuAction[] {
  const t = useT()
  return React.useMemo(
    () => [
      { label: t('blocks.action.copyData'), icon: <Copy />, onSelect: () => void copyText(raw).then((ok) => ok && toast.success(t('blocks.copied'))) },
      { label: t('blocks.action.downloadJson'), icon: <Download />, onSelect: () => downloadText(`${name}.json`, raw, 'application/json') },
      ...(onRaw ? [{ label: t('blocks.action.rawData'), icon: <Braces />, onSelect: onRaw }] : []),
    ],
    [raw, name, onRaw, t],
  )
}

/** A file made in the browser (CSV, PNG, JSON...): never a server round trip. */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
export const downloadText = (name: string, text: string, type = 'text/plain') => downloadBlob(name, new Blob([text], { type: `${type};charset=utf-8` }))

/** RFC 4180 CSV; a cell that a spreadsheet would run as a formula (=, +, -, @ first) gets a leading quote. */
export function toCsv(rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v == null ? '' : typeof v === 'number' ? String(v) : String(v)
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')
}

/** File-name-safe slug of a block title. */
export const fileName = (title: string, fallback: string) =>
  (title || fallback)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60) || fallback

/** Sends `text` as the user's next message in the block's conversation - after showing it and asking. Without a
 *  conversation (a block in the docs), the text is copied instead. Resolves to true when sent. */
export function useSendToSession() {
  const t = useT()
  const host = useBlockHost()
  const send = useSendMessage()
  return React.useCallback(
    async (text: string, from: Element | null): Promise<boolean> => {
      const clean = text.trim().slice(0, 8000)
      if (!clean) return false
      const sid = resolveSessionId(from, host)
      if (!sid) {
        if (await copyText(clean)) toast.info(t('blocks.send.noSession'))
        return false
      }
      let title = ''
      try {
        title = (await api.get<Session>(`/api/sessions/${seg(sid)}`)).title
      } catch {
        /* shown without its title */
      }
      const ok = await confirm({
        title: t('blocks.send.confirmTitle'),
        description: (
          <span className="grid gap-2">
            <span>{title ? t('blocks.send.to', { title }) : t('blocks.send.toThis')}</span>
            <Sensitive block>
              <span className="block max-h-60 overflow-auto rounded-md border bg-muted/40 p-2.5 text-left font-mono text-[12.5px] whitespace-pre-wrap text-foreground">{clean}</span>
            </Sensitive>
          </span>
        ),
        confirmText: t('blocks.send.confirm'),
      })
      if (!ok) return false
      try {
        if (host?.send) {
          if ((await host.send(clean)) === false) return false
        } else await send.mutateAsync({ id: sid, text: clean })
        toast.success(t('blocks.send.sent'))
        return true
      } catch (e) {
        if (host?.send) toast.error(errorMessage(e))
        return false
      }
    },
    [host, send, t],
  )
}

/** What a block leaves in the thread while it is shown in the side panel docked beside it: Show selects (and
 *  focuses) its tab there, Bring back closes that tab and draws the block here again. */
export function OpenedBeside({ title, onShow, onBringBack }: { title: string; onShow: () => void; onBringBack: () => void }) {
  const t = useT()
  const mask = useMask()
  return (
    <div
      role="group"
      aria-label={t('blocks.beside.label', { title: mask(title) })}
      className="mx-block not-prose my-3 flex min-w-0 items-center gap-1 rounded-xl border border-dashed bg-card/60 py-1 pr-1 pl-3 text-[13px]"
      data-testid="block-opened-beside"
    >
      <PanelRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="ml-1 min-w-0 flex-1 truncate text-muted-foreground">
        {t('blocks.beside.opened')} · <Sensitive><span className="font-medium text-foreground">{title}</span></Sensitive>
      </span>
      <Button variant="ghost" size="sm" onClick={onShow} aria-label={t('blocks.beside.showLabel', { title: mask(title) })}>
        <ArrowRight /> {t('blocks.beside.show')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onBringBack} aria-label={t('blocks.beside.backLabel', { title: mask(title) })}>
        <Undo2 /> {t('blocks.beside.back')}
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ fallback states (Plugins-etats) */

/** The block's data as it came, pretty-printed, with copy. */
export function RawData({ type, raw, className }: { type: string; raw: string; className?: string }) {
  const t = useT()
  const pretty = React.useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }, [raw])
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border bg-muted/30', className)}>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{t('blocks.raw.label', { type })}</span>
        <CopyButton text={pretty} />
      </div>
      <Sensitive block>
        <pre className="max-h-80 overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{pretty}</pre>
      </Sensitive>
    </div>
  )
}

/** A block that cannot be drawn as such: what happened, what the user can do, and its raw data on demand. */
export function BlockNotice({
  icon,
  title,
  children,
  actions,
  tone = 'dashed',
  type,
  raw,
  rawOpen = false,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
  tone?: 'dashed' | 'warning' | 'error'
  type: string
  raw: string
  rawOpen?: boolean
}) {
  const t = useT()
  const [showRaw, setShowRaw] = React.useState(rawOpen)
  return (
    <section
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'mx-block not-prose my-3 grid min-w-0 gap-2.5 rounded-xl border p-4',
        tone === 'dashed' && 'border-dashed bg-card/60',
        tone === 'warning' && 'border-warning/40 bg-warning/5',
        tone === 'error' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', tone === 'error' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{icon}</span>
        <h3 className="min-w-0 text-[14px] font-semibold tracking-tight">{title}</h3>
      </div>
      {children && <div className="text-[13px] text-muted-foreground">{children}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Button variant="outline" size="sm" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
          <Braces /> {showRaw ? t('blocks.raw.hide') : t('blocks.raw.show')}
        </Button>
      </div>
      {showRaw && <RawData type={type} raw={raw} />}
    </section>
  )
}
