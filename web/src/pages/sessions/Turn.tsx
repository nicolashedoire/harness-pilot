// A conversation read as turns. The thread's items (log.ts) are grouped into blocks: the user's messages, and the
// agent's turns. A turn = who answers (icon, name, time), its tool calls and thoughts folded into one "activity" line
// per run (expandable into a compact list: what was read, edited, run, with +/- counts and the diff or output on
// demand), the answer itself, the files it wrote, and a quiet footer (duration · cost, copy, new session from it;
// model, tokens and cache in a tooltip). Rows stay memoised on their items: a new event renders the new pieces only.
import * as React from 'react'
import { AlertTriangle, Check, ChevronRight, CircleAlert, CircleCheck, Circle, FileText, GitFork, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLang, useT } from '@/i18n'
import { fmtDate, fmtNumber } from '@/lib/format'
import { CopyButton, Sensitive, Spinner, Tooltip } from '@/components/ui'
import type { ResultField, Session } from '@/lib/types'
import { AgentIcon, agentName, type AgentId } from '@/features/agents/AgentIcon'
import { authServerOf, McpAuthButton } from '@/features/mcp/AuthButton'
import { AssistantMessage, FILE_TOOLS, ItemContext, NoteRow, ToolInput, ToolOutput, toolDiff } from './Items'
import { isShownTask, taskStatus, type Item } from './log'
import { TaskDetails, TaskElapsed, TaskStatusIcon, useOpenTaskLines } from './Tasks'
import { ResultLineMenu, useResultLine } from './resultLine'
import { useOpenPreview } from './FilePreview'
import type { Seed } from './store'
import { baseName, diffStats, fmtCost, fmtElapsed, fmtMs, fmtTokens, modelLabel, relPath, relPaths } from './util'

type UserIt = Extract<Item, { kind: 'user' }>
type ToolIt = Extract<Item, { kind: 'tool' }>
type ThinkIt = Extract<Item, { kind: 'thinking' }>
type ResultIt = Extract<Item, { kind: 'result' }>
type ActIt = ToolIt | ThinkIt

/** `first` / `last`: indexes of the block's items in the log (the thread's window starts at an item index). */
export type TurnBlock = { kind: 'turn'; key: string; agent: AgentId; items: Item[]; first: number; last: number; /** Discussions: rank of the reply. */ reply: number }
export type Block =
  | { kind: 'user'; key: string; item: UserIt; first: number; last: number; intervention: boolean }
  | { kind: 'request'; key: string; item: Extract<Item, { kind: 'request' }>; first: number; last: number }
  | { kind: 'note'; key: string; item: Extract<Item, { kind: 'note' }>; first: number; last: number }
  | TurnBlock

/** In a discussion, the runner writes the name of the agent that answers next as an info note. */
const AGENT_NOTES: Record<string, AgentId> = { 'Claude Code': 'claude', Codex: 'codex' }

export const isDuo = (provider: Session['provider']) => provider === 'discussion' || provider === 'debate'

/** Items -> blocks. A turn opens with the first agent item after a user message (or with an agent note in a
 *  discussion) and ends with its result; notes outside a turn stand alone. */
export function buildBlocks(items: Item[], provider: Session['provider']): Block[] {
  const duo = isDuo(provider)
  const base: AgentId = provider?.startsWith('plugin:') ? 'plugin' : provider === 'codex' ? 'codex' : 'claude'
  const out: Block[] = []
  let turn: TurnBlock | null = null
  let users = 0
  let replies = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'user') {
      turn = null
      out.push({ kind: 'user', key: it.key, item: it, first: i, last: i, intervention: duo && users++ > 0 })
      continue
    }
    if (it.kind === 'request') {
      turn = null
      out.push({ kind: 'request', key: it.key, item: it, first: i, last: i })
      continue
    }
    if (it.kind === 'note') {
      const agent = duo && it.ev.level === 'info' ? AGENT_NOTES[it.ev.text.trim()] : undefined
      if (agent) {
        // the note itself is not shown: the turn's header says who answers
        turn = { kind: 'turn', key: it.key, agent, items: [], first: i, last: i, reply: ++replies }
        out.push(turn)
        continue
      }
      if (!turn) {
        out.push({ kind: 'note', key: it.key, item: it, first: i, last: i })
        continue
      }
    }
    if (!turn) {
      turn = { kind: 'turn', key: it.key, agent: base, items: [], first: i, last: i, reply: duo ? ++replies : 0 }
      out.push(turn)
    }
    turn.items.push(it)
    turn.last = i
    if (it.kind === 'result') turn = null
  }
  return out
}

