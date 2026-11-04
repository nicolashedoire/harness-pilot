// Data blocks: chart, table, stats, list, timeline, progress. Chart, list, timeline and progress reuse the dashboard
// renderers (pages/dashboard/blocks.tsx, charts.tsx), so a pinned block looks the same on the dashboard.
import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, FileImage, Pin, Search, Sheet as SheetIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLang, useT } from '@/i18n'
import { Button, Input, ProgressBar, Segmented, Sensitive, toast } from '@/components/ui'
import { Chart, compact, type Series } from '@/pages/dashboard/charts'
import { BlockView } from '@/pages/dashboard/blocks'
import type { Block as CardBlock, TimelineBlock } from '@/lib/types'
import { usePinBlock } from '../queries'
import { BlockShell, downloadBlob, downloadText, fileName, toCsv, useDataMenu } from '../shell'
import type { RendererProps } from './types'

/* ------------------------------------------------------------------ shared */
function PinButton({ type, data, title }: { type: string; data: Record<string, unknown>; title: string }) {
  const t = useT()
  const pin = usePinBlock()
  return (
    <Button
      variant="outline"
      size="sm"
      loading={pin.isPending}
      disabled={pin.isSuccess}
      onClick={() => pin.mutate({ type, data, title }, { onSuccess: () => toast.success(t('blocks.pinned')) })}
    >
      <Pin /> {pin.isSuccess ? t('blocks.action.pinnedDone') : t('blocks.action.pin')}
    </Button>
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const titleOf = (data: Record<string, unknown>, fallback: string) => str(data.title) || fallback

/* ------------------------------------------------------------------ chart */
type ChartData = { title?: string; source?: string; kind?: 'line' | 'bar'; unit?: string; series: Series[] }

/** The chart's SVG as a PNG (theme colours resolved, since the file leaves the page). */
async function svgToPng(svg: SVGSVGElement, name: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const src = svg.querySelectorAll('*')
  const dst = clone.querySelectorAll('*')
  src.forEach((el, i) => {
    const cs = getComputedStyle(el)
    const d = dst[i] as SVGElement
    for (const p of ['fill', 'stroke', 'stroke-width', 'opacity', 'font-size', 'font-family', 'stop-color', 'stop-opacity'] as const) d.style.setProperty(p, cs.getPropertyValue(p))
    d.style.setProperty('animation', 'none')
  })
  const { width, height } = svg.getBoundingClientRect()
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--card').trim() || '#fff'
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
  const img = new Image()
  await new Promise<void>((ok, ko) => {
    img.onload = () => ok()
    img.onerror = () => ko(new Error('svg'))
    img.src = url
  })
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
  if (blob) downloadBlob(`${name}.png`, blob)
}

function seriesTable(series: Series[]): { columns: string[]; rows: (string | number)[][] } {
  const xs: (string | number)[] = []
  for (const s of series) for (const [x] of s.points) if (!xs.includes(x)) xs.push(x)
  return { columns: ['', ...series.map((s) => s.name)], rows: xs.map((x) => [x, ...series.map((s) => s.points.find((p) => p[0] === x)?.[1] ?? '')]) }
}

export function ChartBlock({ block, size, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const lang = useLang()
  const d = block.data as unknown as ChartData
  const [view, setView] = React.useState<'chart' | 'table'>('chart')
  const box = React.useRef<HTMLDivElement>(null)
  const title = titleOf(block.data, t('blocks.type.chart'))
  const name = fileName(title, 'chart')
  const table = React.useMemo(() => seriesTable(d.series), [d.series])
  const menu = useDataMenu(block.raw, name, onRaw)
  return (
    <BlockShell
      icon={d.kind === 'bar' ? 'chart-column' : 'chart-line'}
      title={<Sensitive>{title}</Sensitive>}
      headerExtra={
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          aria-label={t('blocks.chart.view')}
          options={[
            { value: 'chart', label: t('blocks.chart.chart') },
            { value: 'table', label: t('blocks.chart.table') },
          ]}
        />
      }
      onOpenBeside={onOpenBeside}
      menu={menu}
      footer={
        <>
          {block.plugin.pin && <PinButton type="chart" data={block.data} title={title} />}
          <Button variant="outline" size="sm" disabled={view !== 'chart'} onClick={() => {
            const svg = box.current?.querySelector('svg')
            if (svg) svgToPng(svg, name).catch(() => toast.error(t('blocks.chart.pngFailed')))
          }}>
            <FileImage /> PNG
          </Button>
          <Button variant="outline" size="sm" onClick={() => downloadText(`${name}.csv`, toCsv([table.columns, ...table.rows]), 'text/csv')}>
            <SheetIcon /> CSV
          </Button>
          {d.source && (
            <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
              {t('blocks.source')} <Sensitive>{d.source}</Sensitive>
            </span>
          )}
        </>
      }
    >
      {view === 'chart' ? (
        <div ref={box}>
          <Sensitive placeholder={<div className="h-[220px] rounded-lg bg-muted/50" />}>
            <Chart kind={d.kind || 'line'} series={d.series} unit={d.unit} height={size === 'panel' ? 360 : 220} />
          </Sensitive>
        </div>
      ) : (
        <SimpleTable columns={table.columns} rows={table.rows} lang={lang} />
      )}
    </BlockShell>
  )
}

function SimpleTable({ columns, rows, lang }: { columns: string[]; rows: (string | number)[][]; lang: string }) {
  return (
    <div className="max-h-[360px] overflow-auto">
      <table className="w-full text-sm [overflow-wrap:normal]">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-left text-xs text-muted-foreground">
            {columns.map((c, i) => (
              <th key={i} className={cn('px-2 py-1.5 font-medium', i > 0 && 'text-right')}>
                <Sensitive>{c}</Sensitive>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b last:border-0">
              {r.map((c, ci) => (
                <td key={ci} className={cn('px-2 py-1.5', ci > 0 && 'text-right tabular-nums')}>
                  <Sensitive length={4}>{typeof c === 'number' ? compact(c, lang) : c}</Sensitive>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ table */
type Col = { label: string; type: 'text' | 'number' | 'percent' | 'delta' | 'bar'; align?: 'left' | 'right' | 'center' }
type Cell = string | number | boolean | null

const asNumber = (c: Cell): number | null => {
  if (typeof c === 'number') return c
  if (typeof c !== 'string') return null
  const n = Number(c.replace(/[\s  ]/g, '').replace(/[^\d.,+\-−]/g, '').replace('−', '-').replace(',', '.'))
  return c.trim() && Number.isFinite(n) ? n : null
}

function TableCell({ col, value, lang }: { col: Col; value: Cell; lang: string }) {
  if (value == null || value === '') return <span className="text-muted-foreground">—</span>
  if (col.type === 'bar') {
    const n = Math.max(0, Math.min(100, asNumber(value) ?? 0))
    return (
      <span className="flex items-center gap-2">
        <ProgressBar value={n} max={100} className="h-1.5 min-w-16 flex-1" label={`${n} %`} />
      </span>
    )
  }
  if (col.type === 'delta') {
    const n = asNumber(value)
    const s = typeof value === 'number' ? `${value > 0 ? '+' : ''}${new Intl.NumberFormat(lang).format(value)}` : String(value)
    return <span className={cn('tabular-nums', n != null && n > 0 && 'text-success', n != null && n < 0 && 'text-destructive')}>{s}</span>
  }
  if (col.type === 'percent' && typeof value === 'number') return <span className="tabular-nums">{new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value)} %</span>
  if (typeof value === 'number') return <span className="tabular-nums">{new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(value)}</span>
  if (typeof value === 'boolean') return <span>{value ? '✓' : '—'}</span>
  return <>{value}</>
}

export function TableBlock({ block, size, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const lang = useLang()
  const d = block.data as { title?: string; source?: string; page_size?: number; columns: (string | Partial<Col>)[]; rows: Cell[][] }
  const cols: Col[] = React.useMemo(
    () =>
      d.columns.map((c, i) => {
        const col = typeof c === 'string' ? { label: c } : c
        const numeric = i > 0 && d.rows.length > 0 && d.rows.every((r) => r[i] == null || typeof r[i] === 'number')
        return { label: String(col.label ?? ''), type: col.type ?? (numeric ? 'number' : 'text'), align: col.align }
      }),
    [d.columns, d.rows],
  )
  const [q, setQ] = React.useState('')
  const [sort, setSort] = React.useState<{ i: number; dir: 1 | -1 } | null>(null)
  const [all, setAll] = React.useState(size === 'panel')
  const pageSize = d.page_size ?? 10
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase()
    let r = needle ? d.rows.filter((row) => row.some((c) => c != null && String(c).toLowerCase().includes(needle))) : d.rows
    if (sort) {
      const { i, dir } = sort
      r = [...r].sort((a, b) => {
        const x = a[i], y = b[i]
        const nx = asNumber(x), ny = asNumber(y)
        if (nx != null && ny != null) return (nx - ny) * dir
        if (x == null) return 1
        if (y == null) return -1
        return String(x).localeCompare(String(y), lang, { numeric: true }) * dir
      })
    }
    return r
  }, [d.rows, q, sort, lang])
  const shown = all ? rows : rows.slice(0, pageSize)
  const title = titleOf(block.data, t('blocks.type.table'))
  const name = fileName(title, 'table')
  const menu = useDataMenu(block.raw, name, onRaw)
  const right = (c: Col) => c.align === 'right' || (c.align == null && c.type !== 'text' && c.type !== 'bar')
  return (
    <BlockShell
      icon="table"
      title={<Sensitive>{title}</Sensitive>}
      source={d.source ? <Sensitive>{d.source}</Sensitive> : undefined}
      headerExtra={
        <div className="relative hidden w-44 @xl:block">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('blocks.table.filter')} aria-label={t('blocks.table.filter')} className="h-8 pl-8 text-[13px]" />
        </div>
      }
      onOpenBeside={onOpenBeside}
      menu={menu}
      bodyClassName="p-0"
      footer={
        <>
          <span className="text-xs text-muted-foreground">
            {t('blocks.table.count', { shown: shown.length, total: d.rows.length })}
          </span>
          {rows.length > pageSize && (
            <Button variant="link" size="sm" className="h-auto" onClick={() => setAll((v) => !v)}>
              {all ? t('blocks.table.less') : t('blocks.table.all')}
            </Button>
          )}
          <span className="ml-auto flex gap-2">
            {block.plugin.pin && <PinButton type="table" data={block.data} title={title} />}
            <Button variant="outline" size="sm" onClick={() => downloadText(`${name}.csv`, toCsv([cols.map((c) => c.label), ...rows]), 'text/csv')}>
              <SheetIcon /> {t('blocks.action.exportCsv')}
            </Button>
          </span>
        </>
      }
    >
      <div className="p-2 @xl:hidden">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('blocks.table.filter')} aria-label={t('blocks.table.filter')} className="h-9" />
      </div>
      <div className={cn('overflow-auto', size === 'panel' ? 'max-h-[70vh]' : 'max-h-[480px]')}>
        <table className="w-full text-sm [overflow-wrap:normal]">
          <thead className="sticky top-0 z-[1] bg-card">
            <tr className="border-b text-left text-xs text-muted-foreground">
              {cols.map((c, i) => {
                const dir = sort?.i === i ? sort.dir : 0
                return (
                  <th key={i} aria-sort={dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none'} className={cn('px-3 py-2 font-medium whitespace-nowrap sm:px-4', right(c) && 'text-right')}>
                    <button
                      type="button"
                      onClick={() => setSort(dir === 0 ? { i, dir: c.type === 'text' ? 1 : -1 } : dir === (c.type === 'text' ? 1 : -1) ? { i, dir: dir === 1 ? -1 : 1 } : null)}
                      className={cn('inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', dir && 'text-foreground')}
                    >
                      <Sensitive length={6}>{c.label}</Sensitive>
                      {dir === 1 ? <ArrowUp className="size-3" /> : dir === -1 ? <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri} className="border-b last:border-0 hover:bg-accent/40">
                {cols.map((c, ci) => (
                  <td key={ci} className={cn('px-3 py-2 sm:px-4', right(c) ? 'text-right whitespace-nowrap' : 'min-w-32', c.type === 'bar' && 'w-[22%] min-w-24')}>
                    <Sensitive length={4}>
                      <TableCell col={c} value={r[ci] ?? null} lang={lang} />
                    </Sensitive>
                  </td>
                ))}
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={cols.length} className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                  {t('blocks.table.noMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </BlockShell>
  )
}

/* ------------------------------------------------------------------ stats */
type StatItem = { label: string; value: string | number; delta?: string | number; hint?: string; tone?: 'ok' | 'warn' | 'error' }

export function StatsBlock({ block, onRaw, onOpenBeside }: RendererProps) {
  const lang = useLang()
  const d = block.data as { title?: string; source?: string; items: StatItem[] }
  const menu = useDataMenu(block.raw, fileName(str(d.title), 'stats'), onRaw)
  const grid = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
      {d.items.map((it, i) => {
        const delta = it.delta == null || it.delta === '' ? null : String(it.delta)
        const neg = delta != null && /^\s*[-−]/.test(delta)
        const pos = delta != null && /^\s*\+/.test(delta)
        return (
          <div key={i} className="mx-rise grid min-w-0 gap-1 rounded-xl border bg-card px-4 py-3" style={{ '--i': Math.min(i, 10) } as React.CSSProperties}>
            <span className="truncate text-[13px] text-muted-foreground">{it.label}</span>
            <span className={cn('truncate text-2xl leading-8 font-semibold tracking-tight', it.tone === 'ok' && 'text-success', it.tone === 'warn' && 'text-warning', it.tone === 'error' && 'text-destructive')}>
              <Sensitive length={4}>{typeof it.value === 'number' ? new Intl.NumberFormat(lang).format(it.value) : it.value}</Sensitive>
            </span>
            {(delta || it.hint) && (
              <span className="flex min-w-0 flex-wrap gap-x-1.5 text-xs">
                {delta && (
                  <span className={cn('font-medium', it.tone === 'warn' ? 'text-warning' : neg ? 'text-destructive' : pos ? 'text-success' : 'text-muted-foreground')}>
                    <Sensitive length={3}>{delta}</Sensitive>
                  </span>
                )}
                {it.hint && <span className="truncate text-muted-foreground">{it.hint}</span>}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
  // Without a title the figures stand alone (as in a written answer); with one they get the block header.
  if (!d.title) return <div className="mx-block not-prose my-3">{grid}</div>
  return (
    <BlockShell icon="gauge" title={<Sensitive>{d.title}</Sensitive>} source={d.source ? <Sensitive>{d.source}</Sensitive> : undefined} menu={menu} onOpenBeside={onOpenBeside} footer={block.plugin.pin ? <PinButton type="stats" data={block.data} title={d.title} /> : undefined}>
      {grid}
    </BlockShell>
  )
}

/* ------------------------------------------------------------------ list / timeline / progress (dashboard look) */
function toUnix(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v / 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms / 1000 : null
  }
  return null
}

export function toTimeline(data: Record<string, unknown>): TimelineBlock {
  const lanes = (data.lanes as { name: string; sub?: string; events: { at: unknown; state?: string; label?: string }[] }[]).map((l) => ({
    name: l.name,
    sub: l.sub,
    events: l.events.flatMap((e) => {
      const at = toUnix(e.at)
      return at == null ? [] : [{ at, state: e.state as 'ok' | 'error' | 'running' | 'planned' | undefined, label: e.label }]
    }),
  }))
  const stamps = lanes.flatMap((l) => l.events.map((e) => e.at))
  const now = Date.now() / 1000
  let start = toUnix(data.start) ?? (stamps.length ? Math.min(...stamps) : now - 86400)
  let end = toUnix(data.end) ?? (stamps.length ? Math.max(...stamps) : now)
  if (end <= start) {
    start -= 1800
    end = start + 3600
  } else if (toUnix(data.start) == null || toUnix(data.end) == null) {
    const pad = (end - start) * 0.04
    if (toUnix(data.start) == null) start -= pad
    if (toUnix(data.end) == null) end += pad
  }
  return { type: 'timeline', start, end, now: toUnix(data.now) ?? (now >= start && now <= end ? now : undefined), lanes }
}

export function CardBlocks({ block, onOpenBeside, onRaw }: RendererProps) {
  const t = useT()
  const d = block.data
  const type = block.type as 'list' | 'timeline' | 'progress'
  const cards: CardBlock[] = React.useMemo(() => {
    if (type === 'timeline') return [toTimeline(d)]
    if (type === 'progress') {
      const items = (d.items as Record<string, unknown>[] | undefined) ?? [d]
      return items.map((it) => ({ type: 'progress', label: str(it.label), value: Number(it.value), max: Number(it.max), unit: str(it.unit) || undefined, hint: str(it.hint) || undefined, format: it.format as 'percent' | 'fraction' | undefined }))
    }
    return [{ type: 'list', items: d.items as never, grid: !!d.grid }]
  }, [d, type])
  const title = titleOf(d, t(`blocks.type.${type}`))
  const menu = useDataMenu(block.raw, fileName(title, type), onRaw)
  return (
    <BlockShell
      icon={block.plugin.icon}
      title={<Sensitive>{title}</Sensitive>}
      source={str(d.source) ? <Sensitive>{str(d.source)}</Sensitive> : undefined}
      onOpenBeside={onOpenBeside}
      menu={menu}
      footer={block.plugin.pin ? <PinButton type={type} data={d} title={title} /> : undefined}
      bodyClassName={type === 'list' ? 'px-3 py-2' : undefined}
    >
      <div className="grid gap-4">
        {cards.map((c, i) => (
          <BlockView key={i} block={c} />
        ))}
      </div>
    </BlockShell>
  )
}
