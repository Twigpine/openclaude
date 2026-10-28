// Signature per-hero action effects: pure functions from (elapsed ms, row
// width) to a row of colored runs. Rendered by CompanionActionFX in the
// transient row above the prompt while the sprite plays its shoot/cast
// poses. All effects travel right→left (the companion stands at the right
// edge of the screen) and finish with a short impact/fade phase.
//
// Pure and React-free so every effect is unit-testable frame by frame.

import { clamp } from '../ink/layout/geometry.js'
import type { Species } from './types.js'
import {
  corsair,
  ember,
  kage,
  kaio,
  merlin,
  robinhood,
  strawhat,
} from './types.js'

export type FxRun = {
  text: string
  color?: string
}

export type ActionEffect = {
  /** Sprite draw-pose phase before the projectile appears. */
  drawMs: number
  /** Projectile/beam phase length. */
  travelMs: number
  /** Impact/fade phase after travel. */
  impactMs: number
  /** Runs for the FX row at elapsed ms since the TRAVEL phase began
   *  (impact phase elapsed continues past travelMs), or null for an
   *  empty row. Width is the full FX row width. */
  render: (elapsedMs: number, width: number) => FxRun[] | null
}

export function effectTotalMs(fx: ActionEffect): number {
  return fx.drawMs + fx.travelMs + fx.impactMs
}

// Shared palette for effects (raw rgb() strings — the FX row renders with
// the raw ink Text, same as the pixel sprites).
const C = {
  wood: 'rgb(158,112,66)',
  steel: 'rgb(200,205,210)',
  smoke: 'rgb(120,120,120)',
  ember: 'rgb(255,140,40)',
  flameCore: 'rgb(255,240,200)',
  flameMid: 'rgb(255,170,60)',
  flameDim: 'rgb(180,70,30)',
  beamCore: 'rgb(245,250,255)',
  beamEdge: 'rgb(90,160,255)',
  spark: 'rgb(255,230,120)',
  sparkDim: 'rgb(190,150,220)',
  skin: 'rgb(232,190,152)',
  burst: 'rgb(255,210,80)',
  green: 'rgb(72,158,74)',
}

/** Right→left position for a head glyph: returns the column of the LEFT
 *  edge of a payload of `payloadWidth` at `fraction` (0 = right edge,
 *  1 = left edge). */
function leftPos(fraction: number, width: number, payloadWidth: number): number {
  const span = Math.max(0, width - payloadWidth)
  return span - Math.min(span, Math.floor(clamp(fraction, 0, 1) * (span + 1)))
}

function pad(n: number): FxRun {
  return { text: ' '.repeat(Math.max(0, n)) }
}

/** Shared impact/fade at the left edge: `early` glyphs for the first half
 *  of impactMs, `late` for the second, null when spent. */
function impactBurst(
  impactElapsed: number,
  impactMs: number,
  width: number,
  color: string,
  early = '✺',
  late = '·',
): FxRun[] | null {
  if (impactElapsed >= impactMs) return null
  const glyphs = impactElapsed < impactMs / 2 ? early : late
  return [{ text: glyphs, color }, pad(width - glyphs.length)]
}

// ── Robin Hood: arrow with an impact thunk ─────────────────────────────
const arrowFx: ActionEffect = {
  drawMs: 300,
  travelMs: 800,
  impactMs: 200,
  render(elapsed, width) {
    const glyph = '←──«'
    if (width < glyph.length + 1) return null
    if (elapsed >= this.travelMs) {
      return impactBurst(elapsed - this.travelMs, this.impactMs, width, C.wood)
    }
    const x = leftPos(elapsed / this.travelMs, width, glyph.length)
    return [pad(x), { text: glyph, color: C.green }, pad(width - x - glyph.length)]
  },
}

// ── Kaio: charging orb, then a full-width energy wave ──────────────────
const kaioFx: ActionEffect = {
  drawMs: 500, // longer charge — the orb grows during this phase
  travelMs: 700,
  impactMs: 350,
  render(elapsed, width) {
    if (width < 8) return null
    if (elapsed < 0) return null
    if (elapsed >= this.travelMs) {
      // Crackle fade: residual energy at the left edge.
      return impactBurst(
        elapsed - this.travelMs,
        this.impactMs,
        width,
        C.beamEdge,
        '✺✧·',
        '· ·',
      )
    }
    // The beam FRONT advances right→left; behind it the beam is solid:
    // edge▒core█core▒edge, drawn from the front to the right edge.
    const front = leftPos(elapsed / this.travelMs, width, 1)
    const beamLen = width - front
    if (beamLen <= 0) return null
    const runs: FxRun[] = [pad(front)]
    // Head of the beam is the white-hot core; body alternates core/edge
    // for a crackling look that shimmers as the front advances.
    const head = Math.min(2, beamLen)
    runs.push({ text: '█'.repeat(head), color: C.beamCore })
    let remaining = beamLen - head
    let block = 3
    let bright = false
    while (remaining > 0) {
      const n = Math.min(block, remaining)
      runs.push({
        text: (bright ? '█' : '▓').repeat(n),
        color: bright ? C.beamCore : C.beamEdge,
      })
      remaining -= n
      bright = !bright
      block = 4
    }
    return runs
  },
}