/** Same items, same order (blocks are rebuilt on every change; their rows only re-render when this is false). */
export const sameItems = (a: readonly Item[], b: readonly Item[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]))

/* ---------------------------------------------------------------- tool categories */
type Cat = 'think' | 'read' | 'search' | 'web' | 'edit' | 'write' | 'run' | 'agent' | 'todo' | 'other'
const CAT_ORDER: Cat[] = ['think', 'read', 'search', 'web', 'edit', 'write', 'run', 'agent', 'todo', 'other']

function catOf(it: ActIt): Cat {
  if (it.kind === 'thinking') return 'think'
  const n = it.use.name
  if (n === 'Read' || n === 'NotebookRead') return 'read'
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return 'edit'
  if (n === 'Write') return 'write'
  if (n === 'Bash' || n === 'BashOutput' || n === 'KillShell') return 'run'
  if (n === 'Grep' || n === 'Glob' || n === 'LS') return 'search'
  if (n === 'WebFetch' || n === 'WebSearch') return 'web'
  if (n === 'Task' || n === 'Agent') return 'agent'
  if (n === 'TodoWrite') return 'todo'
  return 'other'
}

const inputOf = (it: ToolIt) => (it.use.input && typeof it.use.input === 'object' ? it.use.input : {}) as Record<string, unknown>
const fileOf = (input: Record<string, unknown>) => (typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null)

/** Status of a tool line: its background task if it started one, else its result. */
function toolState(it: ToolIt, running: boolean, live: boolean) {
  const task = isShownTask(it.task) ? it.task : undefined
  const status = task ? taskStatus(task, running) : null
  const pending = status ? status === 'running' : !it.result && live
  const error = status ? status === 'failed' : !!it.result?.is_error
  return { task, status, pending, error }
}

/** What a tool line shows after its label: the file (relative), else the server's summary without the tool name. */
function toolTarget(it: ToolIt, bases: { topicDir: string | null; wsRoot: string | null }) {
  const input = inputOf(it)
  if (it.use.name === 'TodoWrite' && Array.isArray(input.todos)) {
    // the checklist itself shows under the group: here, how far it is
    const todos = input.todos as Todo[]
    const n = `${todos.filter((td) => td.status === 'completed').length}/${todos.length}`
    return { full: n, short: n }
  }
  const file = fileOf(input)
  const full = file && FILE_TOOLS.has(it.use.name) ? file : it.use.summary.startsWith(it.use.name) ? it.use.summary.slice(it.use.name.length).replace(/^[:\s]+/, '') : it.use.summary
  const short = file && FILE_TOOLS.has(it.use.name) ? relPath(file, bases) : relPaths(full, bases)
  return { full, short }
}

/** Seconds from the first item to the last thing that happened in the group. */
function spanOf(items: ActIt[]): number {
  const start = items[0].kind === 'tool' ? items[0].use.at : items[0].ev.at
  let end = start
  for (const it of items) {
    const at = it.kind === 'tool' ? (it.result?.at ?? it.use.at) : it.ev.at
    if (at > end) end = at
  }
  return end - start
}

/* ---------------------------------------------------------------- ticking time */
/** The running time alone ticks every second (not the turn around it). */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = React.useState(() => Date.now() / 1000)
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])
  return <span className={cn('tabular-nums', className)}>{fmtElapsed(Math.max(0, now - since))}</span>
}

