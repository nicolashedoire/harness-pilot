// What the server's feed can do. A server with kinds (API.md "Feed") counts by category, posts the session events,
// the health issues and the updates as notifications; an older one has none of that.
import { useFeedSummary } from '@/lib/queries'

/** The server posts its own notifications by kind (health issues, updates, sessions...). */
export function useServerNotifies(): boolean {
  return !!useFeedSummary().data?.categories
}
