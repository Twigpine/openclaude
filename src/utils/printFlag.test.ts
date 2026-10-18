import { describe, expect, test } from 'bun:test'
import {
  argsBeforeModelOwningSubcommand,
  findRootCommandPathIndex,
  hasPrintFlag,
  parseRootOptionValue,
} from './printFlag.js'

describe('findRootCommandPathIndex', () => {
  test('finds a real command path after boolean root options', () => {
    expect(findRootCommandPathIndex(
      ['--bare', 'aimlapi', 'topup', '--model', 'gpt-4o'],
      ['aimlapi', 'topup'],
    )).toBe(1)
  })

  test('does not mistake required or optional option values for commands', () => {
    expect(findRootCommandPathIndex(
      ['--name', 'aimlapi', 'topup', '--model', 'gpt-4o'],
      ['aimlapi', 'topup'],
    )).toBe(-1)
    expect(findRootCommandPathIndex(
      ['--debug', 'aimlapi', 'topup', '--model', 'gpt-4o'],
      ['aimlapi', 'topup'],
    )).toBe(-1)
  })

  test('finds a command after an inline optional option value', () => {
    expect(findRootCommandPathIndex(
      ['--debug=api', 'aimlapi', 'topup', '--model', 'gpt-4o'],
      ['aimlapi', 'topup'],
    )).toBe(1)
  })
})

describe('argsBeforeModelOwningSubcommand', () => {
  test('drops argv from nested aimlapi topup onward', () => {
    expect(
      argsBeforeModelOwningSubcommand([
        '--provider',
        'commandcode',
        '--model',
        'deepseek/deepseek-v4-flash',
        'aimlapi',
        'topup',
        '--model',
        'anthropic/claude-sonnet-4-6',
      ]),
    ).toEqual([
      '--provider',
      'commandcode',
      '--model',
      'deepseek/deepseek-v4-flash',
    ])
  })

  test('drops argv from nested auto-mode critique onward', () => {
    expect(
      argsBeforeModelOwningSubcommand([
        '--model=deepseek/deepseek-v4-flash',
        'auto-mode',
        'critique',
        '--model=anthropic/claude-sonnet-4-6',
      ]),
    ).toEqual(['--model=deepseek/deepseek-v4-flash'])
  })

  test('does not treat a required option value as a nested command path', () => {
    const args = [
      '--name',
      'aimlapi',
      'topup',
      '--model',
      'deepseek/deepseek-v4-flash',
    ]
    expect(argsBeforeModelOwningSubcommand(args)).toEqual(args)
  })

  test('keeps inline optional values before a nested command boundary', () => {
    expect(
      argsBeforeModelOwningSubcommand([
        '--debug=api',
        'aimlapi',
        'topup',
        '--model',
        'anthropic/claude-sonnet-4-6',
      ]),
    ).toEqual(['--debug=api'])
  })
})

describe('parseRootOptionValue', () => {
  test('ignores option-looking text consumed by another root option', () => {
    expect(parseRootOptionValue(
      ['--system-prompt', '--model=not-a-real-option'],
      '--model',
    )).toBeUndefined()
  })

  test('returns the final real option occurrence', () => {
    expect(parseRootOptionValue(
      ['--name', 'worker', '--model=first', '--model', 'second'],
      '--model',
    )).toBe('second')
  })

  test('finds --model after a required option consumes the -- delimiter', () => {
    expect(parseRootOptionValue(
      ['--system-prompt', '--', '--model', 'deepseek/deepseek-v4-flash'],
      '--model',
    )).toBe('deepseek/deepseek-v4-flash')
  })

  test('stops at a real end-of-options marker', () => {
    expect(parseRootOptionValue(
      [
        '--system-prompt',
        'hello',
        '--',
        '--model',
        'deepseek/deepseek-v4-flash',
      ],
      '--model',
    )).toBeUndefined()
  })
})

