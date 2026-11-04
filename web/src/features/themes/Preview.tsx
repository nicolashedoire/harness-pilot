// Theme previews shared by Settings -> Appearance (palette, import, My themes, the theme generator) and the Team
// chat card: the real components drawn in a theme's tokens, scoped to one element (CSS variables on its style,
// never a <style> built from strings), and the report of normalizeTheme in words.
import * as React from 'react'
import { AlertTriangle, Check, CheckCircle2 } from 'lucide-react'
import { slugify, cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Switch } from '@/components/ui'
import { Checkbox } from '@/components/ui/checkbox'
import { expandTheme, luminance, matchPreset, parseColor, type ContrastIssue, type Mode, type Theme, type ThemeReport, type TokenMap } from '@/lib/theme'

/** The name to show: a preset's translated name, else the theme's own, else "Custom". */
export const themeName = (t: (k: TKey) => string, p: Theme) => (matchPreset(p) ? t(`colors.preset.${matchPreset(p)!.id}` as TKey) : p.name || t('colors.preset.custom'))

/** CSS variables of a token map, for a scoped preview (values are colours: normalizeTheme / deriveTokens). */
export const tokenStyle = (tokens: TokenMap) => Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as React.CSSProperties

/** Mini drawing of a palette: page, a card line, the filled button and an accent dot. */
export function MiniPreview({ tokens, className }: { tokens: TokenMap; className?: string }) {
  return (
    <span aria-hidden className={cn('flex h-16 flex-col justify-between rounded-lg border p-2', className)} style={{ background: tokens.background, borderColor: tokens.border }}>
      <span className="h-2.5 w-[70%] rounded-[3px]" style={{ background: tokens.card, boxShadow: `inset 0 0 0 1px ${tokens.border}` }} />
      <span className="flex items-center gap-1">
        <span className="h-3.5 w-9 rounded-[4px]" style={{ background: tokens.action }} />
        <span className="size-[7px] rounded-full" style={{ background: tokens.primary }} />
      </span>
    </span>
  )
}

export function ContrastStatus({ issues }: { issues: ContrastIssue[] }) {
  const t = useT()
  if (!issues.length)
    return (
      <span className="flex items-center gap-2 text-[13px] text-success" data-testid="contrast-ok">
        <CheckCircle2 className="size-4" /> {t('colors.contrastOk')}
      </span>
    )
  return (
    <details className="text-[13px]" data-testid="contrast-issues">
      <summary className="flex cursor-pointer items-center gap-2 text-warning">
        <AlertTriangle className="size-4" /> {t('colors.contrastIssues', { count: issues.length })}
      </summary>
      <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {issues.map((i) => (
          <li key={`${i.mode}${i.fg}${i.bg}`}>{t('colors.contrastPair', { fg: i.fg, bg: i.bg, mode: t(`theme.${i.mode}` as TKey), ratio: i.ratio, min: i.min })}</li>
        ))}
      </ul>
    </details>
  )
}

/** The fake notification, switches and buttons of a preview (inside an element that carries the tokens). */
function SampleBody({ scope }: { scope: string }) {
  const t = useT()
  const [sound, setSound] = React.useState(true)
  const [done, setDone] = React.useState(true)
  const [mode, setMode] = React.useState<'on' | 'off'>('on')
  return (
    <>
      <div className="flex gap-2.5 rounded-lg border bg-card p-3 text-card-foreground">
        <span aria-hidden className="mt-px size-4 shrink-0 rounded-full border-2 border-destructive" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[13px] font-semibold">{t('colors.previewNotif')}</span>
          <span className="text-xs text-muted-foreground">{t('colors.previewMeta')}</span>
          <span className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" tabIndex={-1}>{t('colors.previewRetry')}</Button>
            <Button size="sm" variant="outline" tabIndex={-1}>{t('colors.previewOpen')}</Button>
          </span>
        </div>
        <span aria-label={t('colors.unread')} className="mt-1.5 size-[7px] shrink-0 rounded-full bg-primary" />
      </div>
      <div className="grid gap-3 rounded-lg border bg-card p-3 text-[13px] text-card-foreground">
        <label className="flex items-center gap-2.5">
          <span className="flex-1">{t('colors.previewSound')}</span>
          <Switch checked={sound} onCheckedChange={setSound} />
        </label>
        <label className="flex items-center gap-2.5">
          <Checkbox checked={done} onCheckedChange={(c) => setDone(!!c)} />
          <span>{t('colors.previewDone')}</span>
        </label>
        <div role="radiogroup" aria-label={t('colors.previewSound')} className="flex flex-wrap gap-4">
          {(['on', 'off'] as const).map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name={`preview-${scope}`} checked={mode === v} onChange={() => setMode(v)} className="size-4" />
              {t(v === 'on' ? 'colors.previewWithSound' : 'colors.previewSilent')}
            </label>
          ))}
        </div>
        <a href="/docs" onClick={(e) => e.preventDefault()} className="w-fit text-primary underline underline-offset-2">
          {t('colors.previewLink')}
        </a>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button tabIndex={-1}>{t('colors.previewNew')}</Button>
        <Button variant="outline" tabIndex={-1}>{t('common.cancel')}</Button>
      </div>
    </>
  )
}

/** The real components in the current palette (or in `tokens`, for a theme not applied yet). */
export function PalettePreview({ tokens, className }: { tokens?: TokenMap; className?: string }) {
  const t = useT()
  const scope = React.useId()
  return (
    <div style={tokens ? tokenStyle(tokens) : undefined} className={cn('grid gap-3 rounded-xl border bg-sidebar p-4 text-foreground [accent-color:var(--action)]', className)} data-testid="palette-preview">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('colors.preview')}</h4>
      <SampleBody scope={scope} />
    </div>
  )
}

