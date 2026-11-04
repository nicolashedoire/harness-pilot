// Accent colours: the 6 named swatches (the hue of each coloured logo) or any custom colour. One rule derives the
// accent tokens of both kinds, so a custom colour gets the same treatment as a swatch:
//   primary            the seed, lightness moved (darker in light mode, lighter in dark) until it reads as text on
//                      every surface (>= 4.5:1): links, focus ring, selection, active nav, unread / running dots
//   primary-foreground black or white, whichever contrasts most with primary
//   action (accent buttons)  the seed with its preferred label colour; lightness moved until the label reaches 4.5:1
import { contrast, fitGamut, oklch, oklchToRgb, parseColor, rgbToOklch, type RGBA } from './color'
import type { Mode } from './tokens'

export const ACCENTS = ['blue', 'clay', 'violet', 'green', 'amber', 'rose'] as const
export type AccentName = (typeof ACCENTS)[number]
export const isAccentName = (v: unknown): v is AccentName => (ACCENTS as readonly unknown[]).includes(v)

type Seed = { L: number; C: number; H: number; label: 'white' | 'black' }
/** Seeds of the named accents (light, dark) and the label colour each one prefers on a filled button. */
export const ACCENT_SEEDS: Record<AccentName, Record<Mode, Seed>> = {
  blue: { light: { L: 0.58, C: 0.2, H: 256, label: 'white' }, dark: { L: 0.66, C: 0.18, H: 256, label: 'white' } },
  clay: { light: { L: 0.7, C: 0.17, H: 58, label: 'black' }, dark: { L: 0.76, C: 0.16, H: 62, label: 'black' } },
  violet: { light: { L: 0.55, C: 0.25, H: 312, label: 'white' }, dark: { L: 0.79, C: 0.13, H: 309, label: 'black' } },
  green: { light: { L: 0.58, C: 0.18, H: 142, label: 'white' }, dark: { L: 0.75, C: 0.2, H: 142, label: 'black' } },
  amber: { light: { L: 0.8, C: 0.17, H: 95, label: 'black' }, dark: { L: 0.86, C: 0.17, H: 97, label: 'black' } },
  rose: { light: { L: 0.6, C: 0.22, H: 30, label: 'white' }, dark: { L: 0.67, C: 0.21, H: 31, label: 'white' } },
}

/** Swatch shown in the picker (one colour per accent, between its light and dark steps). */
export const ACCENT_SWATCH: Record<AccentName, string> = {
  blue: 'oklch(0.62 0.2 256)',
  clay: 'oklch(0.73 0.17 58)',
  violet: 'oklch(0.6 0.25 312)',
  green: 'oklch(0.67 0.18 142)',
  amber: 'oklch(0.83 0.17 95)',
  rose: 'oklch(0.64 0.22 30)',
}

const WHITE = 'oklch(0.99 0 0)'
const blackFor = (H: number) => oklch(0.16, 0.012, H)
const rgbOf = (L: number, C: number, H: number): RGBA => {
  const [l, c, h] = fitGamut(L, C, H)
  const [r, g, b] = oklchToRgb(l, c, h)
  return { r: Math.min(1, Math.max(0, r)), g: Math.min(1, Math.max(0, g)), b: Math.min(1, Math.max(0, b)), a: 1 }
}
const parsed = (s: string) => parseColor(s) ?? { r: 0, g: 0, b: 0, a: 1 }
const minContrast = (c: RGBA, surfaces: RGBA[]) => Math.min(...surfaces.map((s) => contrast(c, s)))

/** Label for a fill: white when it reaches 4.5:1, else whichever of black / white contrasts most. */
export function labelFor(fill: string): string {
  const f = parsed(fill)
  const [, , H] = rgbToOklch(f)
  const black = blackFor(H)
  const w = contrast(parsed(WHITE), f)
  return w >= 4.5 || w >= contrast(parsed(black), f) ? WHITE : black
}

/** Seed of a custom colour (`#rrggbb`): the same in both modes. Its buttons keep a white label when white reaches
 *  3:1 on it (the fill is then darkened a little to 4.5:1, like the usual "500" blues and reds), black otherwise. */
export function customSeed(hex: string): Seed {
  const c = parsed(hex)
  const [L, C, H] = rgbToOklch(c)
  return { L, C, H: C < 0.0001 ? 0 : H, label: contrast(parsed(WHITE), c) >= 3 ? 'white' : 'black' }
}

/** Hue used by the tinted background. */
export function accentHue(accent: string, mode: Mode = 'light'): number {
  return isAccentName(accent) ? ACCENT_SEEDS[accent][mode].H : customSeed(accent).H
}

export type AccentTokens = { primary: string; 'primary-foreground': string; ring: string; action: string; 'action-foreground': string }

/** Accent tokens of one mode, for the given surfaces (background first). */
export function deriveAccent(accent: string, mode: Mode, surfaces: string[]): AccentTokens {
  const seed = isAccentName(accent) ? ACCENT_SEEDS[accent][mode] : customSeed(accent)
  const surf = surfaces.map(parsed)
  const step = mode === 'light' ? -0.005 : 0.005
  // primary: readable as text on every surface
  let L = seed.L
  for (let i = 0; i < 200 && minContrast(rgbOf(L, seed.C, seed.H), surf) < 4.5 && L > 0.02 && L < 0.98; i++) L += step
  const primary = oklch(L, seed.C, seed.H)
  // action: the seed under its preferred label, darker (white label) or lighter (black label) until 4.5:1
  const label = seed.label === 'white' ? WHITE : blackFor(seed.H)
  const lab = parsed(label)
  const dir = seed.label === 'white' ? -0.005 : 0.005
  let F = seed.L
  for (let i = 0; i < 200 && contrast(lab, rgbOf(F, seed.C, seed.H)) < 4.5 && F > 0.02 && F < 0.98; i++) F += dir
  const action = oklch(F, seed.C, seed.H)
  return { primary, 'primary-foreground': labelFor(primary), ring: primary, action, 'action-foreground': label }
}

/** Contrast of the picked colour itself against a background (the settings warn under 3:1). */
export function seedContrast(accent: string, mode: Mode, background: string): number {
  const seed = isAccentName(accent) ? ACCENT_SEEDS[accent][mode] : customSeed(accent)
  return contrast(rgbOf(seed.L, seed.C, seed.H), parsed(background))
}

/** The named accent closest to a colour (hue distance, then chroma): manifest and app icon of a custom accent. */
export function nearestAccent(accent: string): AccentName {
  if (isAccentName(accent)) return accent
  const s = customSeed(accent)
  let best: AccentName = 'blue'
  let dist = Infinity
  for (const a of ACCENTS) {
    const t = ACCENT_SEEDS[a].light
    const dh = Math.min(Math.abs(t.H - s.H), 360 - Math.abs(t.H - s.H))
    const d = dh + Math.abs(t.L - s.L) * 60
    if (d < dist) {
      dist = d
      best = a
    }
  }
  return best
}
