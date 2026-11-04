// The small pieces every Atelier screen shares (the list, the validation screen, the detail page and the proposal
// card of a conversation): the icon and name of a type, the state pill, where a creation comes from, its version.
import { Link } from 'react-router'
import { AppWindow, Blocks, Bot, Clock, GraduationCap, LayoutGrid, Palette, Pin, UserRound, Wrench, type LucideIcon } from 'lucide-react'
import { useLang, useT, type TKey } from '@/i18n'
import { fmtDate, fmtRelative } from '@/lib/format'
import type { AtelierDraft, AtelierItem, AtelierOrigin, AtelierState, AtelierType } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Sensitive } from '@/components/ui'
import { AgentIcon } from '@/features/agents/AgentIcon'

export const TYPE_ICON: Record<AtelierType, LucideIcon> = {
  widget: LayoutGrid,
  html_widget: LayoutGrid,
  pin: Pin,
  page: AppWindow,
  block: Blocks,
  agent: Bot,
  theme: Palette,
  skill: GraduationCap,
  customization: Wrench,
  cron: Clock,
}

/** "Widget", "HTML widget", "Page"… */
export const typeLabel = (t: (k: TKey) => string, type: AtelierType) => t(`atelier.type.${type}` as TKey)

/** The type's icon in a small tile (list rows, cards, headers). `pending`: in the violet of what waits for the user. */
export function TypeTile({ type, pending, className }: { type: AtelierType; pending?: boolean; className?: string }) {
  const t = useT()
  const Icon = TYPE_ICON[type] ?? Wrench
  return (
    <span
      role="img"
      aria-label={typeLabel(t, type)}
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground', pending && 'border-draft/30 bg-draft/10 text-draft', className)}
    >
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

/** The pill's look: a draft waiting (pending) or the item's state; an active theme or customization reads "Applied". */
export type PillState = AtelierState | 'applied'
export const pillState = (it: Pick<AtelierItem, 'state' | 'pending' | 'kind'>): PillState =>
  it.pending ? 'pending' : it.state === 'active' && (it.kind === 'theme' || it.kind === 'customization') ? 'applied' : it.state

const PILL: Record<PillState, string> = {
  pending: 'border-draft/30 bg-draft/10 text-draft',
  active: 'border-success/25 bg-success/12 text-success',
  applied: 'border-success/25 bg-success/12 text-success',
  error: 'border-destructive/25 bg-destructive/12 text-destructive',
  review: 'border-warning/30 bg-warning/12 text-warning',
  disabled: 'border-transparent bg-muted text-muted-foreground',
}

/** À valider (violet) · Actif / Appliqué (green) · Erreur (red) · À revoir après la mise à jour (amber) · Désactivé. */
export function StatePill({ state, className }: { state: PillState; className?: string }) {
  const t = useT()
  return (
    <span className={cn('inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap', PILL[state] ?? PILL.disabled, className)}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{t(`atelier.state.${state}` as TKey)}</span>
    </span>
  )
}

/** The agent's mark, a person for the user's own changes, nothing when unknown. */
export function OriginMark({ agent, size = 16 }: { agent: string | null | undefined; size?: number }) {
  const t = useT()
  if (agent === 'claude' || agent === 'codex') return <AgentIcon agent={agent} size={size} />
  if (agent?.startsWith('plugin:')) return <AgentIcon agent="plugin" size={size} label={agent.slice(7)} />
  if (agent === 'user') return <UserRound role="img" aria-label={t('atelier.origin.you')} className="shrink-0 text-muted-foreground" style={{ width: size, height: size }} />
  return null
}

/** Link to the session a creation was made in (its topic too when known, so the tree opens there). */
export const sessionHref = (o: Pick<AtelierOrigin, 'session' | 'session_path'>) =>
  `/sessions?${o.session_path ? `path=${encodeURIComponent(o.session_path)}&` : ''}session=${encodeURIComponent(o.session ?? '')}`

/** Agent mark + the session it was made in (a link to it) + when (relative, or the date with `withDate`). */
export function Origin({ origin, className, withDate }: { origin: AtelierOrigin | null | undefined; className?: string; withDate?: boolean }) {
  const t = useT()
  const lang = useLang()
  const known = origin && origin.agent !== 'unknown'
  if (!origin || (!known && !origin.session)) return <span className={cn('text-[13px] text-muted-foreground', className)}>{t('atelier.origin.unknown')}</span>
  const name = origin.session ? origin.session_title || t('atelier.origin.untitled') : origin.agent === 'user' ? t('atelier.origin.you') : t('atelier.origin.noSession')
  const when = origin.at ? (withDate ? fmtDate(origin.at, lang) : fmtRelative(origin.at, lang)) : ''
  return (
    <span className={cn('flex min-w-0 items-center gap-2 text-[13px]', className)}>
      <OriginMark agent={origin.agent} />
      <span className="grid min-w-0 leading-tight">
        {origin.session ? (
          <Link to={sessionHref(origin)} className="truncate font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none">
            <Sensitive length={12}>{name}</Sensitive>
          </Link>
        ) : (
          <span className="truncate font-medium">{name}</span>
        )}
        {when && (
          <span className="truncate text-xs text-muted-foreground" title={origin.at ? new Date(origin.at * 1000).toLocaleString(lang) : undefined}>
            {when}
          </span>
        )}
      </span>
    </span>
  )
}

/** "v3" in the monospace font (the manifest's own version string in the tooltip). */
export function VersionTag({ version, label, className }: { version: number | null | undefined; label?: string | null; className?: string }) {
  if (!version) return <span className={cn('font-mono text-xs text-muted-foreground/60', className)}>–</span>
  return (
    <span className={cn('font-mono text-xs text-muted-foreground tabular-nums', className)} title={label ? label : undefined}>
      {`v${version}`}
    </span>
  )
}

/** The button that turns it on, worded for what it is (the validation screen, the proposal card). */
export function approveWord(t: (k: TKey) => string, d: Pick<AtelierDraft, 'change' | 'type'>) {
  if (d.change === 'update') return t('atelier.review.approveUpdate')
  if (d.type === 'widget' || d.type === 'html_widget' || d.type === 'pin') return t('atelier.review.approveDashboard')
  if (d.type === 'page') return t('atelier.review.approvePage')
  if (d.type === 'block') return t('atelier.review.approveBlock')
  if (d.type === 'agent') return t('atelier.review.approveAgent')
  return t('atelier.review.approve')
}
