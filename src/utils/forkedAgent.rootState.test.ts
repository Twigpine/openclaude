import { describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import { createRootAppStateGetter } from './forkedAgent.js'

describe('createRootAppStateGetter', () => {
  test('preserves the original root across nested transformed contexts', () => {
    const rootState = { source: 'root' } as unknown as AppState
    const firstTransformedState = {
      source: 'first-transformed',
    } as unknown as AppState
    const secondTransformedState = {
      source: 'second-transformed',
    } as unknown as AppState

    const rootContext = {
      getAppState: () => rootState,
    } as ToolUseContext
    const firstTransformedContext = {
      ...rootContext,
      getAppState: () => firstTransformedState,
      getRootAppState: createRootAppStateGetter(rootContext),
    }
    const secondTransformedContext = {
      ...firstTransformedContext,
      getAppState: () => secondTransformedState,
      getRootAppState: createRootAppStateGetter(firstTransformedContext),
    }

    expect(secondTransformedContext.getAppState()).toBe(secondTransformedState)
    expect(secondTransformedContext.getRootAppState()).toBe(rootState)
  })
})
