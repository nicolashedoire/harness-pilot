// Neutral bases: the surfaces, text and borders of a theme, light and dark. `zinc` = the historical neutrals (the
// default, mirrored in styles/globals.css as the fallback painted before the theme style exists), `graphite` =
// deeper, slightly cooler greys, `marine` = navy-tinted neutrals. Status colours are shared by every base.
import { oklch } from './color'
import type { Mode, TokenName } from './tokens'

export const BASES = ['zinc', 'graphite', 'marine'] as const
export type BaseId = (typeof BASES)[number]

type Surface = Exclude<TokenName, 'primary' | 'primary-foreground' | 'action' | 'action-foreground' | 'ring' | 'destructive' | 'destructive-foreground' | 'success' | 'warning'>
type SurfaceMap = Record<Surface, string>
/** Lightness of each surface token when the background is tinted (Settings: Background -> Tinted): the hue then
 *  comes from the accent and the chroma from TINT_CHROMA. */
type TintLadder = Partial<Record<Surface, number>>

export type BaseDef = { light: SurfaceMap; dark: SurfaceMap; tint: Record<Mode, TintLadder> }

const zincL = 285.885
const ZINC: BaseDef = {
  light: {
    background: 'oklch(1 0 0)',
    foreground: 'oklch(0.141 0.005 285.823)',
    card: 'oklch(1 0 0)',
    'card-foreground': 'oklch(0.141 0.005 285.823)',
    popover: 'oklch(1 0 0)',
    'popover-foreground': 'oklch(0.141 0.005 285.823)',
    secondary: 'oklch(0.967 0.001 286.375)',
    'secondary-foreground': 'oklch(0.21 0.006 285.885)',
    muted: 'oklch(0.967 0.001 286.375)',
    'muted-foreground': 'oklch(0.535 0.016 285.938)',
    accent: 'oklch(0.967 0.001 286.375)',
    'accent-foreground': 'oklch(0.21 0.006 285.885)',
    border: 'oklch(0.92 0.004 286.32)',
    input: 'oklch(0.92 0.004 286.32)',
    sidebar: 'oklch(0.985 0 0)',
    'sidebar-border': 'oklch(0.92 0.004 286.32)',
    overlay: 'oklch(0 0 0 / 45%)',
  },
  dark: {
    background: 'oklch(0.141 0.005 285.823)',
    foreground: 'oklch(0.985 0 0)',
    card: `oklch(0.178 0.006 ${zincL})`,
    'card-foreground': 'oklch(0.985 0 0)',
    popover: `oklch(0.19 0.006 ${zincL})`,
    'popover-foreground': 'oklch(0.985 0 0)',
    secondary: 'oklch(0.274 0.006 286.033)',
    'secondary-foreground': 'oklch(0.985 0 0)',
    muted: 'oklch(0.235 0.006 286.033)',
    'muted-foreground': 'oklch(0.705 0.015 286.067)',
    accent: 'oklch(0.274 0.006 286.033)',
    'accent-foreground': 'oklch(0.985 0 0)',
    border: 'oklch(1 0 0 / 9%)',
    input: 'oklch(1 0 0 / 13%)',
    sidebar: 'oklch(0.16 0.005 285.823)',
    'sidebar-border': 'oklch(1 0 0 / 7%)',
    overlay: 'oklch(0 0 0 / 60%)',
  },
  tint: {
    light: { background: 0.985, foreground: 0.16, card: 0.995, 'card-foreground': 0.16, popover: 0.995, 'popover-foreground': 0.16, secondary: 0.95, 'secondary-foreground': 0.22, muted: 0.955, 'muted-foreground': 0.5, accent: 0.945, 'accent-foreground': 0.22, border: 0.9, input: 0.9, sidebar: 0.965, 'sidebar-border': 0.9 },
    dark: { background: 0.16, foreground: 0.975, card: 0.195, 'card-foreground': 0.975, popover: 0.21, 'popover-foreground': 0.975, secondary: 0.285, 'secondary-foreground': 0.975, muted: 0.25, 'muted-foreground': 0.72, accent: 0.285, 'accent-foreground': 0.975, sidebar: 0.175 },
  },
}

