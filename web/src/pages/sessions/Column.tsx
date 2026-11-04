// One column = one session (or a "new session" draft). Shell (resize, drag-to-reorder, focus) +
// header (inline title, path, state, model, cost, context, notify, menu) + thread + composer.
import * as React from 'react'
import { useNavigate } from 'react-router'
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  CircleAlert,
  ExternalLink,
  PanelTop,
  RotateCw,
  Square,
  PictureInPicture2,
  FolderOpen,
  GripVertical,
  Hash,
  ListChecks,
  Minimize2,
  MoreHorizontal,
  Network,
  Sparkles,
  Trash2,
  Upload,
  X,
  Columns2,
  LayoutGrid,
  PenLine,
  Pause,
  Play,
  Quote,
  Rows2,
  SlidersHorizontal,
} from 'lucide-react'
import { cn, copyText } from '@/lib/utils'
import { TouchAppButton, TouchSessionsButton } from '@/components/shell/TouchNav'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useUI } from '@/stores/ui'
import { openHud } from './Hud'
import { useT } from '@/i18n'
import {
  useClaudeStatus,
  useClearQueue,
  useCompactSession,
  useCreateSession,
  useDeleteSession,
  useHandoffSession,
  useMarkSeen,
  usePatchSession,
  useSendMessage,
  useSessionSeeded,
  useSettings,
  useSteerSession,
  useTakeQueue,
  useStopSession,
  usePauseDiscussion,
  useResumeDiscussion,
  useTelegram,
  useWorkspace,
  uploadAttachment,
} from '@/lib/queries'
import { api, errorMessage, isApiError, seg } from '@/lib/api'
import type { Session } from '@/lib/types'
import {
  Button,
  confirm,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Checkbox,
  Input,
  Label,
  Select,
  Sensitive,
  Skeleton,
  toast,
  Tooltip,
  TooltipContent,
  TooltipRoot,
  TooltipTrigger,
  useMask,
} from '@/components/ui'
import { Combobox } from '@/components/ui/combobox'
import { Textarea } from '@/components/ui/textarea'
import { TaskBar } from './Tasks'
import { forgetLog, getLog, loadEarlier, loadLog, seedEmptyLog, useLogSelect, useSessionLog, useSessionStream, type LogState } from './log'
import { PlanCard, PlanToggle } from './Plan'
import { PausedBanner, PauseSeparator, pausedOnLimit } from './PausedBanner'
import { ChangeLimitsDialog } from './ChangeLimitsDialog'
import { BlockPanel, useBlockBeside, useBlockPanel, useWideEnough } from './BlockPanel'
import { BlockHostProvider, type BlockHost } from '@/features/blocks/host'
import { MaxxingControls, MaxxingMeter } from './MaxxingMeter'
import { notifySendFailed, notifySent, useMaxxingEnabled } from './maxxing'
import { MobileTabsSlot } from './Tabs'
import { AsidePanel, useAside } from './Aside'
import { SessionSummary } from './Summary'
import { AgentMap } from './AgentMap'
import { MixedTeam } from './MixedTeam'
import { LayoutPicker } from './LayoutPicker'
import { MIN_W } from './layouts'
import { EASE_OUT, reducedMotion } from '@/lib/presence'
import { canShift, focusComposer, groupAt, MAX_STACK, saveDraft, saveQuotes, seedComposer, useSessionsUI, usePending, usePendingFor, type Col, type OutboxEntry, type Seed } from './store'
import { Thread, type ThreadHandle } from './Thread'
import { Composer, type ComposerHandle } from './Composer'
import { QuotePill } from './Quote'
import { FileMenu } from './FileMenu'
import { ItemContext } from './Items'
import { AgentChip, ContextGauge, ModelPicker, StateBadge } from './Widgets'
import { ModePanel, ModePicker } from './NewSessionModes'
import { absTopicDir, fileQuote, modelLabel, topicLabel } from './util'
import { CONTENT_MIME, contentDragLeave, contentDragOver, contentDrop, useContentDrag, type Dropped } from './contentDrag'

export type ColumnVariant = 'column' | 'solo' | 'mobile'
export { MIN_W }
export const MAX_W = 2000

/** Cell of a session in the strip grid: its grid column, and the whole height or the top / bottom half. */
/** `top`: key of the session at the top of this grid column (its width is saved under that key). */
/** `hidden`: kept mounted but not shown (tabs view: only the focused session is on screen). */
/** Where a session sits in the strip grid: its column, its rank `i` in a stack of `n` (row: 'full' alone, 'top'
 *  first of a stack, 'bottom' any other), its grid lines, the top key of its stack. */
export type Place = { col: number; row: 'full' | 'top' | 'bottom'; i: number; n: number; gridRow: string; top?: string; hidden?: boolean }
/** The strip owns the grid template: handles ask it to resize a column or the row split. */
export const StripContext = React.createContext<{
  startColResize: (key: string, e: React.PointerEvent) => void
  resetColWidth: (key: string) => void
  startRowResize: (e: React.PointerEvent) => void
  /** Columns of the strip grid (two stacked sessions are one): no width handle when there is a single one. */
  columns: number
  resetRowSplit: () => void
} | null>(null)

/** Phone, tabs view: the open sessions' chips, under the app bar of the session's header. */
function MobileTabs() {
  return <>{React.useContext(MobileTabsSlot)}</>
}

/* ---------------------------------------------------------------- shell */
export function ColumnShell({ col, index, count, variant, place, children }: { col: Col; index: number; count: number; variant: ColumnVariant; place?: Place; children: React.ReactNode }) {
  const focused = useSessionsUI((s) => s.focused === col.key)
  const focus = useSessionsUI((s) => s.focus)
  const strip = React.useContext(StripContext)
  const ref = React.useRef<HTMLElement>(null)
  const [dropSide, setDropSide] = React.useState<'above' | 'below' | null>(null)
  const isCol = variant === 'column'
  const rank = place?.i ?? 0
  const size = place?.n ?? 1
  const groupKey = place?.top ?? col.key
  // beside the whole strip column: the line runs along every session of it, not only the one under the pointer
  const beside = useSessionsUI((s) => (s.dropBeside?.top === groupKey ? s.dropBeside.side : null))
  // widened by hand to read: the conversation and the composer use the whole width (otherwise 860 px at most)
  // a half column fixes every width of the strip (index.tsx template): no resize handle, no hand width
  const halfShown = useSessionsUI((s) => s.cols.some((c) => c.half))
  const widened = useSessionsUI((s) => isCol && !!strip && strip.columns > 1 && !halfShown && (s.widths[groupKey] ?? 0) > 900)

  const isColDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('application/x-mx-col')
  return (
    <section
      ref={ref}
      data-col={col.key}
      aria-label={`Column ${index + 1}`}
      onFocusCapture={() => isCol && focus(col.key)}
      onPointerDownCapture={() => isCol && focus(col.key)}
      onDragOver={(e) => {
        if (!isCol || !isColDrag(e)) return
        e.preventDefault()
        const r = ref.current!.getBoundingClientRect()
        const ui = useSessionsUI.getState()
        // upper third of a stack's top session / lower third of its last one: stack above / under it, while the
        // column holds fewer than MAX_STACK
        const room = size < MAX_STACK
        const v = room && rank === size - 1 && e.clientY > r.top + r.height * 0.66 ? 'below' : room && rank === 0 && e.clientY < r.top + r.height * 0.34 ? 'above' : null
        setDropSide(v)
        ui.setDropBeside(v ? null : { top: groupKey, side: e.clientX < r.left + r.width / 2 ? 'left' : 'right' })
      }}
      onDragLeave={(e) => {
        if (ref.current?.contains(e.relatedTarget as Node)) return
        setDropSide(null)
        const ui = useSessionsUI.getState()
        if (ui.dropBeside?.top === groupKey) ui.setDropBeside(null)
      }}
      onDrop={(e) => {
        if (!isColDrag(e)) return
        e.preventDefault()
        const key = e.dataTransfer.getData('application/x-mx-col')
        const ui = useSessionsUI.getState()
        const side = dropSide ?? (ui.dropBeside?.top === groupKey ? ui.dropBeside.side : null)
        setDropSide(null)
        ui.setDropBeside(null)
        if (!key || key === col.key) return
        if (side === 'below') return ui.stack(key, col.key)
        if (side === 'above') return ui.stackAbove(key, col.key)
        // beside the whole strip column (a stack stays a stack)
        ui.moveBeside(key, col.key, side ?? 'right')
      }}
      // In the strip, the grid places the session (its width comes from the grid template, see index.tsx).
      style={{
        ...(isCol && place && { gridColumn: place.col, gridRow: place.gridRow }),
        // reading column: 740 px, or the whole width once widened by hand
        ...({ '--mx-read': widened ? 'none' : '740px' } as React.CSSProperties),
      }}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col bg-background',
        isCol && 'border-r',
        isCol && rank < size - 1 && 'border-b',
        isCol && count > 1 && focused && 'shadow-[inset_0_2px_0_0_var(--primary)]',
        !isCol && 'h-full w-full',
        place?.hidden && 'hidden',
      )}
    >
      {children}
      {dropSide === 'below' || dropSide === 'above' ? (
        <span aria-hidden className={cn('pointer-events-none absolute inset-x-2 z-20 h-1/3 rounded-lg border-2 border-dashed border-primary bg-primary/10 animate-in', dropSide === 'below' ? 'bottom-2' : 'top-2')} />
      ) : (
        beside && <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-primary', beside === 'left' ? 'left-0' : 'right-0')} />
      )}
      {isCol && strip && strip.columns > 1 && !halfShown && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize"
          onPointerDown={(e) => strip.startColResize(place?.top ?? col.key, e)}
          onDoubleClick={() => strip.resetColWidth(place?.top ?? col.key)}
          // Just past the right edge (never over the column's own scrollbar); the strip keeps an 8 px gutter at its
          // end for the last column's handle. Only a thin line on the border lights up.
          className="absolute inset-y-0 left-full z-10 -ml-px w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-0 after:w-[3px] after:transition-colors hover:after:bg-primary/40 active:after:bg-primary/60"
        />
      )}
      {isCol && strip && size === 2 && rank === 1 && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize"
          onPointerDown={strip.startRowResize}
          onDoubleClick={strip.resetRowSplit}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none after:absolute after:inset-x-0 after:top-1 after:h-[3px] after:transition-colors hover:after:bg-primary/40 active:after:bg-primary/60"
        />
      )}
    </section>
  )
}

