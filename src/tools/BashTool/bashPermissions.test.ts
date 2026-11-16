import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  getOriginalCwd,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { SETTING_SOURCES } from '../../utils/settings/constants.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  _test,
  bashToolHasPermission,
  checkSandboxAutoAllow,
  clearSpeculativeChecks,
  consumeSpeculativeClassifierCheck,
  peekSpeculativeClassifierCheck,
  stripAllLeadingEnvVars,
} from './bashPermissions.js'

const originalSandboxMethods = {
  isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
  isAutoAllowBashIfSandboxedEnabled:
    SandboxManager.isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed: SandboxManager.areUnsandboxedCommandsAllowed,
  getExcludedCommands: SandboxManager.getExcludedCommands,
}
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const hadOriginalMacro = Object.hasOwn(globalThis, 'MACRO')

beforeEach(async () => {
  await acquireSharedMutationLock('tools/BashTool/bashPermissions.test.ts')
})

afterEach(() => {
  try {
    SandboxManager.isSandboxingEnabled =
      originalSandboxMethods.isSandboxingEnabled
    SandboxManager.isAutoAllowBashIfSandboxedEnabled =
      originalSandboxMethods.isAutoAllowBashIfSandboxedEnabled
    SandboxManager.areUnsandboxedCommandsAllowed =
      originalSandboxMethods.areUnsandboxedCommandsAllowed
    SandboxManager.getExcludedCommands = originalSandboxMethods.getExcludedCommands
    if (hadOriginalMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function makeToolUseContext(
  toolPermissionContext = getEmptyToolPermissionContext(),
) {
  return {
    abortController: new AbortController(),
    options: {
      isNonInteractiveSession: false,
    },
    getAppState() {
      return {
        toolPermissionContext,
      }
    },
  } as never
}

let legacyParserEnvToggleQueue = Promise.resolve()

async function withLegacyParserDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const waitForTurn = legacyParserEnvToggleQueue
  let releaseQueue!: () => void
  legacyParserEnvToggleQueue = new Promise<void>(resolve => {
    releaseQueue = resolve
  })
  await waitForTurn

  const originalInjectionFlag =
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  try {
    return await fn()
  } finally {
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
    releaseQueue()
  }
}

test('legacy shell parser limitations fail closed to ask', async () => {
  const result = await withLegacyParserDisabled(() =>
    bashToolHasPermission(
      { command: 'echo ${value + 1}' },
      makeToolUseContext(),
    ),
  )

  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: expect.stringContaining('cannot be parsed'),
  })
})

test('explicit deny rules win over legacy shell parser limitations', async () => {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: {
      session: ['Bash(echo:*)'],
    },
  }

  const result = await withLegacyParserDisabled(() =>
    bashToolHasPermission(
      { command: 'echo ${value + 1}' },
      makeToolUseContext(toolPermissionContext),
    ),
  )

  expect(result.behavior).toBe('deny')
  expect(result.decisionReason).toMatchObject({
    type: 'rule',
    rule: {
      ruleBehavior: 'deny',
      ruleValue: {
        toolName: 'Bash',
        ruleContent: 'echo:*',
      },
    },
  })
})

test('legacy parser fallback preserves env vars for path validation', async () => {
  const result = await withLegacyParserDisabled(() =>
    bashToolHasPermission({ command: 'cat $HOME/file' }, makeToolUseContext()),
  )

  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: 'Shell expansion syntax in paths requires manual approval',
  })
})

test('sandbox auto-allow still enforces Bash path constraints', async () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.isAutoAllowBashIfSandboxedEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true
  SandboxManager.getExcludedCommands = () => []

  const result = await bashToolHasPermission(
    { command: 'cat ../../../../../etc/passwd' },
    makeToolUseContext(),
  )

  expect(result.behavior).toBe('ask')
  if (result.behavior !== 'ask') {
    throw new Error(`expected ask, got ${result.behavior}`)
  }
  expect(result.message).toContain('was blocked')
  expect(result.message).toContain('passwd')
})

