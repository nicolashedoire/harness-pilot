// The Atelier (API.md#atelier): the creations of the agents, their drafts and versions. Live: the bus topic `atelier`
// refreshes every key below (keys.ts BUS_KEYS).
import { useQuery } from '@tanstack/react-query'
import { api, seg } from '../api'
import type { AtelierDecision, AtelierDraft, AtelierDraftDetail, AtelierItem, AtelierItemDetail, AtelierList, AtelierPreview, AtelierSettings, AtelierVersionDiff, Extension, Ok, Session } from '../types'
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

export const atelierDraftQuery = (id: string) => ({
  queryKey: qk.atelier.draft(id),
  queryFn: () => api.get<AtelierDraftDetail>(`/api/atelier/drafts/${seg(id)}`),
})
/** A draft with its files (diff against the active version), whether it went stale, and what can be previewed. */
export function useAtelierDraft(id: string) {
  return useQuery(atelierDraftQuery(id))
}

/** Runs the draft (the user opened its validation screen to review it: API.md "Live preview"). Never retried, never
 *  refetched on its own: only `refetch()` (the Refresh button) runs it again. */
export function useDraftPreview(id: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.atelier.preview(id),
    queryFn: () => api.post<AtelierPreview>(`/api/atelier/drafts/${seg(id)}/preview`),
    enabled,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/** Approve: `base` = the active version the user reviewed the diff against (`409 stale` when another one is active now). */
export function useApproveDraft() {
  return useMut(({ id, base }: { id: string; base: number | null }) => api.post<AtelierDecision>(`/api/atelier/drafts/${seg(id)}/approve`, { base }), {
    invalidate: [qk.atelier.all, qk.extensions, qk.dashboard.all, qk.feed.all],
    errorToast: false,
  })
}

/** Refuse: the draft's files go to the trash. */
export function useRejectDraft() {
  return useMut(({ id, reason }: { id: string; reason?: string }) => api.post<{ ok: boolean; draft: AtelierDraft; trash_id: string }>(`/api/atelier/drafts/${seg(id)}/reject`, reason ? { reason } : {}), {
    invalidate: [qk.atelier.all, qk.trash, qk.feed.all],
  })
}

/** Ask the agent for a change: sent to the session the draft came from (or a new one in its topic). */
export function useRequestDraftChange() {
  return useMut(
    ({ id, message }: { id: string; message: string }) =>
      api.post<{ ok: boolean; session: Session; created: boolean; queued: boolean }>(`/api/atelier/drafts/${seg(id)}/request-change`, { message }),
    { invalidate: [qk.atelier.all, qk.sessions.all], errorToast: false },
  )
}

export const atelierItemQuery = (kind: string, id: string) => ({
  queryKey: qk.atelier.item(kind, id),
  queryFn: () => api.get<AtelierItemDetail>(`/api/atelier/${seg(kind)}/${seg(id)}`),
})
/** One creation with its versions, history, drafts, files, permissions and health. */
export function useAtelierItem(kind: string, id: string) {
  return useQuery(atelierItemQuery(kind, id))
}

/** What version `n` changed (against the version before it). */
export function useAtelierVersion(kind: string, id: string, n: number | null) {
  return useQuery({
    queryKey: qk.atelier.version(kind, id, n ?? 0),
    queryFn: () => api.get<AtelierVersionDiff>(`/api/atelier/${seg(kind)}/${seg(id)}/versions/${n}`),
    enabled: n != null,
    staleTime: Infinity,
  })
}

/** The drafts, the decided ones too with `all` (kept 30 days): the History of the list. */
export function useAtelierDrafts(status: 'pending' | 'all', enabled = true) {
  return useQuery({ queryKey: qk.atelier.drafts(status), queryFn: () => api.get<{ drafts: AtelierDraft[] }>('/api/atelier/drafts', { status }), enabled })
}

/** Make a kept version active again (its files replace the extension's, no new version). */
export function useRollback() {
  return useMut(({ kind, id, version }: { kind: string; id: string; version: number }) => api.post<AtelierDecision>(`/api/atelier/${seg(kind)}/${seg(id)}/rollback`, { version }), {
    invalidate: [qk.atelier.all, qk.extensions, qk.dashboard.all],
  })
}

/** Accept files changed outside the Atelier as a new version. */
export function useAcceptChanges() {
  return useMut(({ kind, id }: { kind: string; id: string }) => api.post<AtelierDecision>(`/api/atelier/${seg(kind)}/${seg(id)}/accept`), {
    invalidate: [qk.atelier.all],
  })
}

/** Retention and auto-activation (config `atelier`). */
export function useAtelierSettings() {
  return useQuery({ queryKey: qk.atelier.settings, queryFn: () => api.get<AtelierSettings>('/api/atelier/settings'), staleTime: 5 * 60_000 })
}
