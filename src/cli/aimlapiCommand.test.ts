import { expect, mock, test } from 'bun:test'
import { Command as CommanderCommand } from '@commander-js/extra-typings'

import { registerAimlapiCommand } from './aimlapiCommand.js'

test('aimlapi topup forwards the passwordless CLI contract', async () => {
  const handler = mock(async () => {})
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => handler)

  await program.parseAsync([
    'node',
    'openclaude',
    'aimlapi',
    'topup',
    '--email',
    'user@example.com',
    '--code',
    '123456',
    '--auto-top-up',
    '--no-open',
  ])

  expect(handler).toHaveBeenCalledWith({
    email: 'user@example.com',
    code: '123456',
    amountUsd: undefined,
    autoTopUp: true,
    model: 'gpt-4o',
    noOpen: true,
  })
})

test('aimlapi topup forwards explicit amount and model', async () => {
  const handler = mock(async () => {})
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => handler)

  await program.parseAsync([
    'node',
    'openclaude',
    'aimlapi',
    'topup',
    '--email',
    'user@example.com',
    '--amount',
    '50',
    '--model',
    'gpt-5',
    '--no-open',
  ])

  expect(handler).toHaveBeenCalledWith({
    email: 'user@example.com',
    code: undefined,
    amountUsd: '50',
    autoTopUp: undefined,
    model: 'gpt-5',
    noOpen: true,
  })
})

test('aimlapi topup defaults to opening the browser when --no-open is absent', async () => {
  const handler = mock(async () => {})
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => handler)

  await program.parseAsync([
    'node',
    'openclaude',
    'aimlapi',
    'topup',
    '--email',
    'user@example.com',
  ])

  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ noOpen: false }),
  )
})

test('aimlapi topup --code-stdin reads the code from stdin instead of argv', async () => {
  const handler = mock(async () => {})
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => handler)

  const { Readable } = await import('node:stream')
  const originalStdin = process.stdin
  const fakeStdin = Readable.from('123456\n') as unknown as typeof process.stdin
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  try {
    await program.parseAsync([
      'node',
      'openclaude',
      'aimlapi',
      'topup',
      '--email',
      'user@example.com',
      '--code-stdin',
      '--no-open',
    ])
  } finally {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
  }

  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ email: 'user@example.com', code: '123456' }),
  )
})

test('aimlapi topup --code prints a deprecation warning steering off argv', async () => {
  const handler = mock(async () => {})
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => handler)
  const stderr = mock(() => true)
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = stderr as unknown as typeof process.stderr.write
  try {
    await program.parseAsync([
      'node',
      'openclaude',
      'aimlapi',
      'topup',
      '--email',
      'user@example.com',
      '--code',
      '123456',
      '--no-open',
    ])
  } finally {
    process.stderr.write = originalWrite
  }

  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('shell history'))
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ code: '123456' }),
  )
})

test('aimlapi topup help text does not encourage the argv --code form', () => {
  const program = new CommanderCommand().exitOverride()
  const aimlapi = registerAimlapiCommand(program, async () => async () => {})
  const topupHelp = aimlapi.commands
    .find(command => command.name() === 'topup')
    ?.helpInformation()
  expect(topupHelp).toBeTruthy()
  expect(topupHelp).toContain('--code-stdin')
  expect(topupHelp).toContain('Deprecated')
  expect(topupHelp).not.toMatch(/--code <code>\s+6-digit code/)
})

test('aimlapi topup rejects the removed method option', async () => {
  const program = new CommanderCommand().exitOverride()
  registerAimlapiCommand(program, async () => async () => {})

  await expect(
    program.parseAsync([
      'node',
      'openclaude',
      'aimlapi',
      'topup',
      '--method',
      'card',
    ]),
  ).rejects.toMatchObject({ code: 'commander.unknownOption' })
})
