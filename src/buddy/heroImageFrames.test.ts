import { describe, expect, test } from 'bun:test'
import { HERO_IMAGE_ROWS, heroImageColumns, heroImageFrame } from './heroImageFrames.js'

const cell = { width: 8, height: 16 }

describe('hero image frames', () => {
  test('columns keep the 48:40 shape at the image height', () => {
    expect(heroImageColumns(cell)).toBe(Math.ceil((HERO_IMAGE_ROWS * 16 * 48) / 40 / 8))
    expect(heroImageColumns({ width: 16, height: 34 })).toBe(11)
  })

  test('frames are cached per quantised time and wrap with the loop', () => {
    const a = heroImageFrame('twig', 'idle', 1.01, cell)
    expect(heroImageFrame('twig', 'idle', 0.98, cell)).toBe(a)
    expect(heroImageFrame('twig', 'idle', 1.0 + 6.2, cell)).toBe(a)
    expect(heroImageFrame('twig', 'idle', 1.2, cell).key).not.toBe(a.key)
    expect(heroImageFrame('keynote', 'idle', 1.0, cell).key).not.toBe(a.key)
  })

  test('a frame deletes the previous image, then draws at the box size', () => {
    const f = heroImageFrame('kaio', 'happy', 0.4, cell)
    expect(f.rows).toBe(HERO_IMAGE_ROWS)
    expect(f.draw.startsWith('\x1b_Ga=d,d=I,')).toBe(true)
    expect(f.draw).toContain(`c=${f.columns},r=${f.rows},C=1,q=2`)
  })
})
