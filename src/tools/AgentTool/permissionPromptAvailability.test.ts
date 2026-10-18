import { describe, expect, test } from 'bun:test'
import {
  canDescendantShowPermissionPrompts,
  shouldAvoidAgentPermissionPrompts,
} from './permissionPromptAvailability.js'

describe('shouldAvoidAgentPermissionPrompts', () => {
  test('forwards async agent prompts through an interactive parent session', () => {
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: false,
      }),
    ).toBe(false)
  })

  test('keeps async agents fail-closed in non-interactive sessions', () => {
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      }),
    ).toBe(true)
  })

  test('propagates an interactive parent prompt through nested async agents', () => {
    const parentShouldAvoidPrompts = shouldAvoidAgentPermissionPrompts({
      isAsync: true,
      permissionMode: 'acceptEdits',
      isNonInteractiveSession: false,
    })

    expect(parentShouldAvoidPrompts).toBe(false)
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        canShowPermissionPrompts: !parentShouldAvoidPrompts,
        permissionMode: 'acceptEdits',
        // Async child contexts use this flag for query behavior, so prompt
        // capability must be propagated independently.
        isNonInteractiveSession: true,
      }),
    ).toBe(false)
  })

  test('does not advertise prompt capability through a sync headless agent', () => {
    const currentAgentShouldAvoidPrompts =
      shouldAvoidAgentPermissionPrompts({
        isAsync: false,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      })
    const descendantCanShowPrompts = canDescendantShowPermissionPrompts({
      permissionMode: 'acceptEdits',
      isNonInteractiveSession: true,
    })

    expect(currentAgentShouldAvoidPrompts).toBe(false)
    expect(descendantCanShowPrompts).toBe(false)
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        canShowPermissionPrompts: descendantCanShowPrompts,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      }),
    ).toBe(true)
  })

  test('preserves explicit and bubble capability for descendants', () => {
    expect(
      canDescendantShowPermissionPrompts({
        canShowPermissionPrompts: true,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      }),
    ).toBe(true)
    expect(
      canDescendantShowPermissionPrompts({
        canShowPermissionPrompts: false,
        permissionMode: 'bubble',
        isNonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      canDescendantShowPermissionPrompts({
        permissionMode: 'bubble',
        isNonInteractiveSession: true,
      }),
    ).toBe(true)
  })

  test('preserves synchronous and bubble prompt behavior', () => {
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: false,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      }),
    ).toBe(false)
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        permissionMode: 'bubble',
        isNonInteractiveSession: true,
      }),
    ).toBe(false)
  })

  test('honors an explicit caller override', () => {
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: true,
        canShowPermissionPrompts: true,
        permissionMode: 'acceptEdits',
        isNonInteractiveSession: true,
      }),
    ).toBe(false)
    expect(
      shouldAvoidAgentPermissionPrompts({
        isAsync: false,
        canShowPermissionPrompts: false,
        permissionMode: 'bubble',
        isNonInteractiveSession: false,
      }),
    ).toBe(true)
  })
})
