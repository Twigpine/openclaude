import chalk from 'chalk'
import type { FxRun } from './actionEffects.js'
import { createHeroRaster, HERO_PALETTE, type HeroRaster, type PaletteKey } from './heroCanvas.js'
import { HERO_ART } from './heroForms.js'
import { drawMoodExtras, type HeroMood, heroPose } from './heroMoods.js'
import type { Form } from './types.js'

// The sprite beside the prompt: the 48×40 design drawn at half scale, 24×20
// pixels, which half-block cells show as 24 columns × 10 rows.
export const HERO_SPRITE_SCALE = 0.5
export const HERO_SPRITE_COLS = 24

/**
 * Draw one frame of a hero as rows of palette keys ('.' = transparent).
 * `t` is seconds on the mood's own clock; the same inputs always give the
 * same frame.
 */
export function renderHero(
  form: Form,
  mood: HeroMood,
  t: number,
  scale: number = HERO_SPRITE_SCALE,
): string[] {
  // Keep the outline about one design pixel thick at any size.
  return drawHero(form, mood, t, scale).finish(Math.max(1, Math.round(scale)))
}

/** Draw a hero onto a raster without finishing it (no outline yet). */
export function drawHero(form: Form, mood: HeroMood, t: number, scale: number): HeroRaster {
  const raster = createHeroRaster(scale)
  const { pose, flip } = heroPose(mood, t)
  HERO_ART[form](raster.canvas, pose, t)
  if (flip) raster.flip()
  drawMoodExtras(raster.canvas, mood, t)
  return raster
}

export type PixelRun = FxRun & { backgroundColor?: string }

function colorOf(key: string): string | undefined {
  return key === '.' ? undefined : HERO_PALETTE[key as PaletteKey]
}

/**
 * Turn pixel rows into terminal rows: each cell shows two stacked pixels via
 * '▀' (foreground = top, background = bottom). Adjacent identical cells merge
 * into one run to keep the Text node count low.
 */
export function toHalfBlockRows(pixels: readonly string[]): PixelRun[][] {
  const rows: PixelRun[][] = []
  for (let y = 0; y < pixels.length; y += 2) {
    const top = pixels[y]!
    const bottom = pixels[y + 1] ?? ''
    const runs: PixelRun[] = []
    for (let x = 0; x < top.length; x++) {
      const topColor = colorOf(top[x]!)
      const bottomColor = colorOf(bottom[x] ?? '.')
      let cell: PixelRun
      if (topColor === undefined && bottomColor === undefined) cell = { text: ' ' }
      else if (topColor !== undefined && bottomColor !== undefined) {
        cell = { text: '▀', color: topColor, backgroundColor: bottomColor }
      } else if (topColor !== undefined) cell = { text: '▀', color: topColor }
      else cell = { text: '▄', color: bottomColor }
      const prev = runs[runs.length - 1]
      if (
        prev !== undefined &&
        prev.color === cell.color &&
        prev.backgroundColor === cell.backgroundColor &&
        prev.text[prev.text.length - 1] === cell.text
      ) {
        prev.text += cell.text
      } else {
        runs.push(cell)
      }
    }
    rows.push(runs)
  }
  return rows
}

// The sprite re-renders with its parent as well as on its own clock, so keep
// the last frame: an unchanged (form, mood, t) costs nothing.
let lastFrame: { key: string; rows: PixelRun[][] } | undefined

export function heroSpriteRows(form: Form, mood: HeroMood, t: number): PixelRun[][] {
  const key = `${form}:${mood}:${t}`
  if (lastFrame?.key === key) return lastFrame.rows
  const rows = toHalfBlockRows(renderHero(form, mood, t))
  lastFrame = { key, rows }
  return rows
}

/** True when the terminal can show colored pixel art (chalk approximates
 *  rgb() at level 2; below that the art would print as uncolored blocks). */
export function isPixelColorCapable(): boolean {
  return chalk.level >= 2
}
