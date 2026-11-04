// The Theme object: a versioned, serializable palette (presets, the user's choice, exported / imported files).
// Format documented in docs/dev/DESIGN.md "Themes"; the server validates the same structure (maxxing/themes.py).
import { isAccentName, type AccentName } from './accents'
import { BASES, type BaseId } from './bases'
import type { Mode, TokenName } from './tokens'

export const THEME_SCHEMA = 1
export type ThemeBase = BaseId | 'custom'
export type ButtonStyle = 'accent' | 'neutral'
export type Tint = 'neutral' | 'tinted'
export type ThemeTokens = Record<Mode, Partial<Record<TokenName, string>>>

export type Theme = {
  schema: typeof THEME_SCHEMA
  /** `[a-z0-9-]`, 1-48 characters. Presets: zinc, graphite, marine; a palette edited in the settings: custom. */
  id: string
  /** Shown name; empty for a preset (its name is translated) or an unnamed custom palette. */
  name: string
  description?: string
  author?: string
  /** Neutral surfaces; `custom` = they come from `tokens` (missing ones from zinc). */
  base: ThemeBase
  /** A named accent or a colour `#rrggbb`. */
  accent: AccentName | string
  /** Filled buttons and checked controls in the accent colour, or monochrome (foreground on background). */
  buttons: ButtonStyle
  /** Surfaces in plain greys, or a low-chroma shade of the accent hue. */
  tint: Tint
  /** Explicit values, they win over the derived ones. Only TOKENS, colours only. */
  tokens: ThemeTokens
}

export const BUTTON_STYLES: readonly ButtonStyle[] = ['accent', 'neutral']
export const TINTS: readonly Tint[] = ['neutral', 'tinted']
export const THEME_BASES: readonly ThemeBase[] = [...BASES, 'custom']

const preset = (id: string, base: BaseId, accent: string, buttons: ButtonStyle): Theme => ({
  schema: THEME_SCHEMA, id, name: '', base, accent, buttons, tint: 'neutral', tokens: { light: {}, dark: {} },
})

/** One-click palettes (names in i18n `palette.preset.<id>`). Zinc & blue is the default look. */
export const PRESETS: readonly Theme[] = [
  preset('zinc', 'zinc', 'blue', 'accent'),
  preset('graphite', 'graphite', 'blue', 'neutral'),
  preset('marine', 'marine', '#2d6efd', 'accent'),
]
export const DEFAULT_THEME: Theme = PRESETS[0]
export const PRESET_IDS = PRESETS.map((p) => p.id)

export const emptyTokens = (): ThemeTokens => ({ light: {}, dark: {} })
export const hasTokens = (t: Theme) => Object.keys(t.tokens.light).length > 0 || Object.keys(t.tokens.dark).length > 0

/** The preset a theme is (same parts, no explicit token), or null = a custom palette. */
export function matchPreset(t: Theme): Theme | null {
  if (hasTokens(t)) return null
  return PRESETS.find((p) => p.base === t.base && p.accent === t.accent && p.buttons === t.buttons && p.tint === t.tint) ?? null
}

/** Palette of the previous versions (an accent swatch + neutral / tinted, zinc surfaces, accent buttons). */
export function legacyTheme(accent: unknown, tint: unknown): Theme {
  const a = isAccentName(accent) ? accent : 'blue'
  const theme: Theme = { ...DEFAULT_THEME, tokens: emptyTokens(), accent: a, tint: tint === 'tinted' ? 'tinted' : 'neutral' }
  const p = matchPreset(theme)
  return p ? { ...p, tokens: emptyTokens() } : { ...theme, id: 'custom' }
}
