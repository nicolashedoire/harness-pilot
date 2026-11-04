import * as React from 'react'
import { Send, Smartphone } from 'lucide-react'
import { pollTwoFactor } from '@/lib/queries'
import { errorMessage, isApiError } from '@/lib/api'
import { useT } from '@/i18n'
import { Button, Checkbox, CodeBlock, FormField, Input, Label, Spinner } from '@/components/ui'
import type { TwoFactorChallenge } from '@/lib/types'

const POLL_MS = 1500
/** A code of the authenticator app (6 digits) or a recovery code (16 letters and digits, dashes and spaces aside). */
const twoStepCode = (raw: string, app: boolean): string | null => {
  const digits = raw.replace(/\s/g, '')
  if (/^\d{6}$/.test(digits)) return digits
  if (app && /^[A-Za-z0-9]{16}$/.test(raw.replace(/[\s-]/g, ''))) return raw.trim()
  return null
}

/** Waits for Allow in Telegram (polling) or a code typed by hand: the code of the Telegram message, or with the
 *  authenticator app a code of the app or a recovery code.
 *  `onDone(null)` = approved; `onDone(message)` = denied / expired / cancelled (message to show, or ''). */
export function TwoFactorWait({ challenge, trustOption = false, onDone }: { challenge: TwoFactorChallenge; trustOption?: boolean; onDone: (error: string | null) => void }) {
  const t = useT()
  const app = !!challenge.methods?.includes('totp')
  const telegram = !challenge.methods || challenge.methods.includes('telegram')
  const [left, setLeft] = React.useState(challenge.expires_in)
  const [code, setCode] = React.useState('')
  const [codeError, setCodeError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [trust, setTrust] = React.useState(true)
  const trustRef = React.useRef(trust)
  trustRef.current = trust
  const done = React.useRef(false)
  const finish = React.useCallback(
    (err: string | null) => {
      if (done.current) return
      done.current = true
      onDone(err)
    },
    [onDone],
  )
  const outcome = React.useCallback(
    (e: unknown) => {
      if (isApiError(e, 'denied')) finish(t('twofa.denied'))
      else if (isApiError(e, 'expired')) finish(t('twofa.expired'))
      else return false
      return true
    },
    [finish, t],
  )

  React.useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const r = await pollTwoFactor(challenge.challenge, undefined, trustRef.current)
        if (r.status === 'approved') return finish(null)
        if (typeof r.expires_in === 'number') setLeft(r.expires_in)
      } catch (e) {
        if (outcome(e)) return
      }
      if (!stop && !done.current) timer = setTimeout(tick, POLL_MS)
    }
    if (telegram) timer = setTimeout(tick, POLL_MS) // nothing to wait for with the app alone
    const clock = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => {
      stop = true
      clearTimeout(timer)
      clearInterval(clock)
    }
  }, [challenge.challenge, finish, outcome, telegram])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const c = twoStepCode(code, app)
    if (!c) return setCodeError(t(app ? 'totp.codeFormat' : 'twofa.codeLength'))
    setChecking(true)
    setCodeError(null)
    try {
      const r = await pollTwoFactor(challenge.challenge, c, trust)
      if (r.status === 'approved') finish(null)
    } catch (err) {
      if (!outcome(err))
        setCodeError(isApiError(err, 'bad_code') ? t('twofa.badCode') : isApiError(err, 'codes_paused') ? t(telegram ? 'twofa.codesPaused' : 'totp.codesPaused') : errorMessage(err))
      setCode('')
    } finally {
      setChecking(false)
    }
  }

  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return (
    <div className="grid gap-5">
      <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
        {app ? <Smartphone className="mt-0.5 size-5 shrink-0 text-primary" /> : <Send className="mt-0.5 size-5 shrink-0 text-primary" />}
        <div className="grid gap-1">
          <p className="font-medium">{t(app ? 'totp.open' : 'twofa.check')}</p>
          <p className="text-[13px] text-muted-foreground">{app ? t(telegram ? 'totp.openBoth' : 'totp.openDesc') : t('twofa.checkDesc')}</p>
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground" aria-live={telegram ? 'polite' : undefined}>
            {telegram ? (
              <>
                <Spinner className="size-3.5" /> {t('twofa.waiting', { time: mm })}
              </>
            ) : (
              t('totp.left', { time: mm })
            )}
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="grid gap-3" noValidate>
        <FormField label={t(app ? 'totp.loginCode' : 'twofa.code')} error={codeError || undefined}>
          <Input
            value={code}
            onChange={(e) => setCode(app ? e.target.value.replace(/[^A-Za-z0-9 -]/g, '').slice(0, 24) : e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
            inputMode={app ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus={app}
            placeholder="123456"
            className="font-mono tracking-widest"
          />
        </FormField>
        {trustOption && (
          <Label className="gap-2 font-normal pointer-coarse:min-h-10">
            <Checkbox checked={trust} onCheckedChange={(v) => setTrust(v === true)} /> {t('twofa.trust')}
          </Label>
        )}
        <div className="flex gap-2">
          <Button type="submit" loading={checking} className="flex-1">
            {t('twofa.verify')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => finish('')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
      <details className="text-[13px] text-muted-foreground">
        <summary className="cursor-pointer list-none text-center hover:text-foreground pointer-coarse:flex pointer-coarse:min-h-10 pointer-coarse:items-center pointer-coarse:justify-center">{t(app ? 'totp.lost' : 'twofa.noAnswer')}</summary>
        <div className="mt-3 grid gap-2">
          <p>{t(app ? 'totp.lostHelp' : 'twofa.noAnswerHelp')}</p>
          <CodeBlock inline code="pilot 2fa off" />
        </div>
      </details>
    </div>
  )
}
