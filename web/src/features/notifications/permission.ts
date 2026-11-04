// The browser's notification permission, live in a component, with a way to ask for it.
import * as React from 'react'
import { notificationsSupported } from '@/features/notify/useDoneNotifier'

export type Permission = NotificationPermission | 'unsupported'

export function usePermission(): [Permission, () => Promise<Permission>] {
  const [perm, setPerm] = React.useState<Permission>(() => (notificationsSupported() ? Notification.permission : 'unsupported'))
  const ask = React.useCallback(async () => {
    if (!notificationsSupported()) return 'unsupported' as const
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    setPerm(p)
    return p
  }, [])
  // changed in the site settings while the page is open
  React.useEffect(() => {
    if (!notificationsSupported()) return
    const sync = () => setPerm(Notification.permission)
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [])
  return [perm, ask]
}
