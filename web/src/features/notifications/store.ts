// Open state of the notifications centre (desktop panel next to the sidebar). Its own file: the centre is a lazy
// chunk, the sidebar entry only needs this.
import * as React from 'react'
import { create } from 'zustand'
import { useNavigate } from 'react-router'
import { isCompact } from '@/stores/media'

export const useNotificationCenter = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** Desktop: opens (or closes) the centre. Touch layout: the Notifications page (the centre is a desktop panel). */
export function useOpenNotifications() {
  const navigate = useNavigate()
  return React.useCallback(
    (toggle = false) => {
      if (isCompact()) return navigate('/notifications')
      const { open, setOpen } = useNotificationCenter.getState()
      setOpen(toggle ? !open : true)
    },
    [navigate],
  )
}
