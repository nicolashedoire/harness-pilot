import { Shield, ShieldAlert } from 'lucide-react'
import type { Extension } from '@/lib/types'
import { usePageRuntime } from '@/lib/queries/extensions'
import { useT } from '@/i18n'
import { Button, confirm } from '@/components/ui'

/** Owner-controlled migration. An installed API 1 page keeps compatibility until explicitly switched. */
export function PageIsolation({ ext }: { ext: Extension }) {
  const t = useT()
  const save = usePageRuntime()
  if (ext.type !== 'page') return null
  const isolated = ext.runtime?.page === 'frame'
  const Icon = isolated ? Shield : ShieldAlert
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-[13px]" data-testid="page-isolation">
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    <div className="min-w-48 flex-1">
      <p className="font-medium">{t(isolated ? 'ext.isolation.frame' : 'ext.isolation.trusted')}</p>
      <p className="text-muted-foreground">{t(isolated ? 'ext.isolation.frameHint' : 'ext.isolation.trustedHint')}</p>
    </div>
    <Button variant="outline" size="sm" loading={save.isPending} onClick={async () => {
      if (isolated && !await confirm({ title: t('ext.isolation.trusted'), description: t('ext.isolation.confirm'), confirmText: t('ext.isolation.compatibility') })) return
      save.mutate({ id: ext.id, page_runtime: isolated ? 'trusted' : 'frame' })
    }}>{t(isolated ? 'ext.isolation.compatibility' : 'ext.isolation.enable')}</Button>
  </div>
}
