// The eight hero characters, drawn from shapes in the 48×40 design space
// (see heroCanvas.ts). Every hero faces left, toward the prompt, and reads
// its body language from a HeroPose so one set of moods drives all of them.

import type { EyeStyle, HeroCanvas, MouthStyle, PaletteKey } from './heroCanvas.js'
import {
  corsair,
  ember,
  type Form,
  kage,
  kaio,
  merlin,
  robinhood,
  keynote,
  strawhat,
  twig,
} from './types.js'

export type HeroPose = {
  /** Height of a hop, in design pixels (positive = up). */
  jump: number
  /** Head offset. */
  hx: number
  hy: number
  /** Squash (positive) or stretch (negative) of the body. */
  sq: number
  eye: EyeStyle
  /** Glance: eyes shift left (-1) or right (1). */
  ex: number
  /** Tail, scarf and wing sway, -1 to 1 or a little beyond. */
  sway: number
  /** Arm pump while working. */
  arm: number
  wave: boolean
  point: boolean
  /** Ears and shoulders drop when sad or sleepy, 0 to 1. */
  droop: number
  mouth: MouthStyle
  /** Ear twitch at idle. */
  twitch: number
}

type DrawHero = (g: HeroCanvas, p: HeroPose, t: number) => void

type Outfit = {
  skin: PaletteKey
  cloth: PaletteKey
  sleeve: PaletteKey
  hand: PaletteKey
  legs: PaletteKey
  boots: PaletteKey
  /** Hides the mouth and blush (masks, beards). */
  plain?: boolean
  /** Covers the left eye (eyepatch). */
  patch?: boolean
  back?: (g: HeroCanvas, J: number, p: HeroPose, t: number) => void
  hat?: (g: HeroCanvas, hx: number, hy: number, t: number) => void
  chest?: (g: HeroCanvas, J: number, t: number) => void
  front?: (g: HeroCanvas, J: number, t: number, p: HeroPose) => void
}

/** Shared body for the four human-shaped heroes and Nova. */
function human(g: HeroCanvas, p: HeroPose, t: number, o: Outfit): void {
  const J = -p.jump
  const hx = 21 + p.hx
  const hy = 16 + J + p.hy
  const s = p.sq
  o.back?.(g, J, p, t)
  g.ell(17, 37 + J, 3, 1.8, o.boots)
  g.ell(26, 37 + J, 3, 1.8, o.boots)
  g.cap(18, 33 + J, 18, 35 + J, 1.8, o.legs)
  g.cap(25, 33 + J, 25, 35 + J, 1.8, o.legs)
  g.ell(21.5, 29.5 + J + s * 2, 7 + s * 1.5, 6 - s * 1.5, o.cloth)
  o.chest?.(g, J + s * 2, t)
  if (p.point) {
    g.cap(14, 27 + J, 7, 26 + J, 1.7, o.sleeve)
    g.ell(5.5, 26 + J, 1.6, 1.6, o.hand)
  } else if (p.wave) {
    const wy = Math.sin(t * 10) * 2
    g.cap(14, 27 + J, 9, 21 + J + wy, 1.7, o.sleeve)
    g.ell(8.5, 20 + J + wy, 1.6, 1.6, o.hand)
  } else {
    g.cap(14, 27 + J, 12.5, 31 + J + p.arm, 1.7, o.sleeve)
    g.ell(12.5, 32.5 + J + p.arm, 1.5, 1.5, o.hand)
  }
  g.cap(29, 27 + J, 30.5, 31 + J - p.arm, 1.7, o.sleeve)
  g.ell(30.5, 32.5 + J - p.arm, 1.5, 1.5, o.hand)
  g.ell(hx, hy, 10.5, 9.5, o.skin)
  o.hat?.(g, hx, hy, t)
  if (!o.plain) {
    g.blush(hx - 8, hy + 3.5)
    g.blush(hx + 5.5, hy + 3.5)
    g.mouth(hx - 2.5, hy + 5, p.mouth)
  }
  if (!o.patch) g.eye(hx - 6 + p.ex, hy + 0.5, p.eye)
  g.eye(hx + 3 + p.ex, hy + 0.5, p.eye)
  o.front?.(g, J, t, p)
}

