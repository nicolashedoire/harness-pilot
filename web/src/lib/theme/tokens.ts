// The semantic colour tokens a theme can set (CSS variables `--<name>` on <html>, mapped to Tailwind colours in
// styles/globals.css). docs/dev/DESIGN.md "Themes" documents each one; the server mirrors this list
// (server/maxxing/themes.py TOKENS).

export const TOKENS = [
  'background', 'foreground',
  'card', 'card-foreground',
  'popover', 'popover-foreground',
  'primary', 'primary-foreground',
  'action', 'action-foreground',
  'secondary', 'secondary-foreground',
  'muted', 'muted-foreground',
  'accent', 'accent-foreground',
  'destructive', 'destructive-foreground',
  'success', 'warning',
  'border', 'input', 'ring',
  'sidebar', 'sidebar-border',
  'overlay',
] as const
export type TokenName = (typeof TOKENS)[number]
export type Mode = 'light' | 'dark'
export const MODES: readonly Mode[] = ['light', 'dark']
export type TokenMap = Record<TokenName, string>

/** Which part of a theme each token comes from: changing that part in the settings drops the theme's explicit
 *  values for its tokens (they are derived again). */
export const SURFACE_TOKENS: readonly TokenName[] = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'secondary',
  'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border', 'input', 'sidebar',
  'sidebar-border', 'overlay',
]
export const ACCENT_TOKENS: readonly TokenName[] = ['primary', 'primary-foreground', 'ring']
export const ACTION_TOKENS: readonly TokenName[] = ['action', 'action-foreground']
export const STATUS_TOKENS: readonly TokenName[] = ['destructive', 'destructive-foreground', 'success', 'warning']

export const isToken = (k: string): k is TokenName => (TOKENS as readonly string[]).includes(k)
