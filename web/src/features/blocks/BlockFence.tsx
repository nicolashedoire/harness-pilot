// A fenced block of an answer, drawn (lazy chunk: loaded with the first block, with the `blocks` dictionary).
//   1. parse the body (JSON, or the raw text of terminal / diff / app), size-capped;
//   2. find the plugin that draws the type: none -> "not installed" (or plain code for a guess); off -> "turned
//      off" (activate / raw data); broken -> its error;
//   3. validate the data against the plugin's schema (+ URL and path checks): invalid -> the reason, "Ask for a
//      fix", raw data;
//   4. draw it - a built-in renderer or the extension's sandboxed frame - inside an error boundary.
import * as React from 'react'
import './blocks.css'
import { Link } from 'react-router'
import { Ban, PackagePlus, Power, TriangleAlert, Wrench, X } from 'lucide-react'
import { useLang, useT } from '@/i18n'
import { Button, Sensitive, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton } from '@/components/ui'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { BLOCK_OPEN_EVENT, useBlockHost, type BlockPanelRequest } from './host'
import { RAW_BLOCK_TYPES, type FenceBlock } from './fence'
import { useBlocks, useToggleBlock } from './queries'
import { validate } from './schema'
import { BlockNotice, OpenedBeside, RawData, useSendToSession, type BlockSize } from './shell'
import { pluginLabel } from './labels'
import type { BlockInstance, BlockPlugin } from './types'
import type { RendererProps } from './builtins/types'
import { CardBlocks, ChartBlock, StatsBlock, TableBlock } from './builtins/data'
import { DiffBlock, TerminalBlock } from './builtins/code'
import { FileBlock, LinkBlock } from './builtins/media'
import { ChecklistBlock, CreatedBlock, FormBlock } from './builtins/interactive'
import { AppBlock, PluginBlock } from './builtins/frames'

/** Larger bodies are not parsed (the server caps block data the same way). */
export const MAX_BLOCK_BYTES = 512 * 1024

const RENDERERS: Record<string, React.ComponentType<RendererProps>> = {
  chart: ChartBlock,
  table: TableBlock,
  stats: StatsBlock,
  list: CardBlocks,
  timeline: CardBlocks,
  progress: CardBlocks,
  terminal: TerminalBlock,
  diff: DiffBlock,
  file: FileBlock,
  link: LinkBlock,
  form: FormBlock,
  checklist: ChecklistBlock,
  app: AppBlock,
  created: CreatedBlock,
}

/** FNV-1a: a short stable key of a block (what this browser remembers about it). */
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

type Parsed = { ok: true; data: Record<string, unknown>; json: boolean } | { ok: false; reason: 'too_large' | 'not_json' | 'not_object'; detail?: string }

function parse(code: string, rawField: string | null): Parsed {
  if (code.length > MAX_BLOCK_BYTES) return { ok: false, reason: 'too_large' }
  const text = code.trim()
  if (rawField && !text.startsWith('{')) return { ok: true, data: { [rawField]: code.replace(/\n$/, '') }, json: false }
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: 'not_object' }
    return { ok: true, data: v as Record<string, unknown>, json: true }
  } catch (e) {
    return { ok: false, reason: 'not_json', detail: e instanceof Error ? e.message : String(e) }
  }
}

const SAFE_LINK = /^(https?:\/\/[^\s]+|\/(?!\/)[^\s]*)$/i

/** What the schema cannot say: links that may be followed, paths that may be opened. */
function extraChecks(type: string, data: Record<string, unknown>): string[] {
  const out: string[] = []
  if (type === 'link' && !SAFE_LINK.test(String(data.url ?? ''))) out.push('url: must start with https:// (or be an app route such as /tasks)')
  if (type === 'file') {
    const items = (data.items as { path?: unknown }[] | undefined) ?? [{ path: data.path }]
    items.forEach((it, i) => {
      const p = String(it?.path ?? '')
      if (!p.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(p)) out.push(`${data.items ? `items[${i}].` : ''}path: must be an absolute path of the server`)
    })
  }
  if (type === 'list')
    ((data.items as { href?: unknown }[] | undefined) ?? []).forEach((it, i) => {
      if (it?.href != null && !SAFE_LINK.test(String(it.href))) out.push(`items[${i}].href: must start with https:// or /`)
    })
  if (type === 'chart') {
    const series = data.series as { points: unknown[] }[]
    if (series.length > 1 && series.some((s) => s.points.length !== series[0].points.length)) out.push('series: every series needs the same number of points')
  }
  return out
}

