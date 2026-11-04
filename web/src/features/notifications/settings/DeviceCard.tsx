// Settings -> Notifications -> "On this device": what the browser allows, a test, push notifications while the app
// is closed (when the server and the browser can), the sounds (set, volume, listen), pulsing badges, Team messages.
// Everything here is stored per browser.
import * as React from 'react'
import { BellRing, Check, Volume2 } from 'lucide-react'
import { ApiError, errorMessage } from '@/lib/api'
import { useDeletePush, useFeedSettings, usePushInfo, useSettings, useSubscribePush, useTestPush } from '@/lib/queries'
import { useUI, type SoundSet } from '@/stores/ui'
import { useT } from '@/i18n'
import { isIOS, isStandalone } from '@/pwa'
import { Badge, Button, CountBadge, Select, Switch, toast } from '@/components/ui'
import { Callout, SettingRow } from '@/features/common'
import { SettingsCard } from '@/pages/settings/sections/ui'
import { showSystemNotification } from '@/features/notify/useDoneNotifier'
import { usePermission, type Permission } from '../permission'
import { currentSubscription, ownSubscription, pushReady, pushSupported, subscribeBrowser, unsubscribeBrowser } from '../push'
import { pushSources } from '../prefs'
import { previewSounds, soundEnabled } from '../sound'
import { notifyToast } from '../toast'

function PermissionBadge({ perm, onAsk }: { perm: Permission; onAsk: () => void }) {
  const t = useT()
  if (perm === 'granted')
    return (
      <Badge variant="success" className="h-6 rounded-full px-2.5">
        <Check /> {t('nset.perm.granted')}
      </Badge>
    )
  if (perm === 'denied')
    return (
      <Badge variant="destructive" className="h-6 rounded-full px-2.5">
        {t('nset.perm.denied')}
      </Badge>
    )
  if (perm === 'unsupported')
    return (
      <Badge variant="muted" className="h-6 rounded-full px-2.5">
        {t('nset.perm.unsupported')}
      </Badge>
    )
  return (
    <Button variant="outline" size="sm" onClick={onAsk}>
      {t('nset.allow')}
    </Button>
  )
}

/** Push in this browser: can it be turned on, is it on, and the switch. */
function usePush() {
  const t = useT()
  const pushOn = useUI((s) => s.pushOn)
  const setNotify = useUI((s) => s.setNotify)
  const { data: info } = usePushInfo(pushSupported())
  const { data: feedSettings } = useFeedSettings()
  const subscribe = useSubscribePush()
  const del = useDeletePush()
  const [ready, setReady] = React.useState<boolean | null>(null)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    void pushReady().then(setReady)
  }, [])
  // the switch follows the browser's real subscription (cleared site data, another tab)
  React.useEffect(() => {
    if (!info || !ready) return
    void ownSubscription(info).then((own) => {
      if (!!own !== useUI.getState().pushOn) setNotify({ pushOn: !!own })
    })
  }, [info, ready, setNotify])

  const reason = !pushSupported() || (isIOS() && !isStandalone()) ? 'ios' : ready === false ? 'origin' : info && (!info.available || !info.public_key) ? 'server' : null
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) {
        if (!info?.public_key) return
        const body = await subscribeBrowser(info.public_key, pushSources(feedSettings))
        await subscribe.mutateAsync(body)
        setNotify({ pushOn: true })
      } else {
        const own = await ownSubscription(info)
        await unsubscribeBrowser()
        if (own) await del.mutateAsync(own.id)
        setNotify({ pushOn: false })
      }
    } catch (e) {
      // API errors are shown by the mutation already
      if (!(e instanceof ApiError)) toast.error(t('nset.pushFailed'), (e as Error).message === 'denied' ? t('notify.blockedDesc') : errorMessage(e))
      if (on && !(await currentSubscription())) setNotify({ pushOn: false })
    } finally {
      setBusy(false)
    }
  }
  return { info, on: pushOn, reason, busy, toggle, ready }
}

