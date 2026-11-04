// Validation of a theme from anywhere (an imported file, the server, a future theme generator): normaliseTheme()
// keeps only what it understands, refuses what is unsafe, and reports contrast in light and dark. Rules (mirrored
// by server/maxxing/themes.py for the structure; docs/dev/DESIGN.md "Themes"):
//   - unknown keys are dropped; `schema` must be 1 (missing = 1); id / name / description / author are cleaned
//   - base, buttons, tint: known values or the default; accent: a named accent or a colour (stored as #rrggbb)
//   - tokens: only `light` / `dark`, only TOKENS, values must be colours (hex, rgb(), hsl(), oklch()) - `url(`,
//     `var(`, keywords, `;`… are refused and reported
//   - contrast: text >= 4.5:1, UI parts >= 3:1. primary / action / destructive foregrounds that fail are replaced by
//     black or white (fixed); every other failure is reported (flagged), never blocking.
import { isAccentName, labelFor } from './accents'
import { contrastOf, isColor, normalizeHex, sameColor } from './color'
import { deriveTokens } from './derive'
import { BUTTON_STYLES, DEFAULT_THEME, THEME_BASES, THEME_SCHEMA, TINTS, emptyTokens, type ButtonStyle, type Theme, type ThemeBase, type Tint } from './model'
import { isToken, MODES, type Mode, type TokenMap, type TokenName } from './tokens'

export type ContrastCheck = { mode: Mode; fg: TokenName; bg: TokenName; ratio: number; min: number; kind: 'text' | 'ui' }
export type ContrastIssue = ContrastCheck & { fixed?: string }
export type ThemeReport = {
  /** Refused input (the theme is still usable: the bad parts were dropped). */
  errors: string[]
  /** Contrast below the minimum after the automatic fixes (shown, never blocking). */
  issues: ContrastIssue[]
  /** Foregrounds replaced by black / white. */
  fixed: ContrastIssue[]
}

/** The pairs checked in each mode: [foreground, background, minimum, kind]. */
export const CONTRAST_PAIRS: readonly [TokenName, TokenName, number, 'text' | 'ui'][] = [
  ['foreground', 'background', 4.5, 'text'],
  ['foreground', 'sidebar', 4.5, 'text'],
  ['card-foreground', 'card', 4.5, 'text'],
  ['popover-foreground', 'popover', 4.5, 'text'],
  ['muted-foreground', 'background', 4.5, 'text'],
  ['muted-foreground', 'card', 4.5, 'text'],
  ['muted-foreground', 'muted', 4.5, 'text'],
  ['muted-foreground', 'sidebar', 4.5, 'text'],
  ['secondary-foreground', 'secondary', 4.5, 'text'],
  ['accent-foreground', 'accent', 4.5, 'text'],
  ['primary-foreground', 'primary', 4.5, 'text'],
  ['action-foreground', 'action', 4.5, 'text'],
  ['destructive-foreground', 'destructive', 4.5, 'text'],
  ['primary', 'background', 4.5, 'text'], // links
  ['primary', 'card', 4.5, 'text'],
  ['destructive', 'background', 4.5, 'text'], // error messages, destructive menu items
  ['destructive', 'popover', 4.5, 'text'],
  ['ring', 'background', 3, 'ui'],
  ['primary', 'sidebar', 3, 'ui'], // active nav indicator, running dots
  ['success', 'background', 3, 'ui'],
  ['warning', 'background', 3, 'ui'],
]
const FIXABLE: readonly TokenName[] = ['primary-foreground', 'action-foreground', 'destructive-foreground']

export function checkContrast(tokens: TokenMap, mode: Mode): ContrastCheck[] {
  return CONTRAST_PAIRS.map(([fg, bg, min, kind]) => ({ mode, fg, bg, min, kind, ratio: Math.round(contrastOf(tokens[fg], tokens[bg]) * 100) / 100 }))
}

const CONTROL = /[\u0000-\u001f\u007f<>]/g
const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
export const THEME_LIMITS = { name: 60, description: 280, author: 60, bytes: 16384 }

