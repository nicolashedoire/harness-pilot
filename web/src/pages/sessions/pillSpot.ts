// Where the thread's "Jump to latest" pill sits: centred at the bottom of the scroller, unless that would cover
// something the user can act on there (a block's buttons - CSV, Export, Pin -, a link, a field, a mini-app); then at
// the right edge, then at the left one, then the same spots one or two button rows higher. When every spot is taken
// it stays centred but lets the clicks through to what is under it (translucent; still reachable with the keyboard).

/** `<side>:<lift px>` (a string, so that an unchanged spot does not render again), or `through`. */
export type PillSpot = `${'center' | 'right' | 'left'}:${number}` | 'through'

const ACTIONABLE =
  'a[href], button, input, select, textarea, summary, iframe, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="link"], [tabindex]:not([tabindex="-1"])'
/** Distance between the pill and the scroller's edges (bottom-3 / left-4 / right-4). */
export const PILL_BOTTOM = 12
const SIDE = 16
/** Heights tried above the bottom: a block's footer row of buttons is about 40-48 px high. */
const LIFTS = [0, 48, 96]
/** Hit-test points along the pill: close enough not to miss a 24 px icon button. */
const STEP = 20

/** Would the pill, drawn at (x, y, w, h), sit over an actionable element of the thread? */
function covers(pill: HTMLElement, scroller: HTMLElement, x: number, y: number, w: number, h: number): boolean {
  const ys = [y + 3, y + h / 2, y + h - 3]
  for (let px = x + 2; px <= x + w - 2; px += Math.min(STEP, Math.max(1, w - 4))) {
    for (const py of ys) {
      // the topmost element under that point that is not the pill decides
      const under = document.elementsFromPoint(px, py).find((el) => !pill.contains(el))
      if (!under || !scroller.contains(under)) continue
      const hit = under.closest(ACTIONABLE)
      if (hit && scroller.contains(hit)) return true
    }
  }
  return false
}

export function pillSpot(pill: HTMLElement, scroller: HTMLElement): PillSpot {
  const box = scroller.getBoundingClientRect()
  const w = pill.offsetWidth
  const h = pill.offsetHeight
  if (!w || !h) return 'center:0'
  const sides: ['center' | 'right' | 'left', number][] = [
    ['center', box.left + (box.width - w) / 2],
    ['right', box.right - SIDE - w],
    ['left', box.left + SIDE],
  ]
  for (const lift of LIFTS) {
    const y = box.bottom - PILL_BOTTOM - lift - h
    for (const [side, x] of sides) if (!covers(pill, scroller, x, y, w, h)) return `${side}:${lift}`
  }
  return 'through'
}