/** Paw or claw on the near side: points, waves or rests. */
function frontLimb(g: HeroCanvas, p: HeroPose, t: number, J: number, c: PaletteKey): void {
  if (p.point) g.cap(13, 28 + J, 6, 26 + J, 1.8, c)
  else if (p.wave) g.cap(13, 28 + J, 8, 22 + J + Math.sin(t * 10) * 2, 1.8, c)
  else g.ell(13, 29.5 + J + p.arm, 2, 3, c)
}

const drawTwig: DrawHero = (g, p, t) => {
  const J = -p.jump
  const hx = 20 + p.hx
  const hy = 16 + J + p.hy
  const s = p.sq
  const sw = p.sway * 2
  const ed = p.droop * 2
  // Tail first, behind the body: a long curl with a cream tip.
  g.cap(29, 33 + J, 37, 31 + J, 3.2, 'D')
  g.cap(37, 31 + J, 41 + sw * 0.5, 23 + J, 3.6, 'B')
  g.cap(41 + sw * 0.5, 23 + J, 38.5 + sw, 16 + J, 3.4, 'B')
  g.ell(38.5 + sw, 14.5 + J, 3, 3, 'C')
  g.ell(16, 37 + J, 3.2, 1.8, 'D')
  g.ell(26, 37 + J, 3.2, 1.8, 'D')
  g.ell(21, 30 + J + s * 2, 8 + s * 2, 7 - s * 2, 'B')
  g.ell(19.5, 31 + J + s * 2, 5 + s, 5 - s * 1.5, 'C')
  frontLimb(g, p, t, J, 'D')
  g.ell(28, 29.5 + J - p.arm, 2, 3, 'D')
  g.ell(hx - 8, hy - 8 + ed, 3.6, 4, 'B')
  g.ell(hx - 8, hy - 7.5 + ed, 1.8, 2.2, 'P')
  g.ell(hx + 8 + p.twitch, hy - 8 + ed - p.twitch, 3.6, 4, 'B')
  g.ell(hx + 8 + p.twitch, hy - 7.5 + ed - p.twitch, 1.8, 2.2, 'P')
  g.ell(hx, hy, 11, 9.5, 'B')
  g.ell(hx - 3, hy - 5, 6, 2.6, 'b')
  g.ell(hx - 3, hy + 4.8, 6.2, 4, 'C')
  g.ell(hx - 4.5, hy + 2.6, 1.6, 1.1, 'N')
  g.mouth(hx - 5.5, hy + 5.5, p.mouth)
  g.blush(hx + 6.5, hy + 3.8)
  g.eye(hx - 7 + p.ex, hy - 0.5, p.eye)
  g.eye(hx + 2.5 + p.ex, hy - 0.5, p.eye)
}

const drawRobin: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'S',
    cloth: 'g',
    sleeve: 'G',
    hand: 'S',
    legs: 'H',
    boots: 'D',
    hat(g, hx, hy) {
      g.ell(hx + 8.5, hy, 2.4, 4.5, 'H')
      g.poly(
        [
          [hx - 12, hy - 4],
          [hx - 9, hy - 10],
          [hx, hy - 12.5],
          [hx + 8, hy - 11],
          [hx + 13, hy - 6],
          [hx + 13, hy - 4],
        ],
        'G',
      )
      g.poly(
        [
          [hx - 11, hy - 4],
          [hx - 17, hy - 3],
          [hx - 9, hy - 7],
        ],
        'G',
      )
      g.cap(hx - 6, hy - 9, hx + 2, hy - 10.5, 0.8, 'g')
      g.cap(hx + 7, hy - 9, hx + 13, hy - 15, 1.1, 'R')
    },
    chest(g, J) {
      g.cap(15.5, 32 + J, 27.5, 32 + J, 0.8, 'H')
      g.dot(21, 32 + J, 'Y')
      g.dot(22, 32 + J, 'Y')
    },
    front(g, J) {
      g.cap(7, 23 + J, 4.5, 30 + J, 0.7, 'H')
      g.cap(4.5, 30 + J, 7, 37 + J, 0.7, 'H')
      g.cap(7.5, 23 + J, 7.5, 37 + J, 0.3, 'X')
    },
  })

