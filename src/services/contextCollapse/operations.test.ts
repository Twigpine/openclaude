import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'

function uid(s: string): UUID {
  return `00000000-0000-4000-8000-${s.padStart(12, '0')}` as UUID
}

function makeUserMsg(id: string): Message {
  return {
    type: 'user',
    uuid: uid(id),
    timestamp: new Date().toISOString(),
    message: { content: 'hello', role: 'user' as const },
  } as unknown as Message
}

function makeAssistantMsg(id: string): Message {
  return {
    type: 'assistant',
    uuid: uid(id),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      model: 'claude-sonnet-4',
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: '',
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text' as const, text: 'ok' }],
      context_management: null,
    },
  } as unknown as Message
}

describe('projectView', () => {
  // Reset and rebuild a known commit before EACH test so outcomes never depend
  // on shared module state or test execution order.
  beforeEach(async () => {
    process.env.CLAUDE_CONTEXT_COLLAPSE = '1'
    const idx = await import('./index.js')
    idx.resetContextCollapse()
    idx.initContextCollapse()
    idx.restoreContextCollapseState(
      [
        {
          type: 'marble-origami-commit' as const,
          sessionId: uid('s1'),
          collapseId: '0000000000000001',
          summaryUuid: uid('sum1'),
          summaryContent: '<collapsed id="0000000000000001">test summary</collapsed>',
          summary: 'test summary',
          firstArchivedUuid: uid('a'),
          lastArchivedUuid: uid('b'),
        },
      ],
      undefined,
    )
  })

  afterEach(async () => {
    delete process.env.CLAUDE_CONTEXT_COLLAPSE
    const idx = await import('./index.js')
    idx.resetContextCollapse()
  })

  test('replays commit, replacing span with placeholder', async () => {
    const mod = await import('./operations.js')
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b'), makeUserMsg('c')]
    const result = mod.projectView(msgs)

    expect(result.length).toBe(2)
    expect(result[0]!.type).toBe('system')
    expect((result[0]! as any).content).toContain('test summary')
    expect(result[1]!.uuid).toBe(uid('c'))
  })

  test('collapsed summary survives normalizeMessagesForAPI as a user message', async () => {
    // Regression: the projected placeholder is a system message, and
    // normalizeMessagesForAPI drops system messages that are not local commands.
    // Without the isCollapseSummary carve-out the <collapsed> summary (and the
    // archived span it replaced) would vanish from the model's input.
    const mod = await import('./operations.js')
    const { normalizeMessagesForAPI } = await import('../../utils/messages.js')
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b'), makeUserMsg('c')]
    const projected = mod.projectView(msgs)

    const normalized = normalizeMessagesForAPI(projected)
    const serialized = JSON.stringify(normalized)
    expect(serialized).toContain('test summary')
    expect(serialized).toContain('<collapsed')
  })

  test('collapsed summary merged with real input stays non-snippable', async () => {
    // The system->user conversion preserves isMeta on the collapse placeholder.
    // An active HISTORY_SNIP runtime clears it when adjacent real input merges;
    // otherwise the legacy meta contract remains. The isCollapseSummary marker
    // independently keeps the archived-span replacement out of the snip sweep.
    const mod = await import('./operations.js')
    const { normalizeMessagesForAPI, appendMessageTagToUserMessage } =
      await import('../../utils/messages.js')
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b'), makeUserMsg('c')]
    const normalized = normalizeMessagesForAPI(mod.projectView(msgs))

    const summaryMsg = normalized.find(m =>
      JSON.stringify(m.message.content).includes('test summary'),
    )
    expect(summaryMsg).toBeDefined()
    expect(summaryMsg!.type).toBe('user')
    expect((summaryMsg as { isMeta?: boolean }).isMeta).toBe(
      feature('HISTORY_SNIP') ? undefined : true,
    )
    expect(
      (summaryMsg as { isCollapseSummary?: boolean }).isCollapseSummary,
    ).toBe(true)

    // With snip injection enabled the sweep leaves the collapse summary untagged...
    const swept = appendMessageTagToUserMessage(summaryMsg as never)
    expect(JSON.stringify(swept.message.content)).not.toContain('snip_id=')
    // ...while a normal (non-meta) user message still gets a snip id, so the
    // exemption above is meaningful rather than a no-op.
    const plain = appendMessageTagToUserMessage(makeUserMsg('c') as never)
    expect(JSON.stringify(plain.message.content)).toContain('snip_id=')
  })

  test('collapse summary merged with the next user turn stays non-snippable', async () => {
    // Regression: when the collapsed span ends right before the next user turn,
    // normalizeMessagesForAPI merges the summary (now a user message) with that
    // real user turn (Bedrock can't take consecutive user messages). Under
    // HISTORY_SNIP that merge clears isMeta, so the combined block — which holds
    // the only <collapsed> replacement for the archived span — must keep the
    // isCollapseSummary marker or it gets a snip id and the model can drop it.
    const mod = await import('./operations.js')
    const { normalizeMessagesForAPI, appendMessageTagToUserMessage } =
      await import('../../utils/messages.js')
    // span [a..b] is committed in beforeEach; c is the adjacent real user turn.
    const msgs: Message[] = [makeUserMsg('a'), makeAssistantMsg('b'), makeUserMsg('c')]
    const normalized = normalizeMessagesForAPI(mod.projectView(msgs))

    const merged = normalized.find(m =>
      JSON.stringify(m.message.content).includes('test summary'),
    )
    expect(merged).toBeDefined()
    expect(merged!.type).toBe('user')
    // The real user turn was folded in, and the marker survived the merge.
    expect(JSON.stringify(merged!.message.content)).toContain('hello')
    expect((merged as { isCollapseSummary?: boolean }).isCollapseSummary).toBe(true)
    // So the snip sweep leaves it untagged.
    const swept = appendMessageTagToUserMessage(merged as never)
    expect(JSON.stringify(swept.message.content)).not.toContain('snip_id=')
  })

  test('appendMessageTagToUserMessage skips a merged collapse block even when isMeta was cleared', async () => {
    // The production HISTORY_SNIP merge sets isMeta=undefined; isCollapseSummary
    // alone must keep the block non-snippable.
    const { appendMessageTagToUserMessage } = await import('../../utils/messages.js')
    const merged = {
      type: 'user' as const,
      uuid: uid('c'),
      timestamp: new Date().toISOString(),
      isMeta: undefined,
      isCollapseSummary: true,
      message: { role: 'user' as const, content: '<collapsed id="1">s</collapsed>\nhello' },
    }
    const swept = appendMessageTagToUserMessage(merged as never)
    expect(JSON.stringify(swept.message.content)).not.toContain('snip_id=')
  })

  test('merging a collapse summary strips a snip id already baked into the user turn', async () => {
    // The real user turn may be tagged before the merge; the combined block must
    // shed that id so no resolvable snip id points at the summary.
    const { mergeUserMessages } = await import('../../utils/messages.js')
    const summary = {
      type: 'user' as const,
      uuid: uid('sum1'),
      timestamp: new Date().toISOString(),
      isMeta: true,
      isCollapseSummary: true,
      message: { role: 'user' as const, content: '<collapsed id="1">s</collapsed>' },
    }
    const realUser = {
      type: 'user' as const,
      uuid: uid('c'),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user' as const,
        content:
          'hello\n<system-reminder>snip_id=abc123; system-generated; for snip tool use only; do not discuss in thinking or responses.</system-reminder>',
      },
    }
    const merged = mergeUserMessages(summary as never, realUser as never)
    expect((merged as { isCollapseSummary?: boolean }).isCollapseSummary).toBe(true)
    expect(JSON.stringify(merged.message.content)).not.toContain('snip_id=')
    expect(JSON.stringify(merged.message.content)).toContain('hello')
    expect(JSON.stringify(merged.message.content)).toContain('collapsed')
  })

  test('normalizeMessages preserves isCollapseSummary when splitting array content', async () => {
    // Regression: an already-merged collapse summary can carry array content.
    // normalizeMessages splits multi-block user messages into single-block ones;
    // if it forwards isMeta but drops isCollapseSummary, a later API-normalization
    // pass tags the summary with a snip id and the model can drop the only
    // <collapsed> replacement for the archived span.
    const { normalizeMessages } = await import('../../utils/messages.js')
    const summary = {
      type: 'user' as const,
      uuid: uid('sum1'),
      timestamp: new Date().toISOString(),
      isCollapseSummary: true,
      message: {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '<collapsed id="1">s</collapsed>' },
          { type: 'text' as const, text: 'hello' },
        ],
      },
    }
    const normalized = normalizeMessages([summary as never])
    expect(normalized.length).toBe(2)
    for (const m of normalized) {
      expect((m as { isCollapseSummary?: boolean }).isCollapseSummary).toBe(true)
    }
  })

  test('merging a collapse summary drops a text block that was only a snip marker', async () => {
    // Regression: stripSnipTagsFromContent removed the marker text but kept the
    // now-empty text block. Merging a collapse summary with a tool-result user
    // turn whose trailing text block is solely the snip marker must not leave an
    // empty { type:"text", text:"" } block in the API-bound content.
    const { mergeUserMessages } = await import('../../utils/messages.js')
    const summary = {
      type: 'user' as const,
      uuid: uid('sum1'),
      timestamp: new Date().toISOString(),
      isMeta: true,
      isCollapseSummary: true,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: '<collapsed id="1">s</collapsed>' }],
      },
    }
    const realUser = {
      type: 'user' as const,
      uuid: uid('c'),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'tu1', content: 'result' },
          {
            type: 'text' as const,
            text: '\n<system-reminder>snip_id=abc123; system-generated; for snip tool use only; do not discuss in thinking or responses.</system-reminder>',
          },
        ],
      },
    }
    const merged = mergeUserMessages(summary as never, realUser as never)
    const content = merged.message.content
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as Array<{ type: string; text?: string }>
    expect(blocks.some(b => b.type === 'text' && b.text === '')).toBe(false)
    expect(JSON.stringify(content)).not.toContain('snip_id=')
    expect(JSON.stringify(content)).toContain('collapsed')
  })

  test('silently skips missing boundaries', async () => {
    const mod = await import('./operations.js')
    const msgs: Message[] = [makeUserMsg('x'), makeAssistantMsg('y')]
    const result = mod.projectView(msgs)
    expect(result.length).toBe(2)
  })

  test('handles empty messages', async () => {
    const mod = await import('./operations.js')
    const result = mod.projectView([])
    expect(Array.isArray(result)).toBe(true)
  })
})
