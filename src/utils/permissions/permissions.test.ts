import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { EXPLORE_AGENT } from '../../tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from '../../tools/AgentTool/built-in/planAgent.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { ExitPlanModeV2Tool } from '../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/constants.js'
import { PowerShellTool } from '../../tools/PowerShellTool/PowerShellTool.js'
import { getPlatform } from '../platform.js'
import {
  getActiveSessionPlanFilePath,
  getScratchpadDir,
} from './filesystem.js'
import { hasPermissionsToUseTool } from './permissions.js'

const emptyInputSchema = z.object({})
const assistantMessage = {} as Parameters<typeof hasPermissionsToUseTool>[3]
let actualPlans: typeof import('../plans.js')

beforeAll(async () => {
  await acquireSharedMutationLock('utils/permissions/permissions.test.ts')
  actualPlans = await import(
    `../plans.ts?planPermissionsActual=${Date.now()}-${Math.random()}`
  )
  mock.module('../plans.js', () => actualPlans)
})

afterAll(() => {
  try {
    mock.restore()
    mock.module('../plans.js', () => actualPlans)
  } finally {
    releaseSharedMutationLock()
  }
})

const safetyCheckTool = createToolFixture(emptyInputSchema, {
  name: 'SafetyCheckTool',
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'Safety check requires approval',
      decisionReason: {
        type: 'safetyCheck',
        reason: 'Safety check requires approval',
        classifierApprovable: false,
      },
    }
  },
})

const userInteractionTool = createToolFixture(emptyInputSchema, {
  name: 'UserInteractionTool',
  requiresUserInteraction() {
    return true
  },
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'User interaction requires approval',
    }
  },
})

const plainAskRuleTool = createToolFixture(emptyInputSchema, {
  name: 'PlainAskRuleTool',
  async checkPermissions() {
    return {
      behavior: 'passthrough',
      message: '',
    }
  },
})

const contentAskTool = createToolFixture(emptyInputSchema, {
  name: 'ContentAskTool',
  async checkPermissions() {
    return {
      behavior: 'ask',
      message: 'Content rule requires approval',
      decisionReason: {
        type: 'rule',
        rule: {
          source: 'session',
          ruleBehavior: 'ask',
          ruleValue: {
            toolName: 'ContentAskTool',
          },
        },
      },
    }
  },
})

const denyTool = createToolFixture(emptyInputSchema, {
  name: 'DenyTool',
  async checkPermissions() {
    return {
      behavior: 'deny',
      message: 'Denied by tool',
      decisionReason: {
        type: 'other',
        reason: 'Denied by tool',
      },
    }
  },
})

function contextFor(
  mode: ToolPermissionContext['mode'],
  overrides: Partial<ToolPermissionContext> = {},
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
        activeAgents: [EXPLORE_AGENT, PLAN_AGENT],
        allAgents: [EXPLORE_AGENT, PLAN_AGENT],
      },
    },
  } as unknown as ToolUseContext
}

