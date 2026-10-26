import { createUserMessage } from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { describe, expect, test } from 'bun:test'

import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import { createGoalState } from '../../services/goal/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { clearConversation } from './conversation.js'

describe('/clear goal lifecycle', () => {
  test('/clear clears active goal state', async () => {
    const previousBareMode = process.env.CLAUDE_CODE_SIMPLE
    const previousSessionId = getSessionId()
    const previousSessionProjectDir = getSessionProjectDir()
    process.env.CLAUDE_CODE_SIMPLE = '1'
    let state: AppState = {
      ...getDefaultAppState(),
      goal: createGoalState('finish implementation'),
    }
    let messages: Message[] = [createUserMessage({ content: 'hello' })]
    let sawEmptyMessages = false

    try {
      await clearConversation({
        setMessages: updater => {
          messages = updater(messages)
          if (messages.length === 0) sawEmptyMessages = true
        },
        readFileState: createFileStateCacheWithSizeLimit(100),
        getAppState: () => state,
        setAppState: updater => {
          state = updater(state)
        },
      })
    } finally {
      if (previousBareMode === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = previousBareMode
      }
      switchSession(previousSessionId, previousSessionProjectDir)
    }

    expect(state.goal).toBeNull()
    expect(sawEmptyMessages).toBe(true)
  })
})