/* ---------------------------------------------------------------- turn */
export type TurnProps = {
  turn: TurnBlock
  /** The turn the agent is working on now. */
  live: boolean
  /** Start of the running turn (the last user message), for the ticking time. */
  since: number | null
  /** Running, nothing pending in the thread: what still runs in the background ("2 agents running"). */
  background?: string | null
  duo: boolean
  /** Show "reply N" (discussions whose start is loaded). */
  showReply: boolean
  onFork?: (seed: Seed) => void
}

export const TurnView = React.memo(function TurnView({ turn, live, since, background, duo, showReply, onFork }: TurnProps) {
  const t = useT()
  const lang = useLang()
  const { tz, providerName } = React.useContext(ItemContext)
  const { items, agent } = turn
  const { segs, result, texts, written, todoAfter } = React.useMemo(() => segment(items), [items])
  const first = items[0]
  const at = first ? ('ev' in first ? first.ev.at : first.use.at) : null
  const name = agentName(agent, t, providerName)
  const last = segs[segs.length - 1]
  // live and the last thing shown is not a group at work: a status line says what is going on
  const working = live && !(last?.kind === 'activity' && last.items.some((it) => it.kind === 'tool' && !it.result))
  return (
    <article
      className={cn('flex min-w-0 flex-col gap-3', duo && 'mx-lane border-l-2 pl-3.5')}
      data-agent={agent}
      aria-label={name}
      aria-busy={live || undefined}
      data-testid="turn"
    >
      <div className="flex min-h-[22px] items-center gap-2 text-[13px]">
        <AgentIcon agent={agent} size={22} label={null} />
        <span className={cn('font-semibold', duo && 'mx-agent-name')}>{name}</span>
        <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
          {duo && showReply && turn.reply > 0 && <span>{t('conv.reply', { n: turn.reply })} ·</span>}
          {live && since ? (
            <>
              {t('conv.working')} <Elapsed since={since} />
            </>
          ) : at ? (
            <time className="tabular-nums">{fmtDate(at, lang, tz, { dateStyle: undefined, timeStyle: 'short' })}</time>
          ) : null}
        </span>
      </div>
      {segs.map((s, i) =>
        s.kind === 'activity' ? (
          <React.Fragment key={s.key}>
            <ActivityGroup items={s.items} live={live && i === segs.length - 1} />
            {todoAfter === s.key && <TodoCard items={s.items} />}
          </React.Fragment>
        ) : s.kind === 'text' ? (
          <AssistantMessage key={s.key} text={s.item.ev.text} onFork={onFork} />
        ) : (
          <NoteRow key={s.key} text={s.item.ev.text} level={s.item.ev.level} />
        ),
      )}
      {working && <WorkingLine background={background} />}
      {written.length > 0 && !live && <FileCards paths={written} />}
      {result && <TurnFooter ev={result.ev} text={texts} onFork={onFork} />}
    </article>
  )
}, (a, b) => a.live === b.live && a.since === b.since && a.background === b.background && a.duo === b.duo && a.showReply === b.showReply && a.onFork === b.onFork && a.turn.agent === b.turn.agent && a.turn.reply === b.turn.reply && sameItems(a.turn.items, b.turn.items))

type Seg = { kind: 'activity'; key: string; items: ActIt[] } | { kind: 'text'; key: string; item: Extract<Item, { kind: 'assistant' }> } | { kind: 'note'; key: string; item: Extract<Item, { kind: 'note' }> }

