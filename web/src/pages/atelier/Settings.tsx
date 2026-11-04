// The Atelier's settings (GET / PUT /api/atelier/settings, config `atelier`), in a side sheet opened from the Studio's
// header (?settings=1; a bottom sheet on a phone): turning on by themselves the proposals that declare no network and
// no secret (off by default), and how long versions are kept.
import * as React from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { useAtelierSettings, useSaveAtelierSettings } from '@/lib/queries'
import { errorMessage } from '@/lib/api'
import { useT } from '@/i18n'
import { Button, EmptyState, FormField, Input, Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton, Switch } from '@/components/ui'
import { SettingRow } from '@/features/common'

const LIMITS = { keep_days: [1, 3650], keep_versions: [1, 100] } as const

export function SettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT()
  const q = useAtelierSettings()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('atelier.settings.title')}</SheetTitle>
          <SheetDescription>{t('atelier.settings.desc')}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {q.isPending ? (
            <div className="grid gap-4" aria-busy>
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-40 rounded-lg" />
            </div>
          ) : q.isError || !q.data ? (
            <EmptyState
              compact
              tone="error"
              icon={TriangleAlert}
              title={t('atelier.settings.failed')}
              description={errorMessage(q.error)}
              action={
                <Button variant="outline" size="sm" loading={q.isFetching} onClick={() => q.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <SettingsForm keepDays={q.data.keep_days} keepVersions={q.data.keep_versions} auto={q.data.auto_activate_safe} />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}

function SettingsForm({ auto, keepDays, keepVersions }: { auto: boolean; keepDays: number; keepVersions: number }) {
  const t = useT()
  const toggle = useSaveAtelierSettings()
  const save = useSaveAtelierSettings({ inline: true })
  const [days, setDays] = React.useState(String(keepDays))
  const [versions, setVersions] = React.useState(String(keepVersions))
  // the server's values when they change elsewhere (another device: bus topic `atelier`)
  React.useEffect(() => setDays(String(keepDays)), [keepDays])
  React.useEffect(() => setVersions(String(keepVersions)), [keepVersions])
  const check = (v: string, [lo, hi]: readonly [number, number]) => (/^\d+$/.test(v) && +v >= lo && +v <= hi ? null : t('atelier.settings.range', { min: lo, max: hi }))
  const daysErr = check(days, LIMITS.keep_days)
  const versionsErr = check(versions, LIMITS.keep_versions)
  const dirty = days !== String(keepDays) || versions !== String(keepVersions)
  return (
    <div className="grid gap-6">
      <section className="grid gap-3" aria-labelledby="atelier-auto-title">
        <SettingRow htmlFor="atelier-auto" label={<span id="atelier-auto-title">{t('atelier.settings.auto')}</span>} description={t('atelier.settings.autoDesc')}>
          <Switch id="atelier-auto" checked={auto} onCheckedChange={(v) => toggle.mutate({ auto_activate_safe: v })} />
        </SettingRow>
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t('atelier.settings.autoNote')}
        </p>
      </section>

      <form
        className="grid gap-4 border-t pt-5"
        aria-labelledby="atelier-keep-title"
        onSubmit={(e) => {
          e.preventDefault()
          if (daysErr || versionsErr || !dirty) return
          save.mutate({ keep_days: +days, keep_versions: +versions })
        }}
      >
        <div className="grid gap-1">
          <h3 id="atelier-keep-title" className="text-sm font-medium">
            {t('atelier.settings.keep')}
          </h3>
          <p className="text-[13px] text-muted-foreground">{t('atelier.settings.keepDesc')}</p>
        </div>
        <div className="grid gap-3">
          <FormField label={t('atelier.settings.days')} error={daysErr ?? undefined}>
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.trim())} className="max-w-40" />
          </FormField>
          <FormField label={t('atelier.settings.versions')} error={versionsErr ?? undefined}>
            <Input inputMode="numeric" value={versions} onChange={(e) => setVersions(e.target.value.trim())} className="max-w-40" />
          </FormField>
        </div>
        {save.error && <p className="text-[13px] text-destructive">{errorMessage(save.error)}</p>}
        <div className="flex justify-end gap-2">
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDays(String(keepDays))
                setVersions(String(keepVersions))
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={!dirty || !!daysErr || !!versionsErr} loading={save.isPending}>
            {t('atelier.settings.save')}
          </Button>
        </div>
      </form>
    </div>
  )
}
