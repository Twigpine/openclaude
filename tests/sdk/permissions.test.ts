import { describe, test, expect, vi } from 'bun:test'
import { z } from 'zod/v4'
import {
  buildPermissionContext,
  connectSdkMcpServers,
  createDefaultCanUseTool,
  createExternalCanUseTool,
  createOnceOnlyResolve,
  createPermissionTarget,
  NO_SESSION_PLACEHOLDER,
} from '../../src/entrypoints/sdk/permissions.js'
import type { PermissionResolveDecision } from '../../src/entrypoints/sdk/permissions.js'
import { getEmptyToolPermissionContext } from '../../src/Tool.js'
import { filterToolsByDenyRules } from '../../src/tools.js'

const sdkAskTool = {
  name: 'SDKAskTool',
  inputSchema: z.object({}),
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'confirm?',
      updatedInput: { normalized: true },
    }
  },
} as any

const sdkGuidanceTool = {
  name: 'SDKGuidanceTool',
  inputSchema: z.object({}),
  requiresUserInteraction() {
    return true
  },
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'Choose an option',
      updatedInput: { normalized: true },
    }
  },
} as any

function toolUseContextForPermissionMode(mode: string) {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        ...getEmptyToolPermissionContext(),
        mode,
        isBypassPermissionsModeAvailable:
          mode === 'bypassPermissions' || mode === 'fullAccess',
      },
    }),
  } as any
}

function mutableToolUseContextForPermissionMode(initialMode: string) {
  let mode = initialMode
  return {
    context: {
      abortController: new AbortController(),
      getAppState: () => ({
        toolPermissionContext: {
          ...getEmptyToolPermissionContext(),
          mode,
          isBypassPermissionsModeAvailable:
            mode === 'bypassPermissions' || mode === 'fullAccess',
        },
      }),
    } as any,
    setMode(nextMode: string) {
      mode = nextMode
    },
  }
}

const sdkConditionalTool = {
  name: 'SDKConditionalTool',
  inputSchema: z.object({ operation: z.enum(['read', 'write']) }),
  isReadOnly(input: { operation: 'read' | 'write' }) {
    return input.operation === 'read'
  },
} as any

describe('buildPermissionContext', () => {
  test('returns default mode when no permissionMode specified', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.mode).toBe('default')
  })

  test('maps plan mode correctly', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'plan' })
    expect(ctx.mode).toBe('plan')
  })

  test('maps auto-accept to acceptEdits', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'auto-accept' })
    expect(ctx.mode).toBe('acceptEdits')
  })

  test('maps acceptEdits mode', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', permissionMode: 'acceptEdits' })
    expect(ctx.mode).toBe('acceptEdits')
  })

  test('maps bypass-permissions mode', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      permissionMode: 'bypass-permissions',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.mode).toBe('bypassPermissions')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('maps bypassPermissions mode', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.mode).toBe('bypassPermissions')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('maps fullAccess mode', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      permissionMode: 'fullAccess',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.mode).toBe('fullAccess')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('maps full-access mode', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      permissionMode: 'full-access',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.mode).toBe('fullAccess')
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('rejects dangerous modes without allowDangerouslySkipPermissions', () => {
    expect(() =>
      buildPermissionContext({
        cwd: '/tmp',
        permissionMode: 'bypassPermissions',
      }),
    ).toThrow(
      'SDK permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions: true',
    )

    expect(() =>
      buildPermissionContext({
        cwd: '/tmp',
        permissionMode: 'fullAccess',
      }),
    ).toThrow(
      'SDK permissionMode "fullAccess" requires allowDangerouslySkipPermissions: true',
    )
  })

  test('default mode does not have bypass available', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.isBypassPermissionsModeAvailable).toBe(false)
  })

  test('allowDangerouslySkipPermissions sets bypass flag', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      allowDangerouslySkipPermissions: true,
    })
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true)
  })

  test('additionalDirectories are added to context', () => {
    const ctx = buildPermissionContext({
      cwd: '/tmp',
      additionalDirectories: ['/dir1', '/dir2'],
    })
    expect(ctx.additionalWorkingDirectories.has('/dir1')).toBe(true)
    expect(ctx.additionalWorkingDirectories.has('/dir2')).toBe(true)
  })

  test('empty additionalDirectories does nothing', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', additionalDirectories: [] })
    expect(ctx.additionalWorkingDirectories.size).toBe(0)
  })

  test('disallowedTools sets alwaysDenyRules.cliArg', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash', 'Edit'] })
    expect(ctx.alwaysDenyRules.cliArg).toEqual(['Bash', 'Edit'])
  })

  test('disallowedTools defaults to empty array', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    expect(ctx.alwaysDenyRules.cliArg).toEqual([])
  })
})

