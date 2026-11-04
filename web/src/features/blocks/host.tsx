// How a block reaches the conversation it is shown in. Light on purpose (no renderer code): the conversation view
// may import it eagerly.
//
// Hook for the conversation view (pages/sessions): wrap each thread in
//   <BlockHostProvider value={{ sessionId, send?, openPanel?, agent? }}>
// - sessionId: where forms, checklists, "Ask for a fix" and plugin `maxxing.send()` answers go;
// - send(text): optional, replaces POST /api/sessions/{id}/messages (e.g. to show the message as pending at once);
//   resolves to false when it failed and the view already said why (a thrown error is shown by the block);
// - openPanel(req): optional, shows "Open beside" in the view's own side panel instead of the blocks' drawer;
// - agent: "Claude Code" / "Codex", named in "Your answers are sent to … as a reply".
// Without a provider a block finds its session from the nearest `[data-mx-session]` element, then from the URL
// (`/sessions?session=<id>`, `/sessions/<id>`), and every "Open beside" also fires a `mx-block-open` window event
// (detail: BlockPanelRequest) the view can listen to.
import * as React from 'react'

export type BlockPanelRequest = { type: string; title: string; data: Record<string, unknown>; raw: string }

export type BlockHost = {
  sessionId?: string | null
  send?: (text: string) => Promise<void | boolean>
  openPanel?: (req: BlockPanelRequest) => void
  agent?: string
}

const Ctx = React.createContext<BlockHost | null>(null)

export function BlockHostProvider({ value, children }: { value: BlockHost; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useBlockHost = () => React.useContext(Ctx)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The session a block belongs to: host → `[data-mx-session]` → URL. */
export function resolveSessionId(el: Element | null | undefined, host: BlockHost | null): string | null {
  if (host?.sessionId) return host.sessionId
  const own = el?.closest<HTMLElement>('[data-mx-session]')?.dataset.mxSession
  if (own && UUID.test(own)) return own
  if (typeof window === 'undefined') return null
  const q = new URLSearchParams(window.location.search).get('session')
  if (q && UUID.test(q)) return q
  const m = /\/sessions\/(?:[^/]+\/)?([0-9a-f-]{36})(?:[/?#]|$)/i.exec(window.location.pathname)
  return m && UUID.test(m[1]) ? m[1] : null
}

export const BLOCK_OPEN_EVENT = 'mx-block-open'
