import { useT } from '@/i18n'
import { Skeleton } from '@/components/ui'
import { Callout } from '@/features/common'
import { useVoice } from '@/features/voice/api'
import { ApiEngine, EngineChoice, LocalEngine, RecordTest, VoiceOptions } from '@/features/voice/VoiceSetup'
import { SettingsCard, SectionStack } from './ui'

export function VoiceSection() {
  const t = useT()
  const { data: s } = useVoice()
  if (!s) return <Skeleton className="h-72 rounded-xl" />
  const engine = s.settings.engine
  return (
    <SectionStack>
      <SettingsCard title={t('vset.engine')} description={t('vset.engineDesc')}>
        <EngineChoice status={s} />
        {!s.ffmpeg && engine !== 'off' && (
          <Callout tone="error" className="mt-4" title={t('vset.noFfmpeg')}>
            <code>apt-get install -y ffmpeg</code>
          </Callout>
        )}
      </SettingsCard>
      {engine === 'local' && (
        <SettingsCard title={t('vset.engine.local')} description={t('vset.localDesc')}>
          <LocalEngine status={s} />
        </SettingsCard>
      )}
      {(engine === 'groq' || engine === 'openai') && (
        <SettingsCard title={t(`vset.engine.${engine}`)} description={t('vset.apiDesc')}>
          <ApiEngine status={s} engine={engine} />
        </SettingsCard>
      )}
      {engine !== 'off' && (
        <>
          <SettingsCard title={t('vset.options')}>
            <VoiceOptions status={s} />
          </SettingsCard>
          <SettingsCard title={t('vset.test')} description={t('vset.testDesc')}>
            <RecordTest status={s} />
          </SettingsCard>
        </>
      )}
    </SectionStack>
  )
}