function SoundControls() {
  const t = useT()
  const soundSet = useUI((s) => s.soundSet)
  const volume = useUI((s) => s.soundVolume)
  const setNotify = useUI((s) => s.setNotify)
  const [v, setV] = React.useState(Math.round(volume * 100))
  React.useEffect(() => setV(Math.round(volume * 100)), [volume])
  const commit = () => {
    setNotify({ soundVolume: v / 100 })
    previewSounds(soundSet, v / 100, ['success'])
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        id="mx-sound-set"
        value={soundSet}
        onValueChange={(s) => {
          setNotify({ soundSet: s as SoundSet })
          previewSounds(s as SoundSet, volume, ['success'])
        }}
        options={(['chime', 'soft', 'none'] as const).map((s) => ({ value: s, label: t(`nset.soundSet.${s}`) }))}
        className="w-36"
      />
      <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
        {t('nset.volume')}
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={v}
          disabled={soundSet === 'none'}
          onChange={(e) => setV(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={() => v / 100 !== volume && setNotify({ soundVolume: v / 100 })}
          aria-label={t('nset.volumeLabel')}
          className="h-5 w-28 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11"
        />
      </label>
      <Button variant="outline" size="sm" disabled={soundSet === 'none' || v === 0} onClick={() => previewSounds(soundSet, v / 100)}>
        <Volume2 /> {t('nset.listen')}
      </Button>
    </div>
  )
}

export function DeviceCard() {
  const t = useT()
  const [perm, ask] = usePermission()
  const push = usePush()
  const test = useTestPush()
  const badgePulse = useUI((s) => s.badgePulse)
  const notifyTeam = useUI((s) => s.notifyTeam)
  const setNotify = useUI((s) => s.setNotify)
  const { data: settings } = useSettings()

  const allow = async () => {
    const p = await ask()
    if (p === 'denied') toast.error(t('notify.blocked'), t('notify.blockedDesc'))
  }
  const sendTest = async () => {
    const own = push.on ? await ownSubscription(push.info) : null
    if (own) return test.mutate(own.id, { onSuccess: () => toast.success(t('nset.testSent')) })
    previewSounds(useUI.getState().soundSet, useUI.getState().soundVolume, ['success'])
    if (!showSystemNotification(t('notify.doneTitle'), t('notify.testBody'), undefined, 'mx-test', soundEnabled()))
      notifyToast({ level: 'success', title: t('notify.doneTitle'), body: t('notify.testBody') })
  }

  return (
    <SettingsCard
      title={t('nset.device')}
      description={t('nset.deviceDesc')}
      actions={
        <>
          <PermissionBadge perm={perm} onAsk={() => void allow()} />
          <Button variant="outline" size="sm" onClick={() => void sendTest()} loading={test.isPending}>
            <BellRing /> {t('nset.test')}
          </Button>
        </>
      }
    >
      <div className="divide-y">
        <SettingRow
          label={t('nset.push')}
          description={
            <>
              {t('nset.pushDesc')}
              {push.reason && <span className="mt-1 block text-warning">{t(push.reason === 'ios' ? 'nset.pushIos' : push.reason === 'origin' ? 'nset.pushOrigin' : 'nset.pushServer')}</span>}
            </>
          }
          htmlFor="mx-push"
        >
          <Switch id="mx-push" checked={push.on} disabled={!!push.reason || push.busy || !push.info || push.ready === null} onCheckedChange={(v) => void push.toggle(v)} />
        </SettingRow>
        <SettingRow label={t('nset.sound')} description={t('nset.soundHint')} htmlFor="mx-sound-set" className="items-start">
          <SoundControls />
        </SettingRow>
        <SettingRow label={t('nset.pulse')} description={t('nset.pulseDesc')} htmlFor="mx-badge-pulse">
          <span className="flex items-center gap-3">
            <CountBadge count={1} tone="attention" />
            <Switch id="mx-badge-pulse" checked={badgePulse} onCheckedChange={(v) => setNotify({ badgePulse: v })} />
          </span>
        </SettingRow>
        {settings?.team_page && (
          <SettingRow label={t('nset.team')} description={t('team.notifySettingDesc')} htmlFor="mx-notify-team">
            <Switch
              id="mx-notify-team"
              checked={notifyTeam}
              onCheckedChange={async (v) => {
                setNotify({ notifyTeam: v })
                if (v && perm === 'default') await ask()
              }}
            />
          </SettingRow>
        )}
      </div>
      {perm === 'denied' && (
        <Callout tone="warning" className="mt-4">
          {t('notify.blockedDesc')}
        </Callout>
      )}
      {perm === 'unsupported' && (
        <Callout tone="info" className="mt-4">
          {t('notify.unsupported')}
        </Callout>
      )}
    </SettingsCard>
  )
}
