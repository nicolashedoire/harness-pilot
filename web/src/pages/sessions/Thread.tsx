// The conversation scroller.
// - renders a window of the last N items; older ones are revealed (sentinel / button) with the
//   scroll position kept exactly (manual anchoring, `overflow-anchor: none`); once every loaded item
//   is shown, the same sentinel/button fetches the previous page from the server (`onLoadEarlier`);
// - sticks to the bottom only while the user is at the bottom (ResizeObserver keeps it pinned
//   while markdown/images settle); otherwise a "jump to latest" pill appears, never over a block's buttons
//   (pillSpot.ts).
import * as React from 'react'
import { ArrowDown, MessageSquareDashed, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { Button, EmptyState, Skeleton, Spinner, toast } from '@/components/ui'
import { errorMessage } from '@/lib/api'
import { hideMessage } from '@/lib/queries'
import { reducedMotion } from '@/lib/presence'
import type { Session } from '@/lib/types'
import { ItemContext, NoteRow, RequestRow, UserItem, UserMessage } from './Items'
import { buildBlocks, Elapsed, isDuo, TurnView, type Block } from './Turn'
import { AgentIcon, agentName, type AgentId } from '@/features/agents/AgentIcon'
import { onThreadDragEnd, onThreadDragStart } from './contentDrag'
import { PILL_BOTTOM, pillSpot, type PillSpot } from './pillSpot'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { isShownTask, setHiddenLocal, taskStatus, turnKeys, unanswered, withoutHidden, type LogState } from './log'
import type { Pending, Seed } from './store'

const PAGE = 120
/** A freshly opened thread first renders only its last rows (they fill the screen), then grows to PAGE rows by
 *  STEP-row slices above them, out of sight (same anchoring as "show earlier"): the thread shows up sooner and the
 *  final page is the same. */
const FIRST = 30
const STEP = 30
const PIN_PX = 48
/** Rows at the bottom of a freshly opened thread that cascade in (the rest is off-screen anyway). */
const INTRO_ROWS = 8

export type ThreadHandle = { scrollToBottom: (smooth?: boolean) => void }

export const Thread = React.forwardRef<ThreadHandle, {
  log: LogState
  session: Session | undefined
  pending: Pending[]
  onRetry: () => void
  /** Fetch older events from the server (prepended to `log.items`). */
  onLoadEarlier?: () => void
  empty?: React.ReactNode
  /** Edit on a message that got no answer: it goes back into the composer (and leaves the thread). */
  onEdit?: (seed: Seed) => void
  /** Right click → "New session from this message". */
  onFork?: (seed: Seed) => void
  /** Shown after the last message (a plan to approve, a failed turn). */
  tail?: React.ReactNode
  /** The tail is the failed-turn card: the error notes of the last turn say the same thing, they are not shown. */
  hideFailureNotes?: boolean
}>(function Thread({ log, session, pending, onRetry, onLoadEarlier, empty, onEdit, onFork, tail, hideFailureNotes }, ref) {
  const t = useT()
  const scroller = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const pinned = React.useRef(true)
  const [showPill, setShowPill] = React.useState(false)
  const [unseen, setUnseen] = React.useState(false)
  // Hidden messages (deleted unanswered ones) take their turn's rows with them.
  const items = React.useMemo(() => withoutHidden(log.items, log.hidden), [log.items, log.hidden])
  const ready = log.status === 'ready'

  // Window start: fixed once ready (appends never move it), decreases when loading earlier.
  const [start, setStart] = React.useState<number | null>(null)
  // Where the first page ends up (the progressive first render grows `start` down to it), null once reached.
  const growTo = React.useRef<number | null>(null)
  // A layout effect: the first ready render (FIRST rows) is measured before the browser paints it.
  React.useLayoutEffect(() => {
    if (!ready && start !== null) {
      setStart(null) // reloaded (retry / log reset)
      growTo.current = null
    } else if (ready && start === null) {
      const target = Math.max(0, items.length - PAGE)
      const first = Math.max(target, items.length - FIRST)
      const el = scroller.current
      // The first rows do not overflow the view much (its top is visible): the whole page now, before the paint,
      // so that nothing ever appears in view.
      if (first > target && el && el.scrollHeight - el.clientHeight >= 600) {
        growTo.current = target
        setStart(first)
      } else {
        growTo.current = null
        if (el && first > target) prevHeight.current = el.scrollHeight
        setStart(target)
      }
    }
  }, [ready, items.length, start])
  const from = start ?? Math.max(0, items.length - (ready ? FIRST : PAGE))
  const moreOnServer = ready && log.moreBefore && !!onLoadEarlier

  const prevHeight = React.useRef<number | null>(null)
  // Older items prepended from the server: remember the height of the DOM *before* it is updated
  // (read during render, the commit has not happened yet) so the layout effect below keeps the
  // reading position exactly.
  const headKey = items[0]?.key
  const lastHead = React.useRef(headKey)
  if (headKey !== lastHead.current) {
    if (lastHead.current !== undefined && headKey !== undefined && ready && prevHeight.current == null && scroller.current)
      prevHeight.current = scroller.current.scrollHeight
    lastHead.current = headKey
  }
  const loadEarlier = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    if (from > 0) {
      prevHeight.current = el.scrollHeight
      setStart(Math.max(0, from - PAGE))
    } else if (moreOnServer && !log.loadingEarlier) onLoadEarlier!()
  }, [from, moreOnServer, log.loadingEarlier, onLoadEarlier])
  React.useLayoutEffect(() => {
    const el = scroller.current
    if (el && prevHeight.current != null) {
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
    }
  }, [from, headKey])

  // Progressive first render: the rest of the first page, a slice per idle moment, prepended out of sight.
  React.useEffect(() => {
    const target = growTo.current
    if (target === null || start === null) return
    if (start <= target) {
      growTo.current = null
      return
    }
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }
    const grow = () => {
      const s = scroller.current
      if (!s || growTo.current === null) return
      prevHeight.current = s.scrollHeight
      setStart((cur) => (cur === null ? cur : Math.max(growTo.current ?? 0, cur - STEP)))
    }
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(grow, { timeout: 250 })
      return () => w.cancelIdleCallback?.(h)
    }
    const h = setTimeout(grow, 16)
    return () => clearTimeout(h)
  }, [start])

  const toBottom = React.useCallback((smooth = false) => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    setShowPill(false)
    setUnseen(false)
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  React.useImperativeHandle(ref, () => ({ scrollToBottom: toBottom }), [toBottom])

  // First paint of a loaded thread: at the bottom, before the browser paints.
  const placed = React.useRef(false)
  React.useLayoutEffect(() => {
    if (ready && !placed.current && scroller.current) {
      placed.current = true
      scroller.current.scrollTop = scroller.current.scrollHeight
    }
  })

  // New rows: follow if pinned, else flag unseen content.
  // (Only the END of the list counts: older items prepended at the top are not "new".)
  const tailKey = `${items[items.length - 1]?.key ?? ''}|${pending.length}`
  const lastTail = React.useRef(tailKey)
  const lastCount = React.useRef(items.length + pending.length)
  React.useLayoutEffect(() => {
    const n = items.length + pending.length
    if (tailKey === lastTail.current) {
      lastCount.current = n
      return
    }
    const grew = n > lastCount.current
    lastTail.current = tailKey
    lastCount.current = n
    const el = scroller.current
    if (!el) return
    if (pinned.current) el.scrollTop = el.scrollHeight
    else if (grew) setUnseen(true)
  }, [tailKey, items.length, pending.length])

  // Size changes stay pinned: the content (markdown, images, expanding cards, text re-wrapped by a new width) and
  // the view itself (composer growing or unfolding, waiting-messages card, grid row split, window, phone keyboard).
  React.useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (pinned.current && prevHeight.current == null) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  // Only the user lets go of the bottom: a scroll that moves UP away from it (wheel, drag, keys, scrollbar). Scrolls
  // that go down (smooth "jump to latest", pinning) or that the browser makes when the layout changes keep it.
  const lastTop = React.useRef(0)
  // The pill never sits over a block's buttons (or any link / field): it moves aside or up, or lets the clicks through
  // (pillSpot.ts). Checked once per frame while it shows.
  const pill = React.useRef<HTMLButtonElement>(null)
  const [spot, setSpot] = React.useState<PillSpot>('center:0')
  const [side, lift] = spot === 'through' ? ['center', 0] : [spot.split(':')[0], Number(spot.split(':')[1])]
  const placing = React.useRef(0)
  const placePill = React.useCallback(() => {
    if (placing.current) return
    placing.current = requestAnimationFrame(() => {
      placing.current = 0
      if (pill.current && scroller.current) setSpot(pillSpot(pill.current, scroller.current))
    })
  }, [])
  React.useEffect(() => () => cancelAnimationFrame(placing.current), [])
  const onScroll = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const up = el.scrollTop < lastTop.current - 1
    lastTop.current = el.scrollTop
    if (dist < PIN_PX) pinned.current = true
    else if (up) pinned.current = false
    const atBottom = dist < PIN_PX
    const show = !pinned.current && dist > 160
    setShowPill(show)
    if (show) placePill()
    if (atBottom) setUnseen(false)
  }, [placePill])
  React.useEffect(() => {
    const el = scroller.current
    if (!showPill || !el) return
    placePill()
    const ro = new ResizeObserver(placePill)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showPill, unseen, placePill])

  // Auto-load earlier rows when the top sentinel shows up.
  const sentinel = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const s = sentinel.current
    const el = scroller.current
    if (!s || !el || (from <= 0 && !moreOnServer) || log.loadingEarlier) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadEarlier(), { root: el, rootMargin: '300px 0px 0px 0px' })
    io.observe(s)
    return () => io.disconnect()
  }, [from, moreOnServer, log.loadingEarlier, loadEarlier, headKey])

  // Entrance: the last rows of a freshly opened thread rise one after the other (for ~0.8 s), and rows that
  // arrive live (keys e<N> with N past the count at open time) rise individually. Older rows never animate.
  const [intro, setIntro] = React.useState(true)
  React.useEffect(() => {
    if (!ready) return
    const id = setTimeout(() => setIntro(false), 800)
    return () => clearTimeout(id)
  }, [ready])
  const openedAt = React.useRef<number | null>(null)
  if (ready && openedAt.current === null) openedAt.current = log.count
  const rowAnim = (key: string, fromEnd: number): { className?: string; style?: React.CSSProperties } => {
    if (intro && fromEnd < INTRO_ROWS) return { className: 'mx-rise', style: { '--i': INTRO_ROWS - 1 - fromEnd } as React.CSSProperties }
    const m = /^e(\d+)$/.exec(key)
    return m && openedAt.current !== null && Number(m[1]) >= openedAt.current ? { className: 'mx-rise' } : {}
  }

  const running = session?.state === 'running'
  const optimistic = pending.filter((p) => !p.queued)

  // Deleting an unanswered message: its rows slide out, then the thread drops them; "Undo" in the toast.
  const sid = session?.id
  const hideable = React.useMemo(() => unanswered(items, running), [items, running])
  const [leaving, setLeaving] = React.useState<ReadonlySet<string>>(new Set())
  const itemsRef = React.useRef(items)
  itemsRef.current = items
  // `undo`: the "Deleted" toast with Undo (Edit hides quietly: the text is in the composer).
  const hide = React.useCallback(
    (key: string, at: number, undo: boolean) => {
      if (!sid) return
      const keys = turnKeys(itemsRef.current, key)
      let failed = false
      const fail = (hidden: boolean) => (e: unknown) => {
        setHiddenLocal(sid, at, hidden)
        toast.error(errorMessage(e))
      }
      const show = () => {
        setHiddenLocal(sid, at, false)
        hideMessage(sid, at, false).catch(fail(true))
      }
      setLeaving((cur) => new Set([...cur, ...keys]))
      setTimeout(
        () => {
          if (!failed) setHiddenLocal(sid, at, true)
          setLeaving((cur) => new Set([...cur].filter((k) => !keys.includes(k))))
        },
        reducedMotion() ? 0 : 150,
      )
      hideMessage(sid, at, true).then(
        () => undo && toast.action(t('sessions.msg.deleted'), undefined, { label: t('common.undo'), onClick: show }),
        (e) => {
          failed = true
          fail(false)(e)
        },
      )
    },
    [sid, t],
  )
  const onHide = React.useCallback((key: string, at: number) => hide(key, at, true), [hide])
  const editRef = React.useRef(onEdit)
  editRef.current = onEdit
  const onEditItem = React.useCallback(
    (key: string, at: number, seed: Seed) => {
      editRef.current?.(seed)
      hide(key, at, false)
    },
    [hide],
  )
  const forkRef = React.useRef(onFork)
  forkRef.current = onFork
  const onForkItem = React.useCallback((seed: Seed) => forkRef.current?.(seed), [])
  // Items -> blocks (user messages, agent turns); only the blocks that reach into the window are shown.
  const provider = session?.provider
  const partnerName = session?.discussion_partner?.startsWith('plugin:') ? session.provider_name : null
  const blocks = React.useMemo(() => {
    const all = buildBlocks(items, provider, partnerName)
    return hideFailureNotes ? withoutFailureNotes(all) : all
  }, [items, provider, partnerName, hideFailureNotes])
  const shown = React.useMemo(() => (from > 0 ? blocks.filter((b) => b.last >= from) : blocks), [blocks, from])
  const lastBlock = blocks[blocks.length - 1]
  // the turn at work: the last one, unless it already has its result (the next one has not shown up yet)
  const liveKey = running && lastBlock?.kind === 'turn' && !lastBlock.items.some((it) => it.kind === 'result') ? lastBlock.key : null
  const background = React.useMemo(() => (running ? backgroundText(log, t) : null), [running, log.tasks, t]) // eslint-disable-line react-hooks/exhaustive-deps
  const since = running ? log.lastUserAt || session?.updated || null : null
  const duo = isDuo(provider)
  const showReply = duo && !log.moreBefore

  return (
    <div className="relative min-h-0 flex-1">
      {/* one delegated handler for the drags into another session (message grips, files, selected text) */}
      <div ref={scroller} onScroll={onScroll} onDragStart={(e) => onThreadDragStart(e, sid)} onDragEnd={onThreadDragEnd} className="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain [contain:layout_paint] [overflow-anchor:none]" data-thread>
        <div ref={content} className="mx-auto flex min-h-full w-full max-w-[calc(var(--mx-read,740px)+3rem)] flex-col gap-6 px-6 pt-7 pb-6 max-md:gap-5 max-md:px-4 max-md:pt-5">
          {log.status === 'loading' && <ThreadSkeleton />}
          {log.status === 'error' && (
            <EmptyState
              compact
              tone="error"
              icon={MessageSquareDashed}
              title={log.deleted ? t('sessions.deleted') : t('sessions.loadError')}
              description={log.deleted ? undefined : log.error}
              action={
                !log.deleted && (
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    <RotateCw /> {t('common.retry')}
                  </Button>
                )
              }
            />
          )}
          {ready && (
            <>
              {(from > 0 || moreOnServer) && (
                <div ref={sentinel} className="flex justify-center">
                  <Button size="sm" variant="ghost" onClick={loadEarlier} loading={from <= 0 && log.loadingEarlier} className="text-muted-foreground">
                    {from > 0 ? t('sessions.showEarlier', { count: from }) : t('sessions.showEarlierMessages')}
                  </Button>
                </div>
              )}
              {items.length === 0 && optimistic.length === 0 && !running && (empty ?? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t('sessions.emptyThread')}</div>)}
              {shown.map((b, i) => {
                const anim = rowAnim(b.key, shown.length - 1 - i)
                return (
                  <div
                    key={b.key}
                    style={anim.style}
                    className={cn(
                      anim.className,
                      'min-w-0',
                      b.kind === 'user' && i > 0 && shown[i - 1].kind !== 'user' && 'pt-2',
                      b.kind === 'turn' && i > 0 && 'pt-1',
                      leaving.has(b.key) && 'pointer-events-none translate-x-4 opacity-0 transition-[opacity,transform] duration-150 ease-in',
                    )}
                  >
                    <ErrorBoundary>
                      <BlockRow block={b} live={b.key === liveKey} since={since} background={background} duo={duo} showReply={showReply} onHide={hideable.has(b.key) ? onHide : undefined} onEdit={onEdit && onEditItem} onFork={onFork && onForkItem} />
                    </ErrorBoundary>
                  </div>
                )
              })}
              {optimistic.map((p) => (
                <UserMessage key={p.lid} text={p.text} attachments={p.attachments} voice={p.voice || undefined} pending />
              ))}
              {running && !liveKey && <PendingTurn agent={nextAgent(session!, blocks)} since={since} background={background} />}
              {tail}
              {log.deleted && <p className="text-center text-xs text-muted-foreground">{t('sessions.deleted')}</p>}
            </>
          )}
        </div>
      </div>
      <button
        ref={pill}
        type="button"
        onClick={() => toBottom(true)}
        tabIndex={showPill ? 0 : -1}
        aria-hidden={!showPill}
        data-spot={spot}
        style={{ bottom: PILL_BOTTOM + lift }}
        className={cn(
          'absolute z-10 inline-flex h-8 max-md:h-10 pointer-coarse:h-10 items-center gap-1.5 rounded-full border bg-popover px-3 text-xs font-medium whitespace-nowrap shadow-pop transition-[opacity,transform] duration-150',
          side === 'right' ? 'right-4' : side === 'left' ? 'left-4' : 'left-1/2 -translate-x-1/2',
          !showPill ? 'pointer-events-none translate-y-2 opacity-0' : spot === 'through' ? 'pointer-events-none translate-y-0 opacity-60 focus-visible:opacity-100' : 'translate-y-0 opacity-100',
        )}
      >
        <ArrowDown className="size-3.5" />
        {unseen ? t('sessions.newMessages') : t('sessions.jumpLatest')}
      </button>
    </div>
  )
})

