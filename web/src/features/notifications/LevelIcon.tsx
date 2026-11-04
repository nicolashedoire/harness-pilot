// The icon of a notification: its level (error, to watch, succeeded, information), or its kind when that says more
// (a paused discussion shows "pause"). Colours are the status tokens.
import { CircleAlert, CircleCheck, Info, Pause, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useT } from '@/i18n'
import type { FeedLevel } from '@/lib/types'
import { cn } from '@/lib/utils'
import { levelLabel } from './text'

export const LEVEL_STYLE: Record<FeedLevel, { icon: LucideIcon; text: string; soft: string }> = {
  error: { icon: CircleAlert, text: 'text-destructive', soft: 'bg-destructive/12 text-destructive' },
  warning: { icon: TriangleAlert, text: 'text-warning', soft: 'bg-warning/12 text-warning' },
  success: { icon: CircleCheck, text: 'text-success', soft: 'bg-success/12 text-success' },
  info: { icon: Info, text: 'text-primary', soft: 'bg-primary/12 text-primary' },
}
const KIND_ICON: Record<string, LucideIcon> = { 'discussion.paused': Pause }

export function LevelIcon({ level, kind, className, decorative }: { level: FeedLevel; kind?: string; className?: string; decorative?: boolean }) {
  const t = useT()
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info
  const Icon = (kind && KIND_ICON[kind]) || s.icon
  return decorative ? (
    <Icon aria-hidden className={cn('size-[18px] shrink-0', s.text, className)} />
  ) : (
    <Icon role="img" aria-label={levelLabel(t, level)} className={cn('size-[18px] shrink-0', s.text, className)} />
  )
}

/** Level as a small badge (detail header). */
export function LevelBadge({ level, className }: { level: FeedLevel; className?: string }) {
  const t = useT()
  const s = LEVEL_STYLE[level] ?? LEVEL_STYLE.info
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-semibold', s.soft, className)}>
      <s.icon aria-hidden className="size-3.5" />
      {levelLabel(t, level)}
    </span>
  )
}
