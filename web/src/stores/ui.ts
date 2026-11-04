// Persistent UI preferences (localStorage key `mx-ui`). index.html reads the same key before the
// first paint to avoid a theme flash — keep field names in sync.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Language } from '@/lib/types'
import { applyFavicon } from '@/lib/accent'
import { applyFonts, MONO_FONTS, SANS_FONTS, type MonoFont, type SansFont } from '@/lib/fonts'
import {
  ACCENT_TOKENS, ACTION_TOKENS, DEFAULT_THEME, PRESETS, SURFACE_TOKENS, emptyTokens, legacyTheme, matchPreset, nearestAccent,
  normalizeTheme, themeCss, themeSummary, type ButtonStyle, type Theme as Palette, type ThemeBase, type Tint, type TokenName,
} from '@/lib/theme'

export type Theme = 'dark' | 'light' | 'system'
export type Density = 'comfortable' | 'compact'
export type { Palette, Tint }
/** Layout of this device: auto (touch screens and narrow windows get the touch layout), always touch, or the
 *  desktop layout whenever the window is wide enough. */
export type Layout = 'auto' | 'touch' | 'desktop'
/** First screen of the touch layout when the app opens on `/`: the last session, or the dashboard. */
export type TouchHome = 'session' | 'dashboard'
/** The parts of a palette the settings edit one by one. */
export type PalettePart = { base?: ThemeBase; accent?: string; buttons?: ButtonStyle; tint?: Tint }

/** Expanded sidebar width (px): dragged by its right edge, double-click = default. */
export const SIDEBAR_W = { min: 220, max: 440, default: 264 }
const clampSidebar = (w: number) => Math.round(Math.max(SIDEBAR_W.min, Math.min(SIDEBAR_W.max, w)))

type UIState = {
  theme: Theme
  /** Colour palette (a Theme object of lib/theme): the same on every device of the user (server `look`). */
  palette: Palette
  /** Server revision of the palette this browser shows (0 = never synced). */
  paletteRev: number
  /** Changed here and not yet stored by the server (sent again on the next start). */
  palettePending: boolean
  /** The last custom palette (not a preset) shown here: "Custom" in the settings brings it back. */
  customPalette: Palette | null
  density: Density
  /** Interface and code fonts (this browser). */
  font: SansFont
  monoFont: MonoFont
  language: Language
  sidebarCollapsed: boolean
  /** Width of the expanded sidebar dragged by the user (desktop); null = the default (SIDEBAR_W). */
  sidebarWidth: number | null
  layout: Layout
  touchHome: TouchHome
  /** Presentation mode: every <Sensitive> renders a mask instead of its content. */
  presentation: boolean
  /** The guided tour was completed or skipped (it starts automatically once, after onboarding). */
  tourDone: boolean
  /** Desktop notification when a Claude session finishes its turn (this browser). */
  notifyDone: boolean
  /** Notifications panel next to the dashboard widgets (wide screens). */
  feedPanel: boolean
  /** Notification for a new Team message (a chat that is not on screen, not muted). */
  notifyTeam: boolean
  /** Short sound with that notification. */
  notifySound: boolean
  /** The unread badges (sidebar, tab bar, tree) pulse. */
  badgePulse: boolean
  /** HUD mode: each session gets a button opening its floating bar (this browser). */
  hud: boolean
  /** Theme or palette chosen in this browser; until then it shows the server's look (`receiveLook`). */
  lookChosen: boolean
  setTheme: (t: Theme) => void
  /** A whole palette (preset, imported file). */
  setPalette: (p: Palette) => void
  /** One part changed in the settings: the palette becomes a custom one (or the preset it now equals). */
  editPalette: (part: PalettePart) => void
  setDensity: (d: Density) => void
  setFont: (f: SansFont) => void
  setMonoFont: (f: MonoFont) => void
  setLanguage: (l: Language) => void
  toggleSidebar: () => void
  setSidebarWidth: (w: number | null) => void
  setLayout: (l: Layout) => void
  setTouchHome: (h: TouchHome) => void
  setPresentation: (on: boolean) => void
  setTourDone: (done: boolean) => void
  setNotify: (p: Partial<Pick<UIState, 'notifyDone' | 'notifyTeam' | 'notifySound' | 'badgePulse'>>) => void
  setFeedPanel: (v: boolean) => void
  setHud: (on: boolean) => void
  /** The server's look (auth state): the whole look in a browser that never chose one, else a newer palette. */
  receiveLook: (look: Look) => void
}

