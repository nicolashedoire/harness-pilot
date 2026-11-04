// A theme as CSS: every token for light (`html:root`) and dark (`html:root.dark`). The selectors outrank the
// fallback values of styles/globals.css (`:root`, `.dark`) wherever the <style> lands in <head>.
import { over, parseColor, toHex } from './color'
import { deriveTokens } from './derive'
import type { Theme } from './model'
import { TOKENS, type Mode, type TokenMap } from './tokens'

const block = (sel: string, t: TokenMap) => `${sel}{${TOKENS.map((k) => `--${k}:${t[k]}`).join(';')}}`

export function themeCss(theme: Theme): string {
  return `${block('html:root', deriveTokens(theme, 'light'))}\n${block('html:root.dark', deriveTokens(theme, 'dark'))}`
}

/** sRGB values used before the stylesheet: page background (theme-color, splash), text, the filled button
 *  (`primary` = action, `onPrimary` = its label), card, border. */
export type ThemeSummary = Record<Mode, { bg: string; fg: string; primary: string; onPrimary: string; card: string; muted: string; border: string }>

export function themeSummary(theme: Theme): ThemeSummary {
  const hex = (t: TokenMap, k: keyof TokenMap) => {
    const c = parseColor(t[k])
    const bg = parseColor(t.background)
    return c ? toHex(c.a < 1 && bg ? over(c, bg) : c) : '#000000' // translucent (dark borders): over the page
  }
  const one = (mode: Mode) => {
    const t = deriveTokens(theme, mode)
    return { bg: hex(t, 'background'), fg: hex(t, 'foreground'), primary: hex(t, 'action'), onPrimary: hex(t, 'action-foreground'), card: hex(t, 'card'), muted: hex(t, 'muted-foreground'), border: hex(t, 'border') }
  }
  return { light: one('light'), dark: one('dark') }
}
