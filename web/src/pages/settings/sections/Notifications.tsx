// Settings -> Notifications: this device (permission, test, push, sounds, badges), what goes where (browser, sound,
// Telegram per kind of event), the external sources (webhooks, scripts). Built in features/notifications/settings.
import { SectionStack } from './ui'
import { DeviceCard } from '@/features/notifications/settings/DeviceCard'
import { MatrixCard } from '@/features/notifications/settings/MatrixCard'
import { SourcesCard } from '@/features/notifications/settings/SourcesCard'

export function NotificationsSection() {
  return (
    <SectionStack>
      <DeviceCard />
      <MatrixCard />
      <SourcesCard />
    </SectionStack>
  )
}
