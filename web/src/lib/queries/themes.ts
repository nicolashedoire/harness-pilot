import { useQuery } from '@tanstack/react-query'
import { api, seg } from '../api'
import type { Theme } from '../theme'
import type { Ok } from '../types'
import { qk } from './keys'
import { useMut } from './util'
import type { TeamMessage } from './team'

// Saved themes ("My themes", Settings -> Appearance) and the theme a session wrote (the theme generator):
// docs/dev/API.md "Settings & secrets". Every theme here is validated by the server (themes.clean_theme) and again
// by the browser (normalizeTheme) before it is previewed or applied.
export type ThemeSource = 'created' | 'imported' | 'received' | 'custom'
export type SavedTheme = { id: string; theme: Theme; source: ThemeSource; from: string; saved: number; session?: string }
export type SessionTheme = { theme: Theme; file: string; at: number }

export function useSavedThemes(enabled = true) {
  return useQuery({ queryKey: qk.themes, queryFn: () => api.get<{ themes: SavedTheme[]; max: number }>('/api/settings/themes'), enabled })
}
export function useSaveTheme() {
  return useMut((b: { theme: Theme; source: ThemeSource; from?: string; session?: string }) => api.post<SavedTheme>('/api/settings/themes', b), { invalidate: [qk.themes] })
}
export function useRenameTheme() {
  return useMut(({ id, name }: { id: string; name: string }) => api.patch<SavedTheme>(`/api/settings/themes/${seg(id)}`, { name }), {
    optimistic: ({ id, name }) => [
      { key: qk.themes, update: (d: { themes: SavedTheme[] }) => ({ ...d, themes: d.themes.map((e) => (e.id === id ? { ...e, theme: { ...e.theme, name } } : e)) }) },
    ],
    invalidate: [qk.themes],
  })
}
export function useDeleteTheme() {
  return useMut((id: string) => api.del<Ok>(`/api/settings/themes/${seg(id)}`), {
    optimistic: (id) => [{ key: qk.themes, update: (d: { themes: SavedTheme[] }) => ({ ...d, themes: d.themes.filter((e) => e.id !== id) }) }],
    invalidate: [qk.themes],
  })
}
/** The newest theme file the session wrote after `since` (404 no_theme while there is none). */
export const fetchSessionTheme = (sid: string, since?: number | null) =>
  api.get<SessionTheme>(`/api/settings/themes/session/${seg(sid)}`, since ? { since } : undefined)
/** A theme to a Team chat (a card with Install at the other end). */
export function useTeamSendTheme() {
  return useMut(({ cid, theme }: { cid: string; theme: Theme }) => api.post<TeamMessage>(`/api/team/chats/${seg(cid)}/themes`, { theme }), { invalidate: [['team']] })
}
