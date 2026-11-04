import { useQuery } from '@tanstack/react-query'
import { api, seg } from '../api'
import type { Extension, ExtensionAccess, Ok } from '../types'
import { qk } from './keys'
import { useMut } from './util'

export const extensionsQuery = () => ({ queryKey: qk.extensions, queryFn: () => api.get<Extension[]>('/api/extensions') })
export function useExtensions() {
  return useQuery(extensionsQuery())
}
export function useToggleExtension() {
  return useMut(({ id, enabled }: { id: string; enabled: boolean }) => api.patch<Ok>(`/api/extensions/${seg(id)}`, { enabled }), {
    optimistic: ({ id, enabled }) => [{ key: qk.extensions, update: (l: Extension[]) => l.map((x) => (x.id === id ? { ...x, enabled } : x)) }],
    invalidate: [qk.extensions, qk.dashboard.all],
  })
}
export function usePinExtension() {
  return useMut(({ id, pinned }: { id: string; pinned: boolean }) => api.patch<Ok>(`/api/extensions/${seg(id)}`, { pinned }), {
    optimistic: ({ id, pinned }) => [{ key: qk.extensions, update: (l: Extension[]) => l.map((x) => (x.id === id ? { ...x, pinned } : x)) }],
    invalidate: [qk.extensions],
  })
}
export function useClearExtensionErrors() {
  return useMut((id: string) => api.del<Ok>(`/api/extensions/${seg(id)}/errors`), {
    optimistic: (id) => [{ key: qk.extensions, update: (l: Extension[]) => l.map((x) => (x.id === id ? { ...x, runtime_errors: [] } : x)) }],
    invalidate: [qk.extensions],
  })
}
/** Allow (always), Refuse (deny) or ask again (reset) what an extension declares it uses. */
export function useExtensionConsent() {
  return useMut(
    ({ id, decision }: { id: string; decision: 'always' | 'deny' | 'reset' }) =>
      api.post<Ok & { access: ExtensionAccess }>(`/api/extensions/${seg(id)}/consent`, { decision }),
    { invalidate: [qk.extensions, qk.dashboard.all] },
  )
}
export function useReloadExtensions() {
  return useMut(() => api.post<Ok>('/api/extensions/reload'), { invalidate: [qk.extensions, qk.dashboard.all] })
}
