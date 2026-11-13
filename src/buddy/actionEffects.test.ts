import { describe, expect, test } from 'bun:test'
import {
  ACTION_EFFECTS,
  effectTotalMs,
  getActionEffect,
} from './actionEffects.js'
import { FORMS, type Form } from './types.js'

const WIDTH = 80

describe('action effects', () => {
  test('every hero form has a signature effect', () => {
    for (const species of FORMS) {
      expect(getActionEffect(species)).toBeDefined()
    }
  })

  for (const [species, fx] of Object.entries(ACTION_EFFECTS)) {
    describe(species, () => {
      test('phases are sane', () => {
        expect(fx.drawMs).toBeGreaterThan(0)
        expect(fx.travelMs).toBeGreaterThan(0)
        expect(fx.impactMs).toBeGreaterThanOrEqual(0)
        expect(effectTotalMs(fx)).toBe(fx.drawMs + fx.travelMs + fx.impactMs)
      })

      test('rows sum to exactly the row width at every 50ms sample', () => {
        for (
          let t = 0;
          t < fx.travelMs + fx.impactMs;
          t += 50
        ) {
          const runs = fx.render(t, WIDTH)
          if (runs === null) continue
          const total = runs.reduce((n, r) => n + r.text.length, 0)
          if (total !== WIDTH) {
            throw new Error(`${species} at t=${t}: row is ${total} wide`)
          }
        }
      })

      test('finishes: null after travel+impact', () => {
        expect(fx.render(fx.travelMs + fx.impactMs, WIDTH)).toBeNull()
        expect(fx.render(fx.travelMs + fx.impactMs + 500, WIDTH)).toBeNull()
      })

      test('too-narrow rows render nothing', () => {
        expect(fx.render(0, 2)).toBeNull()
      })

      test('colors are rgb() strings', () => {
        for (let t = 0; t < fx.travelMs; t += 100) {
          for (const run of fx.render(t, WIDTH) ?? []) {
            if (run.color !== undefined) {
              expect(run.color.startsWith('rgb(')).toBe(true)
            }
          }
        }
      })
    })
  }

  test('projectile heads travel right→left where applicable', () => {
    // The arrow, shuriken, cannonball and acorn have a single distinct head glyph
    // whose position must be non-increasing over time.
    for (const [species, head] of [
      ['robinhood', '←'],
      ['kage', null], // glyph rotates — use first non-space run position
      ['corsair', '●'],
      ['twig', '●'],
    ] as const) {
      const fx = ACTION_EFFECTS[species as Form]!
      let prev = Number.POSITIVE_INFINITY
      for (let t = 0; t < fx.travelMs; t += 50) {
        const runs = fx.render(t, WIDTH)!
        let pos = 0
        for (const run of runs) {
          if (run.color !== undefined && run.text.trim() !== '') break
          pos += run.text.length
        }
        if (head !== null) {
          const row = runs.map(r => r.text).join('')
          expect(row.indexOf(head)).toBe(pos)
        }
        expect(pos).toBeLessThanOrEqual(prev)
        prev = pos
      }
    }
  })

  test('strawhat punch extends then retracts', () => {
    const fx = ACTION_EFFECTS['strawhat' as Form]!
    const posAt = (t: number): number => {
      const runs = fx.render(t, WIDTH)!
      let pos = 0
      for (const run of runs) {
        if (run.color !== undefined && run.text.trim() !== '') break
        pos += run.text.length
      }
      return pos
    }
    const mid = fx.travelMs / 2
    expect(posAt(mid - 50)).toBeLessThan(posAt(0)) // extending left
    expect(posAt(fx.travelMs - 50)).toBeGreaterThan(posAt(mid + 50)) // snapping back
  })
})
