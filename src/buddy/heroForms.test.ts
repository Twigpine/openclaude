import { describe, expect, test } from 'bun:test'
import { renderHero } from './heroArt.js'
import { nearHand } from './heroForms.js'
import { heroPose } from './heroMoods.js'
import { keynote } from './types.js'

// Centre of Keynote's chip glow ('c', used only by the chip) in design units.
function chipCentre(rows: string[]): { x: number; y: number } {
  let x = 0
  let y = 0
  let n = 0
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] !== 'c') continue
      x += rx + 0.5
      y += ry + 0.5
      n++
    }
  })
  expect(n).toBeGreaterThan(0)
  return { x: x / n, y: y / n }
}

describe('Keynote', () => {
  // hello and the Enter wind-up raise the hand; idle and working rest it.
  for (const [mood, t] of [
    ['hello', 0.3],
    ['action', 0.2],
    ['idle', 0.5],
    ['working', 0.2],
  ] as const) {
    test(`the chip stays in the near hand (${mood})`, () => {
      const { pose } = heroPose(mood, t)
      const hand = nearHand(pose, t, -pose.jump)
      const chip = chipCentre(renderHero(keynote, mood, t, 1))
      expect(Math.abs(chip.x - hand.x)).toBeLessThan(2.5)
      expect(Math.abs(chip.y - hand.y)).toBeLessThan(3)
    })
  }

  test('the chip leaves the hand while thrown', () => {
    expect(renderHero(keynote, 'action', 1.4, 1).join('')).not.toContain('c')
  })
})
