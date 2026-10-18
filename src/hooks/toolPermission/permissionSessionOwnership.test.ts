import { describe, expect, test } from 'bun:test'
import { asSessionId } from '../../types/ids.js'
import {
  buildInactivePermissionSessionDecision,
  createPermissionSessionStateGetter,
  isPermissionSessionActive,
} from './permissionSessionOwnership.js'

describe('permission session ownership', () => {
  test('keeps legacy and matching contexts active', () => {
    const session = asSessionId('session-a')
    expect(isPermissionSessionActive(undefined, session)).toBe(true)
    expect(isPermissionSessionActive(session, session)).toBe(true)
  })

  test('retains owner state while another session is active', () => {
    let activeSessionId = asSessionId('session-a')
    let liveState = { mode: 'default' }
    const getOwnedState = createPermissionSessionStateGetter(
      asSessionId('session-a'),
      liveState,
      () => liveState,
      () => activeSessionId,
    )

    liveState = { mode: 'dontAsk' }
    expect(getOwnedState()).toEqual({ mode: 'dontAsk' })

    activeSessionId = asSessionId('session-b')
    liveState = { mode: 'fullAccess' }
    expect(getOwnedState()).toEqual({ mode: 'dontAsk' })

    activeSessionId = asSessionId('session-a')
    expect(getOwnedState()).toEqual({ mode: 'fullAccess' })
  })

  test('does not seed an inactive owner from the active session', () => {
    let activeSessionId = asSessionId('session-b')
    let liveState = { mode: 'fullAccess' }
    const getOwnedState = createPermissionSessionStateGetter(
      asSessionId('session-a'),
      { mode: 'dontAsk' },
      () => liveState,
      () => activeSessionId,
    )

    expect(getOwnedState()).toEqual({ mode: 'dontAsk' })

    activeSessionId = asSessionId('session-a')
    liveState = { mode: 'default' }
    expect(getOwnedState()).toEqual({ mode: 'default' })
  })

  test('preserves an owner allow policy while the active session denies', () => {
    const getOwnedState = createPermissionSessionStateGetter(
      asSessionId('session-a'),
      { mode: 'fullAccess' },
      () => ({ mode: 'dontAsk' }),
      () => asSessionId('session-b'),
    )

    expect(getOwnedState()).toEqual({ mode: 'fullAccess' })
  })

  test('rejects a context owned by another session', () => {
    expect(
      isPermissionSessionActive(
        asSessionId('session-a'),
        asSessionId('session-b'),
      ),
    ).toBe(false)
    expect(buildInactivePermissionSessionDecision()).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'asyncAgent' },
    })
  })
})
