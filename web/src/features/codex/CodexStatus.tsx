// The Codex CLI of this server (GET /api/system/codex): installed, signed in and how. Read by Settings -> Codex and the
// wizard's Codex step (through CodexConnect), the cron editor and the new-session form.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type CodexMethod = 'chatgpt' | 'api_key'
export type CodexState = { installed: boolean; authenticated: boolean | null; reason: string | null; method?: CodexMethod | null }

export function useCodexStatus() {
  return useQuery({ queryKey: ['codex-status'], queryFn: () => api.get<CodexState>('/api/system/codex'), staleTime: 10_000 })
}
