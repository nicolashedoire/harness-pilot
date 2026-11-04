// The small pieces every Atelier screen shares (the list, the validation screen, the detail page and the proposal
// card of a conversation): the icon of a kind, the state pill, where a creation comes from.
import { Link } from 'react-router'
import { AppWindow, Blocks, GraduationCap, LayoutGrid, Palette, Wrench, type LucideIcon } from 'lucide-react'
import { useLang, useT, type TKey } from '@/i18n'
import { fmtDate, fmtRelative } from '@/lib/format'
import type { AtelierKind, AtelierOrigin, AtelierState } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Sensitive } from '@/components/ui'
import { AgentIcon, type AgentId } from '@/features/agents/AgentIcon'

export const ATELIER_KINDS: AtelierKind[] = ['widget', 'page', 'block', 'theme', 'skill', 'customization']

export const KIND_ICON: Record<AtelierKind, LucideIcon> = {
  widget: LayoutGrid,
  page: AppWindow,
  block: Blocks,
  theme: Palette,
  skill: GraduationCap,
  customization: Wrench,
}

/** "Widget", "Page"… (one) or "Widgets", "Pages"… (`plural`). */
export const kindLabel = (t: (k: TKey) => string, kind: AtelierKind, plural = false) => t(`atelier.kind.${kind}${plural ? 's' : ''}` as TKey)

/** The kind's icon in a small tile (list rows, cards). */
export function KindTile({ kind, className }: { kind: AtelierKind; className?: string }) {
  const t = useT()
  const Icon = KIND_ICON[kind] ?? Wrench
  return (
    <span role="img" aria-label={kindLabel(t, kind)} className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground', className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

const PILL: Record<AtelierState, string> = {
  draft: 'border-draft/30 bg-draft/10 text-draft',
  active: 'border-success/25 bg-success/12 text-success',
  applied: 'border-success/25 bg-success/12 text-success',
  error: 'border-destructive/25 bg-destructive/12 text-destructive',
  review: 'border-warning/30 bg-warning/12 text-warning',
  disabled: 'border-transparent bg-muted text-muted-foreground',
}

/** À valider (violet) · Actif / Appliqué (green) · Erreur (red) · À revoir après la mise à jour (amber) · Désactivé. */
export function StatePill({ state, className }: { state: AtelierState; className?: string }) {
  const t = useT()
  return (
    <span className={cn('inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap', PILL[state] ?? PILL.disabled, className)}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {t(`atelier.state.${state}` as TKey)}
    </span>
  )
}

const agentOf = (a: string | null | undefined): AgentId => (a === 'codex' ? 'codex' : a === 'claude' || !a ? 'claude' : 'plugin')

/** Agent mark + the session it was made in (a link to it) + when. `compact`: one line, the time only as a tooltip. */
export function Origin({ origin, className, withDate }: { origin: AtelierOrigin | null | undefined; className?: string; withDate?: boolean }) {
  const t = useT()
  const lang = useLang()
  if (!origin) return <span className={cn('text-[13px] text-muted-foreground', className)}>{t('atelier.origin.unknown')}</span>
  const name = origin.session_title || t('atelier.origin.untitled')
  const when = origin.at ? (withDate ? fmtDate(origin.at, lang) : fmtRelative(origin.at, lang)) : ''
  return (
    <span className={cn('flex min-w-0 items-center gap-2 text-[13px]', className)}>
      <AgentIcon agent={agentOf(origin.agent)} size={16} />
      <span className="grid min-w-0 leading-tight">
        {origin.session_id ? (
          <Link to={`/sessions?session=${encodeURIComponent(origin.session_id)}`} className="truncate font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none" onClick={(e) => e.stopPropagation()}>
            <Sensitive length={12}>{name}</Sensitive>
          </Link>
        ) : (
          <span className="truncate font-medium">
            <Sensitive length={12}>{name}</Sensitive>
          </span>
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

/** "v3" in the monospace font. */
export function VersionTag({ version, className }: { version: number | null | undefined; className?: string }) {
  if (!version) return null
  return <span className={cn('font-mono text-xs text-muted-foreground tabular-nums', className)}>v{version}</span>
}
