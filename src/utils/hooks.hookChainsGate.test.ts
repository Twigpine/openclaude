import { afterEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'

const dispatchSpy = mock((_args: unknown) => Promise.resolve())

// Partial mock over a cache-busted real import so unrelated exports stay
// intact and mock.module (process-global) can be restored after the file.
const realHookChains = {
  ...(await import(`./hookChains.js?real=${Date.now()}`)),
}
mock.module('./hookChains.js', () => ({
  ...realHookChains,
  dispatchHookChainsForEvent: dispatchSpy,
}))

const { executeTaskCompletedHooks } = await import('./hooks.js')

afterEach(() => {
  mock.module('./hookChains.js', () => realHookChains)
})

describe('HOOK_CHAINS dispatch gate', () => {
  test('executeTaskCompletedHooks dispatches to hook chains only when the flag is on', async () => {
    dispatchSpy.mockClear()

    for await (const _ of executeTaskCompletedHooks('task-1', 'subject')) {
      // drain the generator so the post-hooks dispatch runs
    }

    if (feature('HOOK_CHAINS')) {
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ eventName: 'TaskCompleted' }),
        }),
      )
    } else {
      expect(dispatchSpy).not.toHaveBeenCalled()
    }
  })
})