/** Turns any input into a valid Theme (+ what was refused). Explicit tokens equal to the derived ones are dropped. */
export function normalizeTheme(input: unknown): { theme: Theme; report: ThemeReport } {
  const errors: string[] = []
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  if (src !== input) errors.push('not an object')
  if (src.schema !== undefined && src.schema !== THEME_SCHEMA) errors.push(`schema ${String(src.schema)} is not supported (expected ${THEME_SCHEMA})`)
  const id = typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : 'custom'
  if (src.id !== undefined && id !== src.id) errors.push('id: lowercase letters, digits and dashes (48 at most)')
  const base: ThemeBase = THEME_BASES.includes(src.base as ThemeBase) ? (src.base as ThemeBase) : DEFAULT_THEME.base
  if (src.base !== undefined && base !== src.base) errors.push(`base: ${THEME_BASES.join(', ')}`)
  let accent: string = DEFAULT_THEME.accent
  if (isAccentName(src.accent)) accent = src.accent
  else if (typeof src.accent === 'string' && isColor(src.accent)) accent = normalizeHex(src.accent)!
  else if (src.accent !== undefined) errors.push('accent: a named accent or a colour')
  const buttons: ButtonStyle = BUTTON_STYLES.includes(src.buttons as ButtonStyle) ? (src.buttons as ButtonStyle) : DEFAULT_THEME.buttons
  if (src.buttons !== undefined && buttons !== src.buttons) errors.push(`buttons: ${BUTTON_STYLES.join(', ')}`)
  const tint: Tint = TINTS.includes(src.tint as Tint) ? (src.tint as Tint) : DEFAULT_THEME.tint
  if (src.tint !== undefined && tint !== src.tint) errors.push(`tint: ${TINTS.join(', ')}`)

  const tokens = emptyTokens()
  const rawTokens = src.tokens && typeof src.tokens === 'object' ? (src.tokens as Record<string, unknown>) : {}
  for (const mode of MODES) {
    const m = rawTokens[mode]
    if (!m || typeof m !== 'object') continue
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (!isToken(k)) continue
      if (isColor(v)) tokens[mode][k] = v.trim()
      else errors.push(`tokens.${mode}.${k}: not a colour`)
    }
  }
  const theme: Theme = { schema: THEME_SCHEMA, id, name: cleanText(src.name, THEME_LIMITS.name), base, accent, buttons, tint, tokens }
  const description = cleanText(src.description, THEME_LIMITS.description)
  const author = cleanText(src.author, THEME_LIMITS.author)
  if (description) theme.description = description
  if (author) theme.author = author

  const fixed: ContrastIssue[] = []
  for (const mode of MODES) {
    let full = deriveTokens(theme, mode)
    for (const c of checkContrast(full, mode)) {
      if (c.ratio >= c.min || !FIXABLE.includes(c.fg)) continue
      const label = labelFor(full[c.bg])
      const ratio = Math.round(contrastOf(label, full[c.bg]) * 100) / 100
      if (ratio <= c.ratio) continue
      theme.tokens[mode][c.fg] = label
      fixed.push({ ...c, fixed: label, ratio })
      full = deriveTokens(theme, mode)
    }
  }
  const compacted = compactTheme(theme)
  return { theme: compacted, report: { errors, issues: themeIssues(compacted), fixed } }
}

/** Contrast failures of a theme (both modes). */
export function themeIssues(theme: Theme): ContrastIssue[] {
  return MODES.flatMap((mode) => checkContrast(deriveTokens(theme, mode), mode).filter((c) => c.ratio < c.min))
}

/** Drops explicit tokens that equal what the theme derives anyway. */
export function compactTheme(theme: Theme): Theme {
  const out: Theme = { ...theme, tokens: emptyTokens() }
  for (const mode of MODES) {
    const own = theme.tokens[mode]
    const derived = deriveTokens({ ...theme, tokens: emptyTokens() }, mode)
    for (const [k, v] of Object.entries(own) as [TokenName, string][]) if (!sameColor(v, derived[k])) out.tokens[mode][k] = v
  }
  // a kept token may change what others derive (a fill and its foreground): keep the theme's own values then
  for (const mode of MODES) {
    const want = deriveTokens(theme, mode)
    const got = deriveTokens(out, mode)
    for (const k of Object.keys(want) as TokenName[]) if (!sameColor(want[k], got[k])) out.tokens[mode][k] = theme.tokens[mode][k] ?? want[k]
  }
  return out
}

/** The theme with every token written out (export: the file does not depend on this version's tables). */
export function expandTheme(theme: Theme): Theme {
  return { ...theme, tokens: { light: deriveTokens(theme, 'light'), dark: deriveTokens(theme, 'dark') } }
}

/** Parses a theme file (JSON text): too big or not JSON = errors only. */
export function parseThemeFile(text: string): { theme: Theme | null; report: ThemeReport } {
  if (new TextEncoder().encode(text).length > THEME_LIMITS.bytes) return { theme: null, report: { errors: ['file too big'], issues: [], fixed: [] } }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { theme: null, report: { errors: ['not JSON'], issues: [], fixed: [] } }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { theme: null, report: { errors: ['not a theme'], issues: [], fixed: [] } }
  return normalizeTheme(data)
}