/** The block as a row: a user message, a summary request, a note between turns, or an agent turn. */
function BlockRow({
  block: b,
  live,
  since,
  background,
  duo,
  showReply,
  onHide,
  onEdit,
  onFork,
}: {
  block: Block
  live: boolean
  since: number | null
  background: string | null
  duo: boolean
  showReply: boolean
  onHide?: (key: string, at: number) => void
  onEdit?: (key: string, at: number, seed: Seed) => void
  onFork?: (seed: Seed) => void
}) {
  if (b.kind === 'user') return <UserItem item={b.item} intervention={b.intervention} onHide={onHide} onEdit={onEdit} onFork={onFork} />
  if (b.kind === 'request') return <RequestRow text={b.item.ev.text} />
  if (b.kind === 'note') return <NoteRow text={b.item.ev.text} level={b.item.ev.level} />
  return <TurnView turn={b} live={live} since={live ? since : null} background={live ? background : null} duo={duo} showReply={showReply} onFork={onFork} />
}

const isErrorNote = (it: { kind: string; ev?: unknown }) => it.kind === 'note' && (it.ev as { level?: string }).level === 'error'

/** The blocks without the error notes written after the last user message ("Turn failed: …", "Runner error: …"): the
 *  failed-turn card at the end of the thread shows that error, with Retry and the details. */
