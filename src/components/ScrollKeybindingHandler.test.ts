import { describe, expect, test } from 'bun:test'
import { computeWheelStep, initWheelAccel } from './ScrollKeybindingHandler.js'

describe('computeWheelStep xterm.js path', () => {
  test('post-pause wheel steps scale with the configured base', () => {
    const slow = initWheelAccel(true, 1)
    const fast = initWheelAccel(true, 3)
    computeWheelStep(slow, 1, 0)
    computeWheelStep(fast, 1, 0)
    // A >500ms gap hits the idle-reset branch; the step scales with base
    // rather than falling back to a fixed multiplier of 2.
    expect(computeWheelStep(slow, 1, 1000)).toBe(2)
    expect(computeWheelStep(fast, 1, 1000)).toBe(6)
  })

  test('sustained scrolling scales the decay curve with base', () => {
    const slow = initWheelAccel(true, 1)
    const fast = initWheelAccel(true, 3)
    // Same-direction events under the 500ms idle threshold run the decay
    // curve; base scales both the step and the cap.
    const slowRows = [0, 100, 200].map(t => computeWheelStep(slow, 1, t))
    const fastRows = [0, 100, 200].map(t => computeWheelStep(fast, 1, t))
    expect(slowRows).toEqual([2, 3, 3])
    expect(fastRows).toEqual([6, 9, 9])
  })
})
