import * as React from 'react'
import { useT } from '@/i18n'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { Button, Input, Label, Skeleton, Switch } from '@/components/ui'
import { SettingRow } from '@/features/common'
import { SettingsCard, SectionStack } from './ui'

export function SupportSection() {
  const t = useT()
  const { data: settings } = useSettings()
  const save = useSaveSettings()
  const [url, setUrl] = React.useState('')
  React.useEffect(() => { if (settings) setUrl(settings.donation_url || '') }, [settings?.donation_url])
  if (!settings) return <Skeleton className="h-56 rounded-xl" />
  return (
    <SectionStack>
      <SettingsCard title={t('donation.setupTitle')} description={t('donation.setupDesc')}>
        <div className="grid max-w-xl gap-3">
          <p className="text-sm text-muted-foreground">{t('donation.setupHelp')}</p>
          <Label htmlFor="donation-url">{t('donation.setupLabel')}</Label>
          <Input id="donation-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://paypal.me/..." />
          <div><Button size="sm" disabled={save.isPending || url.trim() === (settings.donation_url || '')} onClick={() => save.mutate({ donation_url: url.trim() })}>{t('donation.setupSave')}</Button></div>
          <p className="text-xs text-muted-foreground">{t('donation.setupVerify')}</p>
        </div>
      </SettingsCard>
      <SettingsCard>
        <SettingRow label={t('donation.hide')} description={t('donation.hideDesc')} htmlFor="donation-hidden">
          <Switch id="donation-hidden" checked={!!settings.donation_hidden} onCheckedChange={(v) => save.mutate({ donation_hidden: v })} />
        </SettingRow>
      </SettingsCard>
    </SectionStack>
  )
}
