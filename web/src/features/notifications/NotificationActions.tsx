// The buttons of a notification. `compact` (centre, toasts): only "Resume" is a primary button; `detail`: the first
// action is; `touch`: two columns of 44 px buttons (phone cards).
import { ExternalLink, Play, RotateCcw } from 'lucide-react'
import { eventActions } from '@/lib/feed'
import type { FeedAction, FeedEvent } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui'
import { useNotificationActions } from './useNotificationActions'
import { actionLabel } from './text'
import { useT } from '@/i18n'

export type ActionsLayout = 'compact' | 'detail' | 'touch'

const ICON: Record<string, typeof Play> = { resume: Play, rerun: RotateCcw, open_run: ExternalLink }

/** The actions worth a button: not the lone "Open" that does what a click on the row does already. */
export function visibleActions(ev: FeedEvent, layout: ActionsLayout): FeedAction[] {
  const all = eventActions(ev)
  if (layout !== 'detail' && all.length === 1 && all[0].type === 'link' && all[0].url === ev.url) return []
  return all
}

export function NotificationActions({ ev, layout = 'compact', className }: { ev: FeedEvent; layout?: ActionsLayout; className?: string }) {
  const t = useT()
  const actions = useNotificationActions()
  const list = visibleActions(ev, layout)
  if (!list.length) return null
  return (
    <div className={cn(layout === 'touch' ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-1.5', className)}>
      {list.map((a, i) => {
        const primary = layout === 'detail' ? i === 0 : a.id === 'resume'
        const Icon = layout === 'detail' ? ICON[a.id] : undefined
        return (
          <Button
            key={`${a.id}-${i}`}
            type="button"
            variant={primary ? 'default' : 'outline'}
            size={layout === 'detail' ? 'default' : 'sm'}
            loading={actions.running(a)}
            className={cn(
              layout === 'compact' && 'h-7 px-2.5 text-xs',
              layout === 'touch' && 'h-11 text-sm max-md:h-11 pointer-coarse:h-11',
              layout === 'touch' && list.length % 2 === 1 && i === list.length - 1 && 'col-span-2',
            )}
            onClick={(e) => {
              e.stopPropagation()
              actions.act(ev, a)
            }}
            data-action={a.id}
          >
            {Icon && <Icon />}
            {actionLabel(t, a)}
          </Button>
        )
      })}
    </div>
  )
}
