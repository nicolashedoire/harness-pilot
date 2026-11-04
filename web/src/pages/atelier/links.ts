// Where the Atelier sends the user.
import type { AtelierItem } from '@/lib/types'

/** The topic of the product's own work (seeded by `pilot init`): new creations are asked for there. */
export const HARNESS_TOPIC = 'projects/system/topics/harness'

/** A new session in the harness topic, its composer filled with `prompt` (the user completes it and sends). */
export const createHref = (prompt: string) => `/sessions?new=1&path=${encodeURIComponent(HARNESS_TOPIC)}&prompt=${encodeURIComponent(prompt)}`

/** The validation screen of a creation waiting for the user, else its detail page. */
export const itemHref = (it: Pick<AtelierItem, 'kind' | 'id' | 'state' | 'draft_id'>) =>
  it.state === 'draft' || it.draft_id ? `/atelier/drafts/${encodeURIComponent(it.draft_id ?? it.id)}` : `/atelier/${it.kind}/${encodeURIComponent(it.id)}`
