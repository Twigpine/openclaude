// Moods for the hero companions: what each mood does to the body (pose),
// the small badge drawn beside the head, and the state machine that turns
// the agent's activity into a mood.
//
// Everything here is pure: time comes in as an argument, so every frame is
// reproducible in tests.

import type { HeroCanvas, PaletteKey } from './heroCanvas.js'
import type { HeroPose } from './heroForms.js'

export const HERO_MOODS = [
  'idle',
  'hello',
  'thinking',
  'working',
  'waiting',
  'happy',
  'celebrate',
  'dance',
  'sad',
  'sleeping',
  'action',
] as const
export type HeroMood = (typeof HERO_MOODS)[number]

/** What the agent is doing right now, as the REPL sees it. */
export type CompanionActivity = 'idle' | 'thinking' | 'working' | 'waiting'

/** Length of the Enter action pose cycle, in seconds. */
export const ACTION_CYCLE_S = 2.6
const ACTION_WINDUP = 0.18
const ACTION_RELEASE = 0.86

// Deterministic per-index noise for particles (no Math.random: frames must
// be reproducible).
function noise(i: number): number {
  const v = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

export function heroPose(mood: HeroMood, t: number): { pose: HeroPose; flip: boolean } {
  const p: HeroPose = {
    jump: 0,
    hx: 0,
    hy: 0,
    sq: 0,
    eye: 'open',
    ex: 0,
    sway: Math.sin(t * 1.8),
    arm: 0,
    wave: false,
    point: false,
    droop: 0,
    mouth: 'flat',
    twitch: 0,
  }
  let flip = false
  const blink = t % 3.4 < 0.14
  const hop = (rate: number, height: number): void => {
    const j = Math.abs(Math.sin(t * rate))
    p.jump = j * height
    // Squash on landing, stretch at the top of the hop.
    p.sq = 0.55 - j * 1.1
    p.hy = p.sq * 1.5
  }
  switch (mood) {
    case 'hello':
      hop(4, 1.5)
      p.wave = true
      p.eye = blink ? 'shut' : 'open'
      p.mouth = 'smile'
      p.sway = Math.sin(t * 6)
      break
    case 'thinking':
      p.hx = -1
      p.hy = -1 + Math.sin(t * 1.5) * 0.5
      p.eye = 'up'
      p.ex = Math.sin(t * 0.9) > 0 ? 1 : 0
      p.sway = Math.sin(t * 0.9)
      break
    case 'working':
      p.hy = Math.abs(Math.sin(t * 9)) * 1.3
      p.eye = 'down'
      p.arm = Math.sin(t * 18) * 1.6
      p.sway = Math.sin(t * 4) * 0.5
      break
    case 'waiting':
      p.hx = Math.round(Math.sin(t * 2.2))
      p.hy = Math.sin(t * 3) * 0.6
      p.eye = blink ? 'shut' : 'open'
      p.arm = Math.max(0, Math.sin(t * 8)) * 1.2
      break
    case 'happy':
      hop(5, 4.5)
      p.eye = 'happy'
      p.sway = Math.sin(t * 10)
      p.mouth = 'smile'
      break
    case 'celebrate':
      hop(5.5, 5.5)
      p.eye = 'happy'
      p.mouth = 'smile'
      p.sway = Math.sin(t * 12)
      p.arm = -3
      flip = Math.floor((t * 5.5) / Math.PI) % 2 === 1
      break
    case 'dance': {
      const beat = t * 6
      p.hx = Math.sin(beat) * 2
      p.hy = Math.abs(Math.sin(beat)) * 1.5
      p.sq = Math.abs(Math.sin(beat)) * 0.4
      p.arm = Math.sin(beat) * 3
      p.eye = 'happy'
      p.mouth = 'smile'
      p.sway = Math.sin(beat) * 1.5
      flip = Math.floor(beat / (Math.PI * 4)) % 2 === 1
      break
    }
    case 'sad':
      p.hx = t % 1.6 < 0.5 ? Math.sin(t * 26) : 0
      p.hy = 1.5
      p.eye = 'shut'
      p.droop = 1
      p.sway = 0
      p.mouth = 'frown'
      break
    case 'sleeping':
      p.sq = 0.8 + Math.sin(t * 1.2) * 0.25
      p.hy = 4 + Math.sin(t * 1.2) * 0.9
      p.eye = 'shut'
      p.sway = 0
      p.droop = 0.5
      p.mouth = 'o'
      break
    case 'action': {
      const u = (t % ACTION_CYCLE_S) / ACTION_CYCLE_S
      if (u < ACTION_WINDUP) {
        // Wind up: lean back, arm raised.
        p.hx = 1.5 * (u / ACTION_WINDUP)
        p.wave = true
        p.sq = 0.4 * (u / ACTION_WINDUP)
      } else if (u < ACTION_RELEASE) {
        // Release: lunge toward the prompt and point.
        p.hx = -1.5
        p.point = true
        p.mouth = 'o'
        p.sq = -0.2
      } else {
        p.mouth = 'smile'
        p.eye = 'happy'
      }
      break
    }
    case 'idle': {
      const look = t % 6.2
      p.hy = Math.sin(t * 2.2) * 0.6
      p.sq = Math.sin(t * 2.2) * 0.12
      p.eye = blink ? 'shut' : 'open'
      p.ex = look > 4.3 && look < 4.9 ? -1 : look > 4.9 && look < 5.5 ? 1 : 0
      p.twitch = t % 4.7 < 0.16 ? 1 : 0
      break
    }
  }
  return { pose: p, flip }
}

/** Where on the action cycle the sprite is, given a live Enter effect. */
export function actionPoseTime(
  elapsedMs: number,
  phases: { drawMs: number; travelMs: number; impactMs: number },
): number {
  const { drawMs, travelMs, impactMs } = phases
  let u: number
  if (elapsedMs < drawMs) u = ACTION_WINDUP * (elapsedMs / drawMs)
  else if (elapsedMs < drawMs + travelMs) {
    u = ACTION_WINDUP + (ACTION_RELEASE - ACTION_WINDUP) * ((elapsedMs - drawMs) / travelMs)
  } else {
    const k = impactMs > 0 ? Math.min(1, (elapsedMs - drawMs - travelMs) / impactMs) : 1
    u = ACTION_RELEASE + (1 - ACTION_RELEASE) * k * 0.99
  }
  return u * ACTION_CYCLE_S
}

// Badges in the top-right corner, beside the head. Small sprites get
// hand-placed pixel stamps; full-size art gets drawn shapes.
function compactBadge(g: HeroCanvas, mood: HeroMood, t: number): void {
  // Stamp coordinates are design units; at scale 0.5 every 2 units is one
  // pixel, so x 36..46 is the sprite's right-hand 6 columns.
  switch (mood) {
    case 'thinking': {
      const n = Math.floor(t * 2.5) % 4
      if (n >= 1) g.stamp(36, 10, ['w'])
      if (n >= 2) g.stamp(40, 6, ['w'])
      if (n >= 3) g.stamp(42, 0, ['ww', 'ww'])
      return
    }
    case 'working':
      g.stamp(40, 0, Math.floor(t * 8) % 2 ? ['.A.', 'AAA', '.A.'] : ['A.A', '.A.', 'A.A'])
      return
    case 'waiting': {
      const b = Math.round(Math.sin(t * 7)) > 0 ? 2 : 0
      g.stamp(44, b, ['A', 'A', '.', 'A'])
      return
    }
    case 'happy':
      g.stamp(40, 4 - (Math.floor(t * 5) % 3) * 2, ['R.R', 'RRR', '.R.'])
      return
    case 'hello':
      g.stamp(36, 0, ['w...w', 'ww...', 'w.w.w'])
      return
    case 'dance': {
      const b = Math.round(Math.sin(t * 6)) * 2
      g.stamp(38, 2 + b, ['.p', '.p', 'pp'])
      g.stamp(43, 4 - b, ['.u', '.u', 'uu'])
      return
    }
    case 'sad':
      g.stamp(38, Math.floor((t * 9) % 8) * 2, ['u', 'u'])
      return
    case 'sleeping': {
      const rise = Math.floor((t * 1.2) % 1 * 3) * 2
      g.stamp(38, 8 - rise, ['ww.', '.w.', '.ww'])
      return
    }
    default:
      return
  }
}

function fullBadge(g: HeroCanvas, mood: HeroMood, t: number): void {
  switch (mood) {
    case 'thinking': {
      const n = Math.floor(t * 2.5) % 4
      if (n >= 1) g.ell(36.5, 9.5, 1, 1, 'w')
      if (n >= 2) g.ell(39.5, 6.5, 1.5, 1.5, 'w')
      if (n >= 3) g.ell(43.5, 3.5, 2.2, 2.2, 'w')
      return
    }
    case 'working':
      if (Math.floor(t * 8) % 2) {
        g.cap(41, 4.5, 46, 4.5, 0.6, 'A')
        g.cap(43.5, 2, 43.5, 7, 0.6, 'A')
      } else {
        g.cap(41.5, 2.5, 45.5, 6.5, 0.6, 'A')
        g.cap(45.5, 2.5, 41.5, 6.5, 0.6, 'A')
      }
      return
    case 'waiting': {
      const b = Math.round(Math.sin(t * 7))
      g.cap(43.5, 2 + b, 43.5, 6 + b, 1.1, 'A')
      g.ell(43.5, 9.5 + b, 1.2, 1.2, 'A')
      return
    }
    case 'happy': {
      const y = 6 - ((t * 5) % 4)
      g.ell(42, y, 1.7, 1.7, 'R')
      g.ell(45, y, 1.7, 1.7, 'R')
      g.poly(
        [
          [40.3, y + 0.6],
          [46.7, y + 0.6],
          [43.5, y + 4.2],
        ],
        'R',
      )
      return
    }
    case 'hello': {
      const y = 3 + Math.round(Math.sin(t * 6))
      g.cap(38.5, y, 38.5, y + 5, 0.5, 'w')
      g.cap(39, y + 3, 41, y + 3, 0.5, 'w')
      g.cap(41.5, y + 3, 41.5, y + 5, 0.5, 'w')
      g.dot(44, y, 'A')
      g.cap(44.5, y + 2, 44.5, y + 5, 0.5, 'w')
      return
    }
    case 'dance': {
      const note = (x: number, y: number, c: PaletteKey): void => {
        g.ell(x, y + 4, 1.5, 1.2, c)
        g.cap(x + 1, y, x + 1, y + 4, 0.5, c)
        g.cap(x + 1, y, x + 3, y + 1, 0.5, c)
      }
      note(38, 3 + Math.sin(t * 6) * 1.5, 'p')
      note(43, 7 + Math.cos(t * 6) * 1.5, 'u')
      return
    }
    case 'sad':
      g.ell(40.5, 3 + ((t * 9) % 8), 1, 1.7, 'u')
      return
    case 'sleeping': {
      const k = (t * 1.2) % 1
      const zee = (x: number, y: number, size: number): void => {
        g.row(x, y, size, 'w')
        for (let i = 0; i < size; i++) g.dot(x + size - 1 - i, y + i, 'w')
        g.row(x, y + size - 1, size, 'w')
      }
      zee(37, 9 - k * 3, 3)
      zee(41, 5 - k * 3, 4)
      return
    }
    default:
      return
  }
}

/** Particles that belong to the scene, not the corner badge. */
function particles(g: HeroCanvas, mood: HeroMood, t: number): void {
  if (mood === 'celebrate') {
    const colours: PaletteKey[] = ['R', 'A', 'g', 'u', 'p', 'O']
    for (let i = 0; i < 16; i++) {
      const x = noise(i) * 47 + Math.sin(t * 3 + i) * 1.5
      const y = (noise(i + 40) * 40 + t * (14 + noise(i + 80) * 12)) % 40
      g.dot(x, y, colours[i % colours.length]!)
    }
  } else if (mood === 'working') {
    for (let i = 0; i < 4; i++) {
      const k = (t * 2.2 + noise(i)) % 1
      g.dot((i % 2 ? 31 : 11) + (noise(i + 5) - 0.5) * 5, 31 - k * 9, k < 0.5 ? 'A' : 'O')
    }
  } else if (mood === 'happy' && Math.abs(Math.sin(t * 5)) < 0.25) {
    // Landing dust.
    g.dot(9, 37, 'X')
    g.dot(33, 37, 'X')
  }
}

export function drawMoodExtras(g: HeroCanvas, mood: HeroMood, t: number): void {
  particles(g, mood, t)
  if (g.compact) compactBadge(g, mood, t)
  else fullBadge(g, mood, t)
}

/** Animation tick per mood: calm moods redraw less often. */
export function moodFrameMs(mood: HeroMood): number {
  switch (mood) {
    case 'idle':
      return 250
    case 'sleeping':
      return 400
    default:
      return 100
  }
}

// ── Mood state machine ─────────────────────────────────────────────────

export const HELLO_MS = 2400
export const SLEEP_AFTER_MS = 5 * 60_000
/** A turn at least this long ends in a celebration instead of a hop. */
export const BIG_TASK_MS = 60_000
const AFTERGLOW_MS: Record<'happy' | 'sad' | 'celebrate', number> = {
  happy: 1600,
  sad: 1800,
  celebrate: 2600,
}

export type MoodClock = {
  activity: CompanionActivity
  /** The greeting wave plays until this time. */
  helloUntil: number
  /** When the current busy stretch began, or null while idle. */
  busySince: number | null
  /** Last time the agent was doing something (or the sprite mounted). */
  lastActiveAt: number
  /** A short mood played after a turn ends. */
  afterglow: { mood: HeroMood; until: number } | null
}

export function startMoodClock(activity: CompanionActivity, now: number): MoodClock {
  return {
    activity,
    helloUntil: now + HELLO_MS,
    busySince: activity === 'idle' ? null : now,
    lastActiveAt: now,
    afterglow: null,
  }
}

/** Record an activity change. Returns `prev` unchanged when nothing moved. */
export function advanceMoodClock(
  prev: MoodClock,
  activity: CompanionActivity,
  turnFailed: boolean,
  now: number,
): MoodClock {
  if (activity === prev.activity) return prev
  if (activity !== 'idle') {
    return {
      ...prev,
      activity,
      busySince: prev.busySince ?? now,
      lastActiveAt: now,
      afterglow: null,
    }
  }
  const ranFor = prev.busySince === null ? 0 : now - prev.busySince
  const mood = turnFailed ? 'sad' : ranFor >= BIG_TASK_MS ? 'celebrate' : 'happy'
  return {
    ...prev,
    activity,
    busySince: null,
    lastActiveAt: now,
    afterglow: { mood, until: now + AFTERGLOW_MS[mood] },
  }
}

export type MoodCues = {
  now: number
  /** The Enter effect is playing. */
  shooting: boolean
  petting: boolean
  dancing: boolean
  /** A speech bubble is showing. */
  speaking: boolean
  reducedMotion: boolean
}

export function resolveMood(clock: MoodClock, cues: MoodCues): HeroMood {
  if (cues.shooting) return 'action'
  // Needing the user beats everything else: it is the one state they must act on.
  if (clock.activity === 'waiting') return 'waiting'
  if (cues.petting) return 'happy'
  if (cues.dancing) return 'dance'
  if (clock.activity !== 'idle') return clock.activity
  // With reduced motion the clock is frozen, so timed moods would never end.
  if (cues.reducedMotion) return 'idle'
  if (clock.afterglow && cues.now < clock.afterglow.until) return clock.afterglow.mood
  if (cues.speaking || cues.now < clock.helloUntil) return 'hello'
  if (cues.now - clock.lastActiveAt >= SLEEP_AFTER_MS) return 'sleeping'
  return 'idle'
}
