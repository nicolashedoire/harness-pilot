import { useT } from '@/i18n'
import { Button } from '@/components/ui'
import { CodexConnect } from '@/features/codex/CodexConnect'
import { useCodexStatus } from '@/features/codex/CodexStatus'
import { SettingsCard, SectionStack } from './ui'

export function CodexSection() {
  const t = useT()
  const q = useCodexStatus()
  return (
    <SectionStack>
      <SettingsCard title={t('codex.connection')} description={t('codex.connectionDesc')} actions={<Button variant="outline" size="sm" onClick={() => void q.refetch()} loading={q.isFetching}>{t('common.refresh')}</Button>}>
        <CodexConnect />
      </SettingsCard>
      <SettingsCard title={t('codex.capabilities')} description={t('codex.capabilitiesDesc')}>
        <p className="text-sm text-muted-foreground">{t('codex.limits')}</p>
      </SettingsCard>
    </SectionStack>
  )
}
