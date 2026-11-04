// Full token set of a theme in one mode: base surfaces (tinted or not) -> status -> accent -> action, each step
// overridden by the theme's explicit tokens. A fill set explicitly without its foreground gets black or white.
import { accentHue, deriveAccent, labelFor } from './accents'
import { baseSurfaces, STATUS } from './bases'
import type { Theme } from './model'
import type { Mode, TokenMap, TokenName } from './tokens'

export function deriveTokens(theme: Theme, mode: Mode): TokenMap {
  const own = theme.tokens[mode] || {}
  const pick = (k: TokenName, fallback: string) => own[k] ?? fallback
  const base = theme.base === 'custom' ? 'zinc' : theme.base
  const surf = baseSurfaces(base, mode, theme.tint === 'tinted' ? accentHue(theme.accent, mode) : null)
  const s = Object.fromEntries(Object.entries(surf).map(([k, v]) => [k, pick(k as TokenName, v)])) as typeof surf

  const destructive = pick('destructive', STATUS[mode].destructive)
  const acc = deriveAccent(theme.accent, mode, [s.background, s.card, s.popover, s.sidebar])
  const primary = pick('primary', acc.primary)
  const primaryFg = own['primary-foreground'] ?? (own.primary ? labelFor(primary) : acc['primary-foreground'])
  let action: string
  let actionFg: string
  if (theme.buttons === 'neutral') {
    action = s.foreground
    actionFg = s.background
  } else if (own.primary) {
    action = primary
    actionFg = primaryFg
  } else {
    action = acc.action
    actionFg = acc['action-foreground']
  }
  if (own.action) {
    action = own.action
    actionFg = own['action-foreground'] ?? labelFor(action)
  } else if (own['action-foreground']) actionFg = own['action-foreground']

  return {
    ...s,
    primary,
    'primary-foreground': primaryFg,
    ring: pick('ring', primary),
    action,
    'action-foreground': actionFg,
    destructive,
    'destructive-foreground': own['destructive-foreground'] ?? labelFor(destructive),
    success: pick('success', STATUS[mode].success),
    warning: pick('warning', STATUS[mode].warning),
  }
}