/** A turn's items as shown: runs of tool calls / thoughts become one activity group each. */
function segment(items: Item[]) {
  const segs: Seg[] = []
  let run: ActIt[] | null = null
  let result: ResultIt | null = null
  const texts: string[] = []
  const written: string[] = []
  let todoAfter: string | null = null
  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'thinking') {
      if (!run) {
        run = []
        segs.push({ kind: 'activity', key: it.key, items: run })
      }
      run.push(it)
      if (it.kind === 'tool' && it.use.name === 'TodoWrite') todoAfter = segs[segs.length - 1].key
      if (it.kind === 'tool' && it.use.name === 'Write' && !it.result?.is_error) {
        const f = fileOf(inputOf(it))
        if (f) {
          const k = written.indexOf(f)
          if (k >= 0) written.splice(k, 1)
          written.push(f)
        }
      }
      continue
    }
    run = null
    if (it.kind === 'assistant') {
      segs.push({ kind: 'text', key: it.key, item: it })
      if (it.ev.text.trim()) texts.push(it.ev.text.trim())
    } else if (it.kind === 'note') segs.push({ kind: 'note', key: it.key, item: it })
    else if (it.kind === 'result') result = it
    // init (model, folder): in the footer's details and the header chip, not a row
  }
  return { segs, result, texts: texts.join('\n\n'), written: written.slice(-4), todoAfter }
}

function WorkingLine({ background }: { background?: string | null }) {
  const t = useT()
  return (
    <div className="flex h-7 items-center gap-2 text-xs text-muted-foreground" aria-live="polite" data-testid="turn-working">
      <Spinner className="size-3.5" />
      <span className="truncate">{background || t('sessions.working')}</span>
    </div>
  )
}

/* ---------------------------------------------------------------- activity */
const ActivityGroup = React.memo(
  function ActivityGroup({ items, live }: { items: ActIt[]; live: boolean }) {
    const t = useT()
    const { running, topicDir = null, wsRoot = null } = React.useContext(ItemContext)
    const bases = React.useMemo(() => ({ topicDir, wsRoot }), [topicDir, wsRoot])
    const [open, setOpen] = React.useState(false)
    const [openRow, setOpenRow] = React.useState<string | null>(null)
    const root = React.useRef<HTMLDivElement>(null)
    // the bar of background tasks opens the line of one of them, folded in here
    const taskIds = items.flatMap((it) => (it.kind === 'tool' && isShownTask(it.task) ? [it.use.id] : [])).join(' ')
    useOpenTaskLines(
      taskIds,
      React.useCallback((id: string) => {
        setOpen(true)
        setOpenRow(id)
      }, []),
      root,
    )
    const info = React.useMemo(() => {
      const counts = new Map<Cat, number>()
      let failed = 0
      let pending: ToolIt | null = null
      let done = true
      for (const it of items) {
        if (it.kind === 'tool') {
          const st = toolState(it, running, live)
          if (st.error) failed++
          else counts.set(catOf(it), (counts.get(catOf(it)) || 0) + 1)
          if (st.pending) pending = it
          if (!it.result && !st.task) done = false
        } else counts.set('think', 1)
      }
      return { counts, failed, pending, done, span: spanOf(items) }
    }, [items, running, live])
    const last = items[items.length - 1]
    const busy = live && (!!info.pending || last.kind === 'thinking')
    let label: string
    if (busy && info.pending) {
      const cat = catOf(info.pending)
      label = t(`conv.live.${cat}`, { target: toolTarget(info.pending, bases).short || info.pending.use.name })
    } else if (busy) label = t('conv.live.think')
    else {
      const parts = CAT_ORDER.filter((c) => info.counts.get(c)).map((c) => t(`conv.act.${c}`, { count: info.counts.get(c)! }))
      if (info.failed) parts.push(t('conv.act.failed', { count: info.failed }))
      const s = parts.join(', ')
      label = s.charAt(0).toUpperCase() + s.slice(1)
    }
    const auth = items.flatMap((it) => (it.kind === 'tool' && authServerOf(it.use.name) ? [authServerOf(it.use.name)!] : []))
    const icon = busy ? (
      <Spinner className="size-3.5" />
    ) : info.failed ? (
      <CircleAlert className="size-3.5 text-destructive" />
    ) : info.done ? (
      <Check className="size-3.5 text-success" />
    ) : (
      <X className="size-3.5" />
    )
    const span = !busy && info.span >= 1 ? fmtElapsed(info.span) : null
    return (
      <div ref={root} className={cn('min-w-0 max-w-full', open ? 'rounded-xl border bg-card/60' : 'self-start')} data-testid="activity">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(
            'flex h-8 max-w-full min-w-0 items-center gap-2 px-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:h-10 max-md:text-[13px]',
            open ? 'w-full rounded-t-xl hover:bg-accent/50' : 'rounded-lg border bg-card/60 hover:bg-accent',
          )}
          data-testid="activity-toggle"
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
          <span className={cn('min-w-0 truncate', open && 'flex-1')}>
            <Sensitive length={16}>{label}</Sensitive>
            {span && <span className="tabular-nums"> · {span}</span>}
          </span>
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        </button>
        {open && (
          <ol className="grid gap-0.5 px-1.5 pb-1.5">
            {items.map((it) =>
              it.kind === 'tool' ? (
                <ToolRow key={it.key} item={it} live={live} bases={bases} open={openRow === it.use.id} onToggle={() => setOpenRow((r) => (r === it.use.id ? null : it.use.id))} />
              ) : (
                <ThinkRow key={it.key} item={it} open={openRow === it.key} onToggle={() => setOpenRow((r) => (r === it.key ? null : it.key))} />
              ),
            )}
          </ol>
        )}
        {auth.length > 0 && (
          <div className={cn('overflow-hidden', !open && 'mt-1.5 rounded-lg border')}>
            {[...new Set(auth)].map((s) => (
              <McpAuthButton key={s} server={s} />
            ))}
          </div>
        )}
      </div>
    )
  },
  (a, b) => a.live === b.live && sameItems(a.items, b.items),
)

