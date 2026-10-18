import { describe, expect, test } from 'bun:test'

import type { Command } from '../../commands.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { processSlashCommand } from './processSlashCommand.js'

const SECRET = 'exa-secret-key-1234567890'

function localJsxCommand(
  name: string,
  isSensitive: boolean,
  display: 'system' | 'user',
): Command {
  return {
    type: 'local-jsx',
    name,
    description: 'test command',
    isSensitive,
    load: async () => ({
      call: async onDone => {
        onDone('done', display === 'system' ? { display: 'system' } : undefined)
        return null
      },
    }),
  } as Command
}

function makeContext(command: Command): Parameters<typeof processSlashCommand>[4] {
  let state: AppState = getDefaultAppState()
  return {
    options: { commands: [command], isNonInteractiveSession: false },
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    messages: [],
  } as unknown as Parameters<typeof processSlashCommand>[4]
}

async function recordedMessages(command: Command, input: string): Promise<string> {
  const result = await processSlashCommand(input, [], [], [], makeContext(command), () => {})
  return JSON.stringify(result.messages)
}

describe('sensitive local-jsx command args', () => {
  test.each(['system', 'user'] as const)(
    'are redacted from recorded messages (%s display)',
    async display => {
      const command = localJsxCommand('secretcmd', true, display)
      const recorded = await recordedMessages(command, `/secretcmd key ${SECRET}`)

      expect(recorded).not.toContain(SECRET)
      expect(recorded).toContain('***')
    },
  )

  test('non-sensitive commands keep their args', async () => {
    const command = localJsxCommand('plaincmd', false, 'system')
    const recorded = await recordedMessages(command, '/plaincmd visible-arg')

    expect(recorded).toContain('visible-arg')
  })
})