// CC-643 regression: the subcommand-fanout cap must apply on the sandbox
// auto-allow path too, not only the main `bashToolHasPermission` body.
// Otherwise a crafted compound command can iterate `matchingRulesForInput`
// N times in the auto-allow path before the main cap ever runs.
//
// The cap is gated on the LEGACY splitter path (astSubcommands === null),
// mirroring the same gate in `bashToolHasPermission` — the fanout/ReDoS risk
// is specific to legacy `splitCommand`. The test forces parse-unavailable via
// CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK so the AST short-circuit cannot
// hide the regression.
test('sandbox auto-allow caps subcommand fanout when AST is unavailable', async () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const originalInjectionFlag =
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  try {
    SandboxManager.isSandboxingEnabled = () => true
    SandboxManager.isAutoAllowBashIfSandboxedEnabled = () => true
    SandboxManager.areUnsandboxedCommandsAllowed = () => true
    SandboxManager.getExcludedCommands = () => []

    // 60 `echo`s chained with `&&` blow past the 50-subcommand cap.
    const command = Array.from({ length: 60 }, () => 'echo x').join(' && ')

    const result = await bashToolHasPermission(
      { command },
      makeToolUseContext(),
    )

    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: expect.stringContaining('too many to safety-check individually'),
    })
  } finally {
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
  }
})

// CC-643 follow-up: when tree-sitter has parsed the chain cleanly
// (astSubcommands !== null), the cap must NOT fire — AST-validated long
// chains are intentional, and pre-emptively asking is a user-visible
// regression for legitimate compound commands. Driven directly via
// checkSandboxAutoAllow so the assertion does not depend on tree-sitter WASM
// availability in the test runtime.
test('sandbox auto-allow does not cap when astSubcommands is provided', () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const subs = Array.from({ length: 60 }, () => 'echo x')
  const command = subs.join(' && ')

  const result = checkSandboxAutoAllow(
    { command },
    getEmptyToolPermissionContext(),
    subs,
  )

  expect(result.behavior).toBe('allow')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: expect.stringContaining('Auto-allowed with sandbox'),
  })
})

// Symmetric direct check: AST unavailable (null) → cap fires.
test('checkSandboxAutoAllow caps fanout when astSubcommands is null', () => {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }

  const command = Array.from({ length: 60 }, () => 'echo x').join(' && ')

  const result = checkSandboxAutoAllow(
    { command },
    getEmptyToolPermissionContext(),
    null,
  )

  expect(result.behavior).toBe('ask')
  expect(result.decisionReason).toMatchObject({
    type: 'other',
    reason: expect.stringContaining('too many to safety-check individually'),
  })
})