describe('permission modes and safety checks', () => {
  test('bypassPermissions still preserves hard safety-check prompts', async () => {
    const result = await hasPermissionsToUseTool(
      safetyCheckTool,
      {},
      contextFor('bypassPermissions'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  test('fullAccess bypasses hard safety-check prompts', async () => {
    const result = await hasPermissionsToUseTool(
      safetyCheckTool,
      {},
      contextFor('fullAccess'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'mode',
      mode: 'fullAccess',
    })
  })

  test('fullAccess bypasses entire-tool ask rules', async () => {
    const result = await hasPermissionsToUseTool(
      plainAskRuleTool,
      {},
      contextFor('fullAccess', {
        alwaysAskRules: { session: ['PlainAskRuleTool'] },
      }),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'mode',
      mode: 'fullAccess',
    })
  })

  test('fullAccess preserves user interaction prompts', async () => {
    const result = await hasPermissionsToUseTool(
      userInteractionTool,
      {},
      contextFor('fullAccess'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') {
      throw new Error(`Expected ask decision, received ${result.behavior}`)
    }
    expect(result.message).toBe('User interaction requires approval')
  })

  test('fullAccess bypasses content-specific ask-rule prompts', async () => {
    const result = await hasPermissionsToUseTool(
      contentAskTool,
      {},
      contextFor('fullAccess'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'mode',
      mode: 'fullAccess',
    })
  })

  test('fullAccess still preserves hard deny decisions', async () => {
    const result = await hasPermissionsToUseTool(
      denyTool,
      {},
      contextFor('fullAccess'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result.behavior).toBe('deny')
    if (result.behavior !== 'deny') {
      throw new Error(`Expected deny decision, received ${result.behavior}`)
    }
    expect(result.message).toBe('Denied by tool')
  })
})

const fileInputSchema = z.object({
  file_path: z.string(),
  content: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
})

const fileWriteTool = createToolFixture(fileInputSchema, {
  name: FILE_WRITE_TOOL_NAME,
})

const fileEditTool = createToolFixture(fileInputSchema, {
  name: FILE_EDIT_TOOL_NAME,
})

function mcpTool(name: string, readOnlyHint?: boolean) {
  return createToolFixture(z.object({}).passthrough(), {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'test', toolName: name.split('__').at(-1) ?? name },
    ...(readOnlyHint === undefined
      ? {}
      : { isReadOnly: () => readOnlyHint }),
    async checkPermissions() {
      return { behavior: 'passthrough', message: 'MCP permission required' }
    },
  })
}

describe('plan mode mechanical read-only policy', () => {
  test.each([
    [fileEditTool, { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' }],
    [fileWriteTool, { file_path: 'src/new.ts', content: 'new' }],
  ])('denies source mutations through %s', async (tool, input) => {
    const result = await hasPermissionsToUseTool(
      tool,
      input,
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
    if (result.behavior !== 'deny') {
      throw new Error(`Expected deny, received ${result.behavior}`)
    }
    expect(result.message).toBe(
      `Plan mode is read-only. Exit plan mode before using ${tool.name}.`,
    )
  })

  test.each([
    'touch new.txt',
    'echo hi > out.txt',
    'rm old.txt',
    'cp source.txt copy.txt',
    'mv old.txt new.txt',
    'npm install',
    'git commit -m test',
    'unknown-command --flag',
  ])(
    'denies mutating Bash command %j',
    async command => {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )
      expect(result.behavior).toBe('deny')
    },
  )

  test('denies mutating PowerShell', async () => {
    const result = await hasPermissionsToUseTool(
      PowerShellTool,
      { command: 'New-Item created.txt' },
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test.each(['git diff', 'git status', 'ls', 'cat package.json'])(
    'lets read-only Bash continue through normal permissions for %j',
    async command => {
      const result = await hasPermissionsToUseTool(
        BashTool,
        { command },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )
      expect(result.behavior).toBe('allow')
      expect(result.decisionReason).not.toMatchObject({
        type: 'mode',
        mode: 'plan',
      })
    },
  )

  test.each([fileWriteTool, fileEditTool])(
    'allows %s only for the exact active plan file',
    async tool => {
      const planPath = getActiveSessionPlanFilePath()
      const allowed = await hasPermissionsToUseTool(
        tool,
        { file_path: planPath, content: 'plan', old_string: 'a', new_string: 'b' },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )
      const similar = await hasPermissionsToUseTool(
        tool,
        { file_path: planPath.replace(/\.md$/, '-other.md'), content: 'plan' },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )

      expect(allowed.behavior).toBe('allow')
      expect(similar.behavior).toBe('deny')
    },
  )

  test('does not treat the scratchpad as the plan-file exception', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: join(getScratchpadDir(), 'plan.md'), content: 'not a plan' },
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('allows a child only its own exact active plan file', async () => {
    const childContext = contextFor('plan')
    childContext.agentId = 'agent-child' as ToolUseContext['agentId']

    const ownPlan = await hasPermissionsToUseTool(
      fileWriteTool,
      {
        file_path: getActiveSessionPlanFilePath(childContext.agentId),
        content: 'plan',
      },
      childContext,
      assistantMessage,
      'own-plan',
    )
    const parentPlan = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: getActiveSessionPlanFilePath(), content: 'parent plan' },
      childContext,
      assistantMessage,
      'parent-plan',
    )

    expect(ownPlan.behavior).toBe('allow')
    expect(parentPlan.behavior).toBe('deny')
  })

  test.each([
    { isBypassPermissionsModeAvailable: true },
    { prePlanMode: 'bypassPermissions' as const, isBypassPermissionsModeAvailable: true },
    { prePlanMode: 'fullAccess' as const, isBypassPermissionsModeAvailable: true },
    { prePlanMode: 'acceptEdits' as const },
  ])('denies mutations regardless of prior capability %#', async overrides => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'src/new.ts', content: 'new' },
      contextFor('plan', overrides),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('an always-allow rule cannot authorize a mutation', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'src/new.ts', content: 'new' },
      contextFor('plan', { alwaysAllowRules: { session: [FILE_WRITE_TOOL_NAME] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('headless plan mode still hard-denies mutations', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'src/new.ts', content: 'new' },
      contextFor('plan', { shouldAvoidPermissionPrompts: true }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('evaluates tool-normalized input that becomes mutating', async () => {
    const normalizingTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'NormalizingTool',
        isReadOnly: input => input.operation === 'read',
        async checkPermissions() {
          return {
            behavior: 'allow',
            updatedInput: { operation: 'write' as const },
          }
        },
      },
    )
    const result = await hasPermissionsToUseTool(
      normalizingTool,
      { operation: 'read' },
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('entering plan mode during a tool permission check activates the guard', async () => {
    let mode: ToolPermissionContext['mode'] = 'acceptEdits'
    const context = contextFor('acceptEdits')
    context.getAppState = (() => ({
      toolPermissionContext: {
        ...contextFor(mode).getAppState().toolPermissionContext,
        mode,
      },
    })) as ToolUseContext['getAppState']
    const transitioningTool = createToolFixture(
      z.object({ operation: z.enum(['read', 'write']) }),
      {
        name: 'TransitioningTool',
        isReadOnly: input => input.operation === 'read',
        async checkPermissions() {
          mode = 'plan'
          return {
            behavior: 'allow' as const,
            updatedInput: { operation: 'write' as const },
          }
        },
      },
    )

    const result = await hasPermissionsToUseTool(
      transitioningTool,
      { operation: 'read' },
      context,
      assistantMessage,
      'enter-plan',
    )

    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test('denies transparent execution wrappers even if they claim read-only', async () => {
    const wrapper = createToolFixture(emptyInputSchema, {
      name: 'TransparentWrapper',
      isReadOnly: () => true,
      isTransparentWrapper: () => true,
    })
    const result = await hasPermissionsToUseTool(
      wrapper,
      {},
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('preserves explicit deny rules for read-only tools', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'git status' },
      contextFor('plan', { alwaysDenyRules: { session: ['Bash'] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'rule' },
    })
  })

  test('preserves explicit ask rules for otherwise read-only tools', async () => {
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'git status' },
      contextFor('plan', { alwaysAskRules: { session: ['Bash'] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('ask')
  })

  test('preserves explicit ask rules for the active plan-file exception', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: getActiveSessionPlanFilePath(), content: 'plan' },
      contextFor('plan', {
        alwaysAskRules: { session: [FILE_WRITE_TOOL_NAME] },
      }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'rule' })
  })

  test('does not turn a mutating action into an ask prompt', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'src/new.ts', content: 'new' },
      contextFor('plan', { alwaysAskRules: { session: [FILE_WRITE_TOOL_NAME] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('allows read-only MCP tools through normal rules and denies unsafe hints', async () => {
    const readOnly = mcpTool('mcp__test__read', true)
    const mutating = mcpTool('mcp__test__write', false)
    const unclassified = mcpTool('mcp__test__unknown')
    const context = contextFor('plan', {
      alwaysAllowRules: { session: [readOnly.name, mutating.name, unclassified.name] },
    })

    expect(
      (await hasPermissionsToUseTool(readOnly, {}, context, assistantMessage, 'read')).behavior,
    ).toBe('allow')
    expect(
      (await hasPermissionsToUseTool(mutating, {}, context, assistantMessage, 'write')).behavior,
    ).toBe('deny')
    expect(
      (await hasPermissionsToUseTool(unclassified, {}, context, assistantMessage, 'unknown')).behavior,
    ).toBe('deny')
  })

  test('keeps a true MCP read-only hint on the normal permission path', async () => {
    const result = await hasPermissionsToUseTool(
      mcpTool('mcp__test__read', true),
      {},
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toBeUndefined()
  })

  test.each([
    ['ExitPlanMode', {}],
    ['Write', { file_path: getActiveSessionPlanFilePath(), content: 'plan' }],
    ['Edit', { file_path: getActiveSessionPlanFilePath(), old_string: 'a', new_string: 'b' }],
    ['Agent', { description: 'Inspect', prompt: 'Read only', subagent_type: 'Explore' }],
    ['PowerShell', { command: 'Get-Content package.json' }],
  ])('does not let an unsafe MCP tool spoof the built-in %s exception', async (name, input) => {
    const tool = mcpTool(name, false)
    const result = await hasPermissionsToUseTool(
      tool,
      input,
      contextFor('plan', {
        alwaysAllowRules: { session: [`mcp__test__${name}`] },
      }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('denies SendMessage even when the tool claims to be read-only', async () => {
    const sendMessage = createToolFixture(
      z.object({ message: z.string(), recipient: z.string() }),
      {
        name: 'SendMessage',
        isReadOnly: () => true,
      },
    )
    const result = await hasPermissionsToUseTool(
      sendMessage,
      { message: 'Edit the source file', recipient: 'worker' },
      contextFor('plan', { alwaysAllowRules: { session: ['SendMessage'] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('denies a plan-file exception whose active path is a symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plan-policy-'))
    const target = join(directory, 'source.ts')
    const planLink = join(directory, 'active-plan.md')
    await writeFile(target, 'source')
    await symlink(target, planLink)
    mock.module('../plans.js', () => ({
      ...actualPlans,
      getPlanFilePath: () => planLink,
    }))
    try {
      const result = await hasPermissionsToUseTool(
        fileWriteTool,
        { file_path: planLink, content: 'plan' },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )
      expect(result.behavior).toBe('deny')
    } finally {
      mock.module('../plans.js', () => actualPlans)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('invalid plan paths fail closed instead of throwing', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'invalid\0path', content: 'plan' },
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test.each(['darwin', 'win32'] as const)(
    'does not accept a differently cased plan path when process.platform is %s',
    async platform => {
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        'platform',
      )
      Object.defineProperty(process, 'platform', {
        value: platform,
        configurable: true,
      })
      getPlatform.cache.clear()
      try {
        const planPath = getActiveSessionPlanFilePath()
        const differentlyCasedPath = planPath.replace(/([a-z])/, character =>
          character.toUpperCase(),
        )
        const result = await hasPermissionsToUseTool(
          fileWriteTool,
          { file_path: differentlyCasedPath, content: 'plan' },
          contextFor('plan'),
          assistantMessage,
          'tool-use-id',
        )
        expect(result.behavior).toBe('deny')
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
        getPlatform.cache.clear()
      }
    },
  )

  test.each(['Explore', 'Plan'])(
    'allows the built-in one-shot %s agent in non-team form',
    async subagent_type => {
      const result = await hasPermissionsToUseTool(
        AgentTool,
        { description: 'Inspect code', prompt: 'Read only', subagent_type },
        contextFor('plan'),
        assistantMessage,
        'tool-use-id',
      )
      expect(result.behavior).toBe('allow')
    },
  )

  test('fails closed when active agent definitions are unavailable', async () => {
    const context = contextFor('plan')
    context.options.agentDefinitions = {} as NonNullable<
      ToolUseContext['options']['agentDefinitions']
    >

    const result = await hasPermissionsToUseTool(
      AgentTool,
      {
        description: 'Inspect code',
        prompt: 'Read only',
        subagent_type: 'Explore',
      },
      context,
      assistantMessage,
      'tool-use-id',
    )
    expect(result).toMatchObject({
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'plan' },
    })
  })

  test.each([
    { description: 'General', prompt: 'Work' },
    { description: 'Fork', prompt: 'Work' },
    { description: 'Team', prompt: 'Work', subagent_type: 'Explore', name: 'worker' },
    { description: 'Team', prompt: 'Work', subagent_type: 'Plan', team_name: 'team' },
    { description: 'Mode', prompt: 'Work', subagent_type: 'Plan', mode: 'plan' },
    { description: 'Isolate', prompt: 'Work', subagent_type: 'Explore', isolation: 'worktree' },
    { description: 'Background', prompt: 'Work', subagent_type: 'Explore', run_in_background: true },
  ])('denies unsafe Agent form %#', async input => {
    const result = await hasPermissionsToUseTool(
      AgentTool,
      input,
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('still denies mutation in a Plan or Explore child context', async () => {
    const childContext = contextFor('plan')
    childContext.agentId = 'agent-child' as ToolUseContext['agentId']
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'touch child.txt' },
      childContext,
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('deny')
  })

  test('keeps ExitPlanMode available', async () => {
    const result = await hasPermissionsToUseTool(
      ExitPlanModeV2Tool,
      {},
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('ask')
  })

  test('keeps user-question interactions available', async () => {
    const result = await hasPermissionsToUseTool(
      AskUserQuestionTool,
      {
        questions: [
          {
            question: 'Which option?',
            header: 'Choice',
            options: [
              { label: 'One', description: 'First option' },
              { label: 'Two', description: 'Second option' },
            ],
            multiSelect: false,
          },
        ],
      },
      contextFor('plan'),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('ask')
  })

  test('does not change allow-rule behavior outside plan mode', async () => {
    const result = await hasPermissionsToUseTool(
      fileWriteTool,
      { file_path: 'src/new.ts', content: 'new' },
      contextFor('default', { alwaysAllowRules: { session: [FILE_WRITE_TOOL_NAME] } }),
      assistantMessage,
      'tool-use-id',
    )
    expect(result.behavior).toBe('allow')
  })
})
