// Settings -> Notifications -> "What and where": one row per kind of event (grouped Sessions / Crons / System,
// then one row per webhook or script), three columns: Browser (this browser's notices and push), Sound (does it
// ring here), Telegram (No / Silent / With sound / Default) with the global Telegram switch.
// Telegram per kind needs a server with kinds (`kind_rules`); an older one sets it per source (the rows of one
// source then share their value, the session rows have none).
import * as React from 'react'
import { useFeedSettings, useSaveFeedSettings, useSettings } from '@/lib/queries'
import type { EventKind, FeedHookKind, FeedRule, FeedSettings, FeedSource } from '@/lib/types'
import { useUI } from '@/stores/ui'
import { categoryOf } from '@/lib/feed'
import { useT, type TFn, type TKey } from '@/i18n'
import { Badge, Checkbox, Select, Sensitive, Skeleton, Switch } from '@/components/ui'
import { SettingsCard } from '@/pages/settings/sections/ui'
import { PREF_ROWS, rowOn, rowSound, rowSource, sourceKey, sourceSoundDefault, type PrefRow } from '../prefs'

const RULES: FeedRule[] = ['off', 'silent', 'loud']
const SERVICE: Record<FeedHookKind, string> = { stripe: 'Stripe', shopify: 'Shopify', github: 'GitHub', generic: 'JSON' }

function ruleOptions(t: TFn, auto: string) {
  return [{ value: 'auto', label: auto }, ...RULES.map((r) => ({ value: r, label: t(`nset.tg.${r}`) }))]
}
const autoLabel = (t: TFn, def: Exclude<FeedRule, 'auto'> | null) => (def ? t('nset.tg.autoIs', { rule: t(`nset.tg.${def}`) }) : t('nset.tg.auto'))

/** The Telegram cell of a built-in row: its kinds' common rule, or (older server) its source's rule. */
function useRowTelegram(data: FeedSettings | undefined) {
  const save = useSaveFeedSettings()
  const byKind = React.useMemo(() => new Map((data?.event_kinds ?? []).map((k) => [k.kind, k])), [data?.event_kinds])
  const perKind = !!data?.event_kinds
  return (r: PrefRow): { value: FeedRule; auto: Exclude<FeedRule, 'auto'> | null; set: (v: FeedRule) => void } | null => {
    if (perKind) {
      const kinds = r.kinds.map((k) => byKind.get(k)).filter((k): k is EventKind => !!k)
      if (!kinds.length) return null
      const first = kinds[0]
      return {
        value: kinds.every((k) => k.rule === first.rule) ? first.rule : 'auto',
        auto: kinds.every((k) => k.default === first.default) ? first.default : null,
        set: (v) => save.mutate({ kind_rules: Object.fromEntries(kinds.map((k) => [k.kind, v])) }),
      }
    }
    const src = data?.sources.find((s) => s.source === rowSource(r))
    if (!src) return null
    return { value: src.rule, auto: src.own_thread ? 'off' : null, set: (v) => save.mutate({ rules: { [src.source]: v } }) }
  }
}

function GroupHead({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <th scope="rowgroup" colSpan={4} className="border-t pt-4 pb-1.5 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {children}
      </th>
    </tr>
  )
}

function Row({
  label,
  name,
  hint,
  browser,
  sound,
  onBrowser,
  onSound,
  telegram,
  telegramOff,
}: {
  label: React.ReactNode
  /** The event's name for the controls' labels. */
  name: string
  hint?: string
  browser: boolean
  sound: boolean
  onBrowser: (v: boolean) => void
  onSound: (v: boolean) => void
  telegram: { value: FeedRule; options: { value: string; label: string }[]; set: (v: FeedRule) => void } | null
  telegramOff: boolean
}) {
  const t = useT()
  const muted = useUI((s) => s.soundSet === 'none')
  return (
    <tr className="align-middle">
      <td className="py-2 pr-2">
        {label} {hint && <span className="text-muted-foreground">{hint}</span>}
      </td>
      <td className="p-2">
        <Checkbox checked={browser} onCheckedChange={(v) => onBrowser(v === true)} aria-label={t('nset.browserLabel', { event: name })} />
      </td>
      <td className="p-2">
        <Checkbox
          checked={browser && sound && !muted}
          disabled={!browser || muted}
          onCheckedChange={(v) => onSound(v === true)}
          aria-label={t('nset.soundLabel', { event: name })}
          title={muted ? t('nset.soundOff') : undefined}
        />
      </td>
      <td className="py-1.5 pl-2">
        {telegram ? (
          <Select value={telegram.value} onValueChange={(v) => telegram.set(v as FeedRule)} options={telegram.options} disabled={telegramOff} aria-label={t('nset.telegramLabel', { event: name })} className="h-8" />
        ) : (
          <span className="px-3 text-muted-foreground">–</span>
        )}
      </td>
    </tr>
  )
}

