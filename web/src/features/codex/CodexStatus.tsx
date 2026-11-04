// The Codex CLI of this server (GET /api/system/codex): installed, signed in, how to sign in. Shown by
// Settings -> Codex and by the wizard's Codex step.
import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import { api } from '@/lib/api'
import { Skeleton } from '@/components/ui'

export type CodexState = { installed: boolean; authenticated: boolean | null; reason: string | null }

export function useCodexStatus() {
  return useQuery({ queryKey: ['codex-status'], queryFn: () => api.get<CodexState>('/api/system/codex'), staleTime: 10_000 })
}

export function CodexStatus() {
  const t = useT()
  const q = useCodexStatus()
  if (q.isPending) return <Skeleton className="h-12" />
  if (q.isError || q.data?.authenticated === null) return <p role="status" className="text-sm">{t('codex.unknown')}</p>
  if (q.data?.authenticated) return <p role="status" className="text-sm text-success">{t('codex.connected')}</p>
  return (
    <div className="grid gap-2 text-sm">
      <p role="status">{q.data?.installed ? t('codex.notConnected') : t('codex.notInstalled')}</p>
      <p>
        {t('codex.loginHint')} <code>codex login</code>
      </p>
    </div>
  )
}
