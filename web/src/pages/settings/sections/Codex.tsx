import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import { api } from '@/lib/api'
import { Button, Skeleton } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'

type Status = { installed: boolean; authenticated: boolean | null; reason: string | null }

export function CodexSection() {
  const t = useT()
  const q = useQuery({ queryKey: ['codex-status'], queryFn: () => api.get<Status>('/api/system/codex'), staleTime: 10_000 })
  return (
    <SectionStack>
      <SettingsCard title={t('codex.connection')} description={t('codex.connectionDesc')} actions={<Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>{t('common.refresh')}</Button>}>
        {q.isPending ? <Skeleton className="h-12" /> : q.isError || q.data?.authenticated === null ? (
          <p role="status" className="text-sm">{t('codex.unknown')}</p>
        ) : q.data?.authenticated ? (
          <p role="status" className="text-sm text-success">{t('codex.connected')}</p>
        ) : (
          <div className="grid gap-2 text-sm"><p role="status">{q.data?.installed ? t('codex.notConnected') : t('codex.notInstalled')}</p><p>{t('codex.loginHint')} <code>codex login</code></p></div>
        )}
      </SettingsCard>
      <SettingsCard title={t('codex.capabilities')} description={t('codex.capabilitiesDesc')}>
        <p className="text-sm text-muted-foreground">{t('codex.limits')}</p>
      </SettingsCard>
    </SectionStack>
  )
}
