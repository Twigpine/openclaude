import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { BashTool } from '../tools/BashTool/BashTool.js'
import { MalformedCommandError, ShellError } from './errors.js'
import { executeShellCommandsInPrompt } from './promptShellExecution.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalCall = BashTool.call
const originalMapToolResultToToolResultBlockParam =
  BashTool.mapToolResultToToolResultBlockParam

beforeEach(async () => {
  await acquireSharedMutationLock('utils/promptShellExecution.test.ts')
})

afterEach(() => {
  try {
    BashTool.call = originalCall
    BashTool.mapToolResultToToolResultBlockParam =
      originalMapToolResultToToolResultBlockParam
  } finally {
    releaseSharedMutationLock()
  }
})

test('executeShellCommandsInPrompt normalizes null shell output', async () => {
  let normalizedResult:
    | { stdout: string; stderr: string; interrupted: boolean }
    | undefined

  BashTool.call = (async () => ({
    data: {
      stdout: null,
      stderr: null,
      interrupted: false,
    },
  })) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) => {
    normalizedResult = result as {
      stdout: string
      stderr: string
      interrupted: boolean
    }
    return originalMapToolResultToToolResultBlockParam(result, toolUseID)
  }

  await executeShellCommandsInPrompt(
    '```!\ngit status\n```',
    {
      abortController: new AbortController(),
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: new Map(),
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          systemDefinitions: [],
          projectDefinitions: [],
          userDefinitions: [],
        },
      },
      readFileState: new Map(),
      getAppState() {
        return {
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            alwaysAllowRules: { command: ['Bash(*)'] },
          },
        }
      },
      setAppState() {},
    } as never,
    'security-review',
  )

  expect(normalizedResult).toEqual({
    stdout: '',
    stderr: '',
    interrupted: false,
  })
})

test.each([0, 3])('executeShellCommandsInPrompt applies a %s-line cap', async limit => {
  BashTool.call = (async () => ({
    data: {
      stdout: 'line1\nline2\nline3\nline4\nline5\n',
      stderr: '',
      interrupted: false,
    },
  })) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(
      result as never,
      toolUseID,
    )

  const result = await executeShellCommandsInPrompt(
    '```!\ngit diff HEAD -- .\n```',
    {
      abortController: new AbortController(),
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: new Map(),
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          systemDefinitions: [],
          projectDefinitions: [],
          userDefinitions: [],
        },
      },
      readFileState: new Map(),
      getAppState() {
        return {
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            alwaysAllowRules: { command: ['Bash(*)'] },
          },
        }
      },
      setAppState() {},
    } as never,
    'bughunter',
    undefined,
    { lineLimits: { 'git diff HEAD -- .': limit } },
  )

  expect(result).toBe(limit === 0 ? '(Bash completed with no output)' : 'line1\nline2\nline3')
})

test('executeShellCommandsInPrompt does not truncate below the cap', async () => {
  BashTool.call = (async () => ({
    data: {
      stdout: 'line1\nline2\n',
      stderr: '',
      interrupted: false,
    },
  })) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(
      result as never,
      toolUseID,
    )

  const result = await executeShellCommandsInPrompt(
    '```!\ngit diff HEAD -- .\n```',
    {
      abortController: new AbortController(),
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: new Map(),
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          systemDefinitions: [],
          projectDefinitions: [],
          userDefinitions: [],
        },
      },
      readFileState: new Map(),
      getAppState() {
        return {
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            alwaysAllowRules: { command: ['Bash(*)'] },
          },
        }
      },
      setAppState() {},
    } as never,
    'bughunter',
    undefined,
    { lineLimits: { 'git diff HEAD -- .': 400 } },
  )

  expect(result).toBe('line1\nline2')
})

const buildContext = () =>
  ({
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: new Map(),
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        systemDefinitions: [],
        projectDefinitions: [],
        userDefinitions: [],
      },
    },
    readFileState: new Map(),
    getAppState() {
      return {
        toolPermissionContext: {
          ...getEmptyToolPermissionContext(),
          alwaysAllowRules: { command: ['Bash(*)'] },
        },
      }
    },
    setAppState() {},
  }) as never

