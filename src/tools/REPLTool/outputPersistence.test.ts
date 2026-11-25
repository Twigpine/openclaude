import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { runToolUse, type MessageUpdateLazy } from '../../services/tools/toolExecution.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { getToolResultPath } from '../../utils/toolResultStorage.js'
import { REPLTool } from './REPLTool.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import {
  boundReplToolUseResultForPersistence,
  REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
} from './outputPersistence.js'

let tempConfigDir: string
let previousConfigDir: string | undefined
let previousCwd: string
let previousProjectRoot: string
let previousSessionId: SessionId

beforeAll(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), 'repl-output-persistence-'))
  previousConfigDir = getClaudeConfigHomeDirOverrideForTesting()
  previousCwd = getOriginalCwd()
  previousProjectRoot = getProjectRoot()
  previousSessionId = getSessionId()
  setClaudeConfigHomeDirForTesting(tempConfigDir)
  setOriginalCwd(join(tempConfigDir, 'workspace'))
  setProjectRoot(join(tempConfigDir, 'workspace'))
  switchSession('repl-output-persistence-session' as SessionId)
})

afterAll(async () => {
  switchSession(previousSessionId)
  setOriginalCwd(previousCwd)
  setProjectRoot(previousProjectRoot)
  setClaudeConfigHomeDirForTesting(previousConfigDir)
  await rm(tempConfigDir, { recursive: true, force: true })
})


const allow: CanUseToolFn = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })

function createReplContext(sessionHooks = new Map()): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [REPLTool],
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { agents: [], errors: [] },
    },
    abortController: new AbortController(),
    readFileState: {},
    getAppState: () => ({
      ...appState,
      sessionHooks,
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function parentFor(code: string) {
  return createAssistantMessage({
    content: [{
      type: 'tool_use',
      id: 'repl_outer_test',
      name: 'REPL',
      input: { code },
      caller: { type: 'direct' },
    }],
  })
}

async function runCanonicalRepl(
  code: string,
  toolUseID: string,
  sessionHooks = new Map(),
): Promise<MessageUpdateLazy[]> {
  const updates: MessageUpdateLazy[] = []
  for await (const update of runToolUse(
    {
      type: 'tool_use',
      id: toolUseID,
      name: 'REPL',
      input: { code },
    } as ToolUseBlock,
    parentFor(code),
    allow,
    createReplContext(sessionHooks),
  )) {
    updates.push(update)
  }
  return updates
}

function outerReplUserMessage(updates: MessageUpdateLazy[]): Record<string, unknown> {
  const message = updates.find(update =>
    update.message.type === 'user' && update.message.isVirtual !== true,
  )?.message
  if (!message) throw new Error('Expected outer REPL tool result message')
  return message as unknown as Record<string, unknown>
}

describe('boundReplToolUseResultForPersistence', () => {
  test('leaves small structured output unchanged', async () => {
    const output = {
      status: 'completed',
      code: 'return 1',
      result: 1,
      stdout: '',
      stderr: '',
      toolsUsed: [],
    }
    const bounded = await boundReplToolUseResultForPersistence(output, 'small-repl-output')
    expect(bounded).toBe(output)
  })

  test('spills large successful raw output and keeps a bounded shaped excerpt', async () => {
    const output = {
      status: 'completed',
      code: `return { big: '${'z'.repeat(6_000)}' }`,
      result: { big: 'y'.repeat(20_000) },
      stdout: 'x'.repeat(20_000),
      stderr: '',
      durationMs: 12,
      toolsUsed: ['Read'],
    }
    const bounded = await boundReplToolUseResultForPersistence(output, 'large-repl-output') as Record<string, unknown>

    expect(bounded).not.toBe(output)
    expect(bounded.status).toBe('completed')
    expect(bounded.persistedOutputSize).toBeGreaterThan(REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS)
    expect(bounded.persistedOutputPath).toBeString()
    expect(bounded.persistedOutputPreview).toBeString()
    expect(bounded.persistedOutputTruncatedFields).toEqual(
      expect.arrayContaining(['code', 'result', 'stdout']),
    )
    expect(String(bounded.result)).toContain('truncated')
    expect(String(bounded.stdout)).toContain('truncated')
    // Uniform content does not escape in JSON, so the excerpt must keep its
    // full per-field cap rather than being shrunk by the inline budget pass.
    expect(String(bounded.stdout).length).toBeGreaterThan(3_900)

    const inlineSize = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
    expect(inlineSize).toBeLessThan(REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS)

    const artifact = await readFile(String(bounded.persistedOutputPath), 'utf8')
    expect(artifact).toContain('y'.repeat(1_000))
    expect(artifact).toContain('x'.repeat(1_000))
    expect(Buffer.byteLength(artifact, 'utf8')).toBe(Number(bounded.persistedOutputSize))
  })

  test('keeps the serialized inline result under the threshold when excerpts escape heavily', async () => {
    const output = {
      status: 'completed',
      code: `return { big: '${'"'.repeat(20_000)}' }`,
      result: '"'.repeat(20_000),
      stdout: '\\'.repeat(20_000),
      stderr: '\n'.repeat(20_000),
      error: {
        name: 'Error',
        message: '"'.repeat(20_000),
        stack: '\t'.repeat(20_000),
      },
      durationMs: 5,
      toolsUsed: ['Read'],
    }
    const bounded = await boundReplToolUseResultForPersistence(output, 'escaping-large-repl-output') as Record<string, unknown>

    expect(bounded).not.toBe(output)
    expect(bounded.persistedOutputPath).toBeString()
    expect(String(bounded.result)).toContain('truncated')
    // JSON escaping roughly doubles these excerpts, so the per-field caps
    // alone cannot keep the serialized inline result under the threshold.
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThan(
      REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
    )

    const artifact = await readFile(String(bounded.persistedOutputPath), 'utf8')
    expect(Buffer.byteLength(artifact, 'utf8')).toBe(Number(bounded.persistedOutputSize))
    // The artifact is JSON, so the escaped form is what proves the full
    // quote-heavy content was spilled rather than dropped.
    expect(artifact).toContain('\\"'.repeat(1_000))
  })

  test('keeps the serialized inline spill representation within the reserved budget', async () => {
    const output = {
      status: 'completed',
      code: 'c'.repeat(1_100),
      result: 'r'.repeat(16_100),
      stdout: 'o'.repeat(4_100),
      stderr: 'e'.repeat(4_100),
    }
    const bounded = await boundReplToolUseResultForPersistence(output, 'inline-reserve-budget') as Record<string, unknown>

    // The inline representation must leave the full 1,000-byte metadata and
    // artifact-preview reserve rather than depending on almost all of it.
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS - 1_000,
    )
  })

  test('canonical execution stores bounded raw output with the full artifact', async () => {
    const toolUseID = 'canonical-large-repl-output'
    const code = "console.log('x'.repeat(20000)); return { big: 'y'.repeat(20000) }"
    const updates = await runCanonicalRepl(code, toolUseID)
    const message = outerReplUserMessage(updates)
    const toolUseResult = message.toolUseResult as Record<string, unknown>

    expect(toolUseResult.persistedOutputPath).toBeString()
    expect(toolUseResult.persistedOutputSize).toBeGreaterThan(REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS)
    expect(Buffer.byteLength(JSON.stringify(toolUseResult), 'utf8')).toBeLessThan(
      REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
    )
    expect(String(toolUseResult.stdout)).toContain('truncated')

    const artifact = await readFile(String(toolUseResult.persistedOutputPath), 'utf8')
    expect(artifact).toContain('x'.repeat(1_000))
    expect(artifact).toContain('y'.repeat(1_000))
  })

  test('hook replacement wins before artifact spilling and does not persist the original output', async () => {
    const toolUseID = 'hook-redacted-large-repl-output'
    const secret = `original-secret-${'s'.repeat(20_000)}`
    const code = `return { secret: '${secret}' }`
    const replacement = {
      status: 'completed',
      code: '[redacted script]',
      result: '[redacted result]',
    }
    const replacementJson = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: replacement,
      },
    })
    const sessionHooks = new Map([
      [
        getSessionId(),
        {
          hooks: {
            PostToolUse: [
              {
                matcher: 'REPL',
                hooks: [
                  {
                    hook: {
                      type: 'command',
                      command: `printf '%s' '${replacementJson}'`,
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ])

    const updates = await runCanonicalRepl(code, toolUseID, sessionHooks)
    const message = outerReplUserMessage(updates)
    expect(message.toolUseResult).toEqual(replacement)
    // The unique short prefix is what truncation would retain if the
    // original output leaked into the serialized message; the full 20k
    // secret can never fit a bounded excerpt, so checking it asserts nothing.
    expect(JSON.stringify(message)).not.toContain('original-secret-')
    await expect(access(getToolResultPath(`${toolUseID}-repl-output`, false))).rejects.toThrow()
  })

})
