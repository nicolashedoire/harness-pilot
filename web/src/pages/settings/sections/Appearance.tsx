// Settings -> Appearance: theme, colour palette (presets, accent swatches + any colour, button style, background),
// a live preview, export / import of the palette as a theme file, then fonts and density.
// The palette is a Theme object (src/lib/theme, docs/dev/DESIGN.md "Themes") kept by stores/ui.ts.
import * as React from 'react'
import { AlertTriangle, Check, CheckCircle2, Download, Monitor, Moon, Plus, Sun, Upload } from 'lucide-react'
import { useUI, PRESETS, resolveTheme, type Density, type Palette, type Theme } from '@/stores/ui'
import {
  ACCENTS, ACCENT_SWATCH, deriveTokens, expandTheme, isAccentName, matchPreset, normalizeHex, parseThemeFile, seedContrast, themeIssues,
  type ButtonStyle, type ContrastIssue, type Mode, type ThemeReport, type Tint, type TokenMap,
} from '@/lib/theme'
import { cn, slugify } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Segmented, Switch, Tooltip, toast } from '@/components/ui'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingRow } from '@/features/common'
import { SettingsCard, SectionStack } from './ui'
import { FontPickers } from './General'

/** Light or dark as shown now (system follows the OS, live). */
function useMode(): Mode {
  const theme = useUI((s) => s.theme)
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', force)
    return () => mq.removeEventListener('change', force)
  }, [theme])
  return resolveTheme(theme)
}

const presetName = (t: (k: TKey) => string, p: Palette) => (matchPreset(p) ? t(`colors.preset.${matchPreset(p)!.id}` as TKey) : p.name || t('colors.preset.custom'))

