// The Atelier (API.md "Atelier"): the creations of the agents, their drafts and versions. Live: the bus topic
// `atelier` refreshes every key below (keys.ts BUS_KEYS).
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import type { AtelierList } from '../types'
import { qk } from './keys'

export const atelierQuery = () => ({ queryKey: qk.atelier.list, queryFn: () => api.get<AtelierList>('/api/atelier') })
/** Every creation, drafts first (the list page). */
export function useAtelier() {
  return useQuery(atelierQuery())
}
