import { renderHeroImage } from './heroImage.js'
import type { HeroMood } from './heroMoods.js'
import { kittyDelete, kittyShowPng } from './kittyGraphics.js'
import { encodePng } from './png.js'
import type { Form } from './types.js'

// Ready-to-send image frames for the companion in terminals that draw
// images (kitty graphics protocol). Rendering a frame costs ~20 ms, so
// frames are cached: time is quantised to STEP_S and wrapped every LOOP_S,
// which bounds each mood to a fixed set of frames that are drawn once.

/** Terminal image id for the companion (any id unlikely to clash). */
export const COMPANION_IMAGE_ID = 7_171_702

/** Height of the image in terminal rows. */
export const HERO_IMAGE_ROWS = 4

/** Frames are drawn at twice the box's pixel size and the terminal halves
 *  them, which keeps edges smooth on standard and high-density screens. */
const OVERSAMPLE = 2
const LOOP_S = 6.2
const STEP_S = 0.1
const MAX_FRAMES = 600

export type CellSize = { width: number; height: number }

/** Columns the image needs for its 48:40 shape at HERO_IMAGE_ROWS rows. */
export function heroImageColumns(cell: CellSize): number {
  return Math.ceil((HERO_IMAGE_ROWS * cell.height * 48) / 40 / cell.width)
}

export type HeroImageFrame = {
  /** Identifies the picture; equal keys mean an identical frame. */
  key: string
  columns: number
  rows: number
  /** Delete the previous image and draw this one at the cursor. */
  draw: string
}

const cache = new Map<string, HeroImageFrame>()

export function heroImageFrame(form: Form, mood: HeroMood, t: number, cell: CellSize): HeroImageFrame {
  const tq = Math.round((t % LOOP_S) / STEP_S) * STEP_S
  const columns = heroImageColumns(cell)
  const rows = HERO_IMAGE_ROWS
  const key = `${form}:${mood}:${tq.toFixed(1)}:${cell.width}x${cell.height}`
  const hit = cache.get(key)
  if (hit) {
    // Refresh recency for the LRU bound below.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const boxW = columns * cell.width * OVERSAMPLE
  const boxH = rows * cell.height * OVERSAMPLE
  const art = renderHeroImage(form, mood, tq, boxH, 2)
  // Pad to whole cells, right-aligned: the hero stands at the edge, facing
  // the prompt.
  const rgba = new Uint8Array(boxW * boxH * 4)
  const width = Math.min(art.width, boxW)
  const left = boxW - width
  for (let y = 0; y < Math.min(art.height, boxH); y++) {
    rgba.set(art.rgba.subarray(y * art.width * 4, y * art.width * 4 + width * 4), (y * boxW + left) * 4)
  }
  const png = encodePng(boxW, boxH, rgba)
  const frame: HeroImageFrame = {
    key,
    columns,
    rows,
    draw:
      kittyDelete(COMPANION_IMAGE_ID) +
      kittyShowPng(png, { id: COMPANION_IMAGE_ID, columns, rows }),
  }
  cache.set(key, frame)
  if (cache.size > MAX_FRAMES) cache.delete(cache.keys().next().value!)
  return frame
}

/** Erases the companion image wherever it is. */
export const CLEAR_COMPANION_IMAGE = kittyDelete(COMPANION_IMAGE_ID)