/** The look last chosen in a signed-in browser, kept by the server (`/api/auth/state` `look`). `accent` / `tint`
 *  = the palette's nearest swatch and tint, for older clients; `rev` grows with every palette change. */
export type Look = { theme: Theme; accent: string; tint: Tint; palette?: Palette | null; rev?: number }

/** The palette a look carries (servers before palettes: accent + tint). */
export function lookPalette(look: Look): Palette {
  return look.palette ? normalizeTheme(look.palette).theme : legacyTheme(look.accent, look.tint)
}

/** Explicit tokens a part change makes stale (they are derived again). */
function staleTokens(p: Palette, part: PalettePart): readonly TokenName[] {
  const out = new Set<TokenName>()
  if (part.base !== undefined && part.base !== p.base) SURFACE_TOKENS.forEach((k) => out.add(k))
  if (part.tint !== undefined && part.tint !== p.tint) SURFACE_TOKENS.forEach((k) => out.add(k))
  if (part.accent !== undefined && part.accent !== p.accent) {
    ;[...ACCENT_TOKENS, ...ACTION_TOKENS].forEach((k) => out.add(k))
    if ((part.tint ?? p.tint) === 'tinted') SURFACE_TOKENS.forEach((k) => out.add(k))
  }
  if (part.buttons !== undefined && part.buttons !== p.buttons) ACTION_TOKENS.forEach((k) => out.add(k))
  return [...out]
}

export function editedPalette(p: Palette, part: PalettePart): Palette {
  const stale = staleTokens(p, part)
  const tokens = { light: { ...p.tokens.light }, dark: { ...p.tokens.dark } }
  for (const k of stale) {
    delete tokens.light[k]
    delete tokens.dark[k]
  }
  const next: Palette = { ...p, ...part, tokens }
  const preset = matchPreset(next)
  if (preset) return { ...preset, tokens: emptyTokens() }
  // an edited preset or imported theme is the user's own palette now
  return { schema: next.schema, id: 'custom', name: '', base: next.base, accent: next.accent, buttons: next.buttons, tint: next.tint, tokens }
}

export { PRESETS }

/** The new palette, remembered as the custom one when it is not a preset. */
function withCustom(s: UIState, next: Palette, extra: Partial<UIState>): Partial<UIState> {
  const palette = JSON.stringify(next) === JSON.stringify(s.palette) ? s.palette : next // same object: nothing re-applied
  return { ...extra, palette, customPalette: matchPreset(palette) ? s.customPalette : palette }
}