const gH = 260
const g = (L: number, C: number, a?: number) => oklch(L, C, gH, a)
const GRAPHITE: BaseDef = {
  light: {
    background: g(0.975, 0.003),
    foreground: g(0.18, 0.008),
    card: 'oklch(1 0 0)',
    'card-foreground': g(0.18, 0.008),
    popover: 'oklch(1 0 0)',
    'popover-foreground': g(0.18, 0.008),
    secondary: g(0.93, 0.005),
    'secondary-foreground': g(0.2, 0.008),
    muted: g(0.945, 0.004),
    'muted-foreground': g(0.49, 0.014),
    accent: g(0.93, 0.005),
    'accent-foreground': g(0.2, 0.008),
    border: g(0.885, 0.006),
    input: g(0.86, 0.007),
    sidebar: g(0.955, 0.004),
    'sidebar-border': g(0.885, 0.006),
    overlay: 'oklch(0 0 0 / 45%)',
  },
  dark: {
    background: g(0.15, 0.003),
    foreground: g(0.967, 0.002),
    card: g(0.201, 0.004),
    'card-foreground': g(0.967, 0.002),
    popover: g(0.215, 0.005),
    'popover-foreground': g(0.967, 0.002),
    secondary: g(0.27, 0.006),
    'secondary-foreground': g(0.967, 0.002),
    muted: g(0.23, 0.005),
    'muted-foreground': g(0.72, 0.013),
    accent: g(0.245, 0.006),
    'accent-foreground': g(0.967, 0.002),
    border: g(0.287, 0.007),
    input: g(0.33, 0.008),
    sidebar: g(0.179, 0.004),
    'sidebar-border': g(0.25, 0.005),
    overlay: 'oklch(0 0 0 / 65%)',
  },
  tint: {
    light: { background: 0.975, foreground: 0.17, card: 0.995, 'card-foreground': 0.17, popover: 0.995, 'popover-foreground': 0.17, secondary: 0.93, 'secondary-foreground': 0.21, muted: 0.945, 'muted-foreground': 0.48, accent: 0.93, 'accent-foreground': 0.21, border: 0.885, input: 0.86, sidebar: 0.955, 'sidebar-border': 0.885 },
    dark: { background: 0.15, foreground: 0.967, card: 0.201, 'card-foreground': 0.967, popover: 0.215, 'popover-foreground': 0.967, secondary: 0.27, 'secondary-foreground': 0.967, muted: 0.23, 'muted-foreground': 0.72, accent: 0.245, 'accent-foreground': 0.967, sidebar: 0.179 },
  },
}

