// React Query hooks of /api/blocks. The key lives under ['extensions', …]: the `extensions` bus topic (a block
// extension added, changed or toggled, a built-in turned on or off) refreshes it with the other extension data.
import { useQuery } from '@tanstack/react-query'
import { api, seg } from '@/lib/api'
import { useMut } from '@/lib/queries/util'
import type { Ok } from '@/lib/types'
import type { BlockPlugin, BlocksCatalog } from './types'

export const BLOCKS_KEY = ['extensions', 'blocks'] as const

export const blocksQuery = () => ({ queryKey: BLOCKS_KEY, queryFn: () => api.get<BlocksCatalog>('/api/blocks'), staleTime: 60_000 })

export function useBlocks() {
  return useQuery(blocksQuery())
}

export function useToggleBlock() {
  return useMut(({ id, enabled }: { id: string; enabled: boolean }) => api.patch<Ok & { plugin: BlockPlugin }>(`/api/blocks/${seg(id)}`, { enabled }), {
    optimistic: ({ id, enabled }) => [
      {
        key: BLOCKS_KEY,
        update: (c: BlocksCatalog) => {
          const plugins = c.plugins.map((p) => (p.id === id ? { ...p, enabled } : p))
          const types = plugins.filter((p) => p.enabled && !p.error).flatMap((p) => p.renders)
          return { ...c, plugins, agents: { ...c.agents, types, count: types.length } }
        },
      },
    ],
    invalidate: [BLOCKS_KEY, ['extensions']],
  })
}

export type ConsentDecision = 'always' | 'once' | 'deny' | 'reset'
export function useBlockConsent() {
  return useMut(({ id, decision }: { id: string; decision: ConsentDecision }) =>
    api.post<Ok & { consent: BlockPlugin['consent']; grant?: string }>(`/api/blocks/${seg(id)}/consent`, { decision }),
    { invalidate: [BLOCKS_KEY] },
  )
}

export function usePinBlock() {
  return useMut(({ type, data, title }: { type: string; data: unknown; title?: string }) => api.post<Ok & { id: string }>('/api/blocks/pin', { type, data, title }), {
    invalidate: [['extensions'], ['dashboard']],
  })
}