/** A session can go under the column on its left when that column holds one session only. */
function canStackUnderPrevious(key: string) {
  const cols = useSessionsUI.getState().cols
  const i = cols.findIndex((c) => c.key === key)
  if (i < 1) return false
  // the column on the left holds fewer than MAX_STACK
  const [start, end] = groupAt(cols, i - 1)
  return end - start + 1 < MAX_STACK
}

/** Where three sessions share a column, only the focused one shows its composer (the others fold it into a thin
 *  "Write…" bar, smoothly); a click anywhere in the session focuses it and unfolds its composer. Two stacked
 *  sessions both keep theirs (FEU: having to click first was in the way). */
function StackedComposer({ colKey, stacked, children }: { colKey: string; stacked: boolean; children: React.ReactNode }) {
  const t = useT()
  const focused = useSessionsUI((s) => s.focused === colKey)
  const open = !stacked || focused
  // The height changes at once and only the box fades / rises in: animating the height re-laid and repainted the
  // whole conversation above it on every frame. Hidden (not unmounted): the draft and attachments stay.
  const box = React.useRef<HTMLDivElement>(null)
  const wasOpen = React.useRef(open)
  React.useLayoutEffect(() => {
    if (open && !wasOpen.current && !reducedMotion())
      box.current?.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: EASE_OUT })
    wasOpen.current = open
  }, [open])
  return (
    <div className="shrink-0">
      <div ref={box} hidden={!open} inert={!open || undefined}>
        {children}
      </div>
      {!open && (
        <button
          type="button"
          onClick={() => {
            useSessionsUI.getState().focus(colKey)
            requestAnimationFrame(() => focusComposer(colKey))
          }}
          className="mx-3 mb-2 flex h-8 w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border bg-muted/40 px-3 text-left text-[13px] text-muted-foreground transition-colors animate-in hover:bg-accent hover:text-foreground"
          data-testid="composer-folded"
        >
          <PenLine className="size-3.5 shrink-0" />
          {t('sessions.grid.write')}
        </button>
      )}
    </div>
  )
}

/** Content of another session dropped here (contentDrag.ts): into this column's composer as a quote, never sent. */
function quoteDropped(colKey: string, composer: ComposerHandle | null, d: Dropped) {
  if (!composer) return
  composer.quote(d.kind === 'file' ? fileQuote(d.path) : d.text)
  window.getSelection()?.removeAllRanges()
  // a folded composer (two sessions in a column) unfolds with the focus
  useSessionsUI.getState().focus(colKey)
  requestAnimationFrame(() => composer.focus())
}

/** While content of another session is dragged: this column is a drop zone (stronger under the pointer). Only these
 *  overlays follow the drag, not the threads. */
function ContentDropOverlay({ colKey, sid }: { colKey: string; sid: string | null }) {
  const t = useT()
  const state = useContentDrag((s) => (!s.drag || s.drag.from === sid ? null : s.over === colKey ? 'over' : 'on'))
  if (!state) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm font-medium transition-colors',
        state === 'over' ? 'border-primary bg-background/95' : 'border-primary/40 bg-background/60 text-muted-foreground',
      )}
      data-testid="content-drop"
      data-over={state === 'over' || undefined}
    >
      <Quote className="size-6 text-primary" />
      {t('drag.dropToQuote')}
    </div>
  )
}

/** Drag handle for reordering (header). Holding it still shows the ready-made layouts; dragging it shows the
 *  layouts bar at the top of the strip (drop the session on a zone). */
function DragGrip({ colKey }: { colKey: string }) {
  const count = useSessionsUI((s) => s.cols.length)
  const fromMenu = useSessionsUI((s) => s.layoutPicker === colKey)
  const ended = React.useRef(false)
  return (
    <LayoutPicker count={count} colKey={colKey} holdOpens open={fromMenu} onOpenChange={(v) => !v && useSessionsUI.getState().setLayoutPicker(null)}>
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-mx-col', colKey)
          e.dataTransfer.effectAllowed = 'move'
          // the header only: a snapshot of the whole column (its conversation) is slow to take
          const head = (e.currentTarget as HTMLElement).closest('header') as HTMLElement | null
          if (head) e.dataTransfer.setDragImage(head, 40, 20)
          // after the drag has started (changing the page during dragstart can cancel it) - unless it already ended
          ended.current = false
          requestAnimationFrame(() => !ended.current && useSessionsUI.getState().setDragging(colKey))
        }}
        onDragEnd={() => {
          ended.current = true
          useSessionsUI.getState().setDragging(null)
        }}
        className="-ml-1 flex h-8 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        aria-hidden
        data-testid="col-grip"
      >
        <GripVertical className="size-3.5" />
      </span>
    </LayoutPicker>
  )
}

/* ---------------------------------------------------------------- session column */
/** The thread with its own subscription to the log (the column opens the stream). */
// Memo: a column re-renders when it gains or loses the focus (and on every session poll); its thread only when its own
// props change (callbacks below are stable per session).
const LiveThread = React.memo(
  React.forwardRef<ThreadHandle, Omit<React.ComponentProps<typeof Thread>, 'log'> & { sid: string }>(function LiveThread({ sid, ...props }, ref) {
    return <Thread ref={ref} log={useSessionLog(sid, false)} {...props} />
  }),
)

/** A stacked session shorter than this keeps a one-line header (see ColumnHeader `slim`). */
const SLIM_BELOW = 560