test('granularFallback blanks only failing snippets, keeps successful ones', async () => {
  let invocation = 0
  BashTool.call = (async () => {
    invocation++
    if (invocation === 1) {
      return { data: { stdout: 'clean tree\n', stderr: '', interrupted: false } }
    }
    // Simulate git log on a zero-commit repo
    throw new ShellError('', 'fatal: ambiguous argument HEAD', 128, false)
  }) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(result as never, toolUseID)

  const result = await executeShellCommandsInPrompt(
    [
      '```!',
      'git status',
      '```',
      '',
      '```!',
      'git log -10 --pretty=format: --name-only',
      '```',
    ].join('\n'),
    buildContext(),
    'bughunter',
    undefined,
    { granularFallback: true },
  )

  expect(result).toBe('clean tree\n\n')
})

test('default path wraps non-permission shell failure in MalformedCommandError with stderr', async () => {
  BashTool.call = (async () => {
    throw new ShellError('', 'fatal: not a git repository', 128, false)
  }) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(result as never, toolUseID)

  await expect(
    executeShellCommandsInPrompt('```!\ngit status\n```', buildContext(), 'security-review'),
  ).rejects.toThrowError(MalformedCommandError)

  try {
    await executeShellCommandsInPrompt(
      '```!\ngit status\n```',
      buildContext(),
      'security-review',
    )
  } catch (e) {
    expect(e).toBeInstanceOf(MalformedCommandError)
    expect((e as Error).message).toContain('fatal: not a git repository')
    expect((e as Error).message).toContain('git status')
  }
})

test('granularFallback still surfaces permission denials as MalformedCommandError', async () => {
  // hasPermissionsToUseTool returns deny via an `alwaysDenyRules` entry for
  // Bash. With granularFallback enabled the catch block should still rethrow
  // a MalformedCommandError (per the `if (e instanceof MalformedCommandError)
  // throw e` guard), not silently blank the snippet.
  BashTool.call = (async () => ({ data: { stdout: 'ok', stderr: '', interrupted: false } })) as unknown as typeof BashTool.call
  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(result as never, toolUseID)

  const ctx = {
    ...(buildContext() as object),
    getAppState() {
      return {
        toolPermissionContext: {
          ...getEmptyToolPermissionContext(),
          alwaysAllowRules: { command: [] },
          alwaysDenyRules: { command: ['Bash(git:*)'] },
        },
      }
    },
  }

  await expect(
    executeShellCommandsInPrompt(
      '```!\ngit status\n```',
      ctx as never,
      'bughunter',
      undefined,
      { granularFallback: true },
    ),
  ).rejects.toBeInstanceOf(MalformedCommandError)
})

test.each([-1, NaN, Infinity, -Infinity, 1.5])('ignores invalid line limit %s and uses the longest valid prefix', async invalid => {
  BashTool.call = (async () => ({
    data: {
      stdout: 'line1\nline2\nline3\nline4\nline5\n',
      stderr: '',
      interrupted: false,
    },
  })) as unknown as typeof BashTool.call

  BashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) =>
    originalMapToolResultToToolResultBlockParam(
      result as never,
      toolUseID,
    )

  const result = await executeShellCommandsInPrompt(
    '```!\ngit diff HEAD -- .\n```',
    {
      abortController: new AbortController(),
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'sonnet',
        tools: new Map(),
        verbose: false,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: false,
        agentDefinitions: {
          systemDefinitions: [],
          projectDefinitions: [],
          userDefinitions: [],
        },
      },
      readFileState: new Map(),
      getAppState() {
        return {
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            alwaysAllowRules: { command: ['Bash(*)'] },
          },
        }
      },
      setAppState() {},
    } as never,
    'bughunter',
    undefined,
    { lineLimits: { 'git diff': 3, 'git diff HEAD -- .': invalid } },
  )

  expect(result).toBe('line1\nline2\nline3')
})
