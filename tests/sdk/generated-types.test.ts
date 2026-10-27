import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generateSdkTypes } from '../../scripts/generate-sdk-types.js'
import {
  AccountInfoSchema,
  SDKAssistantMessageSchema,
  SDKSystemMessageSchema,
  SDKHeartbeatMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKMessageSchema,
  SDKUserMessageSchema,
  SDKResultSuccessSchema,
  SDKResultErrorSchema,
  SDKSessionInfoSchema,
  PermissionModeSchema,
  ThinkingConfigSchema,
  AgentDefinitionSchema,
  McpServerStatusSchema,
  ModelUsageSchema,
  ModelInfoSchema,
  FastModeStateSchema,
  ExitReasonSchema,
} from '../../src/entrypoints/sdk/coreSchemas.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const generatedTypesPath = fileURLToPath(
  new URL('../../src/entrypoints/sdk/coreTypes.generated.ts', import.meta.url),
)
const normalizeLineEndings = (source: string) => source.replace(/\r\n/g, '\n')
const generatedTypesSource = () => readFileSync(generatedTypesPath, 'utf8')

/**
 * Tests for generated SDK types from Zod schemas.
 *
 * These tests verify that:
 * 1. All schemas materialize correctly (no lazy errors)
 * 2. Schemas can parse valid data
 * 3. Key discriminated fields are correct
 * 4. The full SDKMessage union accepts all message variants
 */
