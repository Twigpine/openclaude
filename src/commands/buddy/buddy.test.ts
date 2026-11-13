import { afterEach, expect, test } from 'bun:test'
import { type AppState, getDefaultAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { call } from './buddy.js'

function harness(): {
  context: LocalJSXCommandContext
  state: () => AppState
  version: () => number
} {
  let state = getDefaultAppState()
  const context = {
    getAppState: () => state,
    setAppState: (update: (prev: AppState) => AppState) => {
      state = update(state)
    },
  } as unknown as LocalJSXCommandContext
  return {
    context,
    state: () => state,
    version: () => state.companionConfigVersion ?? 0,
  }
}

const onDone = (() => {}) as LocalJSXCommandOnDone

afterEach(() => {
  saveGlobalConfig(current => ({
    ...current,
    companion: undefined,
    companionMuted: false,
  }))
})

// The sprite reads the companion config non-reactively and its clock is
// paused under reduced motion, so a config change that does not also change
// AppState would leave a stale (or muted-but-visible) sprite on screen.
test('every config-changing /buddy subcommand bumps the sprite config version', async () => {
  const h = harness()
  await call(onDone, h.context, '')
  expect(h.version()).toBe(1)
  for (const args of ['mute', 'unmute', 'set twig', 'set random', 'name Pip']) {
    const before = h.version()
    await call(onDone, h.context, args)
    expect(h.version(), args).toBe(before + 1)
  }
  expect(getGlobalConfig().companion?.name).toBe('Pip')
  expect(getGlobalConfig().companionMuted).toBe(false)
})

test('read-only and invalid subcommands leave the version alone', async () => {
  const h = harness()
  await call(onDone, h.context, '')
  const hatched = h.version()
  for (const args of ['status', 'help', 'set nobody', 'dance']) {
    await call(onDone, h.context, args)
  }
  expect(h.version()).toBe(hatched)
  expect(h.state().companionDanceAt).toBeNumber()
})

test('set accepts display names and old ids', async () => {
  const h = harness()
  await call(onDone, h.context, '')
  await call(onDone, h.context, 'set Nova')
  expect(getGlobalConfig().companion?.speciesOverride).toBe('kaio')
  await call(onDone, h.context, 'set strawhat')
  expect(getGlobalConfig().companion?.speciesOverride).toBe('strawhat')
})

test('dance under reduced motion says why instead of doing nothing', async () => {
  const h = harness()
  await call(onDone, h.context, '')
  h.context.setAppState(prev => ({
    ...prev,
    settings: { ...prev.settings, prefersReducedMotion: true },
  }))
  let said: string | undefined
  await call(((text?: string) => {
    said = text
  }) as LocalJSXCommandOnDone, h.context, 'dance')
  expect(said).toContain('reduced motion')
  expect(h.state().companionDanceAt).toBeUndefined()
})
