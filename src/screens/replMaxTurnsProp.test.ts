import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  Command as CommanderCommand,
  InvalidArgumentError,
  Option,
} from '@commander-js/extra-typings'
import {
  canRestoreDeferredMaxTurnsCap,
  claimBackgroundTurnBudget,
  computeDeferredMaxTurnsCapForBackgroundHandoff,
  createForegroundTurnBudgetHandoff,
  isLocalInteractiveMaxTurnsSession,
  releaseForegroundTurnBudget,
  resolveReplMaxTurnsForSession,
  shouldContinueBackgroundAfterForegroundQuery,
  shouldShowReplMaxTurnsUnlimitedWarning,
  waitForForegroundTurnBudgetSettlement,
} from './replMaxTurns.js'
import { createQueryTurnBudget } from '../query.js'
import {
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_KEYS,
  getGlobalConfig,
  isGlobalConfigKey,
  saveGlobalConfig,
} from '../utils/config.js'
import {
  DEFAULT_REPL_MAX_TURNS,
  getReplMaxTurnsWarning,
  MAX_TURNS_CLI_DESCRIPTION,
  MAX_TURNS_UNLIMITED_WARNING,
  normalizeReplMaxTurns,
  parseMaxTurnsCommanderArgument,
  parseMaxTurnsCli,
  REPL_MAX_TURNS_OPTIONS,
  resolveReplMaxTurns,
} from '../utils/replMaxTurns.js'
import * as debug from '../utils/debug.js'

const ENV_KEYS = ['OPENCLAUDE_MAX_TURNS', 'CLAUDE_CODE_MAX_TURNS'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {}
const savedReplMaxTurns = getGlobalConfig().replMaxTurns

function clearTurnEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

function setReplMaxTurnsConfig(value: number | undefined): void {
  saveGlobalConfig(current => ({
    ...current,
    replMaxTurns: value,
  }))
}

function createMaxTurnsCliProgram(): CommanderCommand {
  const program = new CommanderCommand()
  program
    .name('openclaude')
    .exitOverride()
    .addOption(
      new Option('--max-turns <turns>', MAX_TURNS_CLI_DESCRIPTION).argParser(
        value => {
          return parseMaxTurnsCommanderArgument(value)
        },
      ),
    )
    .action(() => {})
  return program
}

beforeEach(() => {
  clearTurnEnv()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key]
    if (previous === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previous
    }
  }
  setReplMaxTurnsConfig(savedReplMaxTurns)
})

for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
}

