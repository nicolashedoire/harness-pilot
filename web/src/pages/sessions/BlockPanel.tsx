// "Open beside" of a conversation block (features/blocks, `BlockHostProvider.openPanel`): the blocks opened from a
// session's thread, as tabs in a panel docked on the right of the conversation when the column is wide enough,
// else in a side sheet (a bottom sheet on a phone). The block is drawn again at its `panel` size by the blocks chunk
// (same plugin, same data), so its own actions (switch view, pin, download, raw data) work there too.
// While docked, a block shown in the panel leaves a compact "Opened beside · <title>" placeholder in the thread
// (`BlockHost.beside`, drawn by the blocks chunk): Show selects and focuses its tab, Bring back closes it.
import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Sensitive, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Tooltip, useMask } from '@/components/ui'
import { BlockFence } from '@/features/blocks/fence'
import type { BlockBeside, BlockPanelRequest, BlockRef } from '@/features/blocks/host'

/** Blocks kept open at once (the oldest tab leaves). */
const MAX_TABS = 6
/** Width of the conversation row from which the panel docks beside the thread instead of covering it. */
const DOCK_MIN = 1040

export type BlockPanelState = { items: BlockPanelRequest[]; active: number }

const same = (a: BlockRef, b: BlockRef) => a.type === b.type && a.raw === b.raw

/** The state without tab `i` (null once the last tab leaves). */
function without(s: BlockPanelState, i: number): BlockPanelState | null {
  const items = s.items.filter((_, k) => k !== i)
  if (!items.length) return null
  return { items, active: s.active > i ? s.active - 1 : Math.min(s.active, items.length - 1) }
}

/** The panel of one session column: opening a block already open selects its tab. Reset when the session changes.
 *  `focusSeq` grows each time the panel should take the focus (Open beside, Show): the docked panel moves it to the
 *  active tab (a sheet traps it by itself). */
export function useBlockPanel(sid: string) {
  const [state, setState] = React.useState<BlockPanelState | null>(null)
  const [focusSeq, setFocusSeq] = React.useState(0)
  React.useEffect(() => setState(null), [sid])
  const open = React.useCallback((req: BlockPanelRequest) => {
    setState((s) => {
      const items = s?.items ?? []
      const i = items.findIndex((x) => same(x, req))
      if (i >= 0) return { items, active: i }
      const next = [...items, req].slice(-MAX_TABS)
      return { items: next, active: next.length - 1 }
    })
    setFocusSeq((n) => n + 1)
  }, [])
  const select = React.useCallback((i: number) => setState((s) => (s ? { ...s, active: i } : s)), [])
  const closeTab = React.useCallback((i: number) => setState((s) => (s ? without(s, i) : s)), [])
  const close = React.useCallback(() => setState(null), [])
  const reveal = React.useCallback((ref: BlockRef) => {
    setState((s) => {
      const i = s ? s.items.findIndex((x) => same(x, ref)) : -1
      return s && i >= 0 ? { ...s, active: i } : s
    })
    setFocusSeq((n) => n + 1)
  }, [])
  const bringBack = React.useCallback(
    (ref: BlockRef) =>
      setState((s) => {
        const i = s ? s.items.findIndex((x) => same(x, ref)) : -1
        return s && i >= 0 ? without(s, i) : s
      }),
    [],
  )
  return { state, focusSeq, open, select, closeTab, close, reveal, bringBack }
}

/** What the thread's blocks know of the panel: only while it is docked beside them (a sheet covers the thread and
 *  gives the focus back to the block's own "Open beside" when it closes). */
export function useBlockBeside(panel: ReturnType<typeof useBlockPanel>, docked: boolean): BlockBeside | undefined {
  const { state, reveal, bringBack } = panel
  return React.useMemo(
    () => (docked && state ? { has: (ref: BlockRef) => state.items.some((x) => same(x, ref)), reveal, bringBack } : undefined),
    [docked, state, reveal, bringBack],
  )
}

/** True while `ref` is at least `min` px wide. */
export function useWideEnough(ref: React.RefObject<HTMLElement | null>, min = DOCK_MIN) {
  const [wide, setWide] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => setWide(el.clientWidth >= min)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, min])
  return wide
}

type Props = ReturnType<typeof useBlockPanel> & { state: BlockPanelState; docked: boolean }

export function BlockPanel({ state, focusSeq, docked, select, closeTab, close }: Props) {
  const t = useT()
  const req = state.items[state.active]
  // Open beside / Show: the focus goes to the active tab (or the title of a single block) of the docked panel, once
  // per request - not again when the column is resized across the docking width
  const aside = React.useRef<HTMLElement>(null)
  const focused = React.useRef(0)
  React.useEffect(() => {
    if (focusSeq === focused.current) return
    focused.current = focusSeq
    if (!docked) return
    const root = aside.current
    root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [data-panel-title]')?.focus()
  }, [focusSeq, docked])
  const body = (
    <BlockFence key={`${req.type}:${state.active}:${req.raw.length}`} block={{ type: req.type, explicit: true, candidate: false }} code={req.raw} fallback={null} panel />
  )
  const tabs = state.items.length > 1 && <PanelTabs state={state} select={select} closeTab={closeTab} />
  if (!docked)
    return (
      <Sheet open onOpenChange={(o) => !o && close()}>
        <SheetContent className="md:w-[min(760px,92vw)]">
          <SheetHeader>
            <SheetTitle>
              <Sensitive>{req.title}</Sensitive>
            </SheetTitle>
            <SheetDescription className="sr-only">{t('blocks.panel.label')}</SheetDescription>
            {tabs}
          </SheetHeader>
          <SheetBody>{body}</SheetBody>
        </SheetContent>
      </Sheet>
    )
  return (
    <aside ref={aside} aria-label={t('blocks.panel.label')} className="flex min-h-0 w-[clamp(380px,44%,640px)] shrink-0 flex-col border-l bg-background" data-testid="block-panel">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b pr-1.5 pl-2">
        <div className="min-w-0 flex-1">
          {tabs || (
            <h2 tabIndex={-1} data-panel-title className="truncate rounded-md px-1.5 text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <Sensitive>{req.title}</Sensitive>
            </h2>
          )}
        </div>
        <Tooltip content={t('blocks.panel.close')}>
          <button type="button" onClick={close} aria-label={t('blocks.panel.close')} className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X className="size-4" />
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-1" role="tabpanel">
        {body}
      </div>
    </aside>
  )
}

function PanelTabs({ state, select, closeTab }: { state: BlockPanelState; select: (i: number) => void; closeTab: (i: number) => void }) {
  const t = useT()
  const mask = useMask()
  return (
    <div role="tablist" aria-label={t('blocks.panel.label')} className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {state.items.map((it, i) => {
        const on = i === state.active
        return (
          <span key={`${it.type}:${i}`} className={cn('group/tab flex h-8 max-w-52 shrink-0 items-center rounded-md text-[13px]', on ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
            <button type="button" role="tab" aria-selected={on} onClick={() => select(i)} className="h-full min-w-0 truncate rounded-md pr-1 pl-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <Sensitive>{it.title}</Sensitive>
            </button>
            <button type="button" onClick={() => closeTab(i)} aria-label={t('blocks.panel.closeTab', { title: mask(it.title) })} className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <X className="size-3.5" />
            </button>
          </span>
        )
      })}
    </div>
  )
}
