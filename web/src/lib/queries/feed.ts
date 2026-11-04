import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query'
import { api, ApiError, withQuery } from '../api'
import { categoryOf, isPending } from '../feed'
import type {
  FeedAction,
  FeedCategory,
  FeedDetail,
  FeedEvent,
  FeedHook,
  FeedHookKind,
  FeedList,
  FeedSettings,
  FeedSettingsBody,
  FeedSummary,
  PushInfo,
  PushPrefs,
  PushSubscribeBody,
  PushSubscriptionInfo,
} from '../types'
import { qk } from './keys'
import { useMut } from './util'

const inv = [qk.feed.all] as const

/** The filters of a list. An older server ignores `category` / `pending`: the list is filtered here too. */
export type FeedFilter = { category?: FeedCategory | null; pending?: boolean; unread?: boolean }

/** 404 / 405 / 422 on a route an older server does not have (e.g. `GET /api/feed/summary` hits `/api/feed/{id}`). */
const missingRoute = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 422)

const keep = (f: FeedFilter) => (e: FeedEvent) => (!f.category || categoryOf(e) === f.category) && (!f.pending || isPending(e)) && (!f.unread || !e.read)
const feedUrl = (f: FeedFilter, limit: number, before?: number) =>
  withQuery('/api/feed', { category: f.category || undefined, pending: f.pending || undefined, unread: f.unread || undefined, limit, before: before || undefined })
const filtered = (l: FeedList, f: FeedFilter): FeedList => ({ ...l, events: l.events.filter(keep(f)) })

export const feedQuery = (f: FeedFilter = {}, limit = 30) => ({
  queryKey: qk.feed.list(f.category ?? null, !!f.pending, !!f.unread, limit),
  queryFn: async () => filtered(await api.get<FeedList>(feedUrl(f, limit)), f),
})
/** Latest events (centre, dashboard card, the notifier). Live: the bus topic "feed" refreshes it; the slow interval
 *  only catches read marks made elsewhere (Telegram buttons). */
export function useFeed(f: FeedFilter = {}, limit = 30, enabled = true) {
  return useQuery({ ...feedQuery(f, limit), refetchInterval: 5 * 60_000, enabled })
}

type FeedPage = FeedList & { cursor: number }
export const feedPagesQuery = (f: FeedFilter = {}) => ({
  queryKey: qk.feed.pages(f.category ?? null, !!f.pending, !!f.unread),
  initialPageParam: 0,
  queryFn: async ({ pageParam }: { pageParam: number }): Promise<FeedPage> => {
    const l = await api.get<FeedList>(feedUrl(f, 50, pageParam))
    // the cursor is the last id the server sent, before the filtering done here
    return { ...filtered(l, f), cursor: l.events.length ? l.events[l.events.length - 1].id : 0 }
  },
  getNextPageParam: (last: FeedPage) => (last.more && last.cursor ? last.cursor : undefined),
})
/** Every event, page by page (the Notifications page). */
export function useFeedPages(f: FeedFilter = {}) {
  return useInfiniteQuery(feedPagesQuery(f))
}

export const feedSummaryQuery = () => ({
  queryKey: qk.feed.summary,
  queryFn: async (): Promise<FeedSummary> => {
    try {
      const s = await api.get<FeedSummary>('/api/feed/summary')
      return { ...s, pending: s.pending ?? 0 }
    } catch (e) {
      if (!missingRoute(e)) throw e
      const l = await api.get<FeedList>(withQuery('/api/feed', { limit: 100 }))
      return { unread: l.unread, pending: l.events.filter(isPending).length }
    }
  },
})
/** Counts for the badges (sidebar entry, touch menu, dashboard card). */
export function useFeedSummary() {
  return useQuery({ ...feedSummaryQuery(), refetchInterval: 5 * 60_000 })
}

/** One event with its folded occurrences; `null` when the server has no such route (older version). */
export function useFeedEvent(id: number | null, enabled = true) {
  return useQuery({
    queryKey: qk.feed.one(id ?? 0),
    enabled: id != null && enabled,
    retry: false,
    queryFn: async (): Promise<FeedDetail | null> => {
      try {
        return (await api.get<{ event: FeedDetail }>(`/api/feed/${id}`)).event
      } catch (e) {
        if (missingRoute(e)) return null
        throw e
      }
    },
  })
}

/** Optimistic patch of every cached list / page / detail: the `hit` events become `change(e)`. */
function patchFeed(hit: (e: FeedEvent) => boolean, change: (e: FeedEvent) => FeedEvent) {
  const list = <L extends FeedList>(l: L): L => {
    let unread = 0
    let pending = 0
    const events = l.events.map((e) => {
      if (!hit(e)) return e
      const n = change(e)
      unread += Number(!e.read) - Number(!n.read)
      pending += Number(isPending(e)) - Number(isPending(n))
      return n
    })
    return { ...l, events, unread: Math.max(0, l.unread - unread), pending: l.pending == null ? l.pending : Math.max(0, l.pending - pending) }
  }
  return [
    { key: ['feed', 'list'], update: list },
    { key: ['feed', 'pages'], update: (d: InfiniteData<FeedPage>) => ({ ...d, pages: d.pages.map(list) }) },
    { key: ['feed', 'one'], update: (e: FeedDetail | null) => (e && hit(e) ? { ...e, ...change(e) } : e) },
  ]
}
const asRead = (e: FeedEvent): FeedEvent => ({ ...e, read: true, pending: false })

