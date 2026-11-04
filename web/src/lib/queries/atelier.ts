// The Atelier (API.md#atelier): the creations of the agents, their drafts and versions. Live: the bus topic `atelier`
// refreshes every key below (keys.ts BUS_KEYS).
import { useQuery } from '@tanstack/react-query'
import { api, seg } from '../api'
import type { AtelierItem, AtelierList, Extension, Ok } from '../types'
import { qk } from './keys'
import { useMut } from './util'

export const atelierQuery = () => ({ queryKey: qk.atelier.list, queryFn: () => api.get<AtelierList>('/api/atelier') })
/** Every creation of every kind: drafts first, then what is broken, then the newest changes (the server's order). */
export function useAtelier() {
  return useQuery(atelierQuery())
}

/** An extension turned on or off from the Atelier (`PATCH /api/extensions/{id}`): the row changes at once. */
export function useToggleCreation() {
  const flip = (it: AtelierItem, enabled: boolean): AtelierItem => ({
    ...it,
    state: enabled ? (it.error ? 'error' : 'active') : 'disabled',
    actions: [...it.actions.filter((a) => a !== 'enable' && a !== 'disable'), enabled ? 'disable' : 'enable'],
  })
  return useMut(({ id, enabled }: { id: string; enabled: boolean }) => api.patch<Ok>(`/api/extensions/${seg(id)}`, { enabled }), {
    optimistic: ({ id, enabled }) => [
      { key: qk.atelier.list, update: (l: AtelierList) => ({ ...l, items: l.items.map((x) => (x.kind === 'extension' && x.id === id ? flip(x, enabled) : x)) }) },
      { key: qk.extensions, update: (l: Extension[]) => l.map((x) => (x.id === id ? { ...x, enabled } : x)) },
    ],
    invalidate: [qk.atelier.all, qk.extensions, qk.dashboard.all],
  })
}