const initialLang = (): Language => (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('fr') ? 'fr' : 'en')

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: 'dark',
      palette: DEFAULT_THEME,
      paletteRev: 0,
      palettePending: false,
      customPalette: null,
      density: 'comfortable',
      font: 'inter',
      monoFont: 'system',
      language: initialLang(),
      sidebarCollapsed: false,
      sidebarWidth: null,
      layout: 'auto',
      touchHome: 'session',
      presentation: false,
      tourDone: false,
      notifyDone: false,
      notifyTeam: true,
      feedPanel: true,
      notifySound: true,
      badgePulse: false,
      hud: false,
      lookChosen: false,
      setTheme: (theme) => set({ theme, lookChosen: true }),
      setPalette: (p) => set((s) => withCustom(s, normalizeTheme(p).theme, { palettePending: true, lookChosen: true })),
      editPalette: (part) => set((s) => withCustom(s, editedPalette(s.palette, part), { palettePending: true, lookChosen: true })),
      setDensity: (density) => set({ density }),
      setFont: (font) => set({ font }),
      setMonoFont: (monoFont) => set({ monoFont }),
      setLanguage: (language) => set({ language }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarWidth: (w) => set({ sidebarWidth: w == null ? null : clampSidebar(w) }),
      setLayout: (layout) => set({ layout }),
      setTouchHome: (touchHome) => set({ touchHome }),
      setPresentation: (presentation) => set({ presentation }),
      setTourDone: (tourDone) => set({ tourDone }),
      setNotify: (p) => set(p),
      setFeedPanel: (feedPanel) => set({ feedPanel }),
      setHud: (hud) => set({ hud }),
      receiveLook: (look) =>
        set((s) => {
          const rev = typeof look.rev === 'number' ? look.rev : 0
          if (!s.lookChosen) return withCustom(s, lookPalette(look), { theme: look.theme, paletteRev: rev, palettePending: false })
          if (rev > s.paletteRev && !s.palettePending) return withCustom(s, lookPalette(look), { paletteRev: rev })
          return {}
        }),
    }),
    {
      name: 'mx-ui',
      version: 3,
      // v2: the teal and graphite accents were removed. v3: accent + tint became a palette (lib/theme); a browser
      // that had picked its colours keeps them (zinc surfaces, accent buttons), the others start from the default.
      migrate: (old, version) => {
        const s = (old || {}) as Partial<UIState> & { accent?: unknown; tint?: unknown }
        if (version < 3) {
          const chosen = s.lookChosen ?? (s.theme !== undefined || s.accent !== undefined)
          s.palette = chosen ? legacyTheme(s.accent, s.tint) : DEFAULT_THEME
          s.customPalette = matchPreset(s.palette) ? null : s.palette
          s.palettePending = false
          s.paletteRev = 0
          delete s.accent
          delete s.tint
        }
        return s as UIState
      },
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<UIState> & { accent?: unknown; tint?: unknown }
        const out = { ...current, ...p } as UIState & { accent?: unknown; tint?: unknown }
        // Saved before lookChosen existed: a browser that stored a theme or accent had picked it.
        if (p.lookChosen === undefined) out.lookChosen = p.theme !== undefined || p.accent !== undefined
        out.palette = p.palette ? normalizeTheme(p.palette).theme : current.palette
        out.customPalette = p.customPalette ? normalizeTheme(p.customPalette).theme : matchPreset(out.palette) ? null : out.palette
        if (typeof out.paletteRev !== 'number') out.paletteRev = 0
        out.palettePending = out.palettePending === true
        delete out.accent
        delete out.tint
        if (!(out.font in SANS_FONTS)) out.font = 'inter'
        if (!(out.monoFont in MONO_FONTS)) out.monoFont = 'system'
        if (out.layout !== 'touch' && out.layout !== 'desktop') out.layout = 'auto'
        if (out.touchHome !== 'dashboard') out.touchHome = 'session'
        return out
      },
    },
  ),
)

/** Resolved theme ('system' → OS preference), live. */
export function resolveTheme(t: Theme): 'dark' | 'light' {
  if (t !== 'system') return t
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** localStorage key of the applied palette as CSS + sRGB summary: index.html (before the first paint) and
 *  offline.html read it. */
export const THEME_CACHE_KEY = 'mx-theme'
let appliedPalette: Palette | null = null
let summary = themeSummary(DEFAULT_THEME)

/** Writes the palette's tokens into <style id="mx-theme"> (and the cache read by index.html). */
export function applyPalette(p: Palette) {
  if (p === appliedPalette) return
  appliedPalette = p
  const css = themeCss(p)
  summary = themeSummary(p)
  let el = document.getElementById('mx-theme') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'mx-theme'
    document.head.appendChild(el)
  }
  if (el.textContent !== css) el.textContent = css
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ v: 1, css, summary, accent: nearestAccent(p.accent) }))
  } catch {
    /* private mode: the default colours show until the app starts */
  }
}

/** Applies theme/palette/density/lang to <html>. Called once from main.tsx (subscribes). */
export function bindUIToDocument() {
  const apply = () => {
    const s = useUI.getState()
    const r = document.documentElement
    const dark = resolveTheme(s.theme) === 'dark'
    r.classList.toggle('dark', dark)
    applyPalette(s.palette)
    const accent = nearestAccent(s.palette.accent)
    r.dataset.accent = accent
    r.dataset.base = s.palette.base
    r.dataset.buttons = s.palette.buttons
    r.dataset.tint = s.palette.tint
    r.dataset.density = s.density
    r.lang = s.language
    r.style.background = summary[dark ? 'dark' : 'light'].bg
    applyFavicon(accent)
    applyFonts(s.font, s.monoFont)
    // The app theme may differ from the OS one: every theme-color meta (dark/light media variants) follows it.
    const color = summary[dark ? 'dark' : 'light'].bg
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color))
  }
  apply()
  useUI.subscribe(apply)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
}