const drawMerlin: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'S',
    cloth: 'Q',
    sleeve: 'Q',
    hand: 'S',
    legs: 'Q',
    boots: 'D',
    plain: true,
    hat(g, hx, hy) {
      g.ell(hx - 1.5, hy + 7.5, 7, 5, 'w')
      g.poly(
        [
          [hx - 11, hy - 4.5],
          [hx + 11, hy - 4.5],
          [hx + 3, hy - 16],
        ],
        'Q',
      )
      g.cap(hx - 13, hy - 4.5, hx + 13, hy - 4.5, 1.3, 'Q')
      g.cap(hx - 9, hy - 6.5, hx + 9, hy - 6.5, 0.6, 'Y')
      g.dot(hx + 1, hy - 11, 'A')
      g.dot(hx + 4, hy - 9, 'A')
      g.ell(hx - 4, hy + 3.5, 3, 1.2, 'w')
      g.ell(hx + 2, hy + 3.5, 3, 1.2, 'w')
    },
    chest(g, J) {
      g.ell(21, 27 + J, 4, 3.5, 'w')
      g.cap(15, 34 + J, 28, 34 + J, 0.7, 'p')
    },
    front(g, J, t) {
      g.cap(7.5, 15 + J, 7.5, 37 + J, 0.8, 'H')
      g.ell(7.5, 12.5 + J, 2.3, 2.3, 'A')
      if (Math.floor(t * 4) % 2) {
        g.dot(4, 9 + J, 'A')
        g.dot(11, 10 + J, 'A')
      }
    },
  })

const drawKage: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'M',
    cloth: 'M',
    sleeve: 'n',
    hand: 'n',
    legs: 'n',
    boots: 'n',
    plain: true,
    back(g, J, p, t) {
      g.cap(31, 13 + J, 37, 6 + J, 0.8, 'X')
      g.cap(27, 25 + J, 36 + p.sway, 23 + J + Math.sin(t * 5), 1.5, 'R')
      g.cap(27, 26 + J, 34 + p.sway, 28 + J + Math.cos(t * 5), 1.2, 'R')
    },
    hat(g, hx, hy) {
      g.ell(hx - 1.5, hy + 0.5, 8.5, 3.4, 'S')
      g.cap(hx - 6, hy - 6, hx + 5, hy - 6.5, 0.5, 'n')
    },
    chest(g, J) {
      g.cap(15, 25 + J, 28, 25 + J, 1.6, 'R')
      g.cap(16, 32 + J, 27, 32 + J, 0.7, 'n')
    },
  })

const drawCorsair: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'S',
    cloth: 'V',
    sleeve: 'V',
    hand: 'S',
    legs: 'n',
    boots: 'D',
    patch: true,
    hat(g, hx, hy) {
      g.ell(hx + 8.5, hy, 2.4, 4.5, 'H')
      g.poly(
        [
          [hx - 14, hy - 4.5],
          [hx - 9, hy - 11],
          [hx, hy - 8.5],
          [hx + 9, hy - 12],
          [hx + 14, hy - 4.5],
        ],
        'V',
      )
      g.cap(hx - 13, hy - 4.5, hx + 13, hy - 4.5, 0.9, 'Y')
      g.ell(hx, hy - 7, 1.4, 1.2, 'w')
      g.ell(hx - 6, hy + 0.5, 2.5, 2.5, 'K')
      g.cap(hx - 10, hy - 2.5, hx + 9, hy - 3.5, 0.4, 'K')
    },
    chest(g, J) {
      g.ell(21.5, 29 + J, 2.4, 4.5, 'w')
      g.dot(18, 28 + J, 'Y')
      g.dot(18, 31 + J, 'Y')
      g.dot(25, 28 + J, 'Y')
      g.dot(25, 31 + J, 'Y')
    },
  })

