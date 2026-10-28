import { describe, expect, test } from 'bun:test'

import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'

// We test the exported collectCompactableToolIds behavior indirectly via
// the public microcompactMessages + time-based path. But first we need to
// verify the core predicate: MCP tools (prefixed 'mcp__') should be
// compactable alongside the built-in tool set.

/**
 * Helper: build a minimal assistant message with a tool_use block.
 */
function assistantWithToolUse(toolName: string, toolId: string): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use' as const,
        id: toolId,
        name: toolName,
        input: {},
      },
    ],
  })
}

/**
 * Helper: build a user message with a tool_result block.
 */
function userWithToolResult(toolId: string, output: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolId,
        content: output,
      },
    ],
  })
}

describe('microCompact MCP tool compaction', () => {
  // We can't easily unit-test the private isCompactableTool directly,
  // but we can test the full time-based microcompact path which exercises
  // collectCompactableToolIds → isCompactableTool under the hood.
  // The time-based path is the simplest to trigger: it content-clears
  // old tool results when the gap since last assistant message exceeds
  // the threshold.

  // However, evaluateTimeBasedTrigger depends on config (GrowthBook).
  // So instead, let's test the observable behavior by importing the
  // microcompactMessages function and checking that MCP tool_use blocks
  // are collected.

  // Since collectCompactableToolIds is not exported, we test the predicate
  // behavior by verifying that the module loads without error and that
  // built-in and MCP tools are treated consistently.

  test('module exports load correctly', async () => {
    const mod = await import('./microCompact.js')
    expect(mod.microcompactMessages).toBeFunction()
    expect(mod.estimateMessageTokens).toBeFunction()
    expect(mod.evaluateTimeBasedTrigger).toBeFunction()
  })

  test('estimateMessageTokens counts MCP tool_use blocks', async () => {
    const { estimateMessageTokens } = await import('./microCompact.js')

    const builtinMessages: Message[] = [
      assistantWithToolUse('Read', 'tool-builtin-1'),
      userWithToolResult('tool-builtin-1', 'file contents here'),
    ]

    const mcpMessages: Message[] = [
      assistantWithToolUse('mcp__github__get_file_contents', 'tool-mcp-1'),
      userWithToolResult('tool-mcp-1', 'file contents here'),
    ]

    const builtinTokens = estimateMessageTokens(builtinMessages)
    const mcpTokens = estimateMessageTokens(mcpMessages)

    // Both should produce non-zero estimates
    expect(builtinTokens).toBeGreaterThan(0)
    expect(mcpTokens).toBeGreaterThan(0)

    // The tool_result content is identical, so token estimates should be
    // similar (tool_use name differs slightly, so not exactly equal)
    expect(Math.abs(builtinTokens - mcpTokens)).toBeLessThan(50)
  })

  test('microcompactMessages processes MCP tools without error', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    const messages: Message[] = [
      assistantWithToolUse('mcp__slack__send_message', 'tool-mcp-2'),
      userWithToolResult('tool-mcp-2', 'Message sent successfully'),
      assistantWithToolUse('mcp__github__create_pull_request', 'tool-mcp-3'),
      userWithToolResult('tool-mcp-3', JSON.stringify({ number: 42, url: 'https://github.com/org/repo/pull/42' })),
    ]

    // Should not throw — MCP tools should be handled gracefully
    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })

  test('microcompactMessages processes mixed built-in and MCP tools', async () => {
    const { microcompactMessages } = await import('./microCompact.js')

    const messages: Message[] = [
      assistantWithToolUse('Read', 'tool-read-1'),
      userWithToolResult('tool-read-1', 'some file content'),
      assistantWithToolUse('mcp__playwright__screenshot', 'tool-mcp-4'),
      userWithToolResult('tool-mcp-4', 'base64-encoded-screenshot-data'.repeat(100)),
      assistantWithToolUse('Bash', 'tool-bash-1'),
      userWithToolResult('tool-bash-1', 'command output'),
    ]

    const result = await microcompactMessages(messages)
    expect(result).toBeDefined()
    expect(result.messages.length).toBe(messages.length)
  })

  test('time-based microcompact clears native toolUseResult for old compacted results', async () => {
    const { maybeTimeBasedMicrocompact, TIME_BASED_MC_CLEARED_MESSAGE } =
      await import('./microCompact.js')
    const oldAssistant = {
      ...assistantWithToolUse('Read', 'tool-read-old'),
      timestamp: new Date(Date.now() - 120 * 60_000).toISOString(),
    }
    const oldResult = createUserMessage({
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tool-read-old',
          content: 'old file content',
        },
      ],
      toolUseResult: { content: 'old file content' },
    })
    const recentAssistant = {
      ...assistantWithToolUse('Read', 'tool-read-recent'),
      timestamp: new Date(Date.now() - 120 * 60_000).toISOString(),
    }
    const recentResult = createUserMessage({
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'tool-read-recent',
          content: 'recent file content',
        },
      ],
      toolUseResult: { content: 'recent file content' },
    })

    const result = maybeTimeBasedMicrocompact(
      [oldAssistant, oldResult, recentAssistant, recentResult],
      'repl_main_thread',
      { enabled: true, gapThresholdMinutes: 60, keepRecent: 1 },
    )

    expect(result).not.toBeNull()
    const compactedOld = result!.messages[1]!
    const keptRecent = result!.messages[3]!
    expect(
      (compactedOld.message.content as Array<{ content: string }>)[0]!.content,
    ).toBe(TIME_BASED_MC_CLEARED_MESSAGE)
    expect(compactedOld.toolUseResult).toBeUndefined()
    expect(keptRecent.toolUseResult).toEqual({
      content: 'recent file content',
    })
  })
})

