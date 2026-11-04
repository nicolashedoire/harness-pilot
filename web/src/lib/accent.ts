// The app icon, favicon and installed-app manifest. The mascot no longer changes with the accent; the manifest is
// still chosen per named accent (a custom accent uses its nearest swatch, lib/theme nearestAccent). Page colours
// before the stylesheet (theme-color, splash background) come from the palette cache (stores/ui applyPalette).
import { isAccentName, type AccentName } from '@/lib/theme'

/** The mascot stays the same when the interface accent changes. */
export const logoSrc = (_accent?: AccentName) => `/icons/pilot-companion-v2.png`

/** App icon for installed apps and notifications. */
export const appIconSrc = (_accent?: AccentName) => `/icons/pilot-companion-v2-192.png`

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

/** Apply the mascot icons and the chosen interface manifest. */
export function applyFavicon(accent: AccentName) {
  setLink('icon', '/icons/pilot-companion-v2-32.png', 'image/png')
  setLink('manifest', `/manifest-${isAccentName(accent) ? accent : 'blue'}.webmanifest`)
  setLink('apple-touch-icon', '/icons/pilot-companion-v2-apple.png')
}