export function MatrixCard() {
  const t = useT()
  const { data, isPending } = useFeedSettings()
  const { data: settings } = useSettings()
  const save = useSaveFeedSettings()
  const prefs = useUI((s) => s.notifyPrefs)
  const sounds = useUI((s) => s.soundPrefs)
  const setPrefs = useUI((s) => s.setNotifyPrefs)
  const setSounds = useUI((s) => s.setSoundPrefs)
  const rowTelegram = useRowTelegram(data)
  const telegramOff = !data?.telegram
  const all = (r: PrefRow, v: boolean) => Object.fromEntries(r.kinds.map((k) => [k, v]))
  // the infra rows only when that page is on (its events come from it)
  const rows = PREF_ROWS.filter((r) => r.id !== 'infra' || settings?.infra_page)
  // webhooks and scripts (a built-in source of the server, e.g. infra, belongs to the System rows)
  const external: FeedSource[] = (data?.sources ?? []).filter((s) => !s.builtin && categoryOf({ source: s.source }) === 'webhooks')
  const hookKind = (name: string) => data?.hooks.find((h) => h.name === name)?.kind

  const builtin = (cat: PrefRow['category']) =>
    rows
      .filter((r) => r.category === cat)
      .map((r) => {
        const tg = rowTelegram(r)
        return (
          <Row
            key={r.id}
            label={t(`nset.row.${r.id}` as TKey)}
            name={t(`nset.row.${r.id}` as TKey)}
            hint={r.hint ? t(`nset.row.${r.id}Hint` as TKey) : undefined}
            browser={rowOn(prefs, r)}
            sound={rowSound(sounds, r)}
            onBrowser={(v) => setPrefs(all(r, v))}
            onSound={(v) => setSounds(all(r, v))}
            telegram={tg && { value: tg.value, set: tg.set, options: ruleOptions(t, autoLabel(t, tg.auto)) }}
            telegramOff={telegramOff}
          />
        )
      })

  return (
    <SettingsCard
      title={t('nset.what')}
      description={t('nset.whatDesc')}
      actions={
        <label className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
          <Switch checked={data?.telegram ?? true} disabled={!data} onCheckedChange={(v) => save.mutate({ telegram: v })} aria-label={t('nset.telegramOn')} />
          {t('nset.telegramOn')}
        </label>
      }
    >
      {isPending || !data ? (
        <div className="grid gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : (
        <>
          <div className="-mx-[var(--pad-card)] overflow-x-auto px-[var(--pad-card)]">
            <table className="w-full min-w-[540px] border-collapse text-[13px]" data-testid="notification-matrix">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2 pr-2 font-medium">
                    {t('nset.col.event')}
                  </th>
                  <th scope="col" className="w-24 p-2 font-medium">
                    {t('nset.col.browser')}
                  </th>
                  <th scope="col" className="w-16 p-2 font-medium">
                    {t('nset.col.sound')}
                  </th>
                  <th scope="col" className="w-48 py-2 pl-2 font-medium">
                    {t('nset.col.telegram')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <GroupHead>{t('nset.group.sessions')}</GroupHead>
                {builtin('sessions')}
                <GroupHead>{t('nset.group.crons')}</GroupHead>
                {builtin('crons')}
                <GroupHead>{t('nset.group.system')}</GroupHead>
                {builtin('system')}
                <GroupHead>{t('nset.group.webhooks')}</GroupHead>
                {external.length ? (
                  external.map((s) => {
                    const kind = hookKind(s.source)
                    const key = sourceKey(s.source)
                    return (
                      <Row
                        key={s.source}
                        label={
                          <span className="inline-flex items-center gap-2">
                            <Sensitive length={8}>{s.label}</Sensitive>
                            <Badge variant="muted">{kind ? SERVICE[kind] : t('feed.script')}</Badge>
                          </span>
                        }
                        name={s.label}
                        browser={prefs[key] ?? true}
                        sound={sounds[key] ?? sourceSoundDefault(kind)}
                        onBrowser={(v) => setPrefs({ [key]: v })}
                        onSound={(v) => setSounds({ [key]: v })}
                        telegram={{ value: s.rule, set: (v) => save.mutate({ rules: { [s.source]: v } }), options: ruleOptions(t, autoLabel(t, s.own_thread ? 'off' : null)) }}
                        telegramOff={telegramOff}
                      />
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={4} className="py-2 text-muted-foreground">
                      {t('nset.noScripts')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('nset.browserHint')}</p>
          {!data.event_kinds && <p className="mt-1 text-xs text-muted-foreground">{t('nset.telegramOld')}</p>}
        </>
      )}
    </SettingsCard>
  )
}