// ── Strawhat: stretchy punch — extends, hits, snaps back ───────────────
const strawhatFx: ActionEffect = {
  drawMs: 300,
  travelMs: 900, // 0..450 extend, 450..900 retract
  impactMs: 0, // the hit happens mid-travel, not after
  render(elapsed, width) {
    if (width < 4) return null
    if (elapsed >= this.travelMs) return null
    const half = this.travelMs / 2
    const extendFraction =
      elapsed < half ? elapsed / half : (this.travelMs - elapsed) / half
    const fist = '●'
    const x = leftPos(extendFraction, width, fist.length)
    const armLen = Math.max(0, width - x - fist.length)
    const hit = elapsed >= half - 60 && elapsed < half + 120
    const runs: FxRun[] = []
    if (hit && x > 0) {
      runs.push(pad(x - 1), { text: '✺', color: C.burst })
    } else {
      runs.push(pad(x))
    }
    runs.push({ text: fist, color: C.skin })
    if (armLen > 0) {
      runs.push({ text: '━'.repeat(armLen), color: C.skin })
    }
    return runs
  },
}

// ── Merlin: twinkling sparkle stream with a starburst ──────────────────
const SPARKLES = ['✦', '✧', '·', '˚']
const merlinFx: ActionEffect = {
  drawMs: 300,
  travelMs: 800,
  impactMs: 250,
  render(elapsed, width) {
    if (width < 6) return null
    if (elapsed >= this.travelMs) {
      return impactBurst(
        elapsed - this.travelMs,
        this.impactMs,
        width,
        C.spark,
        '✺✧',
        '˚·',
      )
    }
    // A comet of sparkles: head advances, trail twinkles behind it.
    const head = leftPos(elapsed / this.travelMs, width, 1)
    const phase = Math.floor(elapsed / 100)
    const runs: FxRun[] = [pad(head)]
    const trailLen = Math.min(10, width - head - 1)
    runs.push({ text: '✦', color: C.spark })
    let cells = ''
    for (let i = 0; i < trailLen; i++) {
      cells += i % 2 === phase % 2 ? SPARKLES[(i + phase) % SPARKLES.length]! : ' '
    }
    if (cells) runs.push({ text: cells, color: C.sparkDim })
    runs.push(pad(width - head - 1 - trailLen))
    return runs
  },
}

// ── Kage: spinning shuriken ─────────────────────────────────────────────
const SHURIKEN = ['✕', '✖', '✦', '✖']
const kageFx: ActionEffect = {
  drawMs: 200, // ninjas are fast
  travelMs: 600,
  impactMs: 200,
  render(elapsed, width) {
    if (width < 3) return null
    if (elapsed >= this.travelMs) {
      return impactBurst(elapsed - this.travelMs, this.impactMs, width, C.steel)
    }
    const glyph = SHURIKEN[Math.floor(elapsed / 80) % SHURIKEN.length]!
    const x = leftPos(elapsed / this.travelMs, width, 1)
    return [pad(x), { text: glyph, color: C.steel }, pad(width - x - 1)]
  },
}

// ── Ember: fire cone with warm gradient, scorches out ──────────────────
const emberFx: ActionEffect = {
  drawMs: 300,
  travelMs: 750,
  impactMs: 300,
  render(elapsed, width) {
    if (width < 8) return null
    if (elapsed >= this.travelMs) {
      return impactBurst(
        elapsed - this.travelMs,
        this.impactMs,
        width,
        C.flameDim,
        '▒░·',
        '· ·',
      )
    }
    // Flame cone: hot core at the front, cooling tail behind it. The cone
    // detaches from the mouth and travels (length capped).
    const front = leftPos(elapsed / this.travelMs, width, 1)
    const coneLen = Math.min(12, width - front)
    const runs: FxRun[] = [pad(front)]
    for (let i = 0; i < coneLen; i++) {
      const heat = i / coneLen
      runs.push(
        heat < 0.25
          ? { text: '█', color: C.flameCore }
          : heat < 0.6
            ? { text: '▓', color: C.flameMid }
            : { text: '▒', color: C.flameDim },
      )
    }
    runs.push(pad(width - front - coneLen))
    return runs
  },
}

// ── Corsair: cannonball with smoke trail ────────────────────────────────
const corsairFx: ActionEffect = {
  drawMs: 300,
  travelMs: 650,
  impactMs: 300,
  render(elapsed, width) {
    if (width < 6) return null
    if (elapsed >= this.travelMs) {
      return impactBurst(
        elapsed - this.travelMs,
        this.impactMs,
        width,
        C.burst,
        '✺✺',
        '° ˚',
      )
    }
    const x = leftPos(elapsed / this.travelMs, width, 1)
    const runs: FxRun[] = [pad(x), { text: '●', color: 'rgb(60,60,64)' }]
    const trailLen = Math.min(6, width - x - 1)
    if (trailLen > 0) {
      runs.push({
        text: '°˚· ˚·'.slice(0, trailLen),
        color: C.smoke,
      })
    }
    runs.push(pad(width - x - 1 - trailLen))
    return runs
  },
}

export const ACTION_EFFECTS: Partial<Record<Species, ActionEffect>> = {
  [robinhood]: arrowFx,
  [kaio]: kaioFx,
  [strawhat]: strawhatFx,
  [merlin]: merlinFx,
  [kage]: kageFx,
  [ember]: emberFx,
  [corsair]: corsairFx,
}

export function getActionEffect(species: Species): ActionEffect | undefined {
  return ACTION_EFFECTS[species]
}