const rowBtn =
  'flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none max-md:min-h-10'

function ToolRow({ item, live, bases, open, onToggle }: { item: ToolIt; live: boolean; bases: { topicDir: string | null; wsRoot: string | null }; open: boolean; onToggle: () => void }) {
  const t = useT()
  const { running } = React.useContext(ItemContext)
  const { use, result } = item
  const st = toolState(item, running, live)
  const input = inputOf(item)
  const file = fileOf(input)
  const cat = catOf(item)
  const diff = React.useMemo(() => (open || ['Edit', 'MultiEdit', 'Write'].includes(use.name) ? toolDiff(use.name, input) : null), [open, use.name, input])
  const stats = diff ? diffStats(diff) : null
  const { full, short } = toolTarget(item, bases)
  const label = st.error ? t('convx.row.failed') : cat === 'other' ? (use.name.startsWith('mcp__') ? use.name.split('__').slice(2).join('__') || use.name : use.name) : t(`convx.row.${cat}`)
  const more = diff ? t('convx.viewDiff') : result && !st.task ? t(st.error ? 'convx.viewError' : 'convx.viewOutput') : t('conv.details')
  return (
    <li className="min-w-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className={rowBtn} data-testid="tool-row">
        <span className={cn('w-16 shrink-0 truncate text-xs', st.error ? 'text-destructive' : 'text-muted-foreground')}>{label}</span>
        <Tooltip content={short !== full ? <Sensitive length={20}><span className="max-w-[min(80vw,640px)] font-mono break-all">{full}</span></Sensitive> : null}>
          <span className={cn('min-w-0 flex-1 truncate font-mono text-[12px]', st.error && 'text-destructive')}>
            <Sensitive length={14}>{short || use.name}</Sensitive>
          </span>
        </Tooltip>
        {stats && (stats.add > 0 || stats.del > 0) && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">+{stats.add}</span> <span className="text-destructive">−{stats.del}</span>
          </span>
        )}
        {st.task && st.status && <TaskElapsed task={st.task} status={st.status} />}
        {st.status ? <TaskStatusIcon status={st.status} /> : st.pending ? <Spinner className="size-3.5 shrink-0" /> : null}
        <span className="shrink-0 text-xs text-primary max-sm:hidden">{open ? t('conv.hide') : more}</span>
      </button>
      {open && (
        <div className="mx-1.5 mt-1 mb-1.5 grid gap-2">
          <Sensitive block>
            {st.task && st.status && <TaskDetails task={st.task} status={st.status} />}
            <ToolInput name={use.name} input={input} diff={diff} display={file ? relPath(file, bases) : null} />
            {st.task && (st.task.background || st.task.summary) ? null : result ? (
              <ToolOutput text={result.text} error={result.is_error} />
            ) : (
              <p className="text-xs text-muted-foreground">{st.pending ? t('sessions.tool.running') : t('sessions.tool.noResult')}</p>
            )}
          </Sensitive>
        </div>
      )}
    </li>
  )
}