describe('hasPrintFlag', () => {
  test('detects the standalone -p and --print boolean flags', () => {
    expect(hasPrintFlag(['-p'])).toBe(true)
    expect(hasPrintFlag(['--print'])).toBe(true)
    expect(hasPrintFlag(['cc://host', '--print'])).toBe(true)
  })

  test('does not treat invalid boolean spellings as print mode', () => {
    // The root command rejects these; only exact `-p` / `--print` are valid.
    expect(hasPrintFlag(['--print=prompt'])).toBe(false)
    expect(hasPrintFlag(['-pprompt'])).toBe(false)
  })

  test('does not mistake bare positional text for the flag', () => {
    expect(hasPrintFlag(['cc://host', 'prompt'])).toBe(false)
    expect(hasPrintFlag(['cc://host', '-x', 'prompt'])).toBe(false)
  })

  test('stops at the -- end-of-options marker', () => {
    expect(hasPrintFlag(['cc://host', '--', '--print'])).toBe(false)
    expect(hasPrintFlag(['cc://host', '--', '-p'])).toBe(false)
  })

  test('does not classify a value of a required option as the print flag', () => {
    expect(hasPrintFlag(['--system-prompt', '--print=custom'])).toBe(false)
    expect(hasPrintFlag(['--model', '-p'])).toBe(false)
    expect(hasPrintFlag(['--permission-mode', '--print'])).toBe(false)
    expect(hasPrintFlag(['--system-prompt=--print=custom'])).toBe(false)

    // Required options consume `--` as their value, so the following flag is
    // still parsed by Commander.
    expect(hasPrintFlag(['--model', '--', '-p'])).toBe(true)
  })

  test('does not classify a value of a variadic option as the print flag', () => {
    expect(hasPrintFlag(['--add-dir', '--print'])).toBe(false)
    expect(hasPrintFlag(['--add-dir', '-p'])).toBe(false)

    // After the first value, variadic options stop at the next flag.
    expect(hasPrintFlag(['--add-dir', 'foo', '--print'])).toBe(true)
  })

  test('does not classify a value of an optional option as the print flag unless explicitly provided', () => {
    // Optional-value options do not consume a following flag, so --print/-p is
    // still detected.
    expect(hasPrintFlag(['--resume', '--print'])).toBe(true)
    expect(hasPrintFlag(['--debug', '-p'])).toBe(true)

    // But a non-flag value is consumed and not mistaken for the print flag.
    expect(hasPrintFlag(['--resume', 'print'])).toBe(false)
    expect(hasPrintFlag(['--debug', 'p'])).toBe(false)

    // Optional options do not consume `--`.
    expect(hasPrintFlag(['--resume', '--', '--print'])).toBe(false)

    // Hidden optional-value root options likewise leave following flags alone.
    expect(hasPrintFlag(['--worktree', '--print'])).toBe(true)
    expect(hasPrintFlag(['--teleport', '-p'])).toBe(true)
    expect(hasPrintFlag(['--remote', 'print'])).toBe(false)
    expect(hasPrintFlag(['--remote-control', 'rc'])).toBe(false)
  })

  test('does not classify a value of hidden required root options as the print flag', () => {
    expect(hasPrintFlag(['--agent-id', '--print'])).toBe(false)
    expect(hasPrintFlag(['--sdk-url', '-p'])).toBe(false)
    expect(hasPrintFlag(['--agent-name', '--print'])).toBe(false)
    expect(hasPrintFlag(['--team-name', '-p'])).toBe(false)
    expect(hasPrintFlag(['--parent-session-id', '--print'])).toBe(false)
    expect(hasPrintFlag(['--teammate-mode', '-p'])).toBe(false)
    expect(hasPrintFlag(['--agent-type', '--print'])).toBe(false)
    expect(hasPrintFlag(['--advisor', '-p'])).toBe(false)
    expect(hasPrintFlag(['--messaging-socket-path', '--print'])).toBe(false)
    expect(hasPrintFlag(['--agent-color', '-p'])).toBe(false)
  })

  test('does not classify a value of hidden variadic root options as the print flag', () => {
    expect(hasPrintFlag(['--channels', '--print'])).toBe(false)
    expect(hasPrintFlag(['--channels', '-p'])).toBe(false)
    expect(hasPrintFlag(['--dangerously-load-development-channels', '--print'])).toBe(false)

    // After the first value, variadic options keep consuming consecutive
    // non-flag values, so a later positional-looking value is still hidden.
    expect(hasPrintFlag(['--channels', 'server1', 'server2', 'print'])).toBe(false)

    // Once the next token is a flag, variadic consumption stops and --print
    // is detected normally.
    expect(hasPrintFlag(['--channels', 'server1', '--print'])).toBe(true)
    expect(hasPrintFlag(['--channels', 'server1', 'server2', '--print'])).toBe(true)
  })
})