describe('disallowedTools tool filtering', () => {
  const baseTools = [{ name: 'Bash' }, { name: 'Read' }]

  test('Bash is excluded from the tool list when disallowed', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash'] })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    expect(tools.some(t => t.name === 'Bash')).toBe(false)
  })

  test('disallowedTools does not affect other tools', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp', disallowedTools: ['Bash'] })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    // Read tool should still be present
    expect(tools.some(t => t.name === 'Read')).toBe(true)
  })

  test('empty disallowedTools includes the tool list', () => {
    const ctx = buildPermissionContext({ cwd: '/tmp' })
    const tools = filterToolsByDenyRules(baseTools, ctx)
    expect(tools.some(t => t.name === 'Bash')).toBe(true)
  })
})

describe('createDefaultCanUseTool', () => {
  test('denies all tool uses', async () => {
    const ctx = getEmptyToolPermissionContext()
    const canUseTool = createDefaultCanUseTool(ctx)

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      { command: 'rm -rf /' },
      {} as any,
      {} as any,
      undefined,
      undefined,
    )

    expect(result.behavior).toBe('deny')
  })

  test('honors forceDecision when provided', async () => {
    const ctx = getEmptyToolPermissionContext()
    const canUseTool = createDefaultCanUseTool(ctx)

    const forced = { behavior: 'allow' as const }
    const result = await canUseTool(
      { name: 'Bash' } as any,
      {},
      {} as any,
      {} as any,
      undefined,
      forced,
    )

    expect(result.behavior).toBe('allow')
  })

  test('honors forced ask outside fullAccess', async () => {
    const ctx = getEmptyToolPermissionContext()
    const canUseTool = createDefaultCanUseTool(ctx)
    const forced = { behavior: 'ask' as const, message: 'confirm?' }

    const result = await canUseTool(
      sdkAskTool,
      {},
      toolUseContextForPermissionMode('default'),
      {} as any,
      'default-force-ask',
      forced,
    )

    expect(result).toBe(forced)
  })

  test('warning not emitted at construction time', () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    // Creating the default canUseTool should NOT emit a warning at construction time.
    // The warning is deferred to execution time (when a tool is actually denied).
    createDefaultCanUseTool(ctx, logger)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('no warning when forceDecision is provided', async () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    const canUseTool = createDefaultCanUseTool(ctx, logger)

    await canUseTool(
      { name: 'Bash' } as any,
      {},
      {} as any,
      {} as any,
      undefined,
      { behavior: 'allow' as const },
    )

    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('fullAccess still denies by default without SDK permission callbacks', async () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    const canUseTool = createDefaultCanUseTool(ctx, logger)

    const result = await canUseTool(
      { name: 'Bash' } as any,
      { command: 'git status' },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-default-force-ask',
      {
        behavior: 'ask' as const,
        message: 'confirm?',
        updatedInput: { command: 'git status --short' },
      },
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('no canUseTool or onPermissionRequest callback provided')
  })

  test('fullAccess remains fail-closed without callbacks', async () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    const canUseTool = createDefaultCanUseTool(ctx, logger)

    const result = await canUseTool(
      sdkAskTool,
      { raw: true },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-default-no-force',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('no canUseTool or onPermissionRequest callback provided')
  })
})

describe('createExternalCanUseTool synchronous host response', () => {
  test('user callback cannot rewrite a plan-mode read into a mutation', async () => {
    const state = mutableToolUseContextForPermissionMode('plan')
    const canUseTool = createExternalCanUseTool(
      async () => ({
        behavior: 'allow' as const,
        updatedInput: { operation: 'write' },
      }),
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      createPermissionTarget(),
    )

    const result = await canUseTool(
      sdkConditionalTool,
      { operation: 'read' },
      state.context,
      {} as any,
      'plan-user-callback-rewrite',
      undefined,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('async host approval is denied when plan mode starts while it is pending', async () => {
    const permissionTarget = createPermissionTarget()
    const state = mutableToolUseContextForPermissionMode('default')
    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      message => {
        state.setMode('plan')
        permissionTarget.pendingPermissionPrompts
          .get(message.tool_use_id)!
          .resolve({
            behavior: 'allow',
            updatedInput: { operation: 'write' },
          })
      },
      undefined,
      50,
    )

    const result = await canUseTool(
      sdkConditionalTool,
      { operation: 'read' },
      state.context,
      {} as any,
      'pending-plan-host-rewrite',
      undefined,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('synchronous host response from onPermissionRequest is received', async () => {
    // Regression test: onPermissionRequest must fire AFTER registerPendingPermission
    // so a host that responds synchronously finds the entry in the map.
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn((message: any) => {
      // Simulate a host that resolves synchronously from the callback
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      expect(pending).toBeDefined() // Must be registered before this callback fires
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50, // short timeout — should NOT fire since host responds immediately
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'sync-response-id',
      undefined,
    )

    expect(result.behavior).toBe('allow')
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
  })

  test('fullAccess still routes forced ask through host permission callbacks', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn((message: any) => {
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-full-access',
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      { action: 'run' },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-external-force-ask',
      {
        behavior: 'ask' as const,
        message: 'confirm?',
        updatedInput: { action: 'run-fast' },
      },
    )

    expect(result.behavior).toBe('allow')
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest.mock.calls[0][0].input).toEqual({
      action: 'run-fast',
    })
    expect(permissionTarget.pendingPermissionPrompts.size).toBe(0)
  })

  test('honors forced ask outside fullAccess before SDK callbacks', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn()
    const userFn = vi.fn(async () => ({
      behavior: 'allow' as const,
    }))
    const forced = { behavior: 'ask' as const, message: 'confirm?' }

    const canUseTool = createExternalCanUseTool(
      userFn,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-default',
    )

    const result = await canUseTool(
      sdkAskTool,
      {},
      toolUseContextForPermissionMode('default'),
      {} as any,
      'default-external-force-ask',
      forced,
    )

    expect(result).toBe(forced)
    expect(userFn).not.toHaveBeenCalled()
    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(permissionTarget.pendingPermissionPrompts.size).toBe(0)
  })

  test('fullAccess preserves forced guidance prompts for SDK callbacks', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn((message: any) => {
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({
        behavior: 'allow' as const,
        updatedInput: { answer: 'option-b' },
      })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-full-access',
    )

    const result = await canUseTool(
      sdkGuidanceTool,
      { raw: true },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-forced-guidance',
      {
        behavior: 'ask' as const,
        message: 'Choose an option',
        updatedInput: { normalizedByHook: true },
      },
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answer: 'option-b' },
    })
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest.mock.calls[0][0].input).toEqual({
      normalized: true,
    })
  })

  test('fullAccess still respects SDK canUseTool callbacks', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn()
    const userFn = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'denied by host policy',
    }))
    const fallback = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'fallback should not run',
    }))

    const canUseTool = createExternalCanUseTool(
      userFn,
      fallback,
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-full-access',
    )

    const result = await canUseTool(
      sdkAskTool,
      { raw: true },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-external-no-force',
      undefined,
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'denied by host policy',
    })
    expect(userFn).toHaveBeenCalledTimes(1)
    expect(userFn).toHaveBeenCalledWith(
      'SDKAskTool',
      { normalized: true },
      { toolUseID: 'full-access-external-no-force' },
    )
    expect(fallback).not.toHaveBeenCalled()
    expect(onPermissionRequest).not.toHaveBeenCalled()
    expect(permissionTarget.pendingPermissionPrompts.size).toBe(0)
  })

  test('fullAccess preserves SDK callbacks for guidance prompts', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn((message: any) => {
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({
        behavior: 'allow' as const,
        updatedInput: { answer: 'option-a' },
      })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-full-access',
    )

    const result = await canUseTool(
      sdkGuidanceTool,
      { raw: true },
      toolUseContextForPermissionMode('fullAccess'),
      {} as any,
      'full-access-guidance',
      undefined,
    )

    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: { answer: 'option-a' },
    })
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
  })

  test('permission request message includes uuid and session_id matching schema', async () => {
    // Regression test: permission_request must match SDKMessageSchema contract
    // which requires uuid and session_id fields (not optional).
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn((message: any) => {
      // Verify message shape matches generated schema requirements
      expect(message.type).toBe('permission_request')
      expect(message.request_id).toBeDefined()
      expect(message.tool_name).toBe('TestTool')
      expect(message.tool_use_id).toBe('shape-test-id')
      expect(message.input).toBeDefined()
      expect(message.uuid).toBeDefined() // Required by schema
      expect(message.session_id).toBeDefined() // Required by schema

      // Resolve to complete the test
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'test-session-123', // Provide session_id
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'shape-test-id',
      undefined,
    )

    expect(result.behavior).toBe('allow')
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    // Verify session_id was passed through
    expect(onPermissionRequest.mock.calls[0][0].session_id).toBe('test-session-123')
  })

  test('permission request uses no-session placeholder when sessionId not provided', async () => {
    // When createExternalCanUseTool is called without sessionId,
    // the permission request should emit 'no-session' placeholder
    // to explicitly indicate standalone permission prompt context.
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn((message: any) => {
      expect(message.session_id).toBe(NO_SESSION_PLACEHOLDER)
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    // Note: sessionId parameter intentionally omitted
    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      // sessionId undefined - should use placeholder
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'no-session-test-id',
      undefined,
    )

    expect(result.behavior).toBe('allow')
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
  })
})


