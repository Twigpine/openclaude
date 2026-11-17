import { afterEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'

const registerSpy = mock((_hook: unknown) => {})

const SAVED = process.env.CLAUDE_CODE_SKILL_IMPROVEMENT

const realPostSampling = {
  ...(await import(`./postSamplingHooks.js?real=${Date.now()}`)),
}
mock.module('./postSamplingHooks.js', () => ({
  ...realPostSampling,
  registerPostSamplingHook: registerSpy,
}))

const { initSkillImprovement } = await import('./skillImprovement.js')

afterEach(() => {
  mock.module('./postSamplingHooks.js', () => realPostSampling)
  registerSpy.mockClear()
  if (SAVED === undefined) {
    delete process.env.CLAUDE_CODE_SKILL_IMPROVEMENT
  } else {
    process.env.CLAUDE_CODE_SKILL_IMPROVEMENT = SAVED
  }
})

describe('initSkillImprovement gate', () => {
  test('registers the post-sampling hook only when the flag and env opt-in are both on', () => {
    registerSpy.mockClear()
    process.env.CLAUDE_CODE_SKILL_IMPROVEMENT = '1'

    initSkillImprovement()

    if (feature('SKILL_IMPROVEMENT')) {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    } else {
      expect(registerSpy).not.toHaveBeenCalled()
    }
  })

  test('stays unregistered without the env opt-in even when the flag is on', () => {
    registerSpy.mockClear()
    delete process.env.CLAUDE_CODE_SKILL_IMPROVEMENT

    initSkillImprovement()

    expect(registerSpy).not.toHaveBeenCalled()
  })
})
