import { useParams } from 'react-router'
import { Pin, PinOff } from 'lucide-react'
import { useExtensions, usePinExtension } from '@/lib/queries'
import { useT } from '@/i18n'
import { Button, EmptyState, SkeletonText, Tooltip } from '@/components/ui'
import { PageHeader } from '@/components/shell/Page'
import { PageIsolation } from '@/features/extensions/PageIsolation'
import { PageFrame } from '@/features/extensions/PageFrame'
import { AskFixButton } from '@/features/extensions/AskFix'
import LegacyPage from './LegacyPage'

export default function ExtensionPage() {
  const { id = '' } = useParams()
  const t = useT()
  const { data: extensions, isPending } = useExtensions()
  const pin = usePinExtension()
  const ext = extensions?.find((e) => e.id === id)
  if (isPending) return <SkeletonText lines={6} />
  if (!ext || !ext.enabled) return <EmptyState title={t('ext.notFound')} />
  if (ext.error) return <EmptyState tone="error" title={t('ext.loadFailed')} description={ext.error}
    action={<AskFixButton ext={ext} error={{message:ext.error}} />} />
  if (ext.runtime?.page !== 'frame') return <div className="flex min-h-0 flex-1 flex-col"><div className="px-4 pt-4"><PageIsolation ext={ext} /></div><LegacyPage /></div>
  return <div className="flex min-h-0 flex-1 flex-col">
    <PageHeader title={ext.name} actions={<Tooltip content={t(ext.pinned ? 'ext.unpin' : 'ext.pin')}>
      <Button variant="ghost" size="icon-sm" aria-label={t(ext.pinned ? 'ext.unpin' : 'ext.pin')} aria-pressed={!!ext.pinned}
        onClick={() => pin.mutate({id:ext.id,pinned:!ext.pinned})}>{ext.pinned ? <PinOff /> : <Pin />}</Button>
    </Tooltip>} />
    <div className="px-4 py-3 md:px-6"><PageIsolation ext={ext} /></div>
    <PageFrame key={ext.id} ext={ext} />
  </div>
}