/** `panel`: drawn at its large size, in the conversation's side panel ("Open beside" taken over by the view). */
export default function BlockFence({ block, code, fallback, className, panel: inPanel }: { block: FenceBlock; code: string; fallback: React.ReactNode; className?: string; panel?: boolean }) {
  const t = useT()
  const lang = useLang()
  const host = useBlockHost()
  const { data: cat, isLoading, isError, refetch } = useBlocks()
  const toggle = useToggleBlock()
  const send = useSendToSession()
  const anchor = React.useRef<HTMLDivElement>(null)
  const [panel, setPanel] = React.useState(false)
  const [rawOpen, setRawOpen] = React.useState(false)
  // Shown in the side panel docked beside the thread: a placeholder stands here. Brought back from it, the focus
  // returns to the block's own "Open beside" (the placeholder's button is gone).
  const ref = React.useMemo(() => ({ type: block.type, raw: code }), [block.type, code])
  const shownBeside = !inPanel && !!host?.beside?.has(ref)
  const refocus = React.useRef(false)
  React.useEffect(() => {
    if (shownBeside || !refocus.current) return
    refocus.current = false
    const el = anchor.current
    const target = el?.querySelector<HTMLElement>('[data-mx-open-beside]')
    if (target) target.focus()
    else if (el) {
      el.tabIndex = -1
      el.focus()
    }
  }, [shownBeside])
  const type = block.type
  const drawers = cat?.plugins.filter((p) => p.renders.includes(type)) ?? []
  const plugin: BlockPlugin | undefined = drawers.find((p) => !p.error) ?? drawers[0]
  const parsed = React.useMemo(() => parse(code, plugin?.raw ?? (RAW_BLOCK_TYPES.has(type) ? ({ terminal: 'output', diff: 'diff', app: 'html' } as Record<string, string>)[type] : null)), [code, plugin?.raw, type])
  const errors = React.useMemo(() => {
    if (!plugin || !parsed.ok) return []
    const e = validate(plugin.schema, parsed.data)
    return e.length ? e : plugin.kind === 'builtin' ? extraChecks(type, parsed.data) : []
  }, [plugin, parsed, type])
  const memoKey = React.useMemo(() => hash(`${type}\n${code}`), [type, code])
  const name = plugin ? pluginLabel(t, plugin, lang) : type
  const wrap = (node: React.ReactNode) => (
    <div ref={anchor} className={className ? `${className} min-w-0` : 'min-w-0'} data-mx-block={type}>
      {node}
    </div>
  )

  const askFix = (reason: string) =>
    void send(t('blocks.error.fixMessage', { type, reason }), anchor.current)

  if (isLoading) return wrap(block.candidate ? fallback : <Skeleton className="my-3 h-40 rounded-xl" />)
  if (isError || !cat) {
    if (block.candidate) return <>{fallback}</>
    return wrap(
      <BlockNotice type={type} raw={code} icon={<TriangleAlert />} tone="error" title={t('blocks.error.catalog')} actions={<Button size="sm" variant="outline" onClick={() => refetch()}>{t('common.retry')}</Button>} />,
    )
  }
  if (!plugin) {
    if (block.candidate) return <>{fallback}</>
    return wrap(
      <BlockNotice
        type={type}
        raw={code}
        icon={<PackagePlus />}
        title={t('blocks.missing.title', { type })}
        actions={
          <Button size="sm" asChild>
            <Link to="/settings/blocks?catalogue=1">{t('blocks.missing.install')}</Link>
          </Button>
        }
      >
        {t('blocks.missing.desc', { type })}
      </BlockNotice>,
    )
  }
  if (!plugin.enabled) {
    // a raw-text fence of a built-in that is off (```diff, ```terminal) is ordinary code again
    if (plugin.raw && parsed.ok && !parsed.json) return <>{fallback}</>
    return wrap(
      <BlockNotice
        type={type}
        raw={code}
        icon={<Ban />}
        title={parsed.ok && typeof parsed.data.title === 'string' && parsed.data.title ? <Sensitive>{parsed.data.title}</Sensitive> : name}
        actions={
          <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate({ id: plugin.id, enabled: true })}>
            <Power /> {t('blocks.disabled.enable')}
          </Button>
        }
      >
        {t('blocks.disabled.desc', { name })}
      </BlockNotice>,
    )
  }
  if (plugin.error)
    return wrap(
      <BlockNotice type={type} raw={code} tone="error" icon={<TriangleAlert />} title={t('blocks.error.plugin', { name })} actions={<Button size="sm" variant="outline" asChild><Link to="/settings/blocks">{t('blocks.manage')}</Link></Button>}>
        <span className="font-mono break-all">{plugin.error}</span>
      </BlockNotice>,
    )
  if (!parsed.ok || errors.length) {
    const reason = !parsed.ok ? (parsed.reason === 'too_large' ? t('blocks.error.tooLarge') : parsed.reason === 'not_object' ? t('blocks.error.notObject') : `${t('blocks.error.notJson')} (${parsed.detail})`) : errors.slice(0, 4).join('\n')
    return wrap(
      <BlockNotice
        type={type}
        raw={code}
        tone="error"
        icon={<TriangleAlert />}
        title={t('blocks.error.invalid', { name })}
        actions={
          <Button size="sm" onClick={() => askFix(reason)}>
            <Wrench /> {t('blocks.error.askFix')}
          </Button>
        }
      >
        <span className="block font-mono text-[12px] whitespace-pre-wrap text-destructive">{reason}</span>
        <span className="block pt-1">{t('blocks.error.restSafe')}</span>
      </BlockNotice>,
    )
  }

  const instance: BlockInstance = { type, data: parsed.data, plugin, raw: code }
  const title = typeof parsed.data.title === 'string' && parsed.data.title ? parsed.data.title : name
  const openBeside = () => {
    const req: BlockPanelRequest = { type, title, data: parsed.data, raw: code }
    window.dispatchEvent(new CustomEvent(BLOCK_OPEN_EVENT, { detail: req }))
    if (host?.openPanel) host.openPanel(req)
    else setPanel(true)
  }
  const beside = host?.beside
  if (shownBeside && beside)
    return wrap(
      <OpenedBeside
        title={title}
        onShow={() => beside.reveal(ref)}
        onBringBack={() => {
          refocus.current = true
          beside.bringBack(ref)
        }}
      />,
    )
  const render = (size: BlockSize) => {
    const props: RendererProps = { block: instance, size, memoKey, onRaw: () => setRawOpen(true), onOpenBeside: size === 'panel' ? undefined : openBeside }
    if (plugin.kind === 'extension') return <PluginBlock {...props} onAskFix={askFix} />
    const R = RENDERERS[type]
    return R ? <R {...props} /> : null
  }
  return wrap(
    <>
      <ErrorBoundary variant="card" resetKey={code}>
        {render(inPanel ? 'panel' : 'in-thread')}
      </ErrorBoundary>
      {rawOpen && (
        <div className="relative -mt-1 mb-3">
          <RawData type={type} raw={code} />
          <Button variant="ghost" size="icon-sm" className="absolute top-0.5 right-9" aria-label={t('blocks.raw.hide')} onClick={() => setRawOpen(false)}>
            <X />
          </Button>
        </div>
      )}
      {panel && (
        <Sheet open={panel} onOpenChange={setPanel}>
          <SheetContent className="md:w-[min(760px,92vw)]">
            <SheetHeader>
              <SheetTitle>
                <Sensitive>{title}</Sensitive>
              </SheetTitle>
              <SheetDescription>{name}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <ErrorBoundary variant="card" resetKey={code}>
                {render('panel')}
              </ErrorBoundary>
            </SheetBody>
          </SheetContent>
        </Sheet>
      )}
    </>,
  )
}

/** A built-in block drawn from its sample data, whether it is on or off (Settings -> Conversation blocks). */
export function BlockPreview({ plugin, data }: { plugin: BlockPlugin; data: Record<string, unknown> }) {
  const raw = React.useMemo(() => JSON.stringify(data, null, 2), [data])
  const R = RENDERERS[plugin.id]
  if (plugin.kind !== 'builtin' || !R) return null
  const instance: BlockInstance = { type: plugin.id, data, plugin: { ...plugin, pin: false }, raw }
  return (
    <ErrorBoundary variant="card" resetKey={raw}>
      <div className="pointer-events-none select-none [&_.mx-block]:my-0" inert>
        <R block={instance} size="in-thread" memoKey={`preview-${plugin.id}`} />
      </div>
    </ErrorBoundary>
  )
}
