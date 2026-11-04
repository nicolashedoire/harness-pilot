// Colour parsing, OKLCH <-> sRGB conversion and WCAG contrast. Pure (no DOM): used by the theme engine, its tests
// (web/tests, plain Node) and the settings UI. Relative imports only, `import type` for types (Node strips types).

export type RGBA = { r: number; g: number; b: number; a: number } // sRGB 0..1, alpha 0..1

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`
const PART = String.raw`${NUM}(?:%|deg)?`
/** Strict colour syntax (shared with the server, docs/dev/DESIGN.md "Themes"): hex, rgb(a), hsl(a), oklch with
 *  numbers only. Anything else (`url(`, `var(`, keywords, `;`, braces…) is refused. */
const FUNC_RE = new RegExp(String.raw`^(rgba?|hsla?|oklch)\(\s*(${PART})(?:\s*,\s*|\s+)(${PART})(?:\s*,\s*|\s+)(${PART})(?:\s*[,/]\s*(${NUM}%?))?\s*\)$`, 'i')
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
export const MAX_COLOR_LENGTH = 64

export function isColor(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_COLOR_LENGTH && (HEX_RE.test(v.trim()) || FUNC_RE.test(v.trim()))
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const num = (s: string, scale: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s))
const alphaOf = (s: string | undefined) => (s === undefined ? 1 : clamp01(s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)))

/** Parses a colour accepted by `isColor` (null otherwise). */
export function parseColor(input: string): RGBA | null {
  if (!isColor(input)) return null
  const v = input.trim()
  if (v.startsWith('#')) {
    let h = v.slice(1)
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 }
  }
  const m = v.match(FUNC_RE)!
  const fn = m[1].toLowerCase()
  const [p1, p2, p3] = [m[2], m[3], m[4]]
  const a = alphaOf(m[5])
  if (fn.startsWith('rgb')) return { r: clamp01(num(p1, 255) / 255), g: clamp01(num(p2, 255) / 255), b: clamp01(num(p3, 255) / 255), a }
  if (fn.startsWith('hsl')) {
    const h = ((parseFloat(p1) % 360) + 360) % 360
    const s = clamp01(num(p2, 1) / (p2.endsWith('%') ? 1 : 100))
    const l = clamp01(num(p3, 1) / (p3.endsWith('%') ? 1 : 100))
    const k = (n: number) => (n + h / 30) % 12
    const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return { r: f(0), g: f(8), b: f(4), a }
  }
  // oklch: L as 0..1 or %, C as number (or % of 0.4), H in degrees
  const L = p1.endsWith('%') ? parseFloat(p1) / 100 : parseFloat(p1)
  const C = p2.endsWith('%') ? (parseFloat(p2) / 100) * 0.4 : parseFloat(p2)
  const [r, g, b] = oklchToRgb(L, Math.max(0, C), parseFloat(p3))
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a }
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const delin = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055)

/** OKLCH -> sRGB (unclamped: out-of-gamut channels fall outside 0..1). */
export function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    delin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    delin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    delin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

export function rgbToOklch({ r, g, b }: RGBA): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  let H = (Math.atan2(Bb, A) * 180) / Math.PI
  if (H < 0) H += 360
  return [L, Math.hypot(A, Bb), H]
}

const inGamut = (rgb: [number, number, number]) => rgb.every((c) => c >= -0.0005 && c <= 1.0005)

/** Lowers the chroma until the colour fits sRGB (keeps lightness and hue). */
export function fitGamut(L: number, C: number, H: number): [number, number, number] {
  let c = C
  while (c > 0 && !inGamut(oklchToRgb(L, c, H))) c = Math.max(0, c - 0.002)
  return [L, c, H]
}

const r3 = (x: number) => Math.round(x * 1000) / 1000
/** `oklch(L C H)` (or `/ a%`) with 3 decimals, the format used by the derived tokens. */
export function oklch(L: number, C: number, H: number, alpha?: number): string {
  const [l, c, h] = fitGamut(L, C, H)
  const a = alpha === undefined || alpha >= 1 ? '' : ` / ${Math.round(alpha * 100)}%`
  return `oklch(${r3(l)} ${r3(c)} ${Math.round(h * 10) / 10}${a})`
}

export function toHex(c: RGBA, withAlpha = false): string {
  const h = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${withAlpha && c.a < 1 ? h(c.a) : ''}`
}

/** Colour `top` (with its alpha) laid over the opaque `bottom`. */
export function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 }
}

export function luminance({ r, g, b }: RGBA): number {
  return 0.2126 * lin(clamp01(r)) + 0.7152 * lin(clamp01(g)) + 0.0722 * lin(clamp01(b))
}

/** WCAG 2 contrast ratio (1..21). A translucent foreground is laid over the background first. */
export function contrast(fg: RGBA, bg: RGBA): number {
  const f = fg.a < 1 ? over(fg, bg) : fg
  const x = luminance(f)
  const y = luminance(bg)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Contrast of two colour strings (0 when one does not parse). */
export function contrastOf(fg: string, bg: string): number {
  const f = parseColor(fg)
  const b = parseColor(bg)
  return f && b ? contrast(f, b.a < 1 ? over(b, { r: 0, g: 0, b: 0, a: 1 }) : b) : 0
}

/** `#rrggbb` (lowercase) of any accepted colour, or null. */
export function normalizeHex(v: string): string | null {
  const c = parseColor(v)
  return c ? toHex(c) : null
}

/** Same colour (to 1/255 per channel and 1 % alpha) whatever the notation. */
export function sameColor(a: string, b: string): boolean {
  const x = parseColor(a)
  const y = parseColor(b)
  if (!x || !y) return false
  const d = (p: number, q: number) => Math.abs(p - q) <= 1 / 255 + 1e-6
  return d(x.r, y.r) && d(x.g, y.g) && d(x.b, y.b) && Math.abs(x.a - y.a) <= 0.01
}
