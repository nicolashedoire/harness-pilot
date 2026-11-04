// A theme as text, to copy and paste: a "theme code" (`theme1:` + the compact theme JSON in base64url, explicit tokens
// only: short enough for a chat) or the JSON itself. Whatever is pasted goes through parseThemeFile -> normalizeTheme
// like a file (size cap, colours only, contrast report): docs/dev/DESIGN.md "Themes".
import { sameColor } from './color'
import { deriveTokens } from './derive'
import type { Theme } from './model'
import { MODES, TOKENS } from './tokens'
import { compactTheme, parseThemeFile, THEME_LIMITS, type ThemeReport } from './validate'

export const THEME_CODE_PREFIX = 'theme1:'

const toB64Url = (bytes: Uint8Array) => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64Url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const refused = (error: string) => ({ theme: null, report: { errors: [error], issues: [], fixed: [] } as ThemeReport })

/** The code of a theme (its explicit tokens; the rest is derived again where it is pasted). */
export function themeCode(theme: Theme): string {
  return THEME_CODE_PREFIX + toB64Url(new TextEncoder().encode(JSON.stringify(compactTheme(theme))))
}

/** A pasted theme code or theme JSON -> a valid theme (+ what was refused), or errors only. */
export function parseThemeText(text: string): { theme: Theme | null; report: ThemeReport } {
  const v = text.trim()
  if (v.toLowerCase().startsWith(THEME_CODE_PREFIX)) {
    const body = v.slice(THEME_CODE_PREFIX.length).replace(/\s+/g, '')
    if (body.length > Math.ceil((THEME_LIMITS.bytes * 4) / 3) + 4) return refused('code too long')
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(body)) return refused('not a theme code')
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(fromB64Url(body.replace(/=+$/, '')))
    } catch {
      return refused('not a theme code')
    }
    return parseThemeFile(json)
  }
  if (v.startsWith('{')) return parseThemeFile(v)
  return refused('not a theme code')
}

/** Two themes that paint the same colours in both modes (names aside). */
export function sameLook(a: Theme, b: Theme): boolean {
  if (a === b) return true
  return MODES.every((mode) => {
    const x = deriveTokens(a, mode)
    const y = deriveTokens(b, mode)
    return TOKENS.every((k) => sameColor(x[k], y[k]))
  })
}