describe('createExternalCanUseTool race condition', () => {
  test('handles simultaneous timeout and response correctly', async () => {
    // Use createPermissionTarget which applies onceOnlyResolve at registration
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn()
    const onTimeout = vi.fn()

    // Timeout set to 50ms with 25ms wait to trigger race condition reliably
    // This gives enough time for the test to be stable on slower systems
    // while still being fast enough to test the race condition scenario
    const timeoutMs = 50
    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      onTimeout,
      timeoutMs,
    )

    const toolUseID = 'test-tool-use-id'

    // Start the canUseTool call
    const resultPromise = canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      toolUseID,
      undefined,
    )

    // Simulate host responding right at timeout threshold
    // This creates the race condition scenario where both timeout and host
    // try to resolve the same promise - but onceOnlyResolve ensures only one wins
    await new Promise(r => setTimeout(r, 25))

    const pending = permissionTarget.pendingPermissionPrompts.get(toolUseID)
    if (pending) {
      // This will race with the timeout handler's resolve call
      pending.resolve({ behavior: 'allow' as const })
    }

    // Wait for result - should NOT throw "promise already resolved" error
    // Explicitly wrap in try-catch to verify no error is thrown during race condition
    let result: PermissionResolveDecision
    let errorThrown: Error | null = null
    try {
      result = await resultPromise
    } catch (e) {
      errorThrown = e as Error
      throw new Error(`Expected no error during race condition, but got: ${errorThrown.message}`)
    }

    // Explicitly verify no error was thrown
    expect(errorThrown).toBeNull()

    // Result should be deterministic - either allow or deny, but no error
    expect(['allow', 'deny']).toContain(result!.behavior)
  })

  test('once-only resolve wrapper prevents double resolution', async () => {
    // Use createPermissionTarget which applies onceOnlyResolve at registration
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn()
    const onTimeout = vi.fn()

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      onTimeout,
      50, // 50ms timeout
    )

    const toolUseID = 'test-tool-use-id-race'

    // Start the canUseTool call
    const resultPromise = canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      toolUseID,
      undefined,
    )

    // Respond immediately after starting to simulate very fast host response
    // This tests that the first response wins, not the timeout
    const pending = permissionTarget.pendingPermissionPrompts.get(toolUseID)
    if (pending) {
      pending.resolve({ behavior: 'allow' as const, updatedInput: { test: true } })
    }

    // Wait for result
    const result = await resultPromise

    // Host response should win over timeout since it came first
    expect(result.behavior).toBe('allow')
    expect(onTimeout).not.toHaveBeenCalled()
  })

  test('host response after timeout is safely ignored (no double-resolve)', async () => {
    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn()
    const onTimeout = vi.fn()

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      onTimeout,
      50, // 50ms timeout
    )

    const toolUseID = 'test-timeout-then-late-response'

    // Start the canUseTool call — this registers a pending permission
    const resultPromise = canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      toolUseID,
      undefined,
    )

    // Grab a reference to the resolve BEFORE timeout fires — simulates host
    // capturing the callback while the permission prompt is still pending
    const staleResolve = permissionTarget.pendingPermissionPrompts.get(toolUseID)
    expect(staleResolve).toBeDefined()

    // Wait LONGER than the 50ms timeout — timeout fires first, resolves with deny
    const result = await resultPromise

    // Timeout should have denied
    expect(result.behavior).toBe('deny')
    expect(onTimeout).toHaveBeenCalledTimes(1)

    // Map entry cleaned up by timeout handler — no leaked listener
    expect(permissionTarget.pendingPermissionPrompts.has(toolUseID)).toBe(false)

    // NOW the host responds late through the stale reference it captured earlier.
    // This is the critical scenario: host calls resolve({allow}) AFTER timeout
    // already resolved with {deny}. onceOnlyResolve must silently ignore this.
    // Wrap in try/catch to explicitly verify no error from double-resolve attempt.
    let lateResponseError: Error | null = null
    try {
      staleResolve!.resolve({ behavior: 'allow' as const, updatedInput: { injected: true } })
    } catch (e) {
      lateResponseError = e as Error
    }

    // No error thrown — onceOnlyResolve silently swallowed the second resolve
    expect(lateResponseError).toBeNull()

    // Result stays 'deny' — timeout decision is immutable
    expect(result.behavior).toBe('deny')
    expect((result as any).updatedInput).toBeUndefined()
  })
})