/** True while the session holding `head` is stacked with others and short: its header drops what is rarely used. */
function useSlimHeader(head: React.RefObject<HTMLElement | null>, stacked: boolean) {
  const [slim, setSlim] = React.useState(false)
  React.useLayoutEffect(() => {
    const box = head.current?.parentElement
    if (!stacked || !box) return setSlim(false)
    const fit = () => setSlim(box.clientHeight < SLIM_BELOW)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [head, stacked])
  return slim
}

export function SessionColumn({ col, sid, variant, index, count, place }: { col: Col; sid: string; variant: ColumnVariant; index: number; count: number; place?: Place }) {
  const t = useT()
  const navigate = useNavigate()
  const { data: session, isError, error } = useSessionSeeded(sid)
  // The stream lives here; only the thread re-renders on new events (LiveThread), not the column and its composer.
  useSessionStream(sid, session?.state === 'running')
  const deleted = useLogSelect(sid, (st) => st.deleted)
  const pending = usePendingFor(sid)
  const { data: ws } = useWorkspace()
  const { data: settings } = useSettings()
  const { data: claude } = useClaudeStatus()
  const { data: tg } = useTelegram()
  const focused = useSessionsUI((s) => s.focused === col.key)
  const onRetry = React.useCallback(() => void loadLog(sid, true), [sid])
  const onLoadEarlier = React.useCallback(() => void loadEarlier(sid), [sid])
  const close = useSessionsUI((s) => s.close)
  const becomeSession = useSessionsUI((s) => s.becomeSession)
  const patch = usePatchSession()
  const send = useSendMessage()
  const stop = useStopSession()
  const pauseDiscussion = usePauseDiscussion()
  const resumeDiscussion = useResumeDiscussion()
  const clearQueue = useClearQueue()
  const queuedPending = React.useMemo(() => pending.filter((p) => p.queued), [pending])
  const steer = useSteerSession()
  // Steer accepted: "steering…" until the queued messages start (queue empty) or 20 s at most.
  const [steerPending, setSteerPending] = React.useState(false)
  React.useEffect(() => {
    if (!steerPending) return
    if (!session?.queue) {
      setSteerPending(false)
      return
    }
    const id = setTimeout(() => setSteerPending(false), 20_000)
    return () => clearTimeout(id)
  }, [steerPending, session?.queue])
  const takeQueue = useTakeQueue()
  const aside = useAside(sid)
  // Side question: the waiting messages are taken back and asked apart (the running turn goes on).
  const onAsk = async () => {
    let r: Awaited<ReturnType<typeof takeQueue.mutateAsync>>
    try {
      r = await takeQueue.mutateAsync(sid)
    } catch {
      return // already shown as a toast; the messages stay in the queue
    }
    usePending.getState().clearQueued(sid)
    aside.start(r.messages.map((m) => [m.text, ...m.attachments.map((a) => `- ${a}`)].filter(Boolean).join('\n')).join('\n\n'))
  }
  const compact = useCompactSession()
  const handoff = useHandoffSession()
  const del = useDeleteSession()
  const seen = useMarkSeen()
  const thread = React.useRef<ThreadHandle>(null)
  const composer = React.useRef<ComposerHandle>(null)
  const body = React.useRef<HTMLDivElement>(null)
  const [dragFiles, setDragFiles] = React.useState(false)
  const [summaryOpen, setSummaryOpen] = React.useState(false)
  const [agentMapOpen, setAgentMapOpen] = React.useState(false)
  const [limitsOpen, setLimitsOpen] = React.useState(false)
  // "Open beside" of the thread's blocks: docked on the right of the conversation when there is room, else a sheet
  const row = React.useRef<HTMLDivElement>(null)
  const panel = useBlockPanel(sid)
  const docked = useWideEnough(row) && variant !== 'mobile'
  const beside = useBlockBeside(panel, docked)

  const notFound = (isError && isApiError(error) && error.status === 404) || deleted
  const running = session?.state === 'running'
  const duo = session?.provider === 'discussion' || session?.provider === 'debate'
  const path = session?.path ?? ''
  // Message actions of the thread: Edit (a stopped message back into this composer), New session from a message
  // (a new session of the same topic, its composer filled; the URL opens it, on a phone too).
  const onEdit = React.useCallback((seed: Seed) => composer.current?.bringBack(seed), [])
  const onFork = React.useCallback(
    (seed: Seed) => {
      seedComposer(`new:${path}`, seed)
      navigate(`/sessions?path=${encodeURIComponent(path)}&new=1`, { state: { mxPushed: true } })
    },
    [path, navigate],
  )

  // Mark seen while this column is the focused one and the tab is visible.
  const [visible, setVisible] = React.useState(() => document.visibilityState === 'visible')
  React.useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  const seenFor = React.useRef<number>(0)
  React.useEffect(() => {
    if (!session || !session.unread || !visible) return
    if (!(focused || variant !== 'column' || count === 1)) return
    if (seenFor.current === session.updated) return
    seenFor.current = session.updated
    seen.mutate(session.id)
  }, [session, focused, visible, variant, count]) // eslint-disable-line react-hooks/exhaustive-deps

  // Queued messages of this tab that the server no longer holds (cleared elsewhere) disappear.
  const trimQueued = usePending((s) => s.trimQueued)
  React.useEffect(() => {
    if (session) trimQueued(sid, session.queue)
  }, [session?.queue, sid, trimQueued]) // eslint-disable-line react-hooks/exhaustive-deps

  const onSend = async (text: string, attachments: string[]) => {
    const add = usePending.getState().add
    const remove = usePending.getState().remove
    const lid = add(sid, { text, attachments, queued: running })
    thread.current?.scrollToBottom()
    notifySent(sid)
    try {
      const r = await send.mutateAsync({ id: sid, text, attachments })
      if (r.queued !== running) {
        remove(sid, lid)
        add(sid, { text, attachments, queued: r.queued })
      }
      if (r.queued && (session?.provider === 'discussion' || session?.provider === 'debate')) {
        try { await steer.mutateAsync(sid) } catch { /* the message stays queued */ }
      }
      return true
    } catch {
      remove(sid, lid)
      notifySendFailed(sid)
      return false
    }
  }

  // Sent by a previous page load that went away before the answer: did the server get it? (a user event
  // since it was sent, or still waiting in the queue).
  const sessionNow = React.useRef(session)
  sessionNow.current = session
  const checkSent = React.useCallback(
    async (left: OutboxEntry[]) => {
      await loadLog(sid)
      for (let i = 0; i < 40 && !sessionNow.current; i++) await new Promise((r) => setTimeout(r, 250))
      const st = getLog(sid)
      if (st.status !== 'ready' || !sessionNow.current) return null // unknown: kept for the next load
      const queue = (sessionNow.current.queue_items || []).map((q) => q.text)
      return left.filter((e) => {
        const text = e.text.trim()
        if (st.items.some((it) => it.kind === 'user' && (it.ev.at ?? Infinity) >= e.at / 1000 - 60 && it.ev.text.trim() === text)) return false
        return !queue.some((q) => q && text.startsWith(q.trim()))
      })
    },
    [sid],
  )

  // Voice message sent directly: an optimistic voice bubble while the recording uploads, then sent with `voice`.
  const onSendVoice = async (file: File) => {
    const { add, remove } = usePending.getState()
    const lid = add(sid, { text: '', attachments: [], queued: running, voice: true })
    thread.current?.scrollToBottom()
    try {
      const up = await uploadAttachment(path, file)
      const r = await send.mutateAsync({ id: sid, text: '', voice: up.path })
      if (r.queued !== running) {
        remove(sid, lid)
        add(sid, { text: '', attachments: [], queued: r.queued, voice: true })
      }
      return true
    } catch (e) {
      remove(sid, lid)
      toast.error(errorMessage(e))
      return false
    }
  }

  const onStop = () =>
    stop.mutate(sid, {
      onSuccess: () => usePending.getState().clearQueued(sid),
    })

  const tgLinked = !!tg?.configured && !!tg?.chat
  const authReason = !session?.provider?.startsWith('plugin:') && session?.provider !== 'codex' && claude && !claude.auth.ok ? t(claude.auth.method ? 'sessions.composer.authExpired' : 'sessions.composer.noAuth') : null
  const dir = absTopicDir(ws, path)

  const qc = useQueryClient()
  const hudOn = useUI((s) => s.hud)
  const tabsOn = useSessionsUI((s) => s.tabs)
  const hud = () => {
    const go = (path: string) => {
      navigate(path)
      window.focus()
    }
    openHud(sid, qc, go).then(
      (ok) => !ok && toast.error(t('sessions.popupBlocked')),
      (e) => toast.error(errorMessage(e)),
    )
  }

  const detach = () => {
    const w = window.open(`/sessions/solo/${sid}`, `mx-solo-${sid}`, 'popup,width=560,height=860')
    if (w) close(col.key)
    else toast.error(t('sessions.popupBlocked'))
  }

  const head = React.useRef<HTMLElement>(null)
  const slim = useSlimHeader(head, variant === 'column' && !!place && place.row !== 'full')
  const actions = {
    rename: (title: string) => patch.mutate({ id: sid, title }),
    model: (model: string) => patch.mutate({ id: sid, model }),
    notify: () => session && patch.mutate({ id: sid, notify: !session.notify }),
    archive: () =>
      session &&
      patch.mutate(
        { id: sid, archived: !session.archived },
        { onSuccess: (s) => toast.success(s.archived ? t('sessions.archived') : t('sessions.unarchived')) },
      ),
    compact: () => compact.mutate(sid, { onSuccess: () => toast.success(t('sessions.compacting')) }),
    handoff: async () => {
      if (!(await confirm({ title: t('sessions.handoff.title'), description: t('sessions.handoff.desc'), confirmText: t('sessions.handoff.confirm') }))) return
      handoff.mutate(sid, {
        onSuccess: (s) => {
          seedEmptyLog(s.id)
          becomeSession(col.key, s.id)
          toast.success(t('sessions.handoff.done'))
        },
      })
    },
    del: async () => {
      if (!session) return
      const ok = await confirm({ title: t('sessions.delete.title'), description: t('sessions.delete.desc'), destructive: true, confirmText: t('common.delete') })
      if (!ok) return
      del.mutate(sid, {
        onSuccess: () => {
          close(col.key)
          forgetLog(sid)
          saveDraft(sid, '')
          saveQuotes(sid, [])
          toast.success(t('sessions.delete.done'))
        },
      })
    },
  }

  // End of the thread: the plan of a plan-mode turn to approve, or the failed turn with Retry. Memoised: the thread
  // only re-renders when its own props change.
  const sendNow = React.useRef(onSend)
  sendNow.current = onSend
  const planReady = !!session?.plan_ready && !running
  const failed = session?.state === 'error' && !running ? session.error || '' : null
  // the last turn ended on a question of the agent (AskUserQuestion): its options answer it in one click
  const asked = useLogSelect(sid, lastQuestion)
  const question = !running && !planReady && failed === null ? asked : null
  const agentName = session?.provider_name || (session?.provider === 'codex' ? 'Codex' : 'Claude Code')
  // a paused discussion ends with the date of its pause (and the limit it reached)
  const pauseKey = duo && session?.debate_paused ? [session.discussion_paused_at, session.discussion_pause_reason, session.discussion_turns, session.discussion_turn_limit, session.discussion_duration_seconds, session.discussion_elapsed].join('|') : ''
  const card = React.useMemo(
    () =>
      planReady && session ? (
        <PlanCard session={session} onEdit={() => composer.current?.focus()} />
      ) : failed ? (
        <FailedTurn sid={sid} error={failed} onRetry={(text, attachments) => void sendNow.current(text, attachments)} />
      ) : question ? (
        <QuestionCard question={question} agent={agentName} onAnswer={(text) => void sendNow.current(text, [])} onOther={() => composer.current?.focus()} />
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planReady, failed, sid, planReady && session?.id, question, agentName],
  )
  const tail = React.useMemo(
    () => (pauseKey && session ? <>{<PauseSeparator session={session} />}{card}</> : card),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card, pauseKey],
  )
  // The blocks of this thread answer in this session (forms, checklists, "Ask for a fix"), shown at once as sent
  // messages, and open beside it in the column's own panel (leaving a placeholder in the thread while docked).
  const blockHost = React.useMemo<BlockHost>(
    () => ({
      sessionId: sid,
      send: (text) => sendNow.current(text, []),
      openPanel: panel.open,
      beside,
      agent: duo ? undefined : agentName,
    }),
    [sid, panel.open, beside, duo, agentName],
  )

  // (a picture dragged from a thread carries a file too: that is a content drag)
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(CONTENT_MIME)
  return (
    <ColumnShell col={col} index={index} count={count} variant={variant} place={place}>
      <div
        ref={body}
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(e) => isFileDrag(e) && setDragFiles(true)}
        onDragOver={(e) => {
          if (contentDragOver(e, col.key, sid)) return
          if (isFileDrag(e)) e.preventDefault()
        }}
        onDragLeave={(e) => {
          contentDragLeave(e, col.key)
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragFiles(false)
        }}
        onDrop={(e) => {
          const d = contentDrop(e, sid)
          if (d !== undefined) return d && quoteDropped(col.key, composer.current, d)
          if (!isFileDrag(e)) return
          e.preventDefault()
          setDragFiles(false)
          composer.current?.addFiles(Array.from(e.dataTransfer.files))
        }}
      >
        <ColumnHeader
          col={col}
          variant={variant}
          session={session}
          rootLabel={t('sessions.root')}
          onClose={() => close(col.key)}
          tgLinked={tgLinked}
          headRef={head}
          slim={slim}
          menu={
            <DropdownMenu>
              <Tooltip content={t('common.more')}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t('common.more')} disabled={!session}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                className="w-60"
                // "Layouts…": the focus goes to the picker, not back to this button (that would close the picker)
                onCloseAutoFocus={(e) => useSessionsUI.getState().layoutPicker === col.key && e.preventDefault()}
              >
                {/* The header keeps room for the title: Telegram, plan mode of a folded stacked session and (phone) the
                    tabs view live here. */}
                {slim && session?.provider !== 'debate' && session?.provider !== 'discussion' && (
                  <DropdownMenuCheckboxItem checked={!!session?.plan_mode} disabled={!session} onSelect={() => session && patch.mutate({ id: sid, plan_mode: !session.plan_mode })}>
                    {t('plan.toggle')}
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuCheckboxItem checked={!!session?.notify} disabled={!session || !tgLinked} onSelect={actions.notify}>
                  {session?.notify ? <Bell /> : <BellOff />} {t('sessions.notify.label')}
                </DropdownMenuCheckboxItem>
                {variant === 'mobile' && (
                  <DropdownMenuCheckboxItem checked={tabsOn} onSelect={() => useSessionsUI.getState().setTabs(!tabsOn)} data-testid="menu-tabs">
                    <PanelTop /> {t('tabs.toggle')}
                  </DropdownMenuCheckboxItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={session?.provider === 'debate' || session?.provider === 'discussion' || session?.provider?.startsWith('plugin:') || running || !session?.turns} onSelect={actions.compact}>
                  <Minimize2 /> {t('sessions.menu.compact')}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={session?.provider === 'debate' || session?.provider === 'discussion' || session?.provider?.startsWith('plugin:') || running || !session?.turns} onSelect={actions.handoff}>
                  <Sparkles /> {t('sessions.menu.handoff')}
                </DropdownMenuItem>
                {duo && (
                  <DropdownMenuItem disabled={!session} onSelect={() => setLimitsOpen(true)} data-testid="menu-limits">
                    <SlidersHorizontal /> {t('notifx.change')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!session?.turns} onSelect={() => setSummaryOpen(true)}>
                  <ListChecks /> {t('sessions.menu.summary')}
                </DropdownMenuItem>
                {(!session?.provider || session.provider === 'claude') && <DropdownMenuItem onSelect={() => setAgentMapOpen(true)}><Network /> {t('sessions.swarm.map')}</DropdownMenuItem>}
                <DropdownMenuItem onSelect={actions.archive}>
                  {session?.archived ? <ArchiveRestore /> : <Archive />} {session?.archived ? t('sessions.menu.unarchive') : t('sessions.menu.archive')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!dir} onSelect={() => dir && navigate(`/files?path=${encodeURIComponent(dir)}`)}>
                  <FolderOpen /> {t('sessions.menu.openFolder')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => copyText(sid).then((ok) => ok && toast.success(t('sessions.menu.idCopied')))}>
                  <Copy /> {t('sessions.menu.copyId')}
                </DropdownMenuItem>
                {hudOn && variant !== 'mobile' && (
                  <DropdownMenuItem onSelect={hud}>
                    <PictureInPicture2 /> {t('sessions.menu.hud')}
                  </DropdownMenuItem>
                )}
                {variant === 'column' && (
                  <>
                    <DropdownMenuItem onSelect={detach}>
                      <ExternalLink /> {t('sessions.menu.detach')}
                    </DropdownMenuItem>
                    {index > 0 && (
                      col.below ? (
                        <DropdownMenuItem onSelect={() => useSessionsUI.getState().unstack(col.key)}>
                          <Columns2 /> {t('sessions.grid.unstack')}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          disabled={!canStackUnderPrevious(col.key)}
                          onSelect={() => {
                            const cols = useSessionsUI.getState().cols
                            const i = cols.findIndex((c) => c.key === col.key)
                            // under the last session of the strip column on the left
                            if (i > 0) useSessionsUI.getState().stack(col.key, cols[i - 1].key)
                          }}
                        >
                          <Rows2 /> {t('sessions.grid.stack')}
                        </DropdownMenuItem>
                      )
                    )}
                    {count > 1 && (
                      <>
                        <DropdownMenuItem onSelect={() => useSessionsUI.getState().setLayoutPicker(col.key)}>
                          <LayoutGrid /> {t('sessions.layout.menu')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canShift(useSessionsUI.getState().cols, col.key, -1)} onSelect={() => useSessionsUI.getState().shift(col.key, -1)}>
                          <ChevronLeft /> {t('sessions.menu.moveLeft')}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canShift(useSessionsUI.getState().cols, col.key, 1)} onSelect={() => useSessionsUI.getState().shift(col.key, 1)}>
                          <ChevronRight /> {t('sessions.menu.moveRight')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={actions.del}>
                  <Trash2 /> {t('sessions.menu.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
          onRename={actions.rename}
          onNotify={actions.notify}
        />
        <SessionSummary key={sid} sid={sid} path={path} open={summaryOpen} onOpenChange={setSummaryOpen} />
        {agentMapOpen && <AgentMap key={`agents-${sid}`} sid={sid} running={running} open onOpenChange={setAgentMapOpen} />}
        {duo && session && <ChangeLimitsDialog session={session} open={limitsOpen} onOpenChange={setLimitsOpen} />}
        <BlockHostProvider value={blockHost}>
          <div ref={row} className="flex min-h-0 flex-1">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-mx-session={sid}>
              {session?.archived && (
                <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
                  <Archive className="size-3.5" /> {t('sessions.archivedBanner')}
                  <Button size="sm" variant="link" className="ml-auto h-auto text-xs" onClick={actions.archive}>
                    {t('sessions.menu.unarchive')}
                  </Button>
                </div>
              )}
              {session && pausedOnLimit(session) && <PausedBanner session={session} />}
              <ItemContext.Provider value={React.useMemo(() => ({ filesRoot: settings?.files_root || null, restoredFileRoots: settings?.restored_file_roots, providerName: session?.provider_name, models: claude?.models, running, tz: settings?.timezone, topicDir: dir, wsRoot: ws?.root || null }), [settings?.files_root, settings?.restored_file_roots, session?.provider_name, settings?.timezone, claude?.models, running, dir, ws?.root])}>
                {notFound ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
                    {t('sessions.deleted')}
                    <Button size="sm" variant="outline" onClick={() => close(col.key)}>
                      {t('sessions.closeColumn')}
                    </Button>
                  </div>
                ) : (
                  <LiveThread ref={thread} sid={sid} session={session} pending={pending} onRetry={onRetry} onLoadEarlier={onLoadEarlier} onEdit={onEdit} onFork={path ? onFork : undefined} tail={tail} hideFailureNotes={!planReady && !!failed} />
                )}
              </ItemContext.Provider>
              {!notFound && (
                <QuotePill
                  scope={body}
                  onQuote={(text) => {
                    composer.current?.quote(text)
                    window.getSelection()?.removeAllRanges()
                    composer.current?.focus()
                  }}
                />
              )}
              {!notFound && (
                <FileMenu
                  scope={body}
                  onQuote={(path) => {
                    composer.current?.quote(fileQuote(path))
                    composer.current?.focus()
                  }}
                />
              )}
              {!notFound && aside.aside && <AsidePanel aside={aside.aside} onClose={aside.close} />}
              {!notFound && session?.team_phase && <MixedTeam sid={sid} />}
              {!notFound && <TaskBar sid={sid} running={running} />}
              {!notFound && (
                <StackedComposer colKey={col.key} stacked={!!place && place.n >= 3}>
                <Composer
                  ref={composer}
                  colKey={col.key}
                  maxRows={place && place.row !== 'full' ? 4 : 12}
                  draftKey={sid}
                  placeholder={
                    session?.plan_mode
                      ? t(session.plan_ready ? 'plan.placeholderAdjust' : 'plan.placeholder')
                      : duo
                        ? t('conv.composer.intervene')
                        : session
                          ? t('conv.composer.replyTo', { agent: agentName })
                          : undefined
                  }
                  hint={duo ? t('conv.composer.duoHint') : t('conv.composer.hint')}
                  topicPath={path}
                  running={running}
                  immediateIntervention={session?.provider === 'discussion' || session?.provider === 'debate'}
                  disabledReason={session?.team_phase && ['launching', 'working', 'synthesizing'].includes(session.team_phase) ? t('mixedTeam.wait') : authReason || (!session ? t('sessions.composer.loading') : null)}
                  queueCount={session?.queue || 0}
                  queued={queuedPending}
                  queueItems={session?.queue_items}
                  onClearQueue={() => clearQueue.mutateAsync(sid).then(() => usePending.getState().clearQueued(sid))}
                  onSteer={() =>
                    steer.mutate(sid, {
                      onSuccess: (r) => {
                        if (r.steered) {
                          setSteerPending(true)
                          if (!r.interrupted) toast.info(t('sessions.queue.steerAfter'))
                        }
                        else toast.info(t('sessions.queue.steerNothing'), t('sessions.queue.steerNothingDesc'))
                      },
                    })
                  }
                  steerPending={steerPending}
                  onTakeQueue={async () => {
                    const r = await takeQueue.mutateAsync(sid)
                    usePending.getState().clearQueued(sid)
                    return r.messages
                  }}
                  steering={steer.isPending}
                  onAsk={session?.provider === 'claude' || !session?.provider ? () => void onAsk() : undefined}
                  asking={takeQueue.isPending || aside.pending}
                  clearingQueue={clearQueue.isPending}
                  onSend={onSend}
                  checkSent={checkSent}
                  onSendVoice={onSendVoice}
                  onStop={duo ? undefined : onStop}
                  stopping={stop.isPending}
                  autoFocus={variant !== 'mobile'}
                  toolbar={
                    session ? (
                      <>
                        {!duo && (!session.provider?.startsWith('plugin:') || session.provider_capabilities?.includes('plan')) && <PlanToggle session={session} />}
                        {!!session.swarm_agents && (
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAgentMapOpen(true)}>
                            <Network /> <span className="@max-[26rem]:sr-only">{t('sessions.swarm.map')}</span>
                          </Button>
                        )}
                        {duo && session.debate_paused && !pausedOnLimit(session) && <span className="truncate px-1 text-xs text-muted-foreground">{t('sessions.discussionPaused')}</span>}
                        {duo && (running || session.debate_paused) && (
                          <Tooltip content={t(session.debate_paused ? 'sessions.discussionResume' : 'sessions.discussionPause')}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2.5 text-xs max-md:h-9"
                              loading={pauseDiscussion.isPending || resumeDiscussion.isPending}
                              onClick={() => (session.debate_paused ? resumeDiscussion.mutate(sid) : pauseDiscussion.mutate(sid))}
                              data-testid="duo-pause"
                            >
                              {session.debate_paused ? <Play /> : <Pause />}
                              <span className="@max-[24rem]:sr-only">{t(session.debate_paused ? 'conv.duo.resume' : 'conv.duo.pause')}</span>
                            </Button>
                          </Tooltip>
                        )}
                        {duo && running && (
                          <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs text-destructive hover:text-destructive max-md:h-9" onClick={onStop} loading={stop.isPending} data-testid="duo-stop">
                            <Square className="size-3! fill-current" /> {t('conv.duo.stop')}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Skeleton className="h-6 w-24" />
                    )
                  }
                  toolbarEnd={
                    session && !duo ? (
                      (session.provider === 'codex' || session.provider?.startsWith('plugin:')) ? (
                        <span className="truncate px-1 text-xs text-muted-foreground">{session.model || session.provider_name || 'Codex'}</span>
                      ) : (
                        <ModelPicker chosen={session.model} real={session.real_model} contextTokens={session.context_tokens} onChange={actions.model} compact />
                      )
                    ) : null
                  }
                />
                </StackedComposer>
              )}
            </div>
            {!notFound && panel.state && <BlockPanel {...panel} state={panel.state} docked={docked} />}
          </div>
        </BlockHostProvider>
        {dragFiles && (
          <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/95 text-sm font-medium">
            <Upload className="size-6 text-primary" />
            {t('sessions.dropToAttach')}
          </div>
        )}
        <ContentDropOverlay colKey={col.key} sid={sid} />
      </div>
    </ColumnShell>
  )
}

/* ---------------------------------------------------------------- header */
/** One header per session: where it lives (project › topic, a click moves it), its title (a click renames it), who
 *  answers with which model, how much context is used, the menu and close. A discussion adds its progress. */
function ColumnHeader({
  col,
  variant,
  session,
  rootLabel,
  onClose,
  menu,
  onRename,
  onNotify,
  tgLinked,
  headRef,
  slim,
}: {
  col: Col
  variant: ColumnVariant
  session: Session | undefined
  rootLabel: string
  onClose: () => void
  menu: React.ReactNode
  onRename: (title: string) => void
  onNotify: () => void
  tgLinked: boolean
  headRef?: React.Ref<HTMLElement>
  /** Short stacked session: one line (title, state, context, menu, close). */
  slim?: boolean
}) {
  const t = useT()
  const maxxing = useMaxxingEnabled()
  const { data: claude } = useClaudeStatus()
  const claudeTurns = !session?.provider || session.provider === 'claude'
  const duo = session?.provider === 'discussion' || session?.provider === 'debate'
  const gauge = session && claudeTurns && <ContextGauge percent={!slim} ring={slim} tokens={session.context_tokens} window={session.context_window} model={session.model} realModel={session.real_model} />
  if (variant === 'mobile') {
    // phone / tablet: one bar - sessions (☰), the title over where it lives and the model, the menu, the app (⊞)
    const model = session ? ((session.provider === 'codex' || session.provider?.startsWith('plugin:')) ? session.model || session.provider_name || 'Codex' : duo ? 'Claude Code · Codex' : modelLabel(session.real_model || session.model || claude?.default_model || '', claude?.models)) : ''
    return (
      <header className="relative shrink-0 border-b bg-background px-2 pt-[calc(0.25rem+var(--safe-top))] pb-1" data-col-head>
        {maxxing && <MaxxingMeter strip />}
        <div className="flex min-h-12 min-w-0 items-center gap-0.5">
          <TouchSessionsButton />
          <div className="grid min-w-0 flex-1 px-1">
            <div className="flex min-w-0 items-center gap-1.5">
              {session ? <InlineTitle value={session.title} onSave={onRename} className="-ml-1 h-7 text-[15px] pointer-coarse:h-7" /> : <Skeleton className="h-5 w-40" />}
              {session && <StateBadge session={session} />}
            </div>
            <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {session ? (
                <>
                  <MoveSessionPicker session={session} rootLabel={rootLabel} plain />
                  {model && <span className="min-w-0 shrink truncate">· {model}</span>}
                  {gauge && <span className="ml-auto flex shrink-0">{<ContextGauge ring tokens={session.context_tokens} window={session.context_window} model={session.model} realModel={session.real_model} />}</span>}
                </>
              ) : (
                <Skeleton className="h-3 w-32" />
              )}
            </div>
          </div>
          {maxxing && <MaxxingControls compact />}
          {menu}
          <TouchAppButton />
        </div>
        <MobileTabs />
        {session && duo && <DuoProgress session={session} />}
      </header>
    )
  }
  return (
    <header ref={headRef} data-col-head className={cn('@container shrink-0 border-b bg-background px-3', slim ? 'py-0.5' : 'py-2', variant !== 'column' && 'pt-[calc(0.5rem+var(--safe-top))]')}>
      <div className={cn('flex min-w-0 items-center gap-2', slim ? 'h-9' : 'min-h-11')}>
        {variant === 'column' && <DragGrip colKey={col.key} />}
        <div className="grid min-w-0 flex-1">
          {!slim && (
            <div className="flex h-[18px] min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {session ? (
                <>
                  <MoveSessionPicker session={session} rootLabel={rootLabel} plain />
                  {duo && <span className="shrink-0 truncate">· {t(session.provider === 'debate' ? 'sessions.debate' : 'sessions.discussion')}</span>}
                  {session.source === 'cron' && (
                    <Tooltip content={t('sessions.source.cron')}>
                      <span className="inline-flex shrink-0 items-center"><Clock className="size-3" /></span>
                    </Tooltip>
                  )}
                </>
              ) : (
                <Skeleton className="h-3 w-28" />
              )}
            </div>
          )}
          <div className="flex min-w-0 items-center gap-1.5">
            {session ? <InlineTitle value={session.title} onSave={onRename} className="-ml-1 h-7 text-[15px]" /> : <Skeleton className="my-1 h-4 w-40" />}
            {session && <StateBadge session={session} />}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {session && !slim && <AgentChip session={session} />}
          {gauge && <span className="flex @max-[26rem]:hidden">{gauge}</span>}
          {session?.notify && (
            // Telegram on: a quiet bell says so (a click turns it off; the menu holds the switch)
            <Tooltip content={tgLinked ? t('sessions.notify.on') : t('sessions.notify.unavailable')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('sessions.notify.on')} aria-pressed onClick={onNotify} disabled={!tgLinked} className="text-muted-foreground">
                <Bell />
              </Button>
            </Tooltip>
          )}
          {menu}
          {variant === 'column' && (
            <Tooltip content={t('sessions.closeColumn')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('sessions.closeColumn')} onClick={onClose} className="text-muted-foreground">
                <X />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {session && duo && !slim && <DuoProgress session={session} />}
    </header>
  )
}

/** A discussion between two agents: how far it went against its limits ("Reply 6 of 20 · 14 min of 30"). */
function DuoProgress({ session }: { session: Session }) {
  const t = useT()
  const n = session.discussion_turns || 0
  const max = session.discussion_turn_limit || 0
  const minutes = Math.floor((session.discussion_elapsed || 0) / 60)
  const maxMin = session.discussion_duration_seconds ? Math.round(session.discussion_duration_seconds / 60) : 0
  const pct = Math.min(1, Math.max(max ? n / max : 0, maxMin ? minutes / maxMin : 0))
  const parts = [
    max ? t('conv.duo.replies', { n, max }) : n ? t('conv.duo.repliesNoMax', { n }) : '',
    maxMin ? t('conv.duo.minutes', { n: minutes, max: maxMin }) : session.discussion_elapsed ? t('conv.duo.minutesNoMax', { n: minutes }) : '',
  ].filter(Boolean)
  if (!parts.length) return null
  return (
    <div className="flex min-w-0 items-center gap-3 pt-1.5 pb-0.5 text-xs text-muted-foreground" data-testid="duo-progress">
      {(max || maxMin) > 0 && (
        <span role="progressbar" aria-label={t('conv.duo.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-valuetext={parts.join(', ')} className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-muted-foreground transition-[width] duration-500" style={{ width: `${Math.max(2, pct * 100)}%` }} />
        </span>
      )}
      <span className="shrink-0 tabular-nums">{parts.join(' · ')}</span>
    </div>
  )
}

type Question = { question?: string; header?: string; options?: { label?: string; description?: string }[] }

/** The question the agent asked at the end of the last turn (its AskUserQuestion call), if nobody answered yet. */
function lastQuestion(st: LogState): Question | null {
  for (let i = st.items.length - 1; i >= 0; i--) {
    const it = st.items[i]
    if (it.kind === 'user' || it.kind === 'request') return null
    if (it.kind === 'tool' && it.use.name === 'AskUserQuestion') {
      const qs = (it.use.input as { questions?: Question[] } | null)?.questions
      const q = Array.isArray(qs) ? qs[0] : null
      return q && q.question && Array.isArray(q.options) && q.options.length ? q : null
    }
  }
  return null
}

/** End of the thread: the agent asked a question with choices - one click sends a choice as the answer. */
function QuestionCard({ question, agent, onAnswer, onOther }: { question: Question; agent: string; onAnswer: (text: string) => void; onOther: () => void }) {
  const t = useT()
  const [sent, setSent] = React.useState<string | null>(null)
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4" aria-label={t('conv.question.waiting', { agent })} data-testid="question-card">
      <span className="text-xs text-muted-foreground">{t('conv.question.waiting', { agent })}</span>
      <span className="leading-snug font-semibold">
        <Sensitive>{question.question}</Sensitive>
      </span>
      <div className="grid gap-1.5">
        {(question.options || []).filter((o) => o.label).map((o) => (
          <button
            key={o.label}
            type="button"
            disabled={sent !== null}
            onClick={() => {
              setSent(o.label!)
              onAnswer(o.label!)
            }}
            className="grid min-h-10 gap-0.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 max-md:min-h-11"
          >
            <span className="font-medium">
              <Sensitive>{o.label}</Sensitive>
            </span>
            {o.description && (
              <span className="text-xs text-muted-foreground">
                <Sensitive>{o.description}</Sensitive>
              </span>
            )}
          </button>
        ))}
        <button type="button" onClick={onOther} disabled={sent !== null} className="min-h-10 rounded-lg border border-dashed px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-11">
          {t('conv.question.other')}
        </button>
      </div>
    </section>
  )
}

/** End of the thread when the last turn failed: what happened, Retry (the last message again), the details. */
function FailedTurn({ sid, error, onRetry }: { sid: string; error: string; onRetry?: (text: string, attachments: string[]) => void }) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const last = useLogSelect(sid, (st) => {
    for (let i = st.items.length - 1; i >= 0; i--) {
      const it = st.items[i]
      if (it.kind === 'user') return it.ev
    }
    return null
  })
  const first = error.split('\n')[0]
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/8 p-4" data-testid="failed-turn">
      <CircleAlert className="mt-0.5 size-[18px] shrink-0 text-destructive" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <span className="font-semibold">{t('conv.failed.title')}</span>
        <p className="line-clamp-3 text-[13px] leading-relaxed text-foreground/85 [overflow-wrap:anywhere]">
          <Sensitive>{first}</Sensitive>
        </p>
        {open && (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            <Sensitive>{error}</Sensitive>
          </pre>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2">
          {onRetry && last && (last.text || last.attachments.length > 0) && (
            <Button size="sm" onClick={() => onRetry(last.text, last.attachments)}>
              <RotateCw /> {t('conv.failed.retry')}
            </Button>
          )}
          {error.trim() !== first.trim() && (
            <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {t(open ? 'conv.failed.hideDetails' : 'conv.failed.details')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function InlineTitle({ value, onSave, className }: { value: string; onSave: (v: string) => void; className?: string }) {
  const t = useT()
  const mask = useMask()
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const input = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  React.useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])
  const commit = () => {
    setEditing(false)
    const v = draft.trim()
    if (v && v !== value) onSave(v)
  }
  if (editing)
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
        }}
        aria-label={t('sessions.rename')}
        maxLength={120}
        className={cn('h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm font-semibold outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25', className)}
      />
    )
  return (
    <Tooltip content={t('sessions.renameHint')}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn('min-w-0 truncate rounded px-1 text-left text-sm font-semibold hover:bg-accent pointer-coarse:h-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', className)}
        aria-label={`${t('sessions.rename')}: ${mask(value, 8)}`}
      >
        <Sensitive length={10}>{value}</Sensitive>
      </button>
    </Tooltip>
  )
}

/* ---------------------------------------------------------------- new session column */
/** The session's project / topic: click to move the session to another topic (once its turn is over). */
function MoveSessionPicker({ session, rootLabel, plain }: { session: Session; rootLabel: string; /** Text ("acme › # blog") instead of badges. */ plain?: boolean }) {
  const t = useT()
  const { data: ws } = useWorkspace()
  const patch = usePatchSession()
  const mask = useMask()
  const setExpanded = useSessionsUI((s) => s.setExpanded)
  const projects = ws?.projects || []
  const m = /^projects\/([^/]+)(?:\/topics\/([^/]+))?$/.exec(session.path)
  const project = m ? projects.find((p) => p.name === m[1]) : undefined
  const topic = m?.[2] ? project?.topics.find((tp) => tp.name === m[2]) : undefined
  const options = projects.flatMap((p) => p.topics.map((tp) => ({ value: tp.path, label: mask(`${p.emoji ? p.emoji + ' ' : ''}${p.name} / ${tp.name}`, 10) })))
  const busy = session.state === 'running' || session.queue > 0
  const hint = t(busy ? 'sessions.move.busy' : 'where.move')
  const label = m ? (
    <>
      <WhereBadge kind="project" name={m[1]} description={project?.description} dir={absTopicDir(ws, `projects/${m[1]}`)} hint={hint} plain={plain}>
        {project?.emoji ? <span className="shrink-0 leading-none">{project.emoji}</span> : plain ? null : <FolderOpen className="size-3 shrink-0 opacity-70" />}
      </WhereBadge>
      {m[2] && plain && <span aria-hidden className="shrink-0 opacity-70">›</span>}
      {m[2] && (
        <WhereBadge kind="topic" name={m[2]} description={topic?.description} dir={absTopicDir(ws, session.path)} hint={hint} plain={plain}>
          {plain ? <span className="shrink-0 opacity-70">#</span> : <Hash className="size-3 shrink-0 opacity-70" />}
        </WhereBadge>
      )}
      {!busy && <ChevronDown className="size-3 shrink-0 opacity-60" />}
    </>
  ) : (
    <>
      <FolderOpen className="size-3 shrink-0" />
      <span className="truncate">
        <Sensitive length={10}>{topicLabel(session.path, rootLabel)}</Sensitive>
      </span>
      {!busy && <ChevronDown className="size-3 shrink-0 opacity-60" />}
    </>
  )
  // The row stays 20 px on phones (the header must stay short): an invisible 40 px tap area instead of a taller row.
  const cls = "relative inline-flex min-w-0 items-center gap-1 rounded hover:text-foreground pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-top-1.5 pointer-coarse:before:-bottom-3.5 pointer-coarse:before:content-[''] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  if (busy)
    return (
      <span className={cn(cls, 'cursor-not-allowed')} data-testid="session-path">
        {label}
      </span>
    )
  return (
    <Combobox
      value={session.path}
      options={options}
      searchPlaceholder={t('sessions.move.search')}
      aria-label={t('sessions.move.label')}
      onChange={(path) => {
        if (path === session.path) return
        patch.mutate(
          { id: session.id, path },
          {
            onSuccess: () => {
              // Show it where it now lives in the sessions list.
              const project = path.split('/')[1]
              setExpanded({ [`p:${project}`]: true, [`t:${path}`]: true })
              toast.success(t('sessions.move.done', { where: topicLabel(path, rootLabel) }))
            },
          },
        )
      }}
      trigger={
        <button type="button" className={cls} data-testid="session-path" aria-label={t('sessions.move.label')}>
          {label}
        </button>
      }
    />
  )
}

/** One part of the session's place (project or topic) as a badge; hovering it explains what it is. */
export function WhereBadge({ kind, name, description, dir, hint, generic, plain, children }: { kind: 'project' | 'topic'; name: string; description?: string; dir?: string | null; hint: string; /** The word itself (page subtitle): no name, no folder in the card. */ generic?: boolean; /** Plain text (session header breadcrumb). */ plain?: boolean; children?: React.ReactNode }) {
  const t = useT()
  return (
    <TooltipRoot delayDuration={350}>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex min-w-0 items-center', plain ? 'gap-0.5' : 'h-[18px] gap-1 rounded-md border bg-muted/50 px-1.5 text-[11px] font-medium text-foreground/80 max-md:h-5 max-md:text-xs')} data-testid={generic ? `where-word-${kind}` : `where-${kind}`} tabIndex={generic ? 0 : undefined}>
          {children}
          <span className="truncate">{generic ? name : <Sensitive length={8}>{name}</Sensitive>}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="block w-72 rounded-lg border bg-popover p-3 text-popover-foreground font-normal">
        <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {kind === 'project' ? <FolderOpen className="size-3" /> : <Hash className="size-3" />}
          {t(kind === 'project' ? 'where.project' : 'where.topic')}
        </span>
        {!generic && (
          <span className="mt-1 block text-sm font-semibold">
            <Sensitive length={8}>{name}</Sensitive>
          </span>
        )}
        {description && <span className="mt-0.5 block text-xs text-muted-foreground"><Sensitive length={20}>{description.replace(/[*`_]+/g, '')}</Sensitive></span>}
        <span className="mt-2 block text-xs leading-relaxed">{t(kind === 'project' ? 'where.projectHelp' : generic ? 'where.topicHelpAny' : 'where.topicHelp')}</span>
        {dir && <span className="mt-2 block truncate font-mono text-[11px] text-muted-foreground"><Sensitive length={16}>{dir}</Sensitive></span>}
        <span className="mt-2 block border-t pt-2 text-[11px] text-muted-foreground">{hint}</span>
      </TooltipContent>
    </TooltipRoot>
  )
}

export function NewSessionColumn({ col, variant, index, count, place }: { col: Extract<Col, { kind: 'new' }>; variant: ColumnVariant; index: number; count: number; place?: Place }) {
  const t = useT()
  const { data: ws } = useWorkspace()
  const { data: claude } = useClaudeStatus()
  const close = useSessionsUI((s) => s.close)
  const becomeSession = useSessionsUI((s) => s.becomeSession)
  const setNewPath = useSessionsUI((s) => s.setNewPath)
  const create = useCreateSession()
  const [title, setTitle] = React.useState('')
  const [model, setModel] = React.useState('')
  const [codexModel, setCodexModel] = React.useState('')
  const [provider, setProvider] = React.useState('claude')
  const {data: agentProviders = []} = useQuery({queryKey:['agent-providers'],queryFn:()=>api.get<import('@/lib/types').AgentProvider[]>('/api/agent-providers'),refetchInterval:10000})
  const plugin = provider.startsWith('plugin:')
  const adapter = agentProviders.find(p=>p.id===provider)
  const [swarmAgents, setSwarmAgents] = React.useState('3')
  const [conversationMode, setConversationMode] = React.useState<'discussion' | 'debate'>('discussion')
  const [turnLimit, setTurnLimit] = React.useState('')
  const [durationMinutes, setDurationMinutes] = React.useState('')
  const [claudeRole, setClaudeRole] = React.useState('')
  const [codexRole, setCodexRole] = React.useState('')
  const [preset, setPreset] = React.useState('default')
  const [presetName, setPresetName] = React.useState('')
  const [savingPreset, setSavingPreset] = React.useState(false)
  const qc = useQueryClient()
  type DiscussionPreset = { id: string; name: string; claude_role: string; codex_role: string }
  const { data: presets = [] } = useQuery({ queryKey: ['discussion-presets'], queryFn: () => api.get<DiscussionPreset[]>('/api/discussion-presets'), enabled: provider === 'both' })
  const choosePreset = (id: string) => {
    setPreset(id)
    const selected = presets.find((p) => p.id === id)
    if (selected) { setClaudeRole(selected.claude_role); setCodexRole(selected.codex_role) }
    else if (id === 'review') { setClaudeRole(t('sessions.roleProposer')); setCodexRole(t('sessions.roleReviewer')) }
    else if (id === 'build') { setClaudeRole(t('sessions.roleBuilder')); setCodexRole(t('sessions.roleVerifier')) }
    else { setClaudeRole(''); setCodexRole('') }
  }
  const savePreset = async () => {
    if (!presetName.trim()) return
    setSavingPreset(true)
    try {
      const p = await api.post<DiscussionPreset>('/api/discussion-presets', { name: presetName.trim(), claude_role: claudeRole, codex_role: codexRole })
      await qc.invalidateQueries({ queryKey: ['discussion-presets'] })
      setPreset(p.id); setPresetName(''); toast.success(t('sessions.presetSaved'))
    } catch (e) { toast.error(errorMessage(e)) } finally { setSavingPreset(false) }
  }
  const deletePreset = async () => {
    try { await api.del(`/api/discussion-presets/${seg(preset)}`); await qc.invalidateQueries({ queryKey: ['discussion-presets'] }); setPreset('default'); setClaudeRole(''); setCodexRole('') } catch (e) { toast.error(errorMessage(e)) }
  }
  const [planMode, setPlanMode] = React.useState(false)
  const composer = React.useRef<ComposerHandle>(null)
  const [dragFiles, setDragFiles] = React.useState(false)
  const mask = useMask()
  const topics = (ws?.projects || []).flatMap((p) => p.topics)
  const options = topics.map((tp) => ({ value: tp.path, label: mask(`${tp.project} / ${tp.name}`, 10) }))
  const valid = topics.some((tp) => tp.path === col.path)
  const validLimits = (!turnLimit || (+turnLimit >= 1 && +turnLimit <= 200 && Number.isInteger(+turnLimit))) && (!durationMinutes || (+durationMinutes >= 1 && +durationMinutes <= 1440 && Number.isInteger(+durationMinutes)))
  // Modes that take written messages only: the composer's attach button is off and says why (voice is dictated).
  const noAttach = plugin && adapter && !adapter.capabilities.includes('attachments') ? t('agentProviders.textOnly') : null
  const limits = provider === 'both' ? { discussion_turn_limit: turnLimit ? +turnLimit : undefined, discussion_duration_seconds: durationMinutes ? +durationMinutes * 60 : undefined, claude_role: claudeRole, codex_role: codexRole, codex_model: codexModel.trim() || undefined } : provider === 'swarm' ? { swarm_agents: Number(swarmAgents) } : {}

  const onSend = async (text: string, attachments: string[]) => {
    try {
      if (plugin && attachments.length && !adapter?.capabilities.includes('attachments')) { toast.error(t('agentProviders.textOnly')); return false }
      if (provider === 'team') {
        const s = await api.post<Session>('/api/teams', { path: col.path, message: text, title: title.trim() || undefined, attachments })
        await qc.invalidateQueries({ queryKey: ['sessions'] })
        saveDraft(`new:${col.path}`, '')
        becomeSession(col.key, s.id)
        return true
      }
      const s = await create.mutateAsync({ path: col.path, message: text, title: title.trim() || undefined, model: (provider === 'codex' || plugin ? codexModel.trim() : model) || undefined, provider: provider === 'both' ? conversationMode : provider === 'swarm' ? 'claude' : provider, ...limits, attachments, plan_mode: planMode || undefined })
      seedEmptyLog(s.id)
      usePending.getState().add(s.id, { text, attachments, queued: false })
      saveDraft(`new:${col.path}`, '')
      becomeSession(col.key, s.id)
      requestAnimationFrame(() => focusComposer(col.key))
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }

  const onSendVoice = async (file: File) => {
    try {
      const up = await uploadAttachment(col.path, file)
      const s = await create.mutateAsync({ path: col.path, title: title.trim() || undefined, model: (provider === 'codex' || plugin ? codexModel.trim() : model) || undefined, provider: provider === 'both' ? conversationMode : provider === 'swarm' ? 'claude' : provider, ...limits, plan_mode: planMode || undefined, voice: up.path })
      seedEmptyLog(s.id)
      usePending.getState().add(s.id, { text: '', attachments: [], queued: false, voice: true })
      becomeSession(col.key, s.id)
      requestAnimationFrame(() => focusComposer(col.key))
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }

  // (a picture dragged from a thread carries a file too: that is a content drag)
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(CONTENT_MIME)
  return (
    <ColumnShell col={col} index={index} count={count} variant={variant} place={place}>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={(e) => isFileDrag(e) && setDragFiles(true)}
        onDragOver={(e) => !contentDragOver(e, col.key, null) && isFileDrag(e) && e.preventDefault()}
        onDragLeave={(e) => {
          contentDragLeave(e, col.key)
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragFiles(false)
        }}
        onDrop={(e) => {
          const d = contentDrop(e, null)
          if (d !== undefined) return d && quoteDropped(col.key, composer.current, d)
          if (!isFileDrag(e)) return
          e.preventDefault()
          setDragFiles(false)
          composer.current?.addFiles(Array.from(e.dataTransfer.files))
        }}
      >
        <header data-col-head className={cn('shrink-0 border-b px-3 py-1.5', variant !== 'column' && 'pt-[calc(0.375rem+var(--safe-top))]')}>
          <div className="flex h-9 items-center gap-1">
            {variant === 'mobile' && <TouchSessionsButton className="-ml-2" />}
            {variant === 'column' && <DragGrip colKey={col.key} />}
            <span className="truncate px-1 text-sm font-semibold max-md:flex-1 max-md:text-[15px]">{t('sessions.new.title')}</span>
            {variant === 'mobile' && <TouchAppButton className="-mr-2" />}
            {variant === 'column' && (
              <Tooltip content={t('sessions.closeColumn')}>
                <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={t('sessions.closeColumn')} onClick={() => close(col.key)}>
                  <X />
                </Button>
              </Tooltip>
            )}
          </div>
          {variant === 'mobile' && <MobileTabs />}
          <div className="flex h-5 items-center text-[11px] text-muted-foreground">{t('sessions.new.subtitle')}</div>
        </header>
        <div className="@container min-h-0 flex-1 overflow-y-auto">
          {/* Wide: the form and the mode cards on the left, the mode's settings under them, "What will happen" on the
              right (it spans the rows, the last one takes its extra height). Narrow: one column, the panel right
              under the cards. */}
          <div className="mx-auto grid w-full max-w-[560px] gap-4 px-4 py-6 @3xl:max-w-[1040px] @3xl:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)] @3xl:grid-rows-[auto_auto_1fr] @3xl:gap-x-6">
            <div className="grid min-w-0 content-start gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={`topic-${col.key}`}>{t('sessions.new.topic')}</Label>
                <Combobox id={`topic-${col.key}`} value={col.path} onChange={(v) => setNewPath(col.key, v)} options={options} placeholder={t('sessions.new.pickTopic')} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`title-${col.key}`}>
                  {t('sessions.new.titleLabel')} <span className="font-normal text-muted-foreground">{t('sessions.new.optional')}</span>
                </Label>
                <Input id={`title-${col.key}`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('sessions.new.titlePlaceholder')} maxLength={120} autoComplete="off" />
              </div>
              <ModePicker name={`provider-${col.key}`} value={provider} onChange={(v) => { setProvider(v); setModel(''); setPlanMode(false) }} plugins={agentProviders.filter((p) => !p.builtin)} swarmAgents={swarmAgents} />
            </div>
            <ModePanel mode={provider} adapter={adapter} swarmAgents={swarmAgents} className="@3xl:sticky @3xl:top-0 @3xl:col-start-2 @3xl:row-span-3 @3xl:row-start-1 @3xl:self-start" />
            <div className="grid min-w-0 content-start gap-4 @3xl:col-start-1">
              {provider === 'swarm' && <div className="grid gap-2 rounded-lg border p-3">
                <Label htmlFor={`swarm-count-${col.key}`}>{t('sessions.swarm.count')}</Label>
                <Select id={`swarm-count-${col.key}`} value={swarmAgents} onValueChange={setSwarmAgents} options={['2', '3', '4', '5', '6'].map((n) => ({ value: n, label: n }))} />
              </div>}
              {provider === 'both' && <div className="grid gap-1.5">
                <Label htmlFor={`conversation-mode-${col.key}`}>{t('sessions.conversationMode')}</Label>
                <Select id={`conversation-mode-${col.key}`} value={conversationMode} onValueChange={(v) => setConversationMode(v as 'discussion' | 'debate')} options={[{ value: 'discussion', label: t('sessions.discussion') }, { value: 'debate', label: t('sessions.debate') }]} />
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5"><Label htmlFor={`turn-limit-${col.key}`}>{t('sessions.discussionTurnLimit')}</Label><Input id={`turn-limit-${col.key}`} type="number" min={1} max={200} value={turnLimit} onChange={(e) => setTurnLimit(e.target.value)} placeholder={t('sessions.discussionUnlimited')} /></div>
                  <div className="grid gap-1.5"><Label htmlFor={`duration-limit-${col.key}`}>{t('sessions.discussionDuration')}</Label><Input id={`duration-limit-${col.key}`} type="number" min={1} max={1440} value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} placeholder={t('sessions.discussionUnlimited')} /></div>
                </div>
                <p className="text-xs text-muted-foreground">{t('sessions.discussionLimitsHint')}</p>
                <Label htmlFor={`preset-${col.key}`}>{t('sessions.preset')}</Label>
                <Select id={`preset-${col.key}`} value={preset} onValueChange={choosePreset} options={[{ value: 'default', label: t('sessions.presetDefault') }, { value: 'review', label: t('sessions.presetReview') }, { value: 'build', label: t('sessions.presetBuild') }, ...presets.map((p) => ({ value: p.id, label: p.name }))]} />
                <Label htmlFor={`claude-role-${col.key}`}>{t('sessions.claudeRole')}</Label>
                <Textarea id={`claude-role-${col.key}`} value={claudeRole} maxLength={2000} onChange={(e) => setClaudeRole(e.target.value)} minRows={2} placeholder={t('sessions.rolePlaceholder')} />
                <Label htmlFor={`codex-role-${col.key}`}>{t('sessions.codexRole')}</Label>
                <Textarea id={`codex-role-${col.key}`} value={codexRole} maxLength={2000} onChange={(e) => setCodexRole(e.target.value)} minRows={2} placeholder={t('sessions.rolePlaceholder')} />
                <div className="flex gap-2"><Input value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={80} placeholder={t('sessions.presetName')} aria-label={t('sessions.presetName')} /><Button type="button" variant="outline" disabled={!presetName.trim() || savingPreset} onClick={savePreset}>{t('sessions.presetSave')}</Button></div>
                {presets.some((p) => p.id === preset) && <Button type="button" variant="ghost" className="justify-start" onClick={deletePreset}>{t('sessions.presetDelete')}</Button>}
              </div>}
              {provider !== 'codex' && !plugin && provider !== 'team' && <div className="grid gap-1.5">
                <span className="text-sm font-medium">{provider === 'both' ? t('sessions.claudeModel') : t('sessions.model.label')}</span>
                <div>
                  <ModelPicker chosen={model} onChange={setModel} />
                </div>
              </div>}
              {(provider === 'codex' || provider === 'both' || plugin) && <div className="grid gap-1.5">
                <Label htmlFor={`codex-model-${col.key}`}>{t(plugin ? 'sessions.model.label' : 'sessions.codexModel')}</Label>
                <Input id={`codex-model-${col.key}`} value={codexModel} maxLength={100} onChange={(e) => setCodexModel(e.target.value)} placeholder={t('sessions.model.default')} autoComplete="off" />
                <p className="text-xs text-muted-foreground">{t('sessions.codexModelHint')}</p>
              </div>}
              {provider !== 'both' && provider !== 'team' && (!plugin || adapter?.capabilities.includes('plan')) && <label htmlFor={`plan-${col.key}`} className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/[0.06]">
                <Checkbox id={`plan-${col.key}`} checked={planMode} onCheckedChange={(v) => setPlanMode(v === true)} className="mt-0.5" />
                <span className="grid gap-0.5 leading-tight">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <ListChecks className="size-3.5 text-primary" /> {t('plan.newLabel')}
                  </span>
                  <span className="text-xs text-muted-foreground">{t('plan.newHint')}</span>
                </span>
              </label>}
              <p className="text-[13px] text-muted-foreground">{t('sessions.new.hint')}</p>
            </div>
          </div>
        </div>
        <Composer
          ref={composer}
          colKey={col.key}
          draftKey={`new:${col.path}`}
          topicPath={col.path}
          disabledReason={!valid ? t('sessions.new.pickTopic') : provider === 'both' && !validLimits ? t('sessions.discussionLimitsInvalid') : plugin && !adapter ? t('agentProviders.unavailable') : !plugin && provider !== 'codex' && claude && !claude.auth.ok ? t(claude.auth.method ? 'sessions.composer.authExpired' : 'sessions.composer.noAuth') : null}
          attachDisabledReason={noAttach}
          onSend={onSend}
          // a mixed team takes a written mission: voice is dictated into it
          onSendVoice={noAttach || provider === 'team' ? undefined : onSendVoice}
          autoFocus={variant !== 'mobile'}
          placeholder={planMode ? t('plan.placeholder') : t('sessions.new.placeholder')}
        />
        {dragFiles && (
          <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/95 text-sm font-medium">
            <Upload className="size-6 text-primary" />
            {t('sessions.dropToAttach')}
          </div>
        )}
        <ContentDropOverlay colKey={col.key} sid={null} />
      </div>
    </ColumnShell>
  )
}
