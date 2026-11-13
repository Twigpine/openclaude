import { describe, expect, test } from 'bun:test'
import {
  ACTION_CYCLE_S,
  actionPoseTime,
  advanceMoodClock,
  BIG_TASK_MS,
  HELLO_MS,
  heroPose,
  type MoodCues,
  moodFrameMs,
  resolveMood,
  SLEEP_AFTER_MS,
  startMoodClock,
} from './heroMoods.js'

const cues = (now: number, extra: Partial<MoodCues> = {}): MoodCues => ({
  now,
  shooting: false,
  petting: false,
  dancing: false,
  speaking: false,
  reducedMotion: false,
  ...extra,
})

describe('mood clock', () => {
  test('an unchanged activity returns the same clock', () => {
    const clock = startMoodClock('idle', 0)
    expect(advanceMoodClock(clock, 'idle', false, 500)).toBe(clock)
  })

  test('a short turn ends with a happy hop', () => {
    let clock = startMoodClock('idle', 0)
    clock = advanceMoodClock(clock, 'thinking', false, 10_000)
    clock = advanceMoodClock(clock, 'working', false, 12_000)
    expect(clock.busySince).toBe(10_000)
    clock = advanceMoodClock(clock, 'idle', false, 20_000)
    expect(clock.busySince).toBeNull()
    expect(resolveMood(clock, cues(20_100))).toBe('happy')
    expect(resolveMood(clock, cues(25_000))).toBe('idle')
  })

  test('a long turn ends in a celebration', () => {
    let clock = startMoodClock('idle', 0)
    clock = advanceMoodClock(clock, 'working', false, 10_000)
    clock = advanceMoodClock(clock, 'idle', false, 10_000 + BIG_TASK_MS)
    expect(resolveMood(clock, cues(10_000 + BIG_TASK_MS + 100))).toBe('celebrate')
  })

  test('a failed turn ends sad', () => {
    let clock = startMoodClock('idle', 0)
    clock = advanceMoodClock(clock, 'thinking', false, 10_000)
    clock = advanceMoodClock(clock, 'idle', true, 11_000)
    expect(resolveMood(clock, cues(11_100))).toBe('sad')
  })

  test('starting work cancels the afterglow', () => {
    let clock = startMoodClock('idle', 0)
    clock = advanceMoodClock(clock, 'thinking', false, 10_000)
    clock = advanceMoodClock(clock, 'idle', false, 11_000)
    clock = advanceMoodClock(clock, 'thinking', false, 11_200)
    expect(clock.afterglow).toBeNull()
    expect(resolveMood(clock, cues(11_300))).toBe('thinking')
  })
})

describe('resolveMood', () => {
  const idle = startMoodClock('idle', 0)

  test('says hello right after mounting, then idles', () => {
    expect(resolveMood(idle, cues(0))).toBe('hello')
    expect(resolveMood(idle, cues(HELLO_MS + 1))).toBe('idle')
  })

  test('a remount after the first greeting skips the wave', () => {
    expect(resolveMood(startMoodClock('idle', 5_000, false), cues(5_000))).toBe('idle')
  })

  test('falls asleep after five quiet minutes', () => {
    expect(resolveMood(idle, cues(SLEEP_AFTER_MS - 1))).toBe('idle')
    expect(resolveMood(idle, cues(SLEEP_AFTER_MS))).toBe('sleeping')
  })

  test('the Enter action wins over everything, then needing the user', () => {
    const waiting = startMoodClock('waiting', 0)
    expect(resolveMood(waiting, cues(HELLO_MS, { shooting: true }))).toBe('action')
    expect(resolveMood(waiting, cues(HELLO_MS, { petting: true, dancing: true }))).toBe('waiting')
  })

  test('petting beats dancing, and both beat idle moods', () => {
    expect(resolveMood(idle, cues(HELLO_MS + 1, { petting: true, dancing: true }))).toBe('happy')
    expect(resolveMood(idle, cues(SLEEP_AFTER_MS, { dancing: true }))).toBe('dance')
  })

  test('busy activity shows through', () => {
    expect(resolveMood(startMoodClock('working', 0), cues(HELLO_MS + 1))).toBe('working')
    expect(resolveMood(startMoodClock('thinking', 0), cues(0))).toBe('thinking')
  })

  test('reduced motion skips timed moods, which would never end on a frozen clock', () => {
    expect(resolveMood(idle, cues(0, { reducedMotion: true }))).toBe('idle')
    expect(resolveMood(idle, cues(SLEEP_AFTER_MS, { reducedMotion: true }))).toBe('idle')
    expect(resolveMood(startMoodClock('working', 0), cues(0, { reducedMotion: true }))).toBe('working')
  })

  test('a speech bubble gets a wave', () => {
    expect(resolveMood(idle, cues(HELLO_MS + 1, { speaking: true }))).toBe('hello')
  })
})

describe('poses', () => {
  test('the Enter action winds up, points, then smiles', () => {
    const phases = { drawMs: 300, travelMs: 700, impactMs: 200 }
    const windUp = heroPose('action', actionPoseTime(150, phases)).pose
    const release = heroPose('action', actionPoseTime(600, phases)).pose
    const after = heroPose('action', actionPoseTime(1150, phases)).pose
    expect(windUp.wave).toBe(true)
    expect(release.point).toBe(true)
    expect(after.eye).toBe('happy')
  })

  test('action time stays on the cycle and never goes backwards', () => {
    const phases = { drawMs: 300, travelMs: 650, impactMs: 300 }
    let last = -1
    for (let ms = 0; ms <= 1400; ms += 25) {
      const t = actionPoseTime(ms, phases)
      expect(t).toBeGreaterThanOrEqual(last)
      expect(t).toBeLessThan(ACTION_CYCLE_S)
      last = t
    }
  })

  test('hops squash on landing and stretch at the top', () => {
    const landed = heroPose('happy', 0).pose
    const top = heroPose('happy', Math.PI / 10).pose
    expect(landed.jump).toBe(0)
    expect(landed.sq).toBeGreaterThan(0)
    expect(top.jump).toBeGreaterThan(4)
    expect(top.sq).toBeLessThan(0)
  })

  test('calm moods redraw less often than busy ones', () => {
    expect(moodFrameMs('idle')).toBeGreaterThan(moodFrameMs('working'))
    expect(moodFrameMs('sleeping')).toBeGreaterThan(moodFrameMs('idle'))
  })
})