describe('createOnceOnlyResolve', () => {
  test('only resolves once when called multiple times', () => {
    let resolvedValue: string | undefined
    let callCount = 0

    const resolve = (value: string) => {
      callCount++
      resolvedValue = value
    }

    const onceOnlyResolve = createOnceOnlyResolve(resolve)

    // First call should resolve
    onceOnlyResolve('first')
    expect(resolvedValue).toBe('first')
    expect(callCount).toBe(1)

    // Second call should be ignored
    onceOnlyResolve('second')
    expect(resolvedValue).toBe('first') // Still 'first', not 'second'
    expect(callCount).toBe(1) // Still 1, not incremented

    // Third call should also be ignored
    onceOnlyResolve('third')
    expect(resolvedValue).toBe('first')
    expect(callCount).toBe(1)
  })

  test('works with Promise resolution', async () => {
    let resolveFunc: (value: string) => void
    const promise = new Promise<string>(resolve => {
      resolveFunc = resolve
    })

    const onceOnlyResolve = createOnceOnlyResolve(resolveFunc!)

    // Resolve twice rapidly
    onceOnlyResolve('first')
    onceOnlyResolve('second')

    // Promise should resolve with 'first' only
    const result = await promise
    expect(result).toBe('first')
  })

  test('handles undefined and null values', () => {
    let resolvedValue: string | null | undefined = 'initial'

    const resolve = (value: string | null | undefined) => {
      resolvedValue = value
    }

    const onceOnlyResolve = createOnceOnlyResolve(resolve)

    onceOnlyResolve(undefined)
    expect(resolvedValue).toBeUndefined()

    onceOnlyResolve('should not change')
    expect(resolvedValue).toBeUndefined() // Still undefined

    onceOnlyResolve(null)
    expect(resolvedValue).toBeUndefined() // Still undefined
  })

  test('timeout-deny-then-host-allow: raw resolve called exactly once', () => {
    // This directly proves onceOnlyResolve prevents the raw resolve from being
    // called a second time — the exact scenario the reviewer asked about:
    // timeout fires first (deny), then host responds (allow) — raw resolve
    // must only execute once.
    let rawCallCount = 0
    let rawResolvedValue: PermissionResolveDecision | undefined

    const rawResolve = (value: PermissionResolveDecision) => {
      rawCallCount++
      rawResolvedValue = value
    }

    const wrapped = createOnceOnlyResolve(rawResolve)

    // Step 1: Timeout fires first — resolves with deny
    wrapped({ behavior: 'deny', message: 'Permission resolution timed out' })
    expect(rawCallCount).toBe(1)
    expect(rawResolvedValue!.behavior).toBe('deny')

    // Step 2: Host responds late with allow — must be ignored
    wrapped({ behavior: 'allow' as const, updatedInput: { injected: true } })
    expect(rawCallCount).toBe(1) // NOT 2 — second call was a no-op
    expect(rawResolvedValue!.behavior).toBe('deny') // Unchanged
    expect((rawResolvedValue as any).updatedInput).toBeUndefined()
  })
})

