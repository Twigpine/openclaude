import { describe, expect, test } from 'bun:test'
import {
  HERO_SPRITE_COLS,
  heroSpriteRows,
  renderHero,
  toHalfBlockRows,
} from './heroArt.js'
import { HERO_PALETTE } from './heroCanvas.js'
import { HERO_MOODS } from './heroMoods.js'
import { FORMS } from './types.js'

const ALLOWED = new Set([...Object.keys(HERO_PALETTE), '.'])
const SAMPLE_TIMES = [0, 0.37, 1.3, 2.9, 6.1]

describe('hero art', () => {
  test('every form and mood draws a 24×20 frame of palette pixels', () => {
    for (const form of FORMS) {
      for (const mood of HERO_MOODS) {
        for (const t of SAMPLE_TIMES) {
          const rows = renderHero(form, mood, t)
          expect(rows.length).toBe(20)
          for (const row of rows) {
            expect(row.length).toBe(HERO_SPRITE_COLS)
            for (const px of row) {
              if (!ALLOWED.has(px)) {
                throw new Error(`${form}/${mood}@${t}: unknown pixel '${px}'`)
              }
            }
          }
        }
      }
    }
  })

  test('full scale draws the 48×40 design', () => {
    const rows = renderHero('twig', 'idle', 0.5, 1)
    expect(rows.length).toBe(40)
    expect(rows.every(r => r.length === 48)).toBe(true)
  })

  test('frames are deterministic', () => {
    for (const form of FORMS) {
      expect(renderHero(form, 'celebrate', 1.234)).toEqual(
        renderHero(form, 'celebrate', 1.234),
      )
    }
  })

  test('every hero is outlined and has visible eyes at idle', () => {
    for (const form of FORMS) {
      const pixels = renderHero(form, 'idle', 0.5).join('')
      expect(pixels).toContain('K')
      expect(pixels).toContain('E')
    }
  })

  test('moods change the picture', () => {
    for (const form of FORMS) {
      const idle = renderHero(form, 'idle', 0.5).join('\n')
      for (const mood of ['thinking', 'happy', 'sleeping', 'sad'] as const) {
        expect(renderHero(form, mood, 0.5).join('\n')).not.toBe(idle)
      }
    }
  })

  test('half-block rows are 10 rows of exactly 24 cells', () => {
    for (const form of FORMS) {
      const rows = toHalfBlockRows(renderHero(form, 'dance', 0.8))
      expect(rows.length).toBe(10)
      for (const runs of rows) {
        const width = runs.reduce((n, r) => n + r.text.length, 0)
        expect(width).toBe(HERO_SPRITE_COLS)
        for (const run of runs) {
          expect(run.text).toMatch(/^( +|▀+|▄+)$/)
        }
      }
    }
  })

  test('half blocks carry the top pixel as foreground and the bottom as background', () => {
    const rows = toHalfBlockRows(['K.', 'EK'])
    expect(rows).toEqual([
      [
        { text: '▀', color: HERO_PALETTE.K, backgroundColor: HERO_PALETTE.E },
        { text: '▄', color: HERO_PALETTE.K },
      ],
    ])
  })

  test('an unchanged frame is served from the last-frame cache', () => {
    const a = heroSpriteRows('kaio', 'working', 1.5)
    expect(heroSpriteRows('kaio', 'working', 1.5)).toBe(a)
    expect(heroSpriteRows('kaio', 'working', 1.6)).not.toBe(a)
  })
})