const drawEmber: DrawHero = (g, p, t) => {
  const J = -p.jump
  const hx = 20 + p.hx
  const hy = 16 + J + p.hy
  const s = p.sq
  const sw = p.sway * 2
  const flap = Math.sin(t * 6) * 2
  g.poly(
    [
      [26, 24 + J],
      [39, 15 + J - flap],
      [41, 21 + J - flap * 0.5],
      [35, 27 + J],
    ],
    'F',
  )
  g.cap(29, 33 + J, 38, 34 + J, 2.6, 'F')
  g.cap(38, 34 + J, 43 + sw, 28 + J, 2, 'F')
  g.poly(
    [
      [40 + sw, 28 + J],
      [46.5 + sw, 27 + J],
      [43.5 + sw, 21 + J],
    ],
    'F',
  )
  g.poly(
    [
      [24, 23 + J],
      [28, 20 + J],
      [29, 25 + J],
    ],
    'F',
  )
  g.poly(
    [
      [27, 27 + J],
      [32, 25 + J],
      [31, 30 + J],
    ],
    'F',
  )
  g.ell(16, 37 + J, 3.2, 1.8, 'F')
  g.ell(26, 37 + J, 3.2, 1.8, 'F')
  g.ell(21, 30 + J + s * 2, 8 + s * 2, 7 - s * 2, 'd')
  g.ell(19.5, 31.5 + J + s * 2, 5 + s, 4.5 - s * 1.5, 'C')
  frontLimb(g, p, t, J, 'F')
  g.ell(28, 29.5 + J - p.arm, 2, 3, 'F')
  g.poly(
    [
      [hx - 10, hy - 6],
      [hx - 12, hy - 14],
      [hx - 5, hy - 8],
    ],
    'C',
  )
  g.poly(
    [
      [hx + 10, hy - 6],
      [hx + 12, hy - 14],
      [hx + 5, hy - 8],
    ],
    'C',
  )
  g.ell(hx, hy, 11, 9.5, 'd')
  g.ell(hx - 3, hy - 5, 6, 2.6, 'o')
  g.ell(hx - 4, hy + 4.8, 6.5, 3.8, 'o')
  g.ell(hx - 6.5, hy + 3.8, 0.6, 0.5, 'F')
  g.ell(hx - 2.5, hy + 3.8, 0.6, 0.5, 'F')
  g.mouth(hx - 5.5, hy + 6, p.mouth)
  g.eye(hx - 7 + p.ex, hy - 0.5, p.eye)
  g.eye(hx + 2.5 + p.ex, hy - 0.5, p.eye)
}

const drawNova: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'w',
    cloth: 'w',
    sleeve: 'X',
    hand: 'U',
    legs: 'X',
    boots: 'U',
    hat(g, hx, hy, t) {
      g.cap(hx + 5, hy - 9, hx + 8, hy - 14, 0.6, 'X')
      g.ell(hx + 8.5, hy - 14.5, 1.5, 1.5, Math.floor(t * 3) % 2 ? 'A' : 'O')
      g.ell(hx, hy, 11.5, 10.5, 'w')
      g.ell(hx - 1.5, hy + 0.8, 8.6, 6.6, 'u')
      g.cap(hx + 2, hy - 4, hx + 4.5, hy - 2.5, 0.5, 'W')
    },
    chest(g, J, t) {
      g.ell(21.5, 29.5 + J, 3.2, 2.6, 'U')
      g.dot(21, 29 + J, Math.floor(t * 3) % 2 ? 'A' : 'u')
      g.dot(22, 29 + J, 'u')
    },
  })

const drawInky: DrawHero = (g, p, t) => {
  const J = -p.jump
  const hx = 22 + p.hx
  const hy = 17 + J + p.hy
  const s = p.sq
  for (let i = 0; i < 5; i++) {
    const bx = 10 + i * 6
    const tx = bx + Math.sin(t * 3 + i * 1.3) * 1.8
    g.cap(bx, 28 + J + s, tx, 36 + J, 2, 'T')
    g.ell(tx, 37 + J, 1.6, 1.2, 't')
  }
  if (p.point) g.cap(10, 26 + J, 4, 24 + J, 2, 'T')
  else if (p.wave) {
    const wy = Math.sin(t * 10) * 2
    g.cap(10, 24 + J, 4.5, 16 + J + wy, 1.8, 'T')
    g.ell(4.5, 15 + J + wy, 1.6, 1.6, 't')
  }
  g.ell(hx, hy + 2 + s * 2, 13 + s, 12 - s * 2, 'T')
  g.ell(hx - 4, hy - 4.5 + s * 2, 6.5, 3.2, 't')
  g.ell(hx + 7.5, hy - 4 + s * 2, 1.6, 1.2, 't')
  const ey = hy + 3 + s * 2
  g.blush(hx - 10, ey + 3.5)
  g.blush(hx + 6.5, ey + 3.5)
  g.mouth(hx - 3, ey + 4, p.mouth)
  g.eye(hx - 7 + p.ex, ey, p.eye)
  g.eye(hx + 3 + p.ex, ey, p.eye)
}

