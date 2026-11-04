// Where the Atelier sends the user (API.md#atelier "App routes the server links to").
import type { AtelierItem } from '@/lib/types'

/** The topic of the product's own work (seeded by `pilot init`): new creations are asked for there. */
export const HARNESS_TOPIC = 'projects/system/topics/harness'

/** A new session in `path` (the harness topic by default), its composer filled with `prompt`: the user completes it
 *  and sends. */
export const newSessionHref = (prompt: string, path: string = HARNESS_TOPIC) => `/sessions?new=1&path=${encodeURIComponent(path)}&prompt=${encodeURIComponent(prompt)}`

/** The validation screen of a draft. */
export const draftHref = (draft: string) => `/atelier/drafts/${encodeURIComponent(draft)}`

/** The validation screen when a draft waits for the user, else the creation's detail page. */
export const itemHref = (it: Pick<AtelierItem, 'kind' | 'id' | 'pending'>) =>
  it.pending ? draftHref(it.pending.draft) : `/atelier/${it.kind}/${encodeURIComponent(it.id)}`

/** Where the creation lives in the app (`href`); an extension page answers at /x/<id> (/ext/<id> serves its files). */
export const liveHref = (it: Pick<AtelierItem, 'href'>) => (it.href ? it.href.replace(/^\/ext\/([^/?#]+)\/?$/, '/x/$1') : null)