describe('estimateMessageTokens coverage', () => {
  test('counts tokens from string content user messages', async () => {
    const { estimateMessageTokens } = await import('./microCompact.js')

    // Real user messages from the session can have string content (plain user prompt)
    const content =
      'Hello world this is a long user prompt that needs compression because it is over the threshold'
    const messages: Message[] = [createUserMessage({ content })]

    const total = estimateMessageTokens(messages)
    // The string-content user message should be counted on its own; the old
    // implementation returned 0 because it skipped non-array content.
    expect(total).toBe(Math.ceil(Math.round(content.length / 4) * (4 / 3)))
  })

  test('counts tokens across all block types including tool_result and tool_use', async () => {
    const { estimateMessageTokens } = await import('./microCompact.js')

    const msg = createUserMessage({
      content: [
        { type: 'tool_result' as const, tool_use_id: 't1', content: 'A'.repeat(5000) },
      ],
    })
    const msgWithText = createUserMessage({
      content: [
        { type: 'text' as const, text: 'User query here' },
      ],
    })
    const asstTool = createAssistantMessage({
      content: [
        {
          type: 'tool_use' as const,
          id: 't1',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      ],
    })
    const msgWithResultAndText = createUserMessage({
      content: [
        { type: 'tool_result' as const, tool_use_id: 't1', content: 'file output data' },
        { type: 'text' as const, text: 'based on that output I think the answer is yes' },
      ],
    })

    const messages: Message[] = [msg, msgWithText, asstTool, msgWithResultAndText]

    const total = estimateMessageTokens(messages)

    // Must be significantly > 0 (all blocks counted)
    expect(total).toBeGreaterThan(100)

    // Must be larger than the old reducer's estimate (only string+text blocks)
    // Old reducer would only see text blocks: 'User query here' + 'based on that output...'
    // It would miss 5000-chars tool_result, tool_use name+input
    const oldReducerEstimate = Math.ceil(
      (13 + 46) * (4 / 3), // 'User query here' (13) + 'based on that...' (~46)
    )
    expect(total).toBeGreaterThan(oldReducerEstimate * 2)
  })
})
