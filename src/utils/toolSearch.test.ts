import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  isToolSearchEnabled,
  modelSupportsToolReference,
  resolveToolSearchMode,
} from './toolSearch.js'
import { TaskCreateTool } from '../tools/TaskCreateTool/TaskCreateTool.js'
import { ToolSearchTool } from '../tools/ToolSearchTool/ToolSearchTool.js'

const realGrowthbook = {
  ...await import(`../services/analytics/growthbook.js?real=${Date.now()}-${Math.random()}`),
}

afterEach(() => {
  mock.restore()
  mock.module('../services/analytics/growthbook.js', () => realGrowthbook)
})

describe('resolveToolSearchMode', () => {
  test('defaults to tst when nothing is configured', () => {
    expect(resolveToolSearchMode({}, 'firstParty')).toBe('tst')
    expect(resolveToolSearchMode({}, 'codex')).toBe('tst')
  })

  test('kill switch forces standard mode on Anthropic-wire providers', () => {
    const env = { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true' }
    expect(resolveToolSearchMode(env, 'firstParty')).toBe('standard')
    expect(resolveToolSearchMode(env, 'bedrock')).toBe('standard')
    expect(resolveToolSearchMode(env, 'vertex')).toBe('standard')
    expect(resolveToolSearchMode(env, 'foundry')).toBe('standard')
    expect(resolveToolSearchMode(env, 'minimax')).toBe('standard')
  })

  test('kill switch does not disable tool search on converted-wire providers', () => {
    // The OpenAI shims and the Gemini Vertex client convert every message and
    // tool definition client-side — no Anthropic beta shape reaches the wire,
    // so the beta kill switch has nothing to protect there.
    const env = { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true' }
    expect(resolveToolSearchMode(env, 'codex')).toBe('tst')
    expect(resolveToolSearchMode(env, 'openai')).toBe('tst')
    expect(resolveToolSearchMode(env, 'github')).toBe('tst')
    expect(resolveToolSearchMode(env, 'gemini')).toBe('tst')
    expect(resolveToolSearchMode(env, 'mistral')).toBe('tst')
  })

  test('explicit ENABLE_TOOL_SEARCH=false still disables everywhere', () => {
    const env = { ENABLE_TOOL_SEARCH: 'false' }
    expect(resolveToolSearchMode(env, 'codex')).toBe('standard')
    expect(resolveToolSearchMode(env, 'firstParty')).toBe('standard')
  })

  test('auto mode is preserved on converted-wire providers despite kill switch', () => {
    const env = {
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
      ENABLE_TOOL_SEARCH: 'auto',
    }
    expect(resolveToolSearchMode(env, 'codex')).toBe('tst-auto')
    expect(resolveToolSearchMode(env, 'firstParty')).toBe('standard')
  })
})

describe('modelSupportsToolReference', () => {
  test('keeps Tencent HY3 on the inline tool-schema path', () => {
    expect(modelSupportsToolReference('tencent/hy3')).toBe(false)
    expect(modelSupportsToolReference('tencent/hy3?reasoning=high')).toBe(false)
    expect(modelSupportsToolReference('other/hy3-documentation')).toBe(true)
  })

  test('does not defer TaskCreate for Tencent HY3', async () => {
    expect(
      await isToolSearchEnabled(
        'tencent/hy3',
        [ToolSearchTool, TaskCreateTool],
        async () => undefined as never,
        [],
      ),
    ).toBe(false)
  })

  test('keeps built-in HY3 compatibility when feature flags add exceptions', async () => {
    mock.module('../services/analytics/growthbook.js', () => ({
      getFeatureValue_CACHED_MAY_BE_STALE: () => ['haiku'],
    }))
    const freshToolSearch = await import(
      `./toolSearch.ts?feature-flags-${Date.now()}`
    )

    expect(freshToolSearch.modelSupportsToolReference('tencent/hy3')).toBe(false)
  })
})
