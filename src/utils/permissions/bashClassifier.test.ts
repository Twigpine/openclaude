import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolPermissionContext } from '../../Tool.js'

const ENV_KEYS = ['CLAUDE_CODE_DISABLE_BASH_CLASSIFIER'] as const
let restoreEnv: () => void = () => {}
let importCounter = 0
const classifierEnabled = feature('BASH_CLASSIFIER') ? true : false

async function importClassifier() {
  return import(`./bashClassifier.ts?test=${importCounter++}`)
}

function contextWithRules(rules: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  return {
    ...base,
    alwaysAllowRules: rules.allow ? { projectSettings: rules.allow } : {},
    alwaysDenyRules: rules.deny ? { projectSettings: rules.deny } : {},
    alwaysAskRules: rules.ask ? { projectSettings: rules.ask } : {},
  } as ToolPermissionContext
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/permissions/bashClassifier.test.ts')
  restoreEnv = snapshotEnv(ENV_KEYS, { clear: true })
})

afterEach(() => {
  try {
    restoreEnv()
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

test('extractPromptDescription strips the prompt prefix', async () => {
  const { extractPromptDescription } = await importClassifier()
  expect(extractPromptDescription('prompt: allow git status')).toBe(
    'allow git status',
  )
  expect(extractPromptDescription('npm test')).toBeNull()
  expect(extractPromptDescription('prompt:   ')).toBeNull()
  expect(extractPromptDescription(undefined)).toBeNull()
})

test('createPromptRuleContent writes the prompt prefix', async () => {
  const { createPromptRuleContent } = await importClassifier()
  expect(createPromptRuleContent('  allow git status ')).toBe(
    'prompt: allow git status',
  )
})

test('isClassifierPermissionsEnabled tracks the build flag and env kill-switch', async () => {
  const { isClassifierPermissionsEnabled } = await importClassifier()
  expect(isClassifierPermissionsEnabled()).toBe(classifierEnabled)
  process.env.CLAUDE_CODE_DISABLE_BASH_CLASSIFIER = '1'
  expect(isClassifierPermissionsEnabled()).toBe(false)
})

test('description collectors read only Bash prompt rules from the matching bucket', async () => {
  const {
    getBashPromptAllowDescriptions,
    getBashPromptDenyDescriptions,
    getBashPromptAskDescriptions,
  } = await importClassifier()
  const context = contextWithRules({
    allow: [
      'Bash(prompt: allow git status commands)',
      'Bash(npm test)',
      'WebFetch(prompt: not a bash rule)',
      'Bash(prompt:   )',
      'Bash',
    ],
    deny: ['Bash(prompt: destructive commands)'],
    ask: ['Bash(prompt: package installs)'],
  })

  expect(getBashPromptAllowDescriptions(context)).toEqual([
    'allow git status commands',
  ])
  expect(getBashPromptDenyDescriptions(context)).toEqual([
    'destructive commands',
  ])
  expect(getBashPromptAskDescriptions(context)).toEqual(['package installs'])
})

function mockSideQuery(
  impl: (opts: { messages: unknown[] }) => Promise<unknown>,
) {
  let calls = 0
  mock.module('../sideQuery.js', () => ({
    sideQuery: async (opts: { messages: unknown[] }) => {
      calls++
      return impl(opts)
    },
  }))
  return () => calls
}

const toolUseResponse = (input: unknown) => ({
  content: [
    { type: 'tool_use', name: 'report_bash_rule_match', id: 'tu_1', input },
  ],
})

test('classifyBashCommand maps a matching verdict to the description', async () => {
  const calls = mockSideQuery(async () =>
    toolUseResponse({
      reasoning: 'git status fits description 0',
      matched_index: 0,
      confidence: 'high',
      reason: 'command is a git status call',
    }),
  )
  const { classifyBashCommand } = await importClassifier()
  const result = await classifyBashCommand(
    'git status -sb',
    '/repo',
    ['allow git status commands', 'npm test commands'],
    'allow',
    new AbortController().signal,
    false,
  )
  if (!classifierEnabled) {
    expect(result.matches).toBe(false)
    expect(calls()).toBe(0)
    return
  }
  expect(result).toEqual({
    matches: true,
    matchedDescription: 'allow git status commands',
    confidence: 'high',
    reason: 'command is a git status call',
  })
  expect(calls()).toBe(1)
})

test('classifyBashCommand returns no match for index -1 and out-of-range indexes', async () => {
  let index = -1
  mockSideQuery(async () =>
    toolUseResponse({
      reasoning: 'no fit',
      matched_index: index,
      confidence: 'medium',
      reason: 'outside scope',
    }),
  )
  const { classifyBashCommand } = await importClassifier()
  const descriptions = ['allow git status commands']

  for (const idx of [-1, 5]) {
    index = idx
    const result = await classifyBashCommand(
      'rm -rf /',
      '/repo',
      descriptions,
      'deny',
      new AbortController().signal,
      false,
    )
    expect(result.matches).toBe(false)
    if (classifierEnabled) {
      expect(result.confidence).toBe('medium')
      expect(result.reason).toBe('outside scope')
    }
  }
})

test('classifyBashCommand never calls the model with no descriptions', async () => {
  const calls = mockSideQuery(async () => {
    throw new Error('should not be called')
  })
  const { classifyBashCommand } = await importClassifier()
  const result = await classifyBashCommand(
    'ls',
    '/repo',
    [],
    'allow',
    new AbortController().signal,
    false,
  )
  expect(result.matches).toBe(false)
  expect(calls()).toBe(0)
})

test('classifyBashCommand fails open toward prompting on classifier errors', async () => {
  const calls = mockSideQuery(async () => {
    throw new Error('provider unavailable')
  })
  const { classifyBashCommand } = await importClassifier()
  const result = await classifyBashCommand(
    'npm install',
    '/repo',
    ['package installs'],
    'allow',
    new AbortController().signal,
    false,
  )
  expect(result).toEqual({
    matches: false,
    confidence: 'low',
    reason: classifierEnabled
      ? 'Classifier unavailable'
      : 'Bash prompt rules are disabled',
  })
  expect(calls()).toBe(classifierEnabled ? 1 : 0)
})

test('classifyBashCommand fails open on malformed model output', async () => {
  mockSideQuery(async () => ({
    content: [{ type: 'text', text: 'not a tool call' }],
  }))
  const { classifyBashCommand } = await importClassifier()
  const result = await classifyBashCommand(
    'git status',
    '/repo',
    ['allow git status commands'],
    'allow',
    new AbortController().signal,
    false,
  )
  expect(result.matches).toBe(false)
  expect(result.confidence).toBe('low')
})

test('classifyBashCommand propagates aborts', async () => {
  mockSideQuery(async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  })
  const { classifyBashCommand } = await importClassifier()
  const outcome = classifyBashCommand(
    'git status',
    '/repo',
    ['allow git status commands'],
    'allow',
    new AbortController().signal,
    false,
  )
  if (classifierEnabled) {
    await expect(outcome).rejects.toThrow('aborted')
  } else {
    await expect(outcome).resolves.toMatchObject({ matches: false })
  }
})

test('classifyBashCommand does not call the model when the env kill-switch is set', async () => {
  process.env.CLAUDE_CODE_DISABLE_BASH_CLASSIFIER = '1'
  const calls = mockSideQuery(async () => {
    throw new Error('should not be called')
  })
  const { classifyBashCommand } = await importClassifier()
  const result = await classifyBashCommand(
    'git status',
    '/repo',
    ['allow git status commands'],
    'allow',
    new AbortController().signal,
    false,
  )
  expect(result.matches).toBe(false)
  expect(calls()).toBe(0)
})
