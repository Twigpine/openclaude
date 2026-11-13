import { drawHero } from './heroArt.js'
import { HERO_PALETTE } from './heroCanvas.js'
import { type HeroMood, heroPose } from './heroMoods.js'
import { encodePng } from './png.js'
import type { Form } from './types.js'

// Hero frames as PNG, for terminals that draw images. The art is made of
// shapes, so instead of enlarging the 48×40 pixel sprite (which terminals
// then blur) it is drawn directly at the target size, supersampled and
// averaged down for smooth anti-aliased edges.

/** Each output pixel averages a block of supersample × supersample. */
const DEFAULT_SUPERSAMPLE = 4

const RGB = new Map<string, readonly [number, number, number]>(
  Object.entries(HERO_PALETTE).map(([key, hex]) => [
    key,
    [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ] as const,
  ]),
)

/** Outline colour = this share of the outline ink, the rest from the
 *  neighbouring fill: a darker shade of each part instead of flat black. */
const OUTLINE_INK = 0.62
const INK = RGB.get('K')!

/**
 * One hero frame, `height` pixels tall (width keeps the 48:40 shape), with
 * anti-aliased edges, outlines tinted by the colour they wrap, and a soft
 * ground shadow. Transparent where nothing is drawn. Lower `supersample`
 * when the terminal will shrink the image anyway.
 */
export function renderHeroImage(
  form: Form,
  mood: HeroMood,
  t: number,
  height: number,
  supersample: number = DEFAULT_SUPERSAMPLE,
): { width: number; height: number; rgba: Uint8Array } {
  const ss = Math.max(1, Math.round(supersample))
  const scale = (height / 40) * ss
  const raster = drawHero(form, mood, t, scale)
  const { rows, source } = raster.finishWithSources(Math.max(1, Math.round(scale * 0.8)))
  const srcW = raster.width
  const keyAt = (i: number): string => rows[Math.floor(i / srcW)]![i % srcW]!
  const outH = Math.floor(rows.length / ss)
  const outW = Math.floor(srcW / ss)
  const rgba = new Uint8Array(outW * outH * 4)
  const samples = ss * ss
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = 0; sy < ss; sy++) {
        const rowIndex = y * ss + sy
        const row = rows[rowIndex]!
        for (let sx = 0; sx < ss; sx++) {
          const col = x * ss + sx
          const key = row[col]!
          if (key === '.') continue
          let rgb = RGB.get(key)!
          if (key === 'K') {
            const from = source[rowIndex * srcW + col]!
            const fill = from >= 0 ? RGB.get(keyAt(from)) : undefined
            if (fill !== undefined) {
              rgb = [
                INK[0] * OUTLINE_INK + fill[0] * (1 - OUTLINE_INK),
                INK[1] * OUTLINE_INK + fill[1] * (1 - OUTLINE_INK),
                INK[2] * OUTLINE_INK + fill[2] * (1 - OUTLINE_INK),
              ]
            }
          }
          r += rgb[0]
          g += rgb[1]
          b += rgb[2]
          n++
        }
      }
      if (n === 0) continue
      const p = (y * outW + x) * 4
      rgba[p] = Math.round(r / n)
      rgba[p + 1] = Math.round(g / n)
      rgba[p + 2] = Math.round(b / n)
      rgba[p + 3] = Math.round((255 * n) / samples)
    }
  }
  addGroundShadow(rgba, outW, outH, mood, t)
  return { width: outW, height: outH, rgba }
}

/** A soft shadow under the feet, drawn behind the hero. It stays on the
 *  ground and shrinks as the hero jumps. */
function addGroundShadow(
  rgba: Uint8Array,
  width: number,
  height: number,
  mood: HeroMood,
  t: number,
): void {
  const { pose, flip } = heroPose(mood, t)
  const lift = Math.min(0.55, pose.jump / 12)
  const cx = ((flip ? 48 - 21.5 : 21.5) / 48) * width
  const cy = (38.6 / 40) * height
  const rx = (12.5 / 48) * width * (1 - lift)
  const ry = (1.6 / 40) * height * (1 - lift * 0.6)
  const strength = 0.32 * (1 - lift)
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    if (y < 0 || y >= height) continue
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (x < 0 || x >= width) continue
      const dx = (x + 0.5 - cx) / rx
      const dy = (y + 0.5 - cy) / ry
      const d = dx * dx + dy * dy
      if (d >= 1) continue
      const shadowA = strength * (1 - d) * (1 - d)
      const p = (y * width + x) * 4
      const a = rgba[p + 3]! / 255
      // Composite the hero over the shadow (shadow colour is black).
      const outA = a + shadowA * (1 - a)
      if (outA <= 0) continue
      for (let k = 0; k < 3; k++) rgba[p + k] = Math.round((rgba[p + k]! * a) / outA)
      rgba[p + 3] = Math.round(outA * 255)
    }
  }
}

/** One hero frame as a PNG file, `height` pixels tall. */
export function renderHeroPng(form: Form, mood: HeroMood, t: number, height: number): Buffer {
  const { width, height: h, rgba } = renderHeroImage(form, mood, t, height)
  return encodePng(width, h, rgba)
}