describe('interactive REPL max-turn cap', () => {
  test('supplies the local interactive default at runtime', () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(undefined)
    expect(DEFAULT_REPL_MAX_TURNS).toBe(50)
    expect(resolveReplMaxTurns()).toBe(50)
  })

  test('preserves an explicit interactive cap at runtime', () => {
    clearTurnEnv()
    expect(resolveReplMaxTurns(7)).toBe(7)
  })

  test('honors OPENCLAUDE_MAX_TURNS when no explicit cap is passed', () => {
    clearTurnEnv()
    process.env.OPENCLAUDE_MAX_TURNS = '200'
    expect(resolveReplMaxTurns()).toBe(200)
  })

  test('falls back to CLAUDE_CODE_MAX_TURNS when OPENCLAUDE_MAX_TURNS is unset', () => {
    clearTurnEnv()
    process.env.CLAUDE_CODE_MAX_TURNS = '125'
    expect(resolveReplMaxTurns()).toBe(125)
  })

  test('prefers OPENCLAUDE_MAX_TURNS over CLAUDE_CODE_MAX_TURNS', () => {
    clearTurnEnv()
    process.env.OPENCLAUDE_MAX_TURNS = '90'
    process.env.CLAUDE_CODE_MAX_TURNS = '30'
    expect(resolveReplMaxTurns()).toBe(90)
  })

  test('invalid OPENCLAUDE_MAX_TURNS does not fall through to legacy', () => {
    clearTurnEnv()
    process.env.OPENCLAUDE_MAX_TURNS = 'nope'
    process.env.CLAUDE_CODE_MAX_TURNS = '125'
    expect(resolveReplMaxTurns()).toBe(DEFAULT_REPL_MAX_TURNS)
  })

  test('does not include an invalid environment value in debug logs', () => {
    clearTurnEnv()
    const invalidValue = 'private-value-that-must-not-be-logged'
    process.env.OPENCLAUDE_MAX_TURNS = invalidValue
    const logSpy = spyOn(debug, 'logForDebugging').mockImplementation(() => {})

    try {
      expect(resolveReplMaxTurns()).toBe(DEFAULT_REPL_MAX_TURNS)
      expect(logSpy).toHaveBeenCalledTimes(1)
      const logged = logSpy.mock.calls.flat().join(' ')
      expect(logged).toContain('OPENCLAUDE_MAX_TURNS has an invalid value')
      expect(logged).not.toContain(invalidValue)
    } finally {
      logSpy.mockRestore()
    }
  })

  test('explicit CLI cap wins over environment overrides', () => {
    clearTurnEnv()
    process.env.OPENCLAUDE_MAX_TURNS = '200'
    expect(resolveReplMaxTurns(80)).toBe(80)
  })

  test('honors /config replMaxTurns when CLI and env are unset', () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(200)
    expect(resolveReplMaxTurns()).toBe(200)
  })

  test('env wins over /config replMaxTurns', () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(200)
    process.env.OPENCLAUDE_MAX_TURNS = '80'
    expect(resolveReplMaxTurns()).toBe(80)
  })

  test('CLI wins over /config replMaxTurns', () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(200)
    expect(resolveReplMaxTurns(90)).toBe(90)
  })

  test('treats an explicit CLI zero as unlimited and invalid values as the default', () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(undefined)
    process.env.OPENCLAUDE_MAX_TURNS = 'nope'
    expect(resolveReplMaxTurns()).toBe(DEFAULT_REPL_MAX_TURNS)
    clearTurnEnv()
    expect(resolveReplMaxTurns(0)).toBeUndefined()
    expect(resolveReplMaxTurns(-3)).toBe(DEFAULT_REPL_MAX_TURNS)
    expect(resolveReplMaxTurns(Number.NaN)).toBe(DEFAULT_REPL_MAX_TURNS)
    expect(resolveReplMaxTurns(2.5)).toBe(DEFAULT_REPL_MAX_TURNS)
  })

  test('warns when the CLI explicitly disables the turn limit', () => {
    expect(getReplMaxTurnsWarning(0)).toBe(MAX_TURNS_UNLIMITED_WARNING)
    expect(getReplMaxTurnsWarning(50)).toBeUndefined()
    expect(getReplMaxTurnsWarning()).toBeUndefined()
  })

  test('emits the unlimited warning only from a local REPL', () => {
    expect(
      shouldShowReplMaxTurnsUnlimitedWarning(0, {
        isRemoteSession: false,
        directConnectConfig: undefined,
        sshSession: undefined,
      }),
    ).toBe(true)
    expect(
      shouldShowReplMaxTurnsUnlimitedWarning(0, {
        isRemoteSession: true,
        directConnectConfig: undefined,
        sshSession: undefined,
      }),
    ).toBe(false)
    expect(
      shouldShowReplMaxTurnsUnlimitedWarning(0, {
        isRemoteSession: false,
        directConnectConfig: {},
        sshSession: undefined,
      }),
    ).toBe(false)
    expect(
      shouldShowReplMaxTurnsUnlimitedWarning(0, {
        isRemoteSession: false,
        directConnectConfig: undefined,
        sshSession: {},
      }),
    ).toBe(false)
    expect(
      shouldShowReplMaxTurnsUnlimitedWarning(50, {
        isRemoteSession: false,
        directConnectConfig: undefined,
        sshSession: undefined,
      }),
    ).toBe(false)
    expect(isLocalInteractiveMaxTurnsSession({
      isRemoteSession: false,
      directConnectConfig: undefined,
      sshSession: undefined,
    })).toBe(true)
  })

  test('normalizeReplMaxTurns matches /config picker persistence', () => {
    expect(normalizeReplMaxTurns(200)).toBe(200)
    expect(normalizeReplMaxTurns('500')).toBe(500)
    expect(normalizeReplMaxTurns(0)).toBe(DEFAULT_REPL_MAX_TURNS)
    expect(normalizeReplMaxTurns('nope')).toBe(DEFAULT_REPL_MAX_TURNS)
  })

  test('replMaxTurns is registered for /config', () => {
    expect(GLOBAL_CONFIG_KEYS).toContain('replMaxTurns')
    expect(isGlobalConfigKey('replMaxTurns')).toBe(true)
    expect(DEFAULT_GLOBAL_CONFIG.replMaxTurns).toBeUndefined()
    expect(REPL_MAX_TURNS_OPTIONS).toEqual([50, 100, 200, 500])
  })

  test('headless --max-turns 0 stays distinct from interactive unlimited resolution', () => {
    expect(parseMaxTurnsCli('0')).toBe(0)
    expect(resolveReplMaxTurns(0)).toBeUndefined()
    const headlessTurnBudget = createQueryTurnBudget(parseMaxTurnsCli('0'))
    expect(headlessTurnBudget.maxTurns).toBe(0)
    // Headless passes the CLI value through; falsy maxTurns disables turn-cap guards.
    expect(Boolean(headlessTurnBudget.maxTurns)).toBe(false)
    const help = MAX_TURNS_CLI_DESCRIPTION.toLowerCase()
    expect(help).toContain('local interactive mode')
    expect(help).toContain('--print mode')
  })

  test('background budget handoff preserves identity, settlement, and one-shot ownership', async () => {
    const handoff = createForegroundTurnBudgetHandoff(50)
    const budgetRef = { current: handoff }
    const handoffStartedRef = { current: false }

    expect(
      claimBackgroundTurnBudget(budgetRef, handoffStartedRef),
    ).toBe(handoff)
    expect(handoff.budget.maxTurns).toBe(50)
    expect(
      claimBackgroundTurnBudget(budgetRef, handoffStartedRef),
    ).toBeNull()

    const newerHandoff = createForegroundTurnBudgetHandoff(100)
    budgetRef.current = newerHandoff
    handoffStartedRef.current = false
    releaseForegroundTurnBudget(budgetRef, handoffStartedRef, handoff, true)
    await expect(handoff.settled).resolves.toBe(true)
    expect(budgetRef.current).toBe(newerHandoff)

    releaseForegroundTurnBudget(
      budgetRef,
      handoffStartedRef,
      newerHandoff,
      false,
    )
    await expect(newerHandoff.settled).resolves.toBe(false)
    expect(budgetRef.current).toBeNull()
    expect(handoffStartedRef.current).toBe(false)
  })

  test('a stopped background task does not remain blocked on foreground settlement', async () => {
    const handoff = createForegroundTurnBudgetHandoff(50)
    const abortController = new AbortController()
    const wait = waitForForegroundTurnBudgetSettlement(
      handoff,
      abortController.signal,
    )

    abortController.abort('task stopped')

    await expect(wait).resolves.toBeNull()
  })

  test('defers max-turn cap restoration when foreground suppresses it for background handoff', () => {
    expect(
      computeDeferredMaxTurnsCapForBackgroundHandoff(
        'background',
        { reason: 'aborted_tools' },
        1,
        1,
      ),
    ).toEqual({ maxTurns: 1, turnCount: 2 })
    expect(
      computeDeferredMaxTurnsCapForBackgroundHandoff(
        'background',
        { reason: 'aborted_streaming' },
        1,
        1,
      ),
    ).toBeUndefined()
    expect(
      computeDeferredMaxTurnsCapForBackgroundHandoff(
        'user',
        { reason: 'aborted_tools' },
        1,
        1,
      ),
    ).toBeUndefined()
  })

  test('skips deferred max-turn restoration when a newer prompt owns the transcript', () => {
    const handoff = createForegroundTurnBudgetHandoff(1)
    handoff.deferredMaxTurnsCap = { maxTurns: 1, turnCount: 2 }
    handoff.settledTranscriptTailUuid = 'prior-tail'

    expect(
      canRestoreDeferredMaxTurnsCap(handoff, [
        { uuid: 'prior-tail' },
      ]),
    ).toBe(true)
    expect(
      canRestoreDeferredMaxTurnsCap(handoff, [
        { uuid: 'prior-tail' },
        { uuid: 'new-user-turn' },
      ]),
    ).toBe(false)
  })

  test('does not apply the local interactive cap in remote-backed sessions', () => {
    clearTurnEnv()
    process.env.OPENCLAUDE_MAX_TURNS = '80'
    expect(
      resolveReplMaxTurnsForSession(undefined, {
        isRemoteSession: true,
        directConnectConfig: undefined,
        sshSession: undefined,
      }),
    ).toBeUndefined()
    expect(
      resolveReplMaxTurnsForSession(90, {
        isRemoteSession: false,
        directConnectConfig: {},
        sshSession: undefined,
      }),
    ).toBeUndefined()
    expect(
      resolveReplMaxTurnsForSession(90, {
        isRemoteSession: false,
        directConnectConfig: undefined,
        sshSession: {},
      }),
    ).toBeUndefined()
    expect(
      resolveReplMaxTurnsForSession(90, {
        isRemoteSession: false,
        directConnectConfig: undefined,
        sshSession: undefined,
      }),
    ).toBe(90)
  })

  test('does not continue a background handoff after the foreground query throws', () => {
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: true,
        preflightVetoed: false,
        abortReason: 'background',
        queryTerminal: { reason: 'aborted_streaming' },
      }),
    ).toBe(false)
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: false,
        preflightVetoed: true,
        abortReason: 'background',
        queryTerminal: undefined,
      }),
    ).toBe(false)
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: false,
        preflightVetoed: false,
        abortReason: 'background',
        queryTerminal: { reason: 'aborted_streaming' },
      }),
    ).toBe(true)
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: false,
        preflightVetoed: false,
        abortReason: 'background',
        queryTerminal: { reason: 'aborted_tools' },
      }),
    ).toBe(true)
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: false,
        preflightVetoed: false,
        abortReason: 'background',
        queryTerminal: undefined,
      }),
    ).toBe(false)
    expect(
      shouldContinueBackgroundAfterForegroundQuery({
        didThrow: false,
        preflightVetoed: false,
        abortReason: 'user',
        queryTerminal: { reason: 'aborted_streaming' },
      }),
    ).toBe(false)
  })

  test('Commander --max-turns help scopes the interactive cap to local query loops', () => {
    // Commander wraps long option help across lines; collapse whitespace.
    const help = createMaxTurnsCliProgram()
      .helpInformation()
      .toLowerCase()
      .replace(/\s+/g, ' ')
    expect(help).toContain('--max-turns')
    expect(help).toContain('local interactive')
    expect(help).toContain('remote-backed')
    expect(help).not.toContain('only works with --print')
  })

  test('Commander --max-turns parses into the value the local REPL resolves', async () => {
    clearTurnEnv()
    setReplMaxTurnsConfig(50)
    const program = createMaxTurnsCliProgram()
    await program.parseAsync(['node', 'openclaude', '--max-turns', '200'], {
      from: 'node',
    })
    const parsed = program.getOptionValue('maxTurns') as number
    expect(parsed).toBe(200)
    // Same handoff the interactive session uses: CLI option → resolveReplMaxTurns.
    expect(resolveReplMaxTurns(parsed)).toBe(200)
  })

  test('Commander --max-turns rejects values that could disable the cap accidentally', () => {
    expect(parseMaxTurnsCli('0')).toBe(0)
    expect(parseMaxTurnsCli('200')).toBe(200)
    for (const invalid of ['', '   ', 'nope', '-3', '2.5', 'Infinity']) {
      expect(() => parseMaxTurnsCli(invalid)).toThrow(
        '--max-turns must be a non-negative integer',
      )
    }
  })

  test('Commander formats invalid --max-turns as an option error', async () => {
    const program = createMaxTurnsCliProgram()
    await expect(
      program.parseAsync(['node', 'openclaude', '--max-turns', 'nope'], {
        from: 'node',
      }),
    ).rejects.toMatchObject({
      code: 'commander.invalidArgument',
      exitCode: 1,
    })
  })
})