/** A bigger preview with the navigation column (the theme generator's proposal). */
export function ThemeSample({ tokens, label, className }: { tokens: TokenMap; label: string; className?: string }) {
  const t = useT()
  const scope = React.useId()
  const nav: [TKey, React.ReactNode][] = [
    ['nav.dashboard', <span key="b" className="ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-destructive/20 px-1 text-[10px] font-semibold text-destructive">2</span>],
    ['nav.sessions', <span key="d" className="ml-auto size-1.5 rounded-full bg-primary" />],
    ['nav.files', null],
    ['nav.settings', null],
  ]
  return (
    <div
      role="group"
      aria-label={label}
      style={tokenStyle(tokens)}
      className={cn('flex min-h-[22rem] overflow-hidden rounded-xl border bg-background text-foreground [accent-color:var(--action)]', className)}
      data-testid="theme-sample"
    >
      <div aria-hidden className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-sidebar-border bg-sidebar px-2 py-3 text-xs max-sm:hidden">
        <span className="flex h-8 items-center px-2 font-semibold">harness-pilot</span>
        {nav.map(([k, extra], i) => (
          <span key={k} className={cn('relative flex h-8 items-center gap-1.5 rounded-md px-2', i === 0 ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}>
            {i === 0 && <span className="absolute top-2 -left-2 h-4 w-[3px] rounded-r bg-primary" />}
            <span className="truncate">{t(k)}</span>
            {extra}
          </span>
        ))}
      </div>
      <div className="grid min-w-0 flex-1 content-start gap-2.5 p-3.5">
        <SampleBody scope={scope} />
      </div>
    </div>
  )
}

const SWATCHES: [keyof TokenMap, TKey][] = [
  ['background', 'themegen.sw.background'],
  ['card', 'themegen.sw.card'],
  ['border', 'themegen.sw.border'],
  ['foreground', 'themegen.sw.text'],
  ['muted-foreground', 'themegen.sw.muted'],
  ['action', 'themegen.sw.action'],
  ['primary', 'themegen.sw.link'],
  ['destructive', 'themegen.sw.error'],
]

/** The 8 colours that make a theme, with their names. */
export function SwatchStrip({ tokens }: { tokens: TokenMap }) {
  const t = useT()
  return (
    <div className="grid grid-cols-4 gap-1.5 text-[11px] text-muted-foreground sm:grid-cols-8">
      {SWATCHES.map(([k, label]) => (
        <span key={k} className="flex min-w-0 flex-col gap-1">
          <span className="h-[22px] rounded-[5px] border" style={{ background: tokens[k] }} title={tokens[k]} />
          <span className="truncate">{t(label)}</span>
        </span>
      ))}
    </div>
  )
}

/** Black or white, in words (the labels normalizeTheme puts on a fill). */
const shade = (t: (k: TKey) => string, colour: string | undefined) => {
  const c = colour ? parseColor(colour) : null
  return t(c && luminance(c) > 0.5 ? 'themegen.white' : 'themegen.black')
}

/** The checks of a theme from anywhere (model, file, code, Team): colours only, contrast, automatic fixes. */
export function ThemeChecks({ report, className }: { report: ThemeReport; className?: string }) {
  const t = useT()
  const ok = (text: React.ReactNode, key: string) => (
    <li key={key} className="flex gap-2">
      <Check className="mt-0.5 size-[15px] shrink-0 text-success" />
      <span>{text}</span>
    </li>
  )
  const warn = (text: React.ReactNode, key: string, extra?: React.ReactNode) => (
    <li key={key} className="flex gap-2">
      <AlertTriangle className="mt-0.5 size-[15px] shrink-0 text-warning" />
      <span className="min-w-0">
        {text}
        {extra}
      </span>
    </li>
  )
  return (
    <ul className={cn('grid gap-2.5 text-[13px]', className)} data-testid="theme-checks">
      {report.errors.length
        ? warn(t('themegen.check.dropped', { count: report.errors.length }), 'errors', (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('themegen.check.details')}</summary>
              <ul className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground">
                {report.errors.map((e) => <li key={e} className="[overflow-wrap:anywhere]">{e}</li>)}
              </ul>
            </details>
          ))
        : ok(t('themegen.check.colours'), 'colours')}
      {report.issues.length
        ? warn(t('colors.contrastIssues', { count: report.issues.length }), 'issues', (
            <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {report.issues.map((i) => (
                <li key={`${i.mode}${i.fg}${i.bg}`}>{t('colors.contrastPair', { fg: i.fg, bg: i.bg, mode: t(`theme.${i.mode}` as TKey), ratio: i.ratio, min: i.min })}</li>
              ))}
            </ul>
          ))
        : ok(t('themegen.check.contrast'), 'contrast')}
      {report.fixed.map((f) => warn(t('themegen.check.fixed', { what: t(`themegen.what.${f.fg}` as TKey), colour: shade(t, f.fixed), mode: t(`theme.${f.mode}` as TKey) }), `fixed${f.mode}${f.fg}`))}
    </ul>
  )
}

/** `<name>.theme.json` with every token of both modes written out (the file does not depend on this version). */
export function downloadTheme(theme: Theme, name: string) {
  const text = `${JSON.stringify({ ...expandTheme(theme), name }, null, 2)}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${slugify(name) || 'palette'}.theme.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type { Mode }