// The stage presenter: salt-and-pepper hair, a shiny black leather jacket
// over a dark tee, and a glowing chip in hand.
const drawKeynote: DrawHero = (g, p, t) =>
  human(g, p, t, {
    skin: 'S',
    cloth: 'L',
    sleeve: 'L',
    hand: 'S',
    legs: 'n',
    boots: 'L',
    hat(g, hx, hy) {
      // Short salt-and-pepper hair, swept back, hairline above the brows.
      g.ell(hx + 1, hy - 6.6, 10.4, 4.4, 'h')
      g.ell(hx + 5.5, hy - 5.8, 6.4, 4.4, 'h')
      g.ell(hx + 9.4, hy - 2, 1.5, 3, 'a')
      g.cap(hx - 7.5, hy - 4.6, hx - 1, hy - 7.2, 0.9, 'h')
      // Tufts along the hairline so it reads as hair, not a cap.
      g.ell(hx - 8.2, hy - 3.6, 1.9, 1.6, 'h')
      g.ell(hx - 5.2, hy - 4.3, 2.1, 1.7, 'h')
      g.ell(hx - 2, hy - 4.7, 1.9, 1.5, 'h')
      g.cap(hx - 2, hy - 9, hx + 7, hy - 8.6, 0.4, 'w')
      g.cap(hx + 2, hy - 6.4, hx + 9, hy - 5.4, 0.35, 'a')
    },
    chest(g, J, t) {
      // Collar, dark tee in the open jacket, lapels, a drifting sheen.
      g.poly(
        [
          [16.5, 23.5 + J],
          [19.5, 24.5 + J],
          [18.5, 27 + J],
        ],
        'L',
      )
      g.poly(
        [
          [26.5, 23.5 + J],
          [23.5, 24.5 + J],
          [24.5, 27 + J],
        ],
        'L',
      )
      g.poly(
        [
          [18.5, 24.5 + J],
          [24.5, 24.5 + J],
          [22.6, 33 + J],
          [20.4, 33 + J],
        ],
        'n',
      )
      g.cap(18.4, 24.8 + J, 20.2, 31.5 + J, 0.5, 'l')
      g.cap(24.6, 24.8 + J, 22.8, 31.5 + J, 0.5, 'l')
      const glint = Math.sin(t * 1.3) * 1.2
      g.cap(15.6, 26.5 + J + glint, 16.6, 30.5 + J + glint, 0.45, 'l')
      g.cap(27.4, 26.5 + J - glint, 26.6, 30 + J - glint, 0.4, 'l')
    },
    front(g, J, t, p) {
      // The chip in the near hand, with pins and a soft pulsing glow. Gone
      // from the hand while it is thrown (the Enter effect carries it).
      if (p.point) return
      const pulse = 0.35 + 0.25 * Math.abs(Math.sin(t * 3))
      const cx = 11.8
      const cy = 34.4 + J + p.arm
      g.ell(cx, cy, 2.5 + pulse, 2.1 + pulse, 'c')
      for (const dx of [-1.1, 0, 1.1]) {
        g.cap(cx + dx, cy - 1.9, cx + dx, cy + 1.9, 0.22, 'X')
      }
      g.poly(
        [
          [cx - 1.7, cy - 1.3],
          [cx + 1.7, cy - 1.3],
          [cx + 1.7, cy + 1.3],
          [cx - 1.7, cy + 1.3],
        ],
        'n',
      )
      g.ell(cx, cy, 0.8, 0.55, 'c')
    },
  })

// A full Record so adding a form without art is a compile error.
export const HERO_ART: Record<Form, DrawHero> = {
  [twig]: drawTwig,
  [robinhood]: drawRobin,
  [merlin]: drawMerlin,
  [kage]: drawKage,
  [corsair]: drawCorsair,
  [ember]: drawEmber,
  [kaio]: drawNova,
  [strawhat]: drawInky,
  [keynote]: drawKeynote,
}
