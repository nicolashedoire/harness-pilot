// sRGB values of the accent colors (globals.css defines them in oklch). Used where CSS variables cannot reach:
// the favicon (an image) and the splash painted before the stylesheet. index.html keeps a copy - change both.
import type { Accent } from '@/stores/ui'

export const ACCENT_HEX: Record<'light' | 'dark', Record<Accent, string>> = {
  light: { blue: '#0076ed', clay: '#ea7e00', violet: '#a126d7', green: '#25931c', amber: '#e0bb00', rose: '#e62e1e' },
  dark: { blue: '#3c91fd', clay: '#f8962d', violet: '#c25af3', green: '#55cc4b', amber: '#f1d025', rose: '#fc523a' },
}

/** The mascot stays the same when the interface accent changes. */
export const logoSrc = (_accent: Accent) => `/icons/harness-pilot.png`

const known = (accent: Accent) => (ACCENT_HEX.dark[accent] ? accent : 'blue')

/** App icon for installed apps and notifications. */
export const appIconSrc = (_accent: Accent) => `/icons/harness-pilot-192.png`

function setLink(rel: string, href: string, type?: string) {
  let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!link) {
    link = document.createElement('link')
    link.rel = rel
    document.head.appendChild(link)
  }
  if (link.getAttribute('href') !== href) {
    if (type) link.type = type
    link.href = href
  }
}

/** Apply the mascot icons and the chosen interface manifest before first paint. */
export function applyFavicon(accent: Accent) {
  setLink('icon', logoSrc(accent), 'image/png')
  setLink('manifest', `/manifest-${known(accent)}.webmanifest`)
  setLink('apple-touch-icon', '/icons/harness-pilot-192.png')
}
