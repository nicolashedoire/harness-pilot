// In-app notice of a notification (a session finished, a cron failed, a discussion paused...): level icon, title,
// one line, up to two buttons (the first one primary), a close button. Rendered by sonner (the app's Toaster).
import { toast as sonner } from 'sonner'
import { X } from 'lucide-react'
import type { FeedLevel } from '@/lib/types'
import { translate } from '@/i18n'
import { useUI } from '@/stores/ui'
import { Button, Sensitive } from '@/components/ui'
import { LevelIcon } from './LevelIcon'

export type ToastAction = { label: string; onClick: () => void }
export type NotifyToast = { level: FeedLevel; kind?: string; title: string; body?: string; actions?: ToastAction[]; id?: string }

function NotificationToast({ id, n }: { id: string | number; n: NotifyToast }) {
  const close = () => sonner.dismiss(id)
  return (
    <div role="status" className="flex w-[var(--width,356px)] max-w-full gap-3 rounded-xl border bg-popover p-3.5 font-sans text-popover-foreground shadow-pop" data-testid="notification-toast" data-level={n.level}>
      <LevelIcon level={n.level} kind={n.kind} className="mt-px" />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm leading-snug font-semibold">{n.title}</p>
        {n.body && (
          <p className="line-clamp-2 text-[13px] break-words text-muted-foreground">
            <Sensitive length={14}>{n.body}</Sensitive>
          </p>
        )}
        {!!n.actions?.length && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {n.actions.slice(0, 2).map((a, i) => (
              <Button
                key={a.label}
                size="sm"
                variant={i === 0 ? 'default' : 'outline'}
                onClick={() => {
                  close()
                  a.onClick()
                }}
              >
                {a.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={close}
        aria-label={translate(useUI.getState().language, 'notify.dismiss')}
        className="relative -mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

/** Shows the notice (8 s, longer when it needs attention). The same `id` replaces a notice still on screen. */
export function notifyToast(n: NotifyToast) {
  return sonner.custom((id) => <NotificationToast id={id} n={n} />, { id: n.id, duration: n.level === 'error' || n.level === 'warning' ? 12_000 : 8_000, unstyled: true })
}
