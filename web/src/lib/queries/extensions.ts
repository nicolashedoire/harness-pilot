import { useQuery } from '@tanstack/react-query'
import { api, seg } from '../api'
import type { Extension, ExtensionAccess, ExtFixPreview, Ok, Session } from '../types'
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
/** Allow (always), Refuse (deny) or ask again (reset) what an extension declares it uses; once = its HTML widget frame
 *  may reach the declared sites for one load (`grant`). */
export function useExtensionConsent() {
  return useMut(
    ({ id, decision }: { id: string; decision: 'always' | 'once' | 'deny' | 'reset' }) =>
      api.post<Ok & { access: ExtensionAccess; grant?: string }>(`/api/extensions/${seg(id)}/consent`, { decision }),
    { invalidate: [qk.extensions, qk.dashboard.all] },
  )
}
/** "Ask for a fix": `dry_run` previews the message and its destination; otherwise it is sent -> the session. */
export const previewExtensionFix = (id: string, error?: { message: string; stack?: string }) =>
  api.post<ExtFixPreview>(`/api/extensions/${seg(id)}/fix`, { error, dry_run: true })
export function useAskExtensionFix() {
  return useMut(
    ({ id, error }: { id: string; error?: { message: string; stack?: string } }) =>
      api.post<{ session: Session; reused: boolean }>(`/api/extensions/${seg(id)}/fix`, { error }),
    { invalidate: [qk.extensions] },
  )
}
export function useReloadExtensions() {
  return useMut(() => api.post<Ok>('/api/extensions/reload'), { invalidate: [qk.extensions, qk.dashboard.all] })
}