function withoutFailureNotes(blocks: Block[]): Block[] {
  let from = blocks.length
  while (from > 0 && blocks[from - 1].kind !== 'user') from--
  if (from === blocks.length) return blocks
  const out = blocks.slice(0, from)
  for (const b of blocks.slice(from)) {
    if (b.kind === 'note') {
      if (!isErrorNote(b.item)) out.push(b)
    } else if (b.kind === 'turn' && b.items.some(isErrorNote)) {
      const items = b.items.filter((it) => !isErrorNote(it))
      if (items.length) out.push({ ...b, items })
    } else out.push(b)
  }
  return out
}

/** Who answers next while nothing of the turn has come yet. */
function nextAgent(session: Session, blocks: Block[]): AgentId {
  if (session.provider?.startsWith('plugin:')) return 'plugin'
  if (session.provider === 'codex') return 'codex'
  if (!isDuo(session.provider)) return 'claude'
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'turn') return b.agent === 'claude' ? 'codex' : 'claude'
  }
  return 'claude'
}

/** Running, nothing pending in the thread but sub-agents / background commands still run: say so. */
function backgroundText(log: LogState, t: ReturnType<typeof useT>): string | null {
  const bg = Object.values(log.tasks).filter((tk) => isShownTask(tk) && taskStatus(tk, true) === 'running')
  return bg.length ? t(bg.every((tk) => tk.kind === 'agent') ? 'tasks.bar' : 'tasks.barAny', { count: bg.length }) : null
}

/** The turn has started but nothing of it has arrived yet: who works on it, and for how long. */
function PendingTurn({ agent, since, background }: { agent: AgentId; since: number | null; background: string | null }) {
  const t = useT()
  const { providerName } = React.useContext(ItemContext)
  return (
    <div className="flex flex-col gap-3 pt-1" aria-busy aria-live="polite" data-testid="turn-pending">
      <div className="flex items-center gap-2 text-[13px]">
        <AgentIcon agent={agent} size={22} label={null} />
        <span className="font-semibold">{agentName(agent, t, providerName)}</span>
        {since && (
          <span className="text-muted-foreground">
            {t('conv.working')} <Elapsed since={since} />
          </span>
        )}
      </div>
      <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        <span className="truncate">{background || t('sessions.working')}</span>
      </div>
    </div>
  )
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
      <div className="grid gap-2">
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-10/12" />
        <Skeleton className="h-3.5 w-7/12" />
      </div>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="ml-auto h-9 w-1/2 rounded-2xl" />
      <div className="grid gap-2">
        <Skeleton className="h-3.5 w-10/12" />
        <Skeleton className="h-3.5 w-8/12" />
      </div>
    </div>
  )
}
