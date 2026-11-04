// Settings -> Appearance: theme, colour palette (presets, accent swatches + any colour, button style, background),
// a live preview, share / export of the palette, My themes (saved themes, import from a file or a code, the theme
// generator at ?create=1), then fonts and density.
// The palette is a Theme object (src/lib/theme, docs/dev/DESIGN.md "Themes") kept by stores/ui.ts; the shared
// theme blocks (previews, review, share, generator) live in src/features/themes.
import * as React from 'react'
import { useSearchParams } from 'react-router'
import { AlertTriangle, Check, Download, Monitor, Moon, Plus, Share2, Sun } from 'lucide-react'
import { useUI, PRESETS, resolveTheme, type Density, type Palette, type Theme } from '@/stores/ui'
import { ACCENTS, ACCENT_SWATCH, deriveTokens, isAccentName, matchPreset, normalizeHex, seedContrast, themeIssues, type ButtonStyle, type Mode, type Tint } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { useT, type TKey } from '@/i18n'
import { Button, Segmented, Tooltip } from '@/components/ui'
import { SettingRow } from '@/features/common'
import { ContrastStatus, downloadTheme, MiniPreview, PalettePreview, themeName } from '@/features/themes/Preview'
import { ShareThemeDialog } from '@/features/themes/ShareDialog'
import { MyThemesCard } from '@/features/themes/MyThemes'
import { ThemeCreator } from '@/features/themes/Creator'
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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2.5">
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
                <span className={cn('line-clamp-2 min-w-0 break-words text-[13px] leading-tight', on ? 'font-semibold' : 'font-medium')}>
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

/** Share the palette (Team, file, theme code) and export it as a file. */
function PaletteActions() {
  const t = useT()
  const palette = useUI((s) => s.palette)
  const [share, setShare] = React.useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setShare(true)} data-testid="palette-share">
        <Share2 /> {t('themegen.share')}
      </Button>
      <Button variant="outline" size="sm" onClick={() => downloadTheme(palette, themeName(t, palette))} data-testid="palette-export">
        <Download /> {t('colors.export')}
      </Button>
      <ShareThemeDialog theme={share ? palette : null} open={share} onOpenChange={setShare} />
    </>
  )
}

function ColoursCard() {
  const t = useT()
  const mode = useMode()
  const ui = useUI()
  const issues = React.useMemo(() => themeIssues(ui.palette), [ui.palette])
  return (
    <SettingsCard title={t('colors.title')} description={t('colors.desc')} actions={<PaletteActions />}>
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
  const mode = useMode()
  const [params] = useSearchParams()
  if (params.get('create')) return <ThemeCreator backTo="/settings/appearance" />
  return (
    <SectionStack>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ColoursCard />
        <aside className="lg:sticky lg:top-[calc(var(--header-h)+2rem)]" aria-label={t('colors.preview')}>
          <PalettePreview />
        </aside>
      </div>
      <MyThemesCard mode={mode} onCreate="/settings/appearance?create=1" />
      <TextCard />
    </SectionStack>
  )
}
