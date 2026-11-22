import { describe, expect, test } from 'bun:test'
import type { Command } from '../../commands.js'
import type { ProcessUserInputContext } from './processUserInput.js'
import { processUserInput } from './processUserInput.js'

// A local-jsx command renders Ink UI, so isBridgeSafeCommand always refuses it
// over Remote Control. The refusal answers with a local notice plus command
// stdout, and focus view must not treat the notice as the prompt boundary.
const configCommand = {
  type: 'local-jsx',
  name: 'config',
  description: 'Open the config panel',
  load: async () => ({ call: async () => null }),
} as Command

const context = {
  getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
  options: { commands: [configCommand] },
} as unknown as ProcessUserInputContext

describe('processUserInput bridge refusal', () => {
  test('a non-bridge-safe command answers with an isLocalNotice row and stdout', async () => {
    const res = await processUserInput({
      input: '/config',
      mode: 'prompt',
      setToolJSX: () => {},
      context,
      skipSlashCommands: true,
      bridgeOrigin: true,
    })
    expect(res.shouldQuery).toBe(false)
    expect(res.resultText).toBe(
      "/config isn't available over Remote Control.",
    )
    const [refusal, stdout] = res.messages
    expect(res.messages).toHaveLength(2)
    expect(refusal?.type).toBe('user')
    expect(refusal && 'isLocalNotice' in refusal && refusal.isLocalNotice).toBe(
      true,
    )
    expect(
      stdout?.type === 'system' &&
        'content' in stdout &&
        stdout.content,
    ).toBe(
      "<local-command-stdout>/config isn't available over Remote Control.</local-command-stdout>",
    )
  })
})
