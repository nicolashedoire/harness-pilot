// Notification sounds, made with Web Audio (no file to download). One short sound per level, in two sets:
//   success  two rising notes    info  one soft note    warning  two even notes    error  three lower, longer notes
// "chime" has a little shimmer (a quiet octave above), "soft" is a plain sine, quieter and rounder. Every sound
// is under 0.5 s at a low gain, scaled by the volume of this browser (UI store: soundSet, soundVolume).
// A burst plays once (the most severe level of the burst wins), then nothing for 2 s. Browsers only allow
// audio after a user gesture: the context is created or resumed on the first click / key, and a blocked context
// stays silent.
import type { FeedLevel } from '@/lib/types'
import { useUI, type SoundSet } from '@/stores/ui'

type Note = { f: number; at: number; len: number }
const NOTES: Record<FeedLevel, Note[]> = {
  success: [
    { f: 659.25, at: 0, len: 0.16 },
    { f: 987.77, at: 0.11, len: 0.24 },
  ],
  info: [{ f: 783.99, at: 0, len: 0.3 }],
  warning: [
    { f: 698.46, at: 0, len: 0.15 },
    { f: 698.46, at: 0.17, len: 0.2 },
  ],
  error: [
    { f: 440, at: 0, len: 0.14 },
    { f: 440, at: 0.15, len: 0.14 },
    { f: 369.99, at: 0.3, len: 0.18 },
  ],
}
const SEVERITY: Record<FeedLevel, number> = { info: 0, success: 1, warning: 2, error: 3 }
const BURST_MS = 150
const QUIET_MS = 2000

let ctx: AudioContext | null = null
function context(create: boolean): AudioContext | null {
  if (ctx || !create) return ctx
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    ctx = Ctx ? new Ctx() : null
  } catch {
    ctx = null
  }
  return ctx
}

/** Once, at start: the first click or key creates / resumes the audio context (autoplay rules). */
export function unlockAudioOnGesture() {
  const unlock = () => {
    const c = context(true)
    if (c && c.state === 'suspended') void c.resume().catch(() => {})
    if (c?.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
    }
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
}

function render(level: FeedLevel, set: Exclude<SoundSet, 'none'>, volume: number) {
  const c = context(true)
  if (!c || volume <= 0) return
  if (c.state === 'suspended') void c.resume().catch(() => {})
  if (c.state !== 'running' && c.state !== 'suspended') return
  try {
    const peak = (set === 'soft' ? 0.07 : 0.11) * Math.min(1, Math.max(0, volume))
    const t0 = c.currentTime + 0.01
    for (const n of NOTES[level]) {
      const partials = set === 'soft' ? [[1, 1]] : [[1, 1], [2, 0.18]]
      for (const [mult, share] of partials) {
        const o = c.createOscillator()
        const g = c.createGain()
        o.type = 'sine'
        o.frequency.value = n.f * mult * (set === 'soft' ? 0.5 : 1)
        const start = t0 + n.at
        g.gain.setValueAtTime(0.0001, start)
        g.gain.exponentialRampToValueAtTime(peak * share, start + (set === 'soft' ? 0.03 : 0.012))
        g.gain.exponentialRampToValueAtTime(0.0001, start + n.len)
        o.connect(g).connect(c.destination)
        o.start(start)
        o.stop(start + n.len + 0.02)
      }
    }
  } catch {
    /* audio blocked: silent */
  }
}

/** Sound on in this browser (a set chosen, some volume). */
export function soundEnabled(): boolean {
  const { soundSet, soundVolume } = useUI.getState()
  return soundSet !== 'none' && soundVolume > 0
}

let lastPlayed = 0
let pendingLevel: FeedLevel | null = null
let burst: ReturnType<typeof setTimeout> | null = null

/** The sound of a new notification: throttled, the most severe level of a burst wins. False when it will not
 *  play (sound off, or another one just played), so a system notification can keep its own sound. */
export function playNotificationSound(level: FeedLevel): boolean {
  if (!soundEnabled() || Date.now() - lastPlayed < QUIET_MS) return false
  if (!pendingLevel || SEVERITY[level] > SEVERITY[pendingLevel]) pendingLevel = level
  if (!burst)
    burst = setTimeout(() => {
      burst = null
      const { soundSet, soundVolume } = useUI.getState()
      const l = pendingLevel ?? 'info'
      pendingLevel = null
      lastPlayed = Date.now()
      if (soundSet !== 'none') render(l, soundSet, soundVolume)
    }, BURST_MS)
  return true
}

/** "Listen": the sounds of a set in a row (the four levels by default), at that volume (not throttled). */
export function previewSounds(set: SoundSet, volume: number, levels: FeedLevel[] = ['error', 'warning', 'success', 'info']) {
  if (set === 'none') return
  levels.forEach((l, i) => setTimeout(() => render(l, set, volume), i * 650))
}
