import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getUltracodePermissionAttachment } from './attachments.js'
import type { ToolUseContext } from '../Tool.js'

// The standing `ultracode` multi-agent permission reminder is first-party only
// and must never leak into a routed third-party agent call. These tests pin that
// gating directly on the attachment builder, which is the security-sensitive
// behavior that previously leaked a first-party permission into provider-routed
// subagent requests. @see #1551
//
// Routing env vars are cleared so getAPIProvider() resolves to 'firstParty'
// (its default), isolating the gating decisions to the tool-use context.
const ROUTING_ENV_VARS = [
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'NVIDIA_NIM',
  'LONGCAT_API_KEY',
  'CLAUDE_CODE_EFFORT_LEVEL',
]

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ROUTING_ENV_VARS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ROUTING_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

function makeContext(opts: {
  effortValue?: string
  mainLoopModel?: string
  providerOverride?: { model: string; baseURL: string; apiKey: string }
}): ToolUseContext {
  return {
    getAppState: () => ({ effortValue: opts.effortValue ?? 'ultracode' }),
    options: {
      mainLoopModel: opts.mainLoopModel ?? 'claude-opus-4-8',
      providerOverride: opts.providerOverride,
    },
  } as unknown as ToolUseContext
}

describe('getUltracodePermissionAttachment', () => {
  test('emits ultracode_mode for a first-party, xhigh-capable ultracode request', () => {
    expect(getUltracodePermissionAttachment(makeContext({}))).toEqual([
      { type: 'ultracode_mode' },
    ])
  })

  test('omits the reminder when a per-agent providerOverride routes to a third party', () => {
    // Same first-party ultracode parent state as above, but the request is routed
    // through a provider override — the first-party-only reminder must be dropped.
    const result = getUltracodePermissionAttachment(
      makeContext({
        providerOverride: {
          model: 'gpt-5.5',
          baseURL: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
        },
      }),
    )
    expect(result).toEqual([])
  })

  test('omits the reminder when the model does not support xhigh', () => {
    expect(
      getUltracodePermissionAttachment(makeContext({ mainLoopModel: 'claude-haiku-4-5' })),
    ).toEqual([])
  })

  test('omits the reminder when effort is not ultracode', () => {
    expect(
      getUltracodePermissionAttachment(makeContext({ effortValue: 'high' })),
    ).toEqual([])
  })

  test('omits when CLAUDE_CODE_EFFORT_LEVEL overrides session ultracode with a different value', () => {
    // env override wins over app state for the API effort, so the permission
    // must not fire for a turn the API actually runs at high.
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    expect(getUltracodePermissionAttachment(makeContext({}))).toEqual([])
  })

  test('omits when CLAUDE_CODE_EFFORT_LEVEL=auto clears the session ultracode', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(getUltracodePermissionAttachment(makeContext({}))).toEqual([])
  })

  test('emits when CLAUDE_CODE_EFFORT_LEVEL=ultracode even if app state differs', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'ultracode'
    expect(
      getUltracodePermissionAttachment(makeContext({ effortValue: 'high' })),
    ).toEqual([{ type: 'ultracode_mode' }])
  })
})
