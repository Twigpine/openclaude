import { describe, expect, test } from 'bun:test'
import {
  renderFace,
  renderShootSprite,
  renderSprite,
  shootFrameCount,
  spriteFrameCount,
} from './sprites.js'
import {
  type CompanionBones,
  FORMS,
  type Form,
  robinhood,
} from './types.js'

const SPRITE_WIDTH = 12

function bones(species: Form): CompanionBones {
  return {
    rarity: 'common',
    species,
    eye: '·',
    hat: 'none',
    shiny: false,
    stats: { DEBUGGING: 1, PATIENCE: 1, CHAOS: 1, WISDOM: 1, SNARK: 1 },
  }
}

describe('sprites', () => {
  test('every form renders frames of uniform 12-col width', () => {
    for (const species of FORMS) {
      const frameCount = spriteFrameCount(species)
      expect(frameCount).toBeGreaterThanOrEqual(1)
      for (let frame = 0; frame < frameCount; frame++) {
        const lines = renderSprite(bones(species), frame)
        // Every hero keeps its headwear on row 0 — height is always 5.
        expect(lines.length).toBe(5)
        expect(lines[0]!.trim()).not.toBe('')
        for (const line of lines) {
          expect(line.length).toBe(SPRITE_WIDTH)
        }
      }
    }
  })

  test('robinhood keeps the cap row in every idle frame (stable 5-row height, hats suppressed)', () => {
    for (let frame = 0; frame < spriteFrameCount(robinhood); frame++) {
      const lines = renderSprite(bones(robinhood), frame)
      expect(lines.length).toBe(5)
      expect(lines[0]!.trim()).not.toBe('')
    }
    // A rolled hat must not replace the cap.
    const hatted = renderSprite({ ...bones(robinhood), hat: 'crown' }, 0)
    expect(hatted[0]).toBe(renderSprite(bones(robinhood), 0)[0]!)
  })

  test('renderShootSprite returns 5x12 frames for robinhood and clamps out-of-range', () => {
    for (const frame of [0, 1, 2]) {
      const lines = renderShootSprite(bones(robinhood), frame)
      expect(lines).not.toBeNull()
      expect(lines!.length).toBe(5)
      for (const line of lines!) {
        expect(line.length).toBe(SPRITE_WIDTH)
        expect(line).not.toContain('{E}')
      }
      expect(lines![0]!.trim()).not.toBe('')
    }
    // Clamps: past the end returns the loose pose, negative returns the nock.
    expect(renderShootSprite(bones(robinhood), 99)).toEqual(
      renderShootSprite(bones(robinhood), 2),
    )
    expect(renderShootSprite(bones(robinhood), -1)).toEqual(
      renderShootSprite(bones(robinhood), 0),
    )
  })

  test('every hero has line-art shoot frames of uniform width', () => {
    // Without these, low-color terminals would show a projectile flying out
    // of a motionless sprite.
    for (const species of FORMS) {
      expect(shootFrameCount(species)).toBeGreaterThanOrEqual(3)
      for (let frame = 0; frame < shootFrameCount(species); frame++) {
        const lines = renderShootSprite(bones(species), frame)
        expect(lines.length).toBe(5)
        for (const line of lines) {
          expect(line.length).toBe(SPRITE_WIDTH)
          expect(line).not.toContain('{E}')
        }
      }
    }
  })

  test('renderFace maps every species to its exact face', () => {
    const EXPECTED_FACES: Record<Form, string> = {
      robinhood: '«(·)',
      kaio: '\\(·)/',
      strawhat: '∩(·)',
      merlin: '^(·)',
      kage: '|··|',
      ember: '<··>',
      corsair: '(·x)',
      twig: '=(·)~',
    }
    for (const species of FORMS) {
      expect(renderFace(bones(species))).toBe(EXPECTED_FACES[species])
    }
    void robinhood
  })
})
