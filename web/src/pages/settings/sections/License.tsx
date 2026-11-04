import { ExternalLink } from 'lucide-react'
import { useT } from '@/i18n'
import { Button } from '@/components/ui'
import { SettingsCard, SectionStack } from './ui'

export function LicenseSection() {
  const t = useT()
  return (
    <SectionStack>
      <SettingsCard title={t('license.mitTitle')} description={t('license.mitDesc')} actions={
        <Button variant="outline" size="sm" asChild>
          <a href="https://github.com/nicolashedoire/harness-pilot/blob/main/LICENSE" target="_blank" rel="noreferrer">
            {t('license.read')} <ExternalLink />
          </a>
        </Button>
      }>
        <p className="text-sm text-muted-foreground">{t('license.thirdParty')}</p>
      </SettingsCard>
    </SectionStack>
  )
}