/** Mini drawing of a palette: page, a card line, the filled button and an accent dot. */
function MiniPreview({ tokens, className }: { tokens: TokenMap; className?: string }) {
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

function PresetCards({ mode }: { mode: Mode }) {
  const t = useT()
  const palette = useUI((s) => s.palette)
  const custom = useUI((s) => s.customPalette)
  const current = matchPreset(palette)?.id ?? 'custom'
  const choose = (id: string) => {
    const ui = useUI.getState()
    if (id === 'custom') {
      if (current !== 'custom') ui.setPalette(custom ?? { ...palette, id: 'custom', name: '' })
      requestAnimationFrame(() => document.getElementById('palette-accent')?.querySelector<HTMLElement>('[aria-checked=true]')?.focus())
      return
    }
    ui.setPalette(PRESETS.find((p) => p.id === id)!)
  }
  const items = [...PRESETS.map((p) => ({ id: p.id, theme: p as Palette })), { id: 'custom', theme: (current === 'custom' ? palette : custom) as Palette | null }]
  return (
    <fieldset className="grid gap-2.5" data-tour="color-palette">
      <legend className="pb-2.5 text-sm font-medium">{t('colors.presets')}</legend>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {items.map(({ id, theme }) => {
          const on = current === id
          return (
            <label
              key={id}
              className={cn(
                'flex cursor-pointer flex-col gap-2.5 rounded-xl border p-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background',
                on ? 'border-foreground/80 ring-1 ring-foreground/80' : 'hover:border-foreground/30',
                id === 'custom' && !theme && 'border-dashed',
              )}
              data-testid={`palette-${id}`}
            >
              {theme ? (
                <MiniPreview tokens={deriveTokens(theme, mode)} />
              ) : (
                <span aria-hidden className="grid h-16 place-items-center rounded-lg border border-dashed text-muted-foreground">
                  <Plus className="size-5" />
                </span>
              )}
              <span className="flex min-w-0 items-center gap-2">
                <input type="radio" name="palette" value={id} checked={on} onChange={() => choose(id)} className="size-4 shrink-0" />
                <span className={cn('truncate text-[13px]', on ? 'font-semibold' : 'font-medium')}>
                  {id === 'custom' ? (theme?.name || t('colors.preset.custom')) : t(`colors.preset.${id}` as TKey)}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** Accent: the 6 swatches + any colour (picker + hex field). Warns, without blocking, about a pale / dark colour. */
export function AccentPicker() {
  const t = useT()
  const accent = useUI((s) => s.palette.accent)
  const palette = useUI((s) => s.palette)
  const edit = useUI((s) => s.editPalette)
  const custom = !isAccentName(accent)
  const [hex, setHex] = React.useState(custom ? accent : '#2d6efd')
  React.useEffect(() => {
    if (!isAccentName(accent)) setHex(accent)
  }, [accent])
  const commit = (v: string) => {
    const h = /^#?[0-9a-f]{6}$/i.test(v.trim()) ? normalizeHex(v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`) : null
    if (h) edit({ accent: h })
  }
  const low = custom
    ? (['light', 'dark'] as const).filter((m) => seedContrast(accent, m, deriveTokens({ ...palette, tokens: { light: {}, dark: {} } }, m).background) < 3)
    : []
  return (
    <div className="grid justify-items-end gap-2 max-md:justify-items-start">
      <div role="radiogroup" id="palette-accent" aria-label={t('settings.accent')} data-tour="accent" className="flex flex-wrap items-center gap-2">
        {ACCENTS.map((a) => (
          <Tooltip key={a} content={t(`accent.${a}` as TKey)}>
            <button
              type="button"
              role="radio"
              aria-checked={accent === a}
              aria-label={t(`accent.${a}` as TKey)}
              tabIndex={accent === a || (custom && a === 'blue') ? 0 : -1}
              onClick={() => edit({ accent: a })}
              onKeyDown={(e) => {
                const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                if (!d) return
                e.preventDefault()
                const next = ACCENTS[(ACCENTS.indexOf(a) + d + ACCENTS.length) % ACCENTS.length]
                edit({ accent: next })
                ;(e.currentTarget.parentElement?.querySelector(`[aria-label="${t(`accent.${next}` as TKey)}"]`) as HTMLElement | null)?.focus()
              }}
              className={cn(
                'flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-background outline-none transition focus-visible:ring-2 focus-visible:ring-ring max-md:size-10',
                accent === a && 'ring-2 ring-foreground/70',
              )}
              style={{ background: ACCENT_SWATCH[a] }}
            >
              {accent === a && <Check className="size-4 text-white drop-shadow" strokeWidth={3} />}
            </button>
          </Tooltip>
        ))}
        <span className={cn('flex h-9 items-center gap-1.5 rounded-lg border py-0 pr-2 pl-1 max-md:h-11', custom && 'border-foreground/70 ring-1 ring-foreground/70')}>
          <input
            type="color"
            value={hex}
            aria-label={t('colors.custom')}
            onChange={(e) => {
              setHex(e.target.value)
              commit(e.target.value)
            }}
            className="size-7 cursor-pointer rounded-md border-0 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
            data-testid="accent-custom"
          />
          <input
            value={hex.toUpperCase()}
            onChange={(e) => {
              setHex(e.target.value)
              commit(e.target.value)
            }}
            aria-label={t('colors.hex')}
            spellCheck={false}
            maxLength={7}
            className="w-[4.75rem] bg-transparent font-mono text-[13px] outline-none"
            data-testid="accent-hex"
          />
        </span>
      </div>
      {low.length > 0 && (
        <p className="flex max-w-sm items-start gap-1.5 text-xs text-muted-foreground" role="status" data-testid="accent-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" />
          {low.map((m) => t(`colors.lowContrast.${m}` as TKey)).join(' ')}
        </p>
      )}
    </div>
  )
}

function ContrastStatus({ issues }: { issues: ContrastIssue[] }) {
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

/** The real components in the current palette (or in `tokens`, for a theme not applied yet). */
function PalettePreview({ tokens, className }: { tokens?: TokenMap; className?: string }) {
  const t = useT()
  const [sound, setSound] = React.useState(true)
  const [done, setDone] = React.useState(true)
  const [mode, setMode] = React.useState<'on' | 'off'>('on')
  const style = tokens ? (Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as React.CSSProperties) : undefined
  return (
    <div style={style} className={cn('grid gap-3 rounded-xl border bg-sidebar p-4 text-foreground [accent-color:var(--action)]', className)} data-testid="palette-preview">
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('colors.preview')}</h4>
      <div className="flex gap-2.5 rounded-lg border bg-card p-3">
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
      <div className="grid gap-3 rounded-lg border bg-card p-3 text-[13px]">
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
              <input type="radio" name={tokens ? 'preview-import' : 'preview'} checked={mode === v} onChange={() => setMode(v)} className="size-4" />
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
    </div>
  )
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Export the palette as `<name>.theme.json` (every token written out), import one (validate -> preview -> apply). */
function ThemeFileButtons({ mode }: { mode: Mode }) {
  const t = useT()
  const palette = useUI((s) => s.palette)
  const input = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState<{ theme: Palette; report: ThemeReport } | null>(null)
  const exportIt = () => {
    const name = presetName(t, palette)
    const file = { ...expandTheme(palette), name }
    download(`${slugify(name) || 'palette'}.theme.json`, `${JSON.stringify(file, null, 2)}\n`)
  }
  const onFile = async (f: File | undefined) => {
    if (!f) return
    const parsed = parseThemeFile(await f.text())
    if (!parsed.theme) toast.error(t('colors.importBad'))
    else setPending({ theme: parsed.theme, report: parsed.report })
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={exportIt} data-testid="palette-export">
        <Download /> {t('colors.export')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => input.current?.click()} data-testid="palette-import">
        <Upload /> {t('colors.import')}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('colors.importTitle')}</DialogTitle>
            <DialogDescription>
              {pending && (pending.theme.name || t('colors.preset.custom'))}
              {pending?.theme.author ? ` · ${t('colors.by', { author: pending.theme.author })}` : ''}
            </DialogDescription>
          </DialogHeader>
          {pending && (
            <div className="grid gap-3">
              {pending.theme.description && <p className="text-[13px] text-muted-foreground">{pending.theme.description}</p>}
              <PalettePreview tokens={deriveTokens(pending.theme, mode)} />
              {pending.report.errors.length > 0 && (
                <details className="text-[13px]">
                  <summary className="cursor-pointer text-warning">{t('colors.importErrors', { count: pending.report.errors.length })}</summary>
                  <ul className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground">
                    {pending.report.errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                </details>
              )}
              {pending.report.fixed.length > 0 && <p className="text-[13px] text-muted-foreground">{t('colors.importFixed', { count: pending.report.fixed.length })}</p>}
              <ContrastStatus issues={pending.report.issues} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => {
                if (pending) useUI.getState().setPalette(pending.theme)
                setPending(null)
              }}
              data-testid="palette-import-apply"
            >
              {t('colors.importApply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ColoursCard() {
  const t = useT()
  const mode = useMode()
  const ui = useUI()
  const issues = React.useMemo(() => themeIssues(ui.palette), [ui.palette])
  return (
    <SettingsCard title={t('colors.title')} description={t('colors.desc')} actions={<ThemeFileButtons mode={mode} />}>
      <div className="grid gap-5">
        <SettingRow label={t('shell.theme')} className="py-0">
          <Segmented<Theme>
            value={ui.theme}
            onChange={ui.setTheme}
            aria-label={t('shell.theme')}
            options={[
              { value: 'dark', label: t('theme.dark'), icon: <Moon /> },
              { value: 'light', label: t('theme.light'), icon: <Sun /> },
              { value: 'system', label: t('theme.system'), icon: <Monitor /> },
            ]}
          />
        </SettingRow>
        <PresetCards mode={mode} />
        <div className="divide-y border-t pt-4">
          <SettingRow label={t('settings.accent')} description={t('settings.accentDesc')}>
            <AccentPicker />
          </SettingRow>
          <SettingRow label={t('colors.buttons')} description={t('colors.buttonsDesc')}>
            <Segmented<ButtonStyle>
              value={ui.palette.buttons}
              onChange={(buttons) => ui.editPalette({ buttons })}
              aria-label={t('colors.buttons')}
              options={[
                { value: 'neutral', label: t('colors.buttons.neutral') },
                { value: 'accent', label: t('colors.buttons.accent') },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.tint')} description={t('settings.tintDesc')}>
            <Segmented<Tint>
              value={ui.palette.tint}
              onChange={(tint) => ui.editPalette({ tint })}
              aria-label={t('settings.tint')}
              options={[
                { value: 'neutral', label: t('tint.neutral') },
                { value: 'tinted', label: t('tint.tinted') },
              ]}
            />
          </SettingRow>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <ContrastStatus issues={issues} />
          <Button variant="ghost" size="sm" className="underline-offset-4 hover:underline" onClick={() => ui.setPalette(PRESETS[0])} disabled={matchPreset(ui.palette)?.id === PRESETS[0].id}>
            {t('colors.reset')}
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}

function TextCard() {
  const t = useT()
  const ui = useUI()
  return (
    <SettingsCard title={t('colors.textTitle')} description={t('colors.textDesc')}>
      <div className="divide-y">
        <SettingRow label={t('settings.density')} description={t('settings.densityDesc')}>
          <Segmented<Density>
            value={ui.density}
            onChange={ui.setDensity}
            aria-label={t('settings.density')}
            options={[
              { value: 'comfortable', label: t('density.comfortable') },
              { value: 'compact', label: t('density.compact') },
            ]}
          />
        </SettingRow>
        <FontPickers />
      </div>
    </SettingsCard>
  )
}

export function AppearanceSection() {
  const t = useT()
  return (
    <SectionStack>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ColoursCard />
        <aside className="lg:sticky lg:top-[calc(var(--header-h)+2rem)]" aria-label={t('colors.preview')}>
          <PalettePreview />
        </aside>
      </div>
      <TextCard />
    </SectionStack>
  )
}