test('git commit governance policy runs through the production Bash permission path', async () => {
  const originalCwd = getOriginalCwd()
  const projectDir = await mkdtemp(join(tmpdir(), 'openclaude-git-policy-'))

  try {
    setOriginalCwd(projectDir)
    setAllowedSettingSources([...SETTING_SOURCES])
    await mkdir(join(projectDir, '.openclaude'), { recursive: true })
    await writeFile(
      join(projectDir, '.openclaude', 'settings.local.json'),
      JSON.stringify({
        git: { forbiddenCommitMessagePatterns: ['Generated with'] },
      }),
    )
    resetSettingsCache()

    const result = await bashToolHasPermission(
      { command: 'git commit -m "fix: policy\n\nGenerated with OpenClaude"' },
      makeToolUseContext(),
    )
    const compoundResult = await bashToolHasPermission(
      {
        command:
          'cd repo && git commit -m "fix: policy\n\nGenerated with OpenClaude"',
      },
      makeToolUseContext(),
    )
    const safeCommitThenEchoResult = await bashToolHasPermission(
      {
        command:
          'git commit -m "safe" && echo -m "Generated with OpenClaude"',
      },
      makeToolUseContext(),
    )
    const commandWrappedResult = await bashToolHasPermission(
      {
        command:
          'command git commit -m "fix: policy\n\nGenerated with OpenClaude"',
      },
      makeToolUseContext(),
    )
    const commandPathWrappedResult = await bashToolHasPermission(
      {
        command:
          'command -p git commit -m "fix: policy\n\nGenerated with OpenClaude"',
      },
      makeToolUseContext(),
    )
    const envWrappedResult = await bashToolHasPermission(
      {
        command:
          'env git commit -m "fix: policy\n\nGenerated with OpenClaude"',
      },
      makeToolUseContext(),
    )
    const envSplitStringWrappedResult = await bashToolHasPermission(
      {
        command:
          'env -S \'git commit -m "fix: policy\n\nGenerated with OpenClaude"\'',
      },
      makeToolUseContext(),
    )
    const envSplitStringAssignmentWrappedResult = await bashToolHasPermission(
      {
        command:
          'env -S \'GIT_AUTHOR_NAME=bot git commit -m "fix: policy\n\nGenerated with OpenClaude"\'',
      },
      makeToolUseContext(),
    )

    expect(result.behavior).toBe('ask')
    expect(compoundResult.behavior).toBe('ask')
    expect(safeCommitThenEchoResult.behavior).not.toBe('ask')
    expect(commandWrappedResult.behavior).toBe('ask')
    expect(commandPathWrappedResult.behavior).toBe('ask')
    expect(envWrappedResult.behavior).toBe('ask')
    expect(envSplitStringWrappedResult.behavior).toBe('ask')
    expect(envSplitStringAssignmentWrappedResult.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(compoundResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(commandWrappedResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(commandPathWrappedResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(envWrappedResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(envSplitStringWrappedResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
    expect(envSplitStringAssignmentWrappedResult.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'Git commit message contains forbidden pattern: Generated with',
      classifierApprovable: false,
    })
  } finally {
    setOriginalCwd(originalCwd)
    setAllowedSettingSources([...SETTING_SOURCES])
    resetSettingsCache()
    await rm(projectDir, { recursive: true, force: true })
  }
})

// SEC-02 regression: array subscript with command substitution must NOT be stripped.
// Bash executes FOO[$(cmd)]=val as a side effect; if the pattern matched the
// subscript, the env-var prefix would be stripped while $(cmd) silently ran.
describe('stripAllLeadingEnvVars — SEC-02 subscript expansion guard', () => {
  test('does not strip env var whose subscript contains $()', () => {
    const cmd = 'FOO[$(id)]=val denied_cmd'
    // Pattern must NOT match — command stays intact, deny check sees the full string.
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('does not strip env var whose subscript contains ${var}', () => {
    const cmd = 'ARR[${evil}]=x ls'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('does not strip env var whose subscript contains a backtick', () => {
    const cmd = 'X[`id`]=1 echo hi'
    expect(stripAllLeadingEnvVars(cmd)).toBe(cmd.trim())
  })

  test('still strips a safe numeric array subscript', () => {
    // FOO[0]=val cmd → cmd (safe, no expansion in subscript)
    expect(stripAllLeadingEnvVars('FOO[0]=val cmd')).toBe('cmd')
  })

  test('still strips a safe identifier array subscript', () => {
    expect(stripAllLeadingEnvVars('ARR[idx]=x ls')).toBe('ls')
  })
})

describe('speculative cache eviction', () => {
  beforeEach(() => {
    clearSpeculativeChecks()
  })

  test('evictSpeculativeChecks removes oldest entries when over cap', () => {
    const { speculativeChecks, evictSpeculativeChecks, MAX_SPECULATIVE_CHECKS_SIZE } = _test

    // Fill just under the cap
    for (let i = 0; i < MAX_SPECULATIVE_CHECKS_SIZE; i++) {
      speculativeChecks.set(`cmd-${i}`, Promise.resolve('allow' as never))
    }
    expect(speculativeChecks.size).toBe(MAX_SPECULATIVE_CHECKS_SIZE)

    // Add one more and evict
    speculativeChecks.set('overflow', Promise.resolve('allow' as never))
    evictSpeculativeChecks()
    expect(speculativeChecks.size).toBe(MAX_SPECULATIVE_CHECKS_SIZE)
    expect(speculativeChecks.has('cmd-0')).toBe(false)
    expect(speculativeChecks.has('overflow')).toBe(true)
  })

  test('FIFO eviction removes entries in insertion order', () => {
    const { speculativeChecks, evictSpeculativeChecks, MAX_SPECULATIVE_CHECKS_SIZE } = _test

    for (let i = 0; i < MAX_SPECULATIVE_CHECKS_SIZE; i++) {
      speculativeChecks.set(`cmd-${i}`, Promise.resolve('allow' as never))
    }

    // Add 3 more - should evict cmd-0, cmd-1, cmd-2
    speculativeChecks.set('extra-1', Promise.resolve('allow' as never))
    speculativeChecks.set('extra-2', Promise.resolve('allow' as never))
    speculativeChecks.set('extra-3', Promise.resolve('allow' as never))
    evictSpeculativeChecks()

    expect(speculativeChecks.has('cmd-0')).toBe(false)
    expect(speculativeChecks.has('cmd-1')).toBe(false)
    expect(speculativeChecks.has('cmd-2')).toBe(false)
    expect(speculativeChecks.has('cmd-3')).toBe(true)
    expect(speculativeChecks.has('cmd-999')).toBe(true)
    expect(speculativeChecks.has('extra-1')).toBe(true)
    expect(speculativeChecks.has('extra-2')).toBe(true)
    expect(speculativeChecks.has('extra-3')).toBe(true)
  })

  test('peek and consume return undefined for evicted entries', () => {
    const { speculativeChecks, evictSpeculativeChecks, MAX_SPECULATIVE_CHECKS_SIZE } = _test

    for (let i = 0; i < MAX_SPECULATIVE_CHECKS_SIZE; i++) {
      speculativeChecks.set(`cmd-${i}`, Promise.resolve('allow' as never))
    }

    speculativeChecks.set('survivor', Promise.resolve('allow' as never))
    evictSpeculativeChecks()

    expect(peekSpeculativeClassifierCheck('cmd-0')).toBeUndefined()
    expect(consumeSpeculativeClassifierCheck('cmd-0')).toBeUndefined()
    expect(peekSpeculativeClassifierCheck('survivor')).toBeDefined()
  })

  test('eviction handles exact boundary without removing entries', () => {
    const { speculativeChecks, evictSpeculativeChecks, MAX_SPECULATIVE_CHECKS_SIZE } = _test

    for (let i = 0; i < MAX_SPECULATIVE_CHECKS_SIZE; i++) {
      speculativeChecks.set(`cmd-${i}`, Promise.resolve('allow' as never))
    }

    evictSpeculativeChecks()
    expect(speculativeChecks.size).toBe(MAX_SPECULATIVE_CHECKS_SIZE)
    expect(speculativeChecks.has('cmd-0')).toBe(true)
    expect(speculativeChecks.has('cmd-999')).toBe(true)
  })

  test('empty map survives eviction without error', () => {
    const { evictSpeculativeChecks } = _test
    expect(() => evictSpeculativeChecks()).not.toThrow()
  })

  test('peeking and consuming still works at boundary conditions', () => {
    const { speculativeChecks, evictSpeculativeChecks, MAX_SPECULATIVE_CHECKS_SIZE } = _test

    for (let i = 0; i < MAX_SPECULATIVE_CHECKS_SIZE; i++) {
      speculativeChecks.set(`cmd-${i}`, Promise.resolve('allow' as never))
    }

    expect(peekSpeculativeClassifierCheck('cmd-0')).toBeDefined()
    expect(peekSpeculativeClassifierCheck(`cmd-${MAX_SPECULATIVE_CHECKS_SIZE - 1}`)).toBeDefined()

    speculativeChecks.set('overflow', Promise.resolve('allow' as never))
    evictSpeculativeChecks()

    expect(peekSpeculativeClassifierCheck('cmd-0')).toBeUndefined()
    expect(peekSpeculativeClassifierCheck('cmd-1')).toBeDefined()
    expect(peekSpeculativeClassifierCheck('overflow')).toBeDefined()

    const consumed1 = consumeSpeculativeClassifierCheck('cmd-1')
    expect(consumed1).toBeDefined()
    expect(peekSpeculativeClassifierCheck('cmd-1')).toBeUndefined()

    const consumedOverflow = consumeSpeculativeClassifierCheck('overflow')
    expect(consumedOverflow).toBeDefined()
    expect(peekSpeculativeClassifierCheck('overflow')).toBeUndefined()
  })
})

// Regression: a literal allow rule must not silently win when a Bash prompt
// deny/ask rule exists but the classifier could not evaluate it (provider
// error, malformed verdict). Only an evaluated non-match may fall through.
// sideQuery is mocked so the whole classifyBashCommand path runs for real.
describe('Bash prompt rules when the classifier is unavailable', () => {
  const classifierEnabled = feature('BASH_CLASSIFIER') ? true : false
  let realSideQueryModule: Record<string, unknown> | undefined
  let sideQueryCalls = 0
  let sideQueryImpl: (opts: unknown) => Promise<unknown> = async () => {
    throw new Error('sideQuery mock not configured')
  }

  beforeEach(async () => {
    sideQueryCalls = 0
    realSideQueryModule ??= (await import('../../utils/sideQuery.js')) as Record<
      string,
      unknown
    >
    mock.module('../../utils/sideQuery.js', () => ({
      ...realSideQueryModule,
      sideQuery: (opts: unknown) => {
        sideQueryCalls++
        return sideQueryImpl(opts)
      },
    }))
  })

  afterEach(() => {
    // mock.module() is process-global and mock.restore() does not undo it.
    if (realSideQueryModule) {
      const real = realSideQueryModule
      mock.module('../../utils/sideQuery.js', () => real)
    }
  })

  function promptRuleContext() {
    return {
      ...getEmptyToolPermissionContext(),
      alwaysAllowRules: { projectSettings: ['Bash(git status)'] },
      alwaysDenyRules: { projectSettings: ['Bash(prompt: git commands)'] },
    }
  }

  test('unavailable deny classifier prompts instead of falling through to literal allow', async () => {
    sideQueryImpl = async () => {
      throw new Error('provider down')
    }
    const result = await bashToolHasPermission(
      { command: 'git status' },
      makeToolUseContext(promptRuleContext()),
    )
    if (classifierEnabled) {
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason).toMatchObject({
        type: 'other',
        reason: expect.stringContaining('could not be evaluated'),
      })
      expect(sideQueryCalls).toBe(1)
    } else {
      // Feature gated off: the prompt rule is inert, literal allow applies.
      expect(result.behavior).toBe('allow')
      expect(sideQueryCalls).toBe(0)
    }
  })

  test('evaluated non-match still falls through to literal allow', async () => {
    sideQueryImpl = async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'report_bash_rule_match',
          id: 'tu_1',
          input: {
            reasoning: 'no fit',
            matched_index: -1,
            confidence: 'medium',
            reason: 'outside scope',
          },
        },
      ],
    })
    const result = await bashToolHasPermission(
      { command: 'git status' },
      makeToolUseContext(promptRuleContext()),
    )
    expect(result.behavior).toBe('allow')
    expect(sideQueryCalls).toBe(classifierEnabled ? 1 : 0)
  })
})