const m = (L: number, C: number, H = 264, a?: number) => oklch(L, C, H, a)
const MARINE: BaseDef = {
  light: {
    background: m(0.98, 0.007, 255),
    foreground: m(0.183, 0.031),
    card: 'oklch(1 0 0)',
    'card-foreground': m(0.183, 0.031),
    popover: 'oklch(1 0 0)',
    'popover-foreground': m(0.183, 0.031),
    secondary: m(0.935, 0.018, 258),
    'secondary-foreground': m(0.24, 0.04),
    muted: m(0.948, 0.014, 258),
    'muted-foreground': m(0.48, 0.045, 260),
    accent: m(0.935, 0.018, 258),
    'accent-foreground': m(0.24, 0.04),
    border: m(0.895, 0.02, 258),
    input: m(0.86, 0.025, 258),
    sidebar: m(0.958, 0.013, 258),
    'sidebar-border': m(0.9, 0.018, 258),
    overlay: m(0.12, 0.03, 264, 0.5),
  },
  dark: {
    background: m(0.183, 0.031),
    foreground: m(0.963, 0.012, 260),
    card: m(0.229, 0.045, 265),
    'card-foreground': m(0.963, 0.012, 260),
    popover: m(0.245, 0.048, 265),
    'popover-foreground': m(0.963, 0.012, 260),
    secondary: m(0.29, 0.054),
    'secondary-foreground': m(0.963, 0.012, 260),
    muted: m(0.25, 0.047),
    'muted-foreground': m(0.74, 0.035, 257),
    accent: m(0.263, 0.05),
    'accent-foreground': m(0.963, 0.012, 260),
    border: m(0.295, 0.053),
    input: m(0.37, 0.061),
    sidebar: m(0.203, 0.038, 265),
    'sidebar-border': m(0.27, 0.05),
    overlay: m(0.08, 0.02, 264, 0.65),
  },
  tint: {
    light: { background: 0.98, foreground: 0.183, card: 0.995, 'card-foreground': 0.183, popover: 0.995, 'popover-foreground': 0.183, secondary: 0.935, 'secondary-foreground': 0.24, muted: 0.948, 'muted-foreground': 0.48, accent: 0.935, 'accent-foreground': 0.24, border: 0.895, input: 0.86, sidebar: 0.958, 'sidebar-border': 0.9 },
    dark: { background: 0.183, foreground: 0.963, card: 0.229, 'card-foreground': 0.963, popover: 0.245, 'popover-foreground': 0.963, secondary: 0.29, 'secondary-foreground': 0.963, muted: 0.25, 'muted-foreground': 0.74, accent: 0.263, 'accent-foreground': 0.963, sidebar: 0.203 },
  },
}

export const BASE_DEFS: Record<BaseId, BaseDef> = { zinc: ZINC, graphite: GRAPHITE, marine: MARINE }

/** Chroma of the tinted surfaces (light, dark). Dark borders stay translucent: a tinted white at low alpha. */
const TINT_CHROMA: Record<Mode, Partial<Record<Surface, number>>> = {
  light: { background: 0.012, foreground: 0.02, card: 0.007, 'card-foreground': 0.02, popover: 0.007, 'popover-foreground': 0.02, secondary: 0.02, 'secondary-foreground': 0.03, muted: 0.018, 'muted-foreground': 0.035, accent: 0.024, 'accent-foreground': 0.03, border: 0.025, input: 0.025, sidebar: 0.02, 'sidebar-border': 0.025 },
  dark: { background: 0.024, foreground: 0.008, card: 0.028, 'card-foreground': 0.008, popover: 0.03, 'popover-foreground': 0.008, secondary: 0.035, 'secondary-foreground': 0.008, muted: 0.032, 'muted-foreground': 0.03, accent: 0.035, 'accent-foreground': 0.008, sidebar: 0.026 },
}
const TINT_DARK_ALPHA: Partial<Record<Surface, number>> = { border: 0.11, input: 0.15, 'sidebar-border': 0.08 }

/** The surfaces of a base in one mode, tinted with `hue` when asked. */
export function baseSurfaces(base: BaseId, mode: Mode, tintHue: number | null): SurfaceMap {
  const def = BASE_DEFS[base]
  const out = { ...def[mode] }
  if (tintHue === null) return out
  const ladder = def.tint[mode]
  for (const k of Object.keys(out) as Surface[]) {
    if (mode === 'dark' && TINT_DARK_ALPHA[k] !== undefined) out[k] = oklch(0.85, 0.06, tintHue, TINT_DARK_ALPHA[k])
    else if (ladder[k] !== undefined) out[k] = oklch(ladder[k]!, TINT_CHROMA[mode][k] ?? 0.02, tintHue)
  }
  return out
}

/** Status colours (every base). `destructive-foreground` is derived by contrast. */
export const STATUS: Record<Mode, { destructive: string; success: string; warning: string }> = {
  light: { destructive: 'oklch(0.56 0.235 27.3)', success: 'oklch(0.6 0.15 155)', warning: 'oklch(0.64 0.16 68)' },
  dark: { destructive: 'oklch(0.66 0.2 25.3)', success: 'oklch(0.72 0.15 155)', warning: 'oklch(0.8 0.15 80)' },
}
