import { describe, expect, test } from 'bun:test'

import goal from '../../commands/goal/index.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { processSlashCommand } from './processSlashCommand.js'

function makeContext() {
  let state: AppState = getDefaultAppState()
  return {
    context: {
      options: {
        commands: [goal],
        isNonInteractiveSession: false,
      },
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
      messages: [],
    } as unknown as Parameters<typeof processSlashCommand>[4],
    getState: () => state,
  }
}

describe('/goal slash-command plumbing', () => {
  test('/goal <condition> inserts hidden directive and starts a query', async () => {
    const { context, getState } = makeContext()

    const result = await processSlashCommand(
      '/goal finish implementation',
      [],
      [],
      [],
      context,
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(getState().goal?.condition).toBe('finish implementation')
    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          message.isMeta === true &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('A session goal has been set.'),
      ),
    ).toBe(true)
  })
})