describe('SDK Zod schemas (type generation source)', () => {
  test('SDK type generation exports heartbeat messages directly', () => {
    const generatedSource = generateSdkTypes()
    const committedSource = normalizeLineEndings(generatedTypesSource())

    expect(generatedSource).toBe(committedSource)
    expect(generatedSource).toMatch(/^export type SDKHeartbeatMessage\b/m)
    expect(generatedSource).not.toContain(
      '// ⚠ Failed: SDKHeartbeatMessageSchema',
    )
    expect(generatedSource).not.toMatch(
      /^export type SDKHeartbeatMessage = any$/m,
    )
  })

  test('SDK type generator can be imported from non-file entrypoints', () => {
    const beforeSource = generatedTypesSource()
    const beforeMtimeMs = statSync(generatedTypesPath).mtimeMs

    // The generator is a Bun TypeScript script, matching package.json scripts.
    const bunExecutable = process.execPath
    const result = spawnSync(
      bunExecutable,
      [
        '--eval',
        "process.argv[1] = '-'; import('./scripts/generate-sdk-types.ts').then(() => console.log('import-ok'))",
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(normalizeLineEndings(result.stdout).trim()).toBe('import-ok')
    expect(generatedTypesSource()).toBe(beforeSource)
    expect(statSync(generatedTypesPath).mtimeMs).toBe(beforeMtimeMs)
  })

  test('SDKAssistantMessageSchema accepts valid data', () => {
    const schema = SDKAssistantMessageSchema()
    const result = schema.safeParse({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKSystemMessageSchema accepts valid data', () => {
    const schema = SDKSystemMessageSchema()
    const result = schema.safeParse({
      type: 'system',
      subtype: 'init',
      apiKeySource: 'user',
      claude_code_version: '0.3.0',
      cwd: '/home/user/project',
      tools: ['Read', 'Write'],
      mcp_servers: [{ name: 'test', status: 'connected' }],
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKCompactBoundaryMessageSchema accepts valid data', () => {
    const schema = SDKCompactBoundaryMessageSchema()
    const result = schema.safeParse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 1000,
      },
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKCompactBoundaryMessageSchema accepts preserved_segment', () => {
    const schema = SDKCompactBoundaryMessageSchema()
    const result = schema.safeParse({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 50000,
        preserved_segment: {
          head_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          anchor_uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          tail_uuid: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        },
      },
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKUserMessageSchema accepts valid data', () => {
    const schema = SDKUserMessageSchema()
    const result = schema.safeParse({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
    })
    expect(result.success).toBe(true)
  })

  test('SDKResultSuccessSchema accepts valid data', () => {
    const schema = SDKResultSuccessSchema()
    const result = schema.safeParse({
      type: 'result',
      subtype: 'success',
      duration_ms: 1500,
      duration_api_ms: 1200,
      is_error: false,
      num_turns: 1,
      result: 'Done',
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
      permission_denials: [],
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKResultErrorSchema accepts valid data', () => {
    const schema = SDKResultErrorSchema()
    const result = schema.safeParse({
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.001,
      usage: { input_tokens: 50, output_tokens: 10 },
      modelUsage: {},
      permission_denials: [],
      errors: ['Something went wrong'],
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    })
    expect(result.success).toBe(true)
  })

  test('SDKMessageSchema accepts all message types', () => {
    const schema = SDKMessageSchema()

    const messages = [
      {
        type: 'assistant',
        message: {},
        parent_tool_use_id: null,
        uuid: '12345678-1234-1234-1234-123456789012',
        session_id: '12345678-1234-1234-1234-123456789012',
      },
      {
        type: 'user',
        message: {},
        parent_tool_use_id: null,
      },
      {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'user',
        claude_code_version: '0.3.0',
        cwd: '/tmp',
        tools: [],
        mcp_servers: [],
        model: 'sonnet',
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: '12345678-1234-1234-1234-123456789012',
        session_id: '12345678-1234-1234-1234-123456789012',
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 100 },
        uuid: '12345678-1234-1234-1234-123456789012',
        session_id: '12345678-1234-1234-1234-123456789012',
      },
      {
        type: 'system',
        subtype: 'heartbeat',
        timestamp: '2026-06-25T12:00:30.000Z',
        elapsed_ms: 30_000,
        since_last_activity_ms: 30_000,
        state: 'running',
        phase: 'in_turn',
        heartbeat_index: 1,
        pending_permission_requests: 0,
        background_tasks: {},
        uuid: '12345678-1234-1234-1234-123456789012',
        session_id: '12345678-1234-1234-1234-123456789012',
      },
    ]

    for (const msg of messages) {
      const result = schema.safeParse(msg)
      expect(result.success).toBe(true)
    }
  })

  test('SDKHeartbeatMessageSchema rejects values outside the producer contract', () => {
    const schema = SDKHeartbeatMessageSchema()
    const validHeartbeat = {
      type: 'system',
      subtype: 'heartbeat',
      timestamp: '2026-06-25T12:00:30.000Z',
      elapsed_ms: 30_000,
      since_last_activity_ms: 30_000,
      state: 'running',
      phase: 'in_turn',
      heartbeat_index: 1,
      pending_permission_requests: 0,
      background_tasks: { local_agent: 1 },
      uuid: '12345678-1234-1234-1234-123456789012',
      session_id: '12345678-1234-1234-1234-123456789012',
    }

    expect(schema.safeParse(validHeartbeat).success).toBe(true)
    expect(
      schema.safeParse({
        ...validHeartbeat,
        uuid: '00000000-0000-4000-8000-000000000000',
        session_id: '',
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        ...validHeartbeat,
        uuid: 'heartbeat-fallback',
        session_id: 'session-fallback',
      }).success,
    ).toBe(true)

    for (const invalidHeartbeat of [
      { ...validHeartbeat, elapsed_ms: -1 },
      { ...validHeartbeat, elapsed_ms: 1.5 },
      { ...validHeartbeat, since_last_activity_ms: -1 },
      { ...validHeartbeat, since_last_activity_ms: 1.5 },
      { ...validHeartbeat, heartbeat_index: 0 },
      { ...validHeartbeat, heartbeat_index: 1.5 },
      { ...validHeartbeat, pending_permission_requests: -1 },
      { ...validHeartbeat, pending_permission_requests: 1.5 },
      { ...validHeartbeat, background_tasks: { local_agent: 0 } },
      { ...validHeartbeat, background_tasks: { local_agent: 1.5 } },
    ]) {
      expect(schema.safeParse(invalidHeartbeat).success).toBe(false)
    }
  })

  test('SDKSessionInfoSchema accepts valid data', () => {
    const schema = SDKSessionInfoSchema()
    const result = schema.safeParse({
      sessionId: '12345678-1234-1234-1234-123456789012',
      summary: 'Test session',
      lastModified: Date.now(),
    })
    expect(result.success).toBe(true)
  })

  test('PermissionModeSchema accepts valid modes', () => {
    const schema = PermissionModeSchema()
    const modes = [
      'default',
      'acceptEdits',
      'bypassPermissions',
      'fullAccess',
      'plan',
      'dontAsk',
    ]
    for (const mode of modes) {
      expect(schema.safeParse(mode).success).toBe(true)
    }
    expect(schema.safeParse('invalid').success).toBe(false)
  })

  test('ThinkingConfigSchema accepts all variants', () => {
    const schema = ThinkingConfigSchema()
    expect(schema.safeParse({ type: 'adaptive' }).success).toBe(true)
    expect(schema.safeParse({ type: 'enabled' }).success).toBe(true)
    expect(schema.safeParse({ type: 'enabled', budgetTokens: 10000 }).success).toBe(true)
    expect(schema.safeParse({ type: 'disabled' }).success).toBe(true)
    expect(schema.safeParse({ type: 'unknown' }).success).toBe(false)
  })

  test('FastModeStateSchema accepts valid states', () => {
    const schema = FastModeStateSchema()
    expect(schema.safeParse('off').success).toBe(true)
    expect(schema.safeParse('cooldown').success).toBe(true)
    expect(schema.safeParse('on').success).toBe(true)
    expect(schema.safeParse('unknown').success).toBe(false)
  })

  test('ExitReasonSchema accepts valid reasons', () => {
    const schema = ExitReasonSchema()
    const reasons = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other', 'bypass_permissions_disabled']
    for (const r of reasons) {
      expect(schema.safeParse(r).success).toBe(true)
    }
    expect(schema.safeParse('invalid').success).toBe(false)
  })

  test('ModelUsageSchema accepts valid data', () => {
    const schema = ModelUsageSchema()
    const result = schema.safeParse({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 300,
      webSearchRequests: 1,
      costUSD: 0.01,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    })
    expect(result.success).toBe(true)
  })

  test('ModelInfoSchema accepts supported effort level arrays', () => {
    const schema = ModelInfoSchema()
    const result = schema.safeParse({
      value: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6',
      description: 'Most capable model',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    })

    expect(result.success).toBe(true)
  })

  test('AccountInfoSchema accepts all runtime API provider categories', () => {
    const schema = AccountInfoSchema()
    const providers = [
      'firstParty',
      'bedrock',
      'vertex',
      'foundry',
      'openai',
      'gemini',
      'github',
      'codex',
      'nvidia-nim',
      'minimax',
      'mistral',
      'xai',
      'xiaomi-mimo',
    ]

    for (const apiProvider of providers) {
      expect(schema.safeParse({ apiProvider }).success).toBe(true)
    }
    expect(schema.safeParse({ apiProvider: 'unknown' }).success).toBe(false)
  })

  test('AgentDefinitionSchema accepts valid data', () => {
    const schema = AgentDefinitionSchema()
    const result = schema.safeParse({
      description: 'Test agent',
      prompt: 'You are a test agent',
    })
    expect(result.success).toBe(true)
  })

  test('McpServerStatusSchema accepts valid data', () => {
    const schema = McpServerStatusSchema()
    const result = schema.safeParse({
      name: 'test-server',
      status: 'connected',
    })
    expect(result.success).toBe(true)
  })
})
