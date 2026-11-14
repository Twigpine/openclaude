import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { PermissionsSchema, type SettingsJson } from '../settings/types.js'

const realSettings = await import(
  `../settings/settings.js?denyInsteadOfPromptingActual=${Date.now()}-${Math.random()}`
)
let denyInsteadOfPrompting = false
mock.module('../settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: (): SettingsJson => ({
    permissions: { denyInsteadOfPrompting },
  }),
}))

const { hasPermissionsToUseTool } = await import('./permissions.js')

const emptyInputSchema = z.object({})
const assistantMessage = {} as Parameters<typeof hasPermissionsToUseTool>[3]

const askTool = createToolFixture(emptyInputSchema, {
  name: 'PromptingTool',
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'Requires approval',
    }
  },
})

const allowTool = createToolFixture(emptyInputSchema, {
  name: 'AlwaysAllowedTool',
  async checkPermissions() {
    return {
      behavior: 'allow',
      updatedInput: {},
    }
  },
})

function contextFor(
  mode: ToolPermissionContext['mode'],
  overrides: Partial<ToolPermissionContext> = {},
  contextOverrides: Partial<ToolUseContext> = {},
): ToolUseContext {
  const toolPermissionContext = {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable:
      mode === 'bypassPermissions' || mode === 'fullAccess',
    ...overrides,
  } satisfies ToolPermissionContext

  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
      },
    },
    ...contextOverrides,
  } as unknown as ToolUseContext
}

describe('permissions.denyInsteadOfPrompting', () => {
  beforeAll(async () => {
    await acquireSharedMutationLock(
      'utils/permissions/permissions.denyInsteadOfPrompting.test.ts',
    )
  })

  afterAll(() => {
    try {
      denyInsteadOfPrompting = false
      mock.restore()
      mock.module('../settings/settings.js', () => realSettings)
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('denies a call that would prompt, and the turn continues', async () => {
    denyInsteadOfPrompting = true
    const result = await hasPermissionsToUseTool(
      askTool,
      {},
      contextFor('default'),
      assistantMessage,
      'tool-use-1',
    )
    if (result.behavior !== 'deny') {
      throw new Error(`expected deny, got ${result.behavior}`)
    }
    expect(result.message).toContain('denyInsteadOfPrompting')
  })

  test('leaves allow decisions untouched', async () => {
    denyInsteadOfPrompting = true
    const result = await hasPermissionsToUseTool(
      allowTool,
      {},
      contextFor('default'),
      assistantMessage,
      'tool-use-2',
    )
    expect(result.behavior).toBe('allow')
  })

  test('applies inside a subagent context', async () => {
    denyInsteadOfPrompting = true
    const result = await hasPermissionsToUseTool(
      askTool,
      {},
      contextFor('default', {}, { agentId: 'subagent-1' as AgentId }),
      assistantMessage,
      'tool-use-3',
    )
    expect(result.behavior).toBe('deny')
  })

  test('is inert under bypassPermissions', async () => {
    denyInsteadOfPrompting = true
    const result = await hasPermissionsToUseTool(
      askTool,
      {},
      contextFor('bypassPermissions'),
      assistantMessage,
      'tool-use-4',
    )
    expect(result.behavior).not.toBe('deny')
  })

  test('settings schema accepts the key', () => {
    const result = PermissionsSchema().safeParse({
      denyInsteadOfPrompting: true,
    })
    expect(result.success).toBe(true)
  })

  test('converts a whole-tool ask rule into a deny', async () => {
    denyInsteadOfPrompting = true
    const result = await hasPermissionsToUseTool(
      askTool,
      {},
      contextFor('default', {
        alwaysAskRules: { localSettings: ['PromptingTool'] },
      }),
      assistantMessage,
      'tool-use-6',
    )
    expect(result.behavior).toBe('deny')
  })

  test('prompts as usual when the setting is off', async () => {
    denyInsteadOfPrompting = false
    const result = await hasPermissionsToUseTool(
      askTool,
      {},
      contextFor('default'),
      assistantMessage,
      'tool-use-5',
    )
    expect(result.behavior).toBe('ask')
  })
})
