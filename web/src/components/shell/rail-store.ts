// The sidebar as an icon rail on the Sessions page: conversations get the width. The rail can be unfolded there (the
// fold button, ⌘\), remembered apart from the sidebar's own fold on the other pages.
import * as React from 'react'
import { useLocation } from 'react-router'
import { create } from 'zustand'
import { store } from '@/lib/utils'
import { useUI } from '@/stores/ui'

const KEY = 'mx-rail-sessions-open'

export const useRail = create<{ sessionsOpen: boolean; setSessionsOpen: (open: boolean) => void }>((set) => ({
  sessionsOpen: store.get(KEY) === '1',
  setSessionsOpen: (sessionsOpen) => {
    store.set(KEY, sessionsOpen ? '1' : '0')
    set({ sessionsOpen })
  },
}))

/** Pages shown with the rail (folded sidebar) by default. */
export const isRailRoute = (path: string) => path === '/sessions' || path.startsWith('/sessions/')

/** Folded state of the sidebar for the page on screen, and the toggle that goes with it. */
export function useSidebarFold() {
  const { pathname } = useLocation()
  const rail = isRailRoute(pathname)
  const userCollapsed = useUI((s) => s.sidebarCollapsed)
  const toggleUser = useUI((s) => s.toggleSidebar)
  const sessionsOpen = useRail((s) => s.sessionsOpen)
  const toggle = React.useCallback(() => {
    if (!rail) return toggleUser()
    const st = useRail.getState()
    st.setSessionsOpen(!st.sessionsOpen)
  }, [rail, toggleUser])
  return { collapsed: rail ? !sessionsOpen : userCollapsed, toggle, rail }
}
