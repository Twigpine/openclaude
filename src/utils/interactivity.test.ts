import { expect, test, describe } from 'bun:test'
import { hasPrintFlag } from './printFlag.js'
import { isInteractiveSession } from './interactivity.js'

describe('isInteractiveSession', () => {
  test('returns true when stdout is TTY', () => {
    expect(
      isInteractiveSession({
        stdoutIsTTY: true,
        args: [],
        env: {},
      }),
    ).toBe(true)
  })

  test('returns false when stdout is not TTY and no SSH env vars', () => {
    expect(
      isInteractiveSession({
        stdoutIsTTY: false,
        args: [],
        env: {},
      }),
    ).toBe(false)
  })

  test('returns true when in SSH session even if stdout is not TTY (SSH_TTY)', () => {
    expect(
      isInteractiveSession({
        stdoutIsTTY: false,
        args: [],
        env: { SSH_TTY: '/dev/pts/0' },
      }),
    ).toBe(true)
  })

  test('returns false when in SSH session without TTY allocation (SSH_CONNECTION only)', () => {
    // Regression test for piped-stdin-over-ssh case
    expect(
      isInteractiveSession({
        stdoutIsTTY: false,
        args: [],
        env: { SSH_CONNECTION: '192.168.1.1 56789 192.168.1.100 22' },
      }),
    ).toBe(false)
  })

  test('returns false when explicit non-interactive flags are present even with SSH', () => {
    expect(
      isInteractiveSession({
        stdoutIsTTY: true,
        args: ['-p'],
        env: { SSH_TTY: '/dev/pts/0' },
      }),
    ).toBe(false)

    expect(
      isInteractiveSession({
        stdoutIsTTY: true,
        args: ['--print'],
        env: { SSH_TTY: '/dev/pts/0' },
      }),
    ).toBe(false)

    expect(
      isInteractiveSession({
        stdoutIsTTY: true,
        args: ['--init-only'],
        env: { SSH_TTY: '/dev/pts/0' },
      }),
    ).toBe(false)

    expect(
      isInteractiveSession({
        stdoutIsTTY: true,
        args: ['--sdk-url=ws://localhost'],
        env: { SSH_TTY: '/dev/pts/0' },
      }),
    ).toBe(false)
  })

  test('agrees with hasPrintFlag on value-consumed and genuine print argv', () => {
    // If hasPrintFlag says the argv is not print mode, isInteractiveSession
    // must not treat it as non-interactive just because a -p/--print token
    // appears as a value.
    const rows = [
      { args: [], print: false },
      { args: ['-p'], print: true },
      { args: ['--print'], print: true },
      { args: ['cc://host', '--print'], print: true },
      { args: ['--system-prompt', '--print'], print: false },
      { args: ['--system-prompt', '-p'], print: false },
      { args: ['--model', '-p'], print: false },
      { args: ['--permission-mode', '--print'], print: false },
      { args: ['--add-dir', '--print'], print: false },
      { args: ['--resume', '--print'], print: true },
      { args: ['--debug', '-p'], print: true },
    ]

    for (const { args, print } of rows) {
      expect(hasPrintFlag(args)).toBe(print)
      expect(
        isInteractiveSession({
          stdoutIsTTY: true,
          args,
          env: { SSH_TTY: '/dev/pts/0' },
        }),
      ).toBe(!print)
    }
  })
})