export function useMarkFeedRead() {
  return useMut((b: { ids?: number[]; source?: string; all?: boolean }) => api.post<{ unread: number; pending?: number }>('/api/feed/read', b), {
    // Shown as read at once; the refetch (invalidate) brings the server's counts.
    optimistic: ({ ids, source, all }) => [
      ...patchFeed((e) => !e.read && (!!all || (source ? e.source === source : !!ids?.includes(e.id))), asRead),
      ...(all ? [{ key: qk.feed.summary, update: (s: FeedSummary) => ({ ...s, unread: 0, pending: 0 }) }] : []),
    ],
    invalidate: inv,
    errorToast: false,
  })
}
/** Out of "To handle" by hand (the read state stays). Needs a server with kinds. */
export function useResolveFeed() {
  return useMut((ids: number[]) => api.post<{ pending: number }>('/api/feed/resolve', { ids }), {
    optimistic: (ids) => patchFeed((e) => ids.includes(e.id), (e) => ({ ...e, pending: false, resolved_at: e.resolved_at || Date.now() / 1000 })),
    invalidate: inv,
  })
}
export function useDeleteFeedEvent() {
  return useMut((id: number) => api.del<{ ok: boolean }>(`/api/feed/${id}`), { invalidate: inv })
}
/** A `post` action of an event (re-run a cron, resume a discussion). */
export function useRunFeedAction() {
  return useMut((action: FeedAction) => api.post<unknown>(action.url), { invalidate: [qk.feed.all, qk.crons.all, qk.sessions.all] })
}

export function useFeedSettings(enabled = true) {
  return useQuery({ queryKey: qk.feed.settings, queryFn: () => api.get<FeedSettings>('/api/feed/settings'), enabled })
}
export function useSaveFeedSettings() {
  return useMut((b: FeedSettingsBody) => api.put<FeedSettings>('/api/feed/settings', b), {
    optimistic: (b) => [
      {
        key: qk.feed.settings,
        update: (f: FeedSettings) => ({
          ...f,
          telegram: b.telegram ?? f.telegram,
          sources: f.sources.map((x) => (b.rules?.[x.source] ? { ...x, rule: b.rules[x.source] } : x)),
          kind_rules: f.kind_rules && b.kind_rules ? { ...f.kind_rules, ...b.kind_rules } : f.kind_rules,
          event_kinds: f.event_kinds?.map((k) => (b.kind_rules?.[k.kind] ? { ...k, rule: b.kind_rules[k.kind] } : k)),
        }),
      },
    ],
    invalidate: inv,
  })
}
export function useCreateHook() {
  return useMut((b: { name: string; kind: FeedHookKind; secret?: string }) => api.post<FeedHook>('/api/feed/hooks', b), { invalidate: inv })
}
export function usePatchHook() {
  return useMut(({ id, ...b }: { id: string; secret?: string; regenerate?: boolean }) => api.patch<FeedHook>(`/api/feed/hooks/${encodeURIComponent(id)}`, b), { invalidate: inv })
}
export function useDeleteHook() {
  return useMut((id: string) => api.del<{ ok: boolean }>(`/api/feed/hooks/${encodeURIComponent(id)}`), { invalidate: inv })
}
export function useTestHook() {
  return useMut((id: string) => api.post<{ event: FeedEvent | null }>(`/api/feed/hooks/${encodeURIComponent(id)}/test`), { invalidate: inv })
}

/* ---------------------------------------------------------------- Web Push (API.md "Web Push") */
const NO_PUSH: PushInfo = { available: false, public_key: null, subscriptions: [], missing: true }
export const pushInfoQuery = () => ({
  queryKey: qk.push,
  queryFn: async (): Promise<PushInfo> => {
    try {
      return await api.get<PushInfo>('/api/push')
    } catch (e) {
      if (missingRoute(e)) return NO_PUSH
      throw e
    }
  },
})
export function usePushInfo(enabled = true) {
  return useQuery({ ...pushInfoQuery(), enabled })
}
export function useSubscribePush() {
  return useMut((b: PushSubscribeBody) => api.post<PushSubscriptionInfo>('/api/push/subscriptions', b), { invalidate: [qk.push] })
}
export function usePatchPush() {
  return useMut(({ id, ...b }: { id: string; label?: string; prefs?: PushPrefs }) => api.patch<PushSubscriptionInfo>(`/api/push/subscriptions/${encodeURIComponent(id)}`, b), {
    invalidate: [qk.push],
    errorToast: false,
  })
}
export function useDeletePush() {
  return useMut((id: string) => api.del<{ ok: boolean }>(`/api/push/subscriptions/${encodeURIComponent(id)}`), { invalidate: [qk.push] })
}
export function useTestPush() {
  return useMut((id: string) => api.post<{ ok: boolean; status: number }>(`/api/push/subscriptions/${encodeURIComponent(id)}/test`), { invalidate: [qk.push] })
}
