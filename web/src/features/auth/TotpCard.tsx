import * as React from 'react'
import { useTotp, useTotpDisable, useTotpEnable, useTotpSetup } from '@/lib/queries'
import { errorMessage, isApiError } from '@/lib/api'
import { useT, type TFn } from '@/i18n'
import type { TotpSetup } from '@/lib/types'
import { Badge, Button, CodeBlock, CopyButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, SecretInput, toast } from '@/components/ui'
import { QRCode } from '@/components/ui/qr-code'
import { Callout, SettingRow } from '@/features/common'

type Errors = { password?: string; code?: string }

/** Wrong password / wrong code / throttled -> the field to mark. */
function fieldErrors(t: TFn, err: unknown): Errors {
  if (isApiError(err, 'bad_password')) return { password: t('security.currentWrong') }
  if (isApiError(err, 'bad_code')) return { code: t('twofa.badCode') }
  return { code: errorMessage(err) }
}

/** Two-step sign-in with an authenticator app (TOTP): set up with a QR code, recovery codes shown once, turned off
 *  with the password and a code. */
export function TotpCard() {
  const t = useT()
  const { data } = useTotp()
  const setup = useTotpSetup()
  const enable = useTotpEnable()
  const disable = useTotpDisable()
  const [enroll, setEnroll] = React.useState<TotpSetup | null>(null)
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [turnOff, setTurnOff] = React.useState(false)
  const [password, setPassword] = React.useState('')
  const [code, setCode] = React.useState('')
  const [errors, setErrors] = React.useState<Errors>({})
  const reset = () => {
    setPassword('')
    setCode('')
    setErrors({})
  }
  const check = (): boolean => {
    const v: Errors = {}
    if (!password) v.password = t('security.currentRequired')
    if (!code.trim()) v.code = t('totp.codeRequired')
    setErrors(v)
    return !Object.keys(v).length
  }
  const on = !!data?.enabled
  return (
    <>
      <SettingRow
        label={
          <span className="flex items-center gap-2">
            {t('totp.title')} {on && <Badge variant="success">{t('totp.on')}</Badge>}
          </span>
        }
        description={on ? t('totp.onDesc', { count: data?.recovery_left ?? 0 }) : t('totp.desc')}
      >
        {on ? (
          <Button variant="outline" size="sm" onClick={() => (reset(), setTurnOff(true))}>
            {t('totp.turnOff')}
          </Button>
        ) : (
          <Button size="sm" loading={setup.isPending} onClick={() => setup.mutate(undefined, { onSuccess: (s) => (reset(), setEnroll(s)) })}>
            {t('totp.setUp')}
          </Button>
        )}
      </SettingRow>

      <Dialog open={!!enroll} onOpenChange={(o) => !o && setEnroll(null)}>
        <DialogContent className="md:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('totp.setUpTitle')}</DialogTitle>
            <DialogDescription>{t('totp.setUpDesc')}</DialogDescription>
          </DialogHeader>
          {enroll && (
            <form
              className="grid gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault()
                if (!check()) return
                enable.mutate(
                  { password, code: code.replace(/\s/g, '') },
                  {
                    onSuccess: (r) => {
                      setEnroll(null)
                      reset()
                      setCodes(r.recovery_codes)
                    },
                    onError: (err) => (isApiError(err, 'expired') ? (setEnroll(null), toast.error(t('totp.expired'))) : setErrors(fieldErrors(t, err))),
                  },
                )
              }}
            >
              <QRCode value={enroll.uri} label={t('totp.qr')} className="mx-auto size-44" />
              <div className="grid gap-1">
                <p className="text-[13px] text-muted-foreground">{t('totp.manual')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[13px]">{enroll.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                  <CopyButton text={enroll.secret} label={t('totp.copySecret')} />
                </div>
              </div>
              <FormField label={t('totp.code')} error={errors.code}>
                <Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" className="font-mono tracking-widest" autoFocus />
              </FormField>
              <FormField label={t('security.current')} error={errors.password}>
                <SecretInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </FormField>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEnroll(null)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" loading={enable.isPending}>
                  {t('totp.turnOn')}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!codes} onOpenChange={() => undefined}>
        <DialogContent className="md:max-w-md" hideClose>
          <DialogHeader>
            <DialogTitle>{t('totp.recoveryTitle')}</DialogTitle>
            <DialogDescription>{t('totp.recoveryDesc')}</DialogDescription>
          </DialogHeader>
          {codes && <CodeBlock code={codes.join('\n')} />}
          <Callout tone="warning">{t('totp.recoveryOnce')}</Callout>
          <DialogFooter>
            <Button onClick={() => (setCodes(null), toast.success(t('totp.enabled')))}>{t('totp.saved')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={turnOff} onOpenChange={setTurnOff}>
        <DialogContent className="md:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('totp.offTitle')}</DialogTitle>
            <DialogDescription>{t('totp.offDesc')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (!check()) return
              disable.mutate(
                { password, code: code.trim() },
                {
                  onSuccess: () => {
                    setTurnOff(false)
                    reset()
                    toast.success(t('totp.disabled'))
                  },
                  onError: (err) => setErrors(fieldErrors(t, err)),
                },
              )
            }}
          >
            <FormField label={t('totp.codeOrRecovery')} error={errors.code}>
              <Input value={code} onChange={(e) => setCode(e.target.value.slice(0, 24))} autoComplete="one-time-code" placeholder="123456" className="font-mono" autoFocus />
            </FormField>
            <FormField label={t('security.current')} error={errors.password}>
              <SecretInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setTurnOff(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="destructive" loading={disable.isPending}>
                {t('totp.turnOff')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