function ThinkRow({ item, open, onToggle }: { item: ThinkIt; open: boolean; onToggle: () => void }) {
  const t = useT()
  const line = item.ev.text.trim().split('\n')[0]
  return (
    <li className="min-w-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className={rowBtn}>
        <span className="w-16 shrink-0 truncate text-xs text-muted-foreground">{t('convx.row.think')}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground italic">
          <Sensitive length={20}>{line}</Sensitive>
        </span>
        <span className="shrink-0 text-xs text-primary max-sm:hidden">{open ? t('conv.hide') : t('conv.details')}</span>
      </button>
      {open && (
        <div className="mx-1.5 mt-1 mb-1.5 border-l-2 pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground italic">
          <Sensitive block>{item.ev.text}</Sensitive>
        </div>
      )}
    </li>
  )
}

/* ---------------------------------------------------------------- tasks checklist */
type Todo = { content?: string; status?: string; activeForm?: string }

/** The agent's own checklist (its last TodoWrite in the turn), under the group that holds it. */
function TodoCard({ items }: { items: ActIt[] }) {
  const t = useT()
  let todos: Todo[] = []
  for (const it of items) if (it.kind === 'tool' && it.use.name === 'TodoWrite' && Array.isArray(inputOf(it).todos)) todos = inputOf(it).todos as Todo[]
  if (!todos.length) return null
  const done = todos.filter((td) => td.status === 'completed').length
  return (
    <div className="grid gap-2.5 rounded-xl border bg-card/60 px-4 py-3.5 text-[13px]" data-testid="todo-card">
      <div className="flex items-center gap-2.5">
        <span className="flex-1 font-semibold">{t('conv.todo.title')}</span>
        <span className="text-muted-foreground tabular-nums">{t('conv.todo.count', { done, count: todos.length })}</span>
      </div>
      <span aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-success" style={{ width: `${(done / todos.length) * 100}%` }} />
      </span>
      <ul className="grid gap-2">
        {todos.map((td, i) => (
          <li key={i} className={cn('flex items-start gap-2.5', td.status === 'completed' && 'text-muted-foreground')}>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {td.status === 'completed' ? (
                <CircleCheck className="size-4 text-success" aria-label={t('conv.todo.done')} />
              ) : td.status === 'in_progress' ? (
                <Spinner className="size-3.5" />
              ) : (
                <Circle className="size-4 text-muted-foreground/60" aria-label={t('conv.todo.pending')} />
              )}
            </span>
            <span className={cn('min-w-0', td.status === 'completed' && 'line-through')}>
              <Sensitive length={14}>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content || ''}</Sensitive>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ---------------------------------------------------------------- written files */
const KIND_BY_EXT: Record<string, string> = { md: 'Markdown', mdx: 'Markdown', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', json: 'JSON', css: 'CSS', html: 'HTML', yml: 'YAML', yaml: 'YAML', sh: 'Shell', csv: 'CSV', txt: 'Text', toml: 'TOML', sql: 'SQL' }

function FileCards({ paths }: { paths: string[] }) {
  const t = useT()
  const open = useOpenPreview()
  const { topicDir = null, wsRoot = null } = React.useContext(ItemContext)
  return (
    <div className="flex flex-wrap gap-2">
      {paths.map((p) => {
        const ext = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() || ''
        return (
          <button
            key={p}
            type="button"
            data-mx-file={p}
            draggable
            onClick={() => open(p)}
            className="flex max-w-full min-w-0 items-center gap-3 rounded-xl border bg-card/60 px-3.5 py-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-w-72"
            data-testid="file-card"
          >
            <FileText className="size-[18px] shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 flex-1">
              <span className="truncate font-mono text-[13px]">
                <Sensitive length={12}>{relPath(p, { topicDir, wsRoot }) || baseName(p)}</Sensitive>
              </span>
              <span className="text-xs text-muted-foreground">{[t('conv.file.written'), KIND_BY_EXT[ext] || ext.toUpperCase()].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="shrink-0 text-[13px] text-primary">{t('conv.file.open')}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- footer */
function TurnFooter({ ev, text, onFork }: { ev: ResultIt['ev']; text: string; onFork?: (seed: Seed) => void }) {
  const t = useT()
  const lang = useLang()
  const { models } = React.useContext(ItemContext)
  const { hidden } = useResultLine()
  const show = (f: ResultField) => !hidden.includes(f)
  const u = ev.usage
  const ctx = (u?.input || 0) + (u?.cache_read || 0) + (u?.cache_write || 0)
  const share = fmtNumber(ctx > 0 ? (u?.cache_read || 0) / ctx : 0, lang, { style: 'percent', maximumFractionDigits: 0 })
  const parts = [ev.duration_ms > 0 && show('duration') ? fmtMs(ev.duration_ms) : null, ev.cost_usd > 0 && show('cost') ? `≈ ${fmtCost(ev.cost_usd)}` : null].filter(Boolean) as string[]
  const rows: [string, string][] = [
    ...(ev.model && show('model') ? [[t('convx.detail.model'), modelLabel(ev.model, models)] as [string, string]] : []),
    ...(ctx > 0 && show('tokens') ? [[t('convx.detail.tokens'), t('convx.detail.tokensValue', { input: fmtTokens(ctx), output: fmtTokens(u?.output || 0) })] as [string, string]] : []),
    ...(ctx > 0 && show('cache') ? [[t('convx.detail.cache'), share] as [string, string]] : []),
  ]
  const details = rows.length ? (
    <span className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <span className="opacity-70">{k}</span>
          <span className="tabular-nums">{v}</span>
        </React.Fragment>
      ))}
      {ev.cost_usd > 0 && show('cost') && <span className="col-span-2 mt-1 max-w-64 whitespace-normal opacity-70">{t('sessions.result.costEstimate')}</span>}
    </span>
  ) : null
  return (
    <div className="group/result -ml-1.5 flex items-center gap-0.5 text-xs text-muted-foreground" data-testid="turn-footer">
      {text && <CopyButton text={text} label={t('conv.copy')} className="size-7" />}
      {onFork && text && (
        <Tooltip content={t('sessions.msg.newSession')}>
          <button
            type="button"
            onClick={() => onFork({ text: '', quotes: [text], attachments: [] })}
            aria-label={t('sessions.msg.newSession')}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:size-10 pointer-coarse:size-10"
            data-testid="turn-fork"
          >
            <GitFork className="size-3.5" />
          </button>
        </Tooltip>
      )}
      {!ev.ok && (
        <span className="ml-1 inline-flex items-center gap-1 text-destructive">
          <AlertTriangle className="size-3.5" /> {t('conv.turnFailed')}
        </span>
      )}
      <Tooltip content={details}>
        <span tabIndex={0} className="ml-1 inline-flex h-6 items-center gap-1 rounded px-0.5 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={[...parts, ...rows.map(([k, v]) => `${k} ${v}`)].join(', ') || t('conv.details')}>
          {parts.length ? <Sensitive length={6}>{parts.join(' · ')}</Sensitive> : <Info className="size-3.5" />}
        </span>
      </Tooltip>
      <span className="ml-1">
        <ResultLineMenu />
      </span>
    </div>
  )
}