describe('createPermissionTarget', () => {
  test('creates permission target with wrapped resolve', () => {
    const target = createPermissionTarget()
    expect(target.pendingPermissionPrompts).toBeDefined()
    expect(target.registerPendingPermission).toBeDefined()
  })

  test('registerPendingPermission stores wrapped resolve', async () => {
    const target = createPermissionTarget()
    const toolUseId = 'test-id'

    // Register should create a promise
    const promise = target.registerPendingPermission(toolUseId)

    // The resolve should be stored in the map
    const pending = target.pendingPermissionPrompts.get(toolUseId)
    expect(pending).toBeDefined()

    // Calling resolve twice should only resolve once (onceOnlyResolve behavior)
    pending!.resolve({ behavior: 'allow' as const })
    pending!.resolve({ behavior: 'deny' as const, message: 'should not happen', decisionReason: { type: 'mode', mode: 'default' } })

    // Promise should resolve with 'allow' (first call)
    const result = await promise
    expect(result.behavior).toBe('allow')
  })
})

describe('createExternalCanUseTool error handling', () => {
  test('includes original error message in denial', async () => {
    const userFn = async () => {
      throw new Error('Custom error from callback')
    }

    const permissionTarget = {
      registerPendingPermission: async () => ({ behavior: 'deny' as const }),
      pendingPermissionPrompts: new Map(),
    }

    const canUseTool = createExternalCanUseTool(
      userFn,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'test-id',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('Custom error from callback')
  })

  test('throwing onPermissionRequest cleans up pending resolver and denies', async () => {
    // Regression test: After registerPendingPermission was moved before onPermissionRequest,
    // a throwing host callback leaves a pending resolver behind in pendingPermissionPrompts.
    // The callback should be wrapped so the pending entry is deleted and the flow denies cleanly.
    const permissionTarget = createPermissionTarget()

    const throwingCallback = vi.fn(() => {
      throw new Error('host boom')
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      throwingCallback,
      undefined,
      50,
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'throw-id',
      undefined,
    )

    // Should deny with error message, NOT throw
    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('host boom')
    expect(throwingCallback).toHaveBeenCalledTimes(1)

    // Critical: pending resolver must be cleaned up, not leaked
    expect(permissionTarget.pendingPermissionPrompts.has('throw-id')).toBe(false)
  })
})

describe('createExternalCanUseTool warning suppression', () => {
  test('fallback warning not emitted when userFn allows tool', async () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    const fallback = createDefaultCanUseTool(ctx, logger)

    const userFn = vi.fn(async () => ({ behavior: 'allow' as const }))

    const permissionTarget = createPermissionTarget()
    const canUseTool = createExternalCanUseTool(
      userFn,
      fallback,
      permissionTarget,
    )

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    // User callback allowed the tool — default fallback warning should NOT fire
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('fallback warning not emitted when onPermissionRequest resolves', async () => {
    const ctx = getEmptyToolPermissionContext()
    const logger = { warn: vi.fn() }
    const fallback = createDefaultCanUseTool(ctx, logger)

    const permissionTarget = createPermissionTarget()
    const onPermissionRequest = vi.fn((message: any) => {
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      fallback,
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
    )

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    // onPermissionRequest resolved — default fallback warning should NOT fire
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('createExternalCanUseTool timeout scenarios', () => {
  test('emits timeout message when host does not respond', async () => {
    // Use createPermissionTarget which applies onceOnlyResolve at registration
    const permissionTarget = createPermissionTarget()

    const onPermissionRequest = vi.fn()
    const onTimeout = vi.fn()

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      onTimeout,
      50, // 50ms timeout for fast test
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'test-id',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    // A timeout reports itself. Falling through to the fallback would report
    // "no canUseTool or onPermissionRequest callback provided", which is not
    // true here -- onPermissionRequest was supplied, it just did not answer.
    expect(result.message).toContain('timed out')
    expect(onTimeout).toHaveBeenCalled()
    expect(onTimeout.mock.calls[0][0].type).toBe('permission_timeout')
    expect(onTimeout.mock.calls[0][0].tool_name).toBe('TestTool')
    expect(onTimeout.mock.calls[0][0].timed_out_after_ms).toBe(50)
  })

  test('fallback is used when no onPermissionRequest callback', async () => {
    const permissionTarget = createPermissionTarget()

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback denial' }),
      permissionTarget,
      // No onPermissionRequest callback
    )

    const result = await canUseTool(
      { name: 'TestTool' } as any,
      {},
      {} as any,
      {} as any,
      'test-id',
      undefined,
    )

    expect(result.behavior).toBe('deny')
    expect(result.message).toBe('fallback denial')
  })
})

describe('connectSdkMcpServers error handling', () => {
  test('returns empty arrays for undefined config', async () => {
    const result = await connectSdkMcpServers(undefined)

    expect(result.clients).toEqual([])
    expect(result.tools).toEqual([])
  })

  test('returns empty arrays for empty config', async () => {
    const result = await connectSdkMcpServers({})

    expect(result.clients).toEqual([])
    expect(result.tools).toEqual([])
  })
})

describe('permission session_id dynamic resolution', () => {
  test('static sessionId is used in permission_request', async () => {
    const permissionTarget = createPermissionTarget()
    let capturedSessionId: string | undefined

    const onPermissionRequest = vi.fn((message: any) => {
      capturedSessionId = message.session_id
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      'static-session-123', // Static value
    )

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    expect(capturedSessionId).toBe('static-session-123')
  })

  test('getter function resolves sessionId at event time', async () => {
    const permissionTarget = createPermissionTarget()
    let currentSessionId = 'initial-session'
    let capturedSessionId: string | undefined

    const onPermissionRequest = vi.fn((message: any) => {
      capturedSessionId = message.session_id
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    // Pass getter that returns current value at call time
    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      () => currentSessionId, // Dynamic getter
    )

    // Change sessionId BEFORE the permission request is emitted
    currentSessionId = 'updated-session'

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    // Should use the value at event emission time, not initial value
    expect(capturedSessionId).toBe('updated-session')
  })

  test('getter returning undefined falls back to no-session placeholder', async () => {
    const permissionTarget = createPermissionTarget()
    let capturedSessionId: string | undefined

    const onPermissionRequest = vi.fn((message: any) => {
      capturedSessionId = message.session_id
      const pending = permissionTarget.pendingPermissionPrompts.get(message.tool_use_id)
      pending!.resolve({ behavior: 'allow' as const })
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest,
      undefined,
      50,
      () => undefined, // Getter returns undefined
    )

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    expect(capturedSessionId).toBe(NO_SESSION_PLACEHOLDER)
  })

  test('permission_timeout also uses dynamic sessionId', async () => {
    const permissionTarget = createPermissionTarget()
    let currentSessionId = 'timeout-session' // Set before call
    let capturedTimeoutSessionId: string | undefined

    const onPermissionRequest = vi.fn((message: any) => {
      // Don't resolve - let it timeout
    })

    const onTimeout = vi.fn((message: any) => {
      capturedTimeoutSessionId = message.session_id
    })

    const canUseTool = createExternalCanUseTool(
      undefined,
      async () => ({ behavior: 'deny' as const, message: 'fallback' }),
      permissionTarget,
      onPermissionRequest, // Required for timeout logic to run
      onTimeout,
      20, // Short timeout
      () => currentSessionId,
    )

    await canUseTool({ name: 'TestTool' } as any, {}, {} as any, {} as any, 'test-id', undefined)

    // Timeout message should use dynamic sessionId
    expect(capturedTimeoutSessionId).toBe('timeout-session')
  })
})

describe('permission timeout does not masquerade as a missing callback', () => {
  // The timeout branch used to resolve its deny into a promise the race had
  // already abandoned and then fall through to the fallback, whose contract is
  // "no permission callback was provided at all". A host that wired up
  // onPermissionRequest and merely answered slowly was told it had supplied no
  // callback, so the reason for the denial never reached the model or the
  // host developer.
  test('the no-callback fallback is not consulted on timeout', async () => {
    const fallback = vi.fn(async () => ({
      behavior: 'deny' as const,
      message:
        'SDK: Tool "TestTool" denied — no canUseTool or onPermissionRequest callback provided. Pass canUseTool in options to control tool permissions.',
    }))
    const onTimeout = vi.fn()

    const canUseTool = createExternalCanUseTool(
      undefined,
      fallback as never,
      createPermissionTarget(),
      // Provided, but never answers.
      () => {},
      onTimeout,
      10,
    )

    // Drive the timeout off a mocked clock rather than a real 10ms wait, so the
    // deny is the timer firing deterministically and not a scheduling race.
    vi.useFakeTimers()
    try {
      const pending = canUseTool(
        { name: 'TestTool' } as never,
        {},
        {} as never,
        {} as never,
        'test-id',
        undefined,
      )
      vi.advanceTimersByTime(10)
      const result = await pending

      expect(result.behavior).toBe('deny')
      expect(result.behavior === 'deny' && result.message).toContain(
        'timed out',
      )
      // The misleading advice must not be what the model is told.
      expect(result.behavior === 'deny' && result.message).not.toContain(
        'no canUseTool or onPermissionRequest callback provided',
      )
      // Running the fallback would also burn its one-shot warning latch, so a
      // genuinely misconfigured later query in the process is never warned.
      expect(fallback).not.toHaveBeenCalled()
      expect(onTimeout).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a host answering before the timeout is unaffected', async () => {
    const fallback = vi.fn(async () => ({
      behavior: 'deny' as const,
      message: 'fallback',
    }))
    const onTimeout = vi.fn()
    const permissionTarget = createPermissionTarget()

    const canUseTool = createExternalCanUseTool(
      undefined,
      fallback as never,
      permissionTarget,
      message => {
        permissionTarget.denyPendingPermission(message.tool_use_id, 'no')
      },
      onTimeout,
      5_000,
    )

    const result = await canUseTool(
      { name: 'TestTool' } as never,
      {},
      {} as never,
      {} as never,
      'test-id',
      undefined,
    )

    expect(result.behavior === 'deny' && result.message).toBe('no')
    expect(onTimeout).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })
})
