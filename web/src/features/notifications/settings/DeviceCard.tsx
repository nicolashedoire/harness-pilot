// Settings -> Notifications -> "On this device": what the browser allows, a test, push notifications while the app
// is closed (when the server and the browser can), the sounds (set, volume, listen), pulsing badges, Team messages.
// Everything here is stored per browser.
import * as React from 'react'
import { BellRing, Check, Volume2 } from 'lucide-react'
import { browserRequest } from '@/lib/browser-request'
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
import { ownSubscription, pushReady, pushSupported, subscribeBrowser, unsubscribeBrowser } from '../push'
import { pushSources } from '../prefs'
import { previewSounds, soundEnabled } from '../sound'
import { notifyToast } from '../toast'

function PermissionBadge({ perm, onAsk, busy, disabled }: { perm: Permission; onAsk: () => void; busy: boolean; disabled: boolean }) {
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
    <Button variant="outline" size="sm" onClick={onAsk} loading={busy} disabled={disabled}>
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
  const [waiting, setWaiting] = React.useState(false)
  const pending = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => { const old = pending.current; pending.current = null; old?.abort() }, [])
  React.useEffect(() => {
    let current: AbortController | null = null
    const check = () => {
      current?.abort()
      const next = new AbortController()
      current = next
      void pushReady(next.signal).then((value) => {
        if (!next.signal.aborted) setReady(value)
      }, () => {})
    }
    check()
    window.addEventListener('focus', check)
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', check)
    return () => {
      current?.abort()
      window.removeEventListener('focus', check)
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('controllerchange', check)
    }
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
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setWaiting(on)
    try {
      if (on) {
        if (!info?.public_key) return
        const body = await subscribeBrowser(info.public_key, pushSources(feedSettings), controller.signal)
        controller.signal.throwIfAborted()
        setWaiting(false)
        await subscribe.mutateAsync(body)
        setNotify({ pushOn: true })
      } else {
        const own = await ownSubscription(info)
        await unsubscribeBrowser()
        if (own) await del.mutateAsync(own.id)
        setNotify({ pushOn: false })
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // API errors are shown by the mutation already
      if (!(e instanceof ApiError)) toast.error(t('nset.pushFailed'), (e as Error).message === 'denied' ? t('notify.blockedDesc') : (e as Error).message === 'browser_timeout' ? t('nset.browserRequestTimeout') : errorMessage(e))
      if (on) setNotify({ pushOn: false })
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); setWaiting(false) }
    }
  }
  return { info, on: pushOn, reason, busy, waiting, cancel: () => pending.current?.abort(), toggle, ready }
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
          className="h-5 w-28 cursor-pointer accent-action disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11"
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
  const [allowBusy, setAllowBusy] = React.useState(false)
  const allowPending = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => { const old = allowPending.current; allowPending.current = null; old?.abort() }, [])
  const push = usePush()
  const test = useTestPush()
  const badgePulse = useUI((s) => s.badgePulse)
  const notifyTeam = useUI((s) => s.notifyTeam)
  const setNotify = useUI((s) => s.setNotify)
  const { data: settings } = useSettings()

  const allow = async () => {
    if (allowPending.current) return
    const controller = new AbortController()
    allowPending.current = controller
    setAllowBusy(true)
    try {
      const p = await browserRequest(ask, { signal: controller.signal })
      if (p === 'denied') toast.error(t('notify.blocked'), t('notify.blockedDesc'))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(t('nset.permissionFailed'), (e as Error).message === 'browser_timeout' ? t('nset.browserRequestTimeout') : errorMessage(e))
    } finally {
      if (allowPending.current === controller) { allowPending.current = null; setAllowBusy(false) }
    }
  }
  const sendTest = async () => {
    const own = push.on ? await ownSubscription(push.info) : null
    if (own) return test.mutate(own.id, { onSuccess: () => toast.success(t('nset.testSent')) })
    previewSounds(useUI.getState().soundSet, useUI.getState().soundVolume, ['success'])
    if (!showSystemNotification(t('notify.doneTitle'), t('nset.device.testBody'), undefined, 'mx-test', soundEnabled()))
      notifyToast({ level: 'success', title: t('notify.doneTitle'), body: t('nset.device.testBody') })
  }

  return (
    <SettingsCard
      title={t('nset.device')}
      description={t('nset.deviceDesc')}
      actions={
        <>
          <PermissionBadge perm={perm} onAsk={() => void allow()} busy={allowBusy} disabled={push.busy} />
          {allowBusy && (
            <Button variant="outline" size="sm" onClick={() => allowPending.current?.abort()}>
              {t('common.cancel')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void sendTest()} loading={test.isPending}>
            <BellRing /> {t('nset.test')}
          </Button>
        </>
      }
    >
      {(allowBusy || push.waiting) && (
        <Callout tone="info" className="mb-4" title={t('nset.browserRequestWaiting')}>
          {t('nset.browserRequestHint')}
        </Callout>
      )}
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
          <span className="flex flex-wrap items-center gap-2">
            {push.waiting && (
              <Button variant="outline" size="sm" onClick={push.cancel}>
                {t('common.cancel')}
              </Button>
            )}
            <Switch
              id="mx-push"
              checked={push.on}
              disabled={!!push.reason || push.busy || allowBusy || !push.info || push.ready === null}
              onCheckedChange={(v) => void push.toggle(v)}
            />
          </span>
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
          {t('nset.device.unsupported')}
        </Callout>
      )}
    </SettingsCard>
  )
}
