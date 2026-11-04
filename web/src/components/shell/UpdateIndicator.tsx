import { RefreshCw } from 'lucide-react'
import { applyUpdate, usePWA } from '@/pwa'
import { useT } from '@/i18n'
import { Tooltip } from '@/components/ui'
import { cn } from '@/lib/utils'

/** The web app was rebuilt on the server: a reload takes the new version. (A server update is a notification,
 *  `update.available`, in the notifications centre.) */
export function useReloadPending(): boolean {
  return !!usePWA((s) => s.waiting)
}

const row =
  'flex h-8 w-full items-center gap-3 rounded-md px-2.5 text-[12.5px] font-medium text-primary outline-none pointer-coarse:h-10 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring'

/** One discreet line above the health indicator - nothing at all when the page runs the latest build. */
export function UpdateIndicator({ collapsed }: { collapsed?: boolean }) {
  const t = useT()
  if (!useReloadPending()) return null
  const label = t('shell.updateReload')
  return (
    <Tooltip content={collapsed ? label : null} side="right">
      <button type="button" onClick={applyUpdate} className={cn(row, collapsed && 'justify-center px-0')} aria-label={label}>
        <span className="flex size-4 items-center justify-center">
          <RefreshCw className="size-3.5" />
        </span>
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    </Tooltip>
  )
}
