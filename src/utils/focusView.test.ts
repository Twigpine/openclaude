import { describe, expect, test } from 'bun:test'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createCommandInputMessage,
  createCompactBoundaryMessage,
  createUserInterruptionMessage,
  createUserMessage,
  formatCommandInputTags,
} from './messages.js'
import {
  countUnseenFocusTurns,
  selectFocusView,
  type FocusMessage,
} from './focusView.js'

// Every fixture gets its label as uuid so assertions read as label lists.
function label<T extends object>(id: string, msg: T): T {
  return { ...msg, uuid: id } as T
}

function prompt(id: string, text: string, extra: object = {}) {
  return label(id, { ...createUserMessage({ content: text }), ...extra })
}
function say(id: string, text: string) {
  return label(id, createAssistantMessage({ content: text }))
}
function think(id: string) {
  return label(
    id,
    createAssistantMessage({
      content: [{ type: 'thinking', thinking: 'hmm', signature: 's' } as never],
    }),
  )
}
function redacted(id: string) {
  return label(
    id,
    createAssistantMessage({
      content: [{ type: 'redacted_thinking', data: 'x' } as never],
    }),
  )
}
function use(id: string, toolUseId: string, name = 'Read') {
  return label(
    id,
    createAssistantMessage({
      content: [
        { type: 'tool_use', id: toolUseId, name, input: { a: 1 } } as never,
      ],
    }),
  )
}
function result(
  id: string,
  toolUseId: string,
  opts: { isError?: boolean; content?: string; toolUseResult?: unknown } = {},
) {
  return label(
    id,
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: opts.content ?? 'ok',
          ...(opts.isError ? { is_error: true } : {}),
        } as never,
      ],
      toolUseResult: opts.toolUseResult,
    }),
  )
}
function command(id: string, name: string) {
  return label(id, createUserMessage({ content: formatCommandInputTags(name, '') }))
}
function commandOut(id: string, text = 'done') {
  return label(
    id,
    createCommandInputMessage(`<local-command-stdout>${text}</local-command-stdout>`),
  )
}
function queued(id: string, extra: object = {}) {
  return label(id, {
    type: 'attachment' as const,
    timestamp: '',
    attachment: {
      type: 'queued_command',
      prompt: 'typed mid turn',
      commandMode: 'prompt',
      ...extra,
    },
  })
}
function sys(id: string, subtype: string, extra: object = {}) {
  return {
    type: 'system' as const,
    subtype,
    uuid: id,
    level: 'info',
    isMeta: false,
    content: 'x',
    ...extra,
  }
}
function interrupt(id: string, toolUse = false) {
  return label(id, createUserInterruptionMessage({ toolUse }))
}

const ids = (rows: Array<{ uuid?: string }>) => rows.map(r => r.uuid)
const select = (msgs: FocusMessage[], opts = {}) => selectFocusView(msgs, opts)

describe('selectFocusView turn boundaries', () => {
  test('three completed typed turns keep the latest prompt and answer and count two hidden', () => {
    const r = select([
      prompt('p1', 'one'),
      use('u1', 't1'),
      result('r1', 't1'),
      say('a1', 'answer one'),
      prompt('p2', 'two'),
      say('a2', 'answer two'),
      prompt('p3', 'three'),
      use('u3', 't3', 'Bash'),
      result('r3', 't3'),
      say('a3', 'answer three'),
    ])
    expect(r.hiddenTurns).toBe(2)
    expect(r.compacted).toBe(false)
    expect(ids(r.rows)).toEqual(['p3', 'a3'])
    expect(r.boundary?.uuid).toBe('p3')
    expect(r.summary.toolCount).toBe(1)
  })

  test('a local command and its output after a turn stay in the tail without moving the boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer one'),
      prompt('p2', 'two'),
      say('a2', 'answer two'),
      command('c', 'cost'),
      commandOut('o'),
    ])
    expect(ids(r.rows)).toEqual(['p2', 'a2', 'c', 'o'])
    expect(r.hiddenTurns).toBe(1)
  })

  test('a focus command with output after a completed turn keeps the previous turn as latest', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer'),
      command('c', 'focus'),
      commandOut('o', 'Focus view on'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
    expect(r.hiddenTurns).toBe(0)
    expect(ids(r.rows)).toEqual(['p1', 'a1', 'c', 'o'])
  })

  test('a prompt command followed by an assistant message is the boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer'),
      command('c', 'commit'),
      say('a2', 'committed'),
    ])
    expect(r.boundary?.uuid).toBe('c')
    expect(r.hiddenTurns).toBe(1)
    expect(ids(r.rows)).toEqual(['c', 'a2'])
  })

  test('a command with no output as the last candidate is the boundary only while a turn is in flight', () => {
    const msgs = [prompt('p1', 'one'), say('a1', 'answer'), command('c', 'commit')]
    expect(select(msgs, { isLoading: true }).boundary?.uuid).toBe('c')
    expect(select(msgs, { isLoading: false }).boundary?.uuid).toBe('p1')
  })

  test('a local command mid-turn does not take the boundary from the typed prompt', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'looking'),
      command('c', 'focus'),
      commandOut('o'),
      say('a2', 'more'),
      say('a3', 'final'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
    expect(r.hiddenTurns).toBe(0)
  })

  test('a local command before the answer to a scheduled prompt does not become the boundary', () => {
    const r = select([
      prompt('p1', 'typed'),
      say('a1', 'answer'),
      command('c', 'cost'),
      commandOut('o'),
      prompt('sched', 'scheduled', { origin: { kind: 'scheduled' } }),
      say('a2', 'scheduled answer'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
    expect(ids(r.rows)).toEqual(['p1', 'a1', 'c', 'o', 'a2'])
  })

  test('an immediate local command between two assistant messages is not the boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'first'),
      command('c', 'rename'),
      commandOut('o'),
      say('a2', 'second'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
  })

  test('shell input and output after a turn are kept and never the boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer'),
      prompt('sh', '<bash-input>ls</bash-input>'),
      prompt('so', '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
    expect(ids(r.rows)).toEqual(['p1', 'a1', 'sh', 'so'])
  })

  test('a queued prompt attachment mid-turn becomes the boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer'),
      queued('q'),
      say('a2', 'reply to queued'),
    ])
    expect(r.boundary?.uuid).toBe('q')
    expect(r.hiddenTurns).toBe(1)
    expect(ids(r.rows)).toEqual(['q', 'a2'])
  })

  test('a queued task notification is never a boundary', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'answer'),
      queued('q', { commandMode: 'task-notification' }),
      say('a2', 'noted'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
  })

  test('prompts and queued prompts with an origin are not boundaries and their answer is the final response', () => {
    const r = select([
      prompt('p1', 'typed'),
      say('a1', 'answer'),
      prompt('o1', 'from channel', { origin: { kind: 'channel' } }),
      queued('o2', { origin: { kind: 'channel' } }),
      say('a2', 'reply to channel'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
    expect(ids(r.rows)).toEqual(['p1', 'a1', 'a2'])
  })

  test('an image-only prompt and an image plus text prompt are boundaries', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } }
    const imageOnly = label('img', createUserMessage({ content: [image as never] }))
    const imageText = label(
      'imgtxt',
      createUserMessage({ content: [image as never, { type: 'text', text: 'what is this' }] }),
    )
    expect(select([prompt('p1', 'one'), say('a1', 'x'), imageOnly, say('a2', 'y')]).boundary?.uuid).toBe('img')
    expect(select([prompt('p1', 'one'), say('a1', 'x'), imageText, say('a2', 'y')]).boundary?.uuid).toBe('imgtxt')
  })

  test('a prompt starting with a html tag is a boundary but a task notification or system reminder text is not', () => {
    const base = [prompt('p1', 'one'), say('a1', 'x')]
    expect(select([...base, prompt('div', '<div>hi</div>'), say('a2', 'y')]).boundary?.uuid).toBe('div')
    expect(select([...base, prompt('tn', '<task-notification>done</task-notification>'), say('a2', 'y')]).boundary?.uuid).toBe('p1')
    expect(select([...base, prompt('lc', '<local-command-stdout>x</local-command-stdout>')]).boundary?.uuid).toBe('p1')
  })

  test('meta, compaction summary and synthetic messages are never boundaries', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'x'),
      prompt('meta', 'hidden context', { isMeta: true }),
      prompt('sum', 'summary of the conversation', { isCompactSummary: true }),
      prompt('syn', 'No response requested.'),
    ])
    expect(r.boundary?.uuid).toBe('p1')
  })

  test('a system reminder prefix is stripped before the tag check', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'x'),
      prompt('p2', '<system-reminder>ctx</system-reminder>\nreal question'),
      say('a2', 'y'),
    ])
    expect(r.boundary?.uuid).toBe('p2')
  })
})

describe('selectFocusView compaction and degenerate lists', () => {
  test('a compaction after three turns hides all of them and flags compaction', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'x'),
      prompt('p2', 'two'),
      say('a2', 'x'),
      prompt('p3', 'three'),
      say('a3', 'x'),
      command('c', 'compact'),
      label('cb', createCompactBoundaryMessage('manual', 100)),
      prompt('sum', 'This session is being continued...', { isCompactSummary: true }),
    ])
    expect(r.hiddenTurns).toBe(3)
    expect(r.compacted).toBe(true)
    expect(r.boundary?.uuid).toBe('cb')
    expect(ids(r.rows)).not.toContain('sum')
    expect(ids(r.rows)).not.toContain('p3')
  })

  test('the next prompt after a compaction becomes the boundary and clears the flag', () => {
    const r = select([
      prompt('p1', 'one'),
      say('a1', 'x'),
      label('cb', createCompactBoundaryMessage('manual', 100)),
      prompt('sum', 'summary', { isCompactSummary: true }),
      prompt('p2', 'two'),
      say('a2', 'y'),
    ])
    expect(r.boundary?.uuid).toBe('p2')
    expect(r.compacted).toBe(false)
    expect(r.hiddenTurns).toBe(1)
  })

  test('a list with no boundary is returned unchanged', () => {
    const msgs = [result('r', 't0'), say('a', 'tail of a resumed transcript')]
    const r = select(msgs)
    expect(r.rows).toBe(msgs)
    expect(r.boundary).toBeUndefined()
    expect(r.hiddenTurns).toBe(0)
  })

  test('an empty list yields no rows, no hidden turns and no compaction', () => {
    const r = select([])
    expect(r.rows).toEqual([])
    expect(r.hiddenTurns).toBe(0)
    expect(r.compacted).toBe(false)
  })
})

describe('selectFocusView summary counts', () => {
  test('a text-only turn has an empty summary', () => {
    const r = select([prompt('p', 'hi'), say('a', 'hello')])
    expect(r.summary).toEqual({ toolCount: 0, linesAdded: 0, linesRemoved: 0, failed: 0 })
  })

  test('tools without edits count tools only', () => {
    const r = select([
      prompt('p', 'hi'),
      use('u1', 't1'),
      result('r1', 't1'),
      use('u2', 't2', 'Grep'),
      result('r2', 't2'),
      say('a', 'done'),
    ])
    expect(r.summary).toEqual({ toolCount: 2, linesAdded: 0, linesRemoved: 0, failed: 0 })
  })

  test('a file edit and a file create sum added and removed lines', () => {
    const edit = {
      filePath: '/a.ts',
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' ctx', '-old', '+new1', '+new2'] },
      ],
    }
    const create = { type: 'create', filePath: '/b.ts', content: 'l1\nl2\nl3', structuredPatch: [] }
    const r = select([
      prompt('p', 'hi'),
      use('u1', 't1', 'Edit'),
      result('r1', 't1', { toolUseResult: edit }),
      use('u2', 't2', 'Write'),
      result('r2', 't2', { toolUseResult: create }),
      say('a', 'done'),
    ])
    expect(r.summary).toEqual({ toolCount: 2, linesAdded: 5, linesRemoved: 1, failed: 0 })
  })

  test('an agent result adds its reported tool count and one without the field counts as one', () => {
    const withCount = select([
      prompt('p', 'hi'),
      use('u1', 't1', 'Agent'),
      result('r1', 't1', { toolUseResult: { totalToolUseCount: 5 } }),
      say('a', 'done'),
    ])
    expect(withCount.summary.toolCount).toBe(6)
    const without = select([
      prompt('p', 'hi'),
      use('u1', 't1', 'Agent'),
      result('r1', 't1', { toolUseResult: { status: 'async_launched' } }),
      say('a', 'done'),
    ])
    expect(without.summary.toolCount).toBe(1)
  })

  test('plan, todo and question tool results are hidden and counted', () => {
    const r = select([
      prompt('p', 'hi'),
      use('u1', 't1', 'ExitPlanMode'),
      result('r1', 't1', { content: 'plan approved' }),
      use('u2', 't2', 'TodoWrite'),
      result('r2', 't2', { content: 'todos updated' }),
      use('u3', 't3', 'AskUserQuestion'),
      result('r3', 't3', { content: 'User answered' }),
      say('a', 'done'),
    ])
    expect(r.summary.toolCount).toBe(3)
    expect(ids(r.rows)).toEqual(['p', 'a'])
  })

  test('a synthetic streaming tool row is hidden and not counted', () => {
    const msgs = [prompt('p', 'hi'), say('n', 'narration'), use('u1', 'stream1')]
    const r = select(msgs, { isLoading: true, syntheticToolUseIds: new Set(['stream1']) })
    expect(r.summary.toolCount).toBe(0)
    expect(ids(r.rows)).toEqual(['p'])
    const committed = select([...msgs, result('r1', 'stream1')], { isLoading: true })
    expect(committed.summary.toolCount).toBe(1)
  })
})

describe('selectFocusView failures and rejections', () => {
  test('one failed result among four tools counts four with one failed and keeps the failure with its call line', () => {
    const r = select([
      prompt('p', 'hi'),
      use('u1', 't1'),
      result('r1', 't1'),
      use('u2', 't2', 'Bash'),
      result('r2', 't2', { isError: true, content: 'npm test failed' }),
      use('u3', 't3'),
      result('r3', 't3'),
      use('u4', 't4'),
      result('r4', 't4'),
      say('a', 'tests failed'),
    ])
    expect(r.summary.toolCount).toBe(4)
    expect(r.summary.failed).toBe(1)
    expect(ids(r.rows)).toEqual(['p', 'u2', 'r2', 'a'])
  })

  test('a rejected result is not a failure and with a following interrupt only the interrupt shows', () => {
    const r = select([
      prompt('p', 'edit it'),
      use('u1', 't1', 'Edit'),
      result('r1', 't1', { isError: true, content: REJECT_MESSAGE }),
      interrupt('i', true),
    ])
    expect(r.summary.failed).toBe(0)
    expect(r.summary.toolCount).toBe(1)
    expect(ids(r.rows)).toEqual(['p', 'i'])
  })

  test('a rejected result with nothing after it shows as the response with its call line before it', () => {
    const r = select([
      prompt('p', 'edit it'),
      use('u1', 't1', 'Edit'),
      result('r1', 't1', { isError: true, content: REJECT_MESSAGE }),
    ])
    expect(r.summary.failed).toBe(0)
    expect(ids(r.rows)).toEqual(['p', 'u1', 'r1'])
  })

  test('every rejection wording is a rejection rather than a failure', () => {
    const wordings = [
      CANCEL_MESSAGE,
      REJECT_MESSAGE_WITH_REASON_PREFIX + 'not now',
      PLAN_REJECTION_PREFIX + 'the plan',
      INTERRUPT_MESSAGE_FOR_TOOL_USE,
    ]
    for (const content of wordings) {
      const r = select([
        prompt('p', 'x'),
        use('u1', 't1'),
        result('r1', 't1', { isError: true, content }),
      ])
      expect(r.summary.failed).toBe(0)
    }
  })

  test('an error result that is not a rejection counts as failed', () => {
    const r = select([
      prompt('p', 'x'),
      use('u1', 't1'),
      result('r1', 't1', { isError: true, content: 'Permission denied by classifier' }),
      say('a', 'ok'),
    ])
    expect(r.summary.failed).toBe(1)
  })

  test('a turn ending with tool calls then an interrupt keeps the interrupt and hides narration', () => {
    const r = select([
      prompt('p', 'x'),
      say('n', 'starting'),
      use('u1', 't1'),
      interrupt('i'),
    ])
    expect(ids(r.rows)).toEqual(['p', 'i'])
  })

  test('api error messages and api_error system rows are kept', () => {
    const r = select([
      prompt('p', 'x'),
      label('e', createAssistantAPIErrorMessage({ content: 'rate limited' })),
      sys('se', 'api_error', { level: 'error' }),
    ])
    expect(ids(r.rows)).toEqual(['p', 'e', 'se'])
  })

  test('a hook summary with errors or a prevented continuation is kept and a clean one is hidden', () => {
    const r = select([
      prompt('p', 'x'),
      say('a', 'done'),
      sys('h1', 'stop_hook_summary', { hookErrors: ['boom'], preventedContinuation: false }),
      sys('h2', 'stop_hook_summary', { hookErrors: [], preventedContinuation: true }),
      sys('h3', 'stop_hook_summary', { hookErrors: [], preventedContinuation: false }),
    ])
    expect(ids(r.rows)).toEqual(['p', 'a', 'h1', 'h2'])
  })

  test('a warning after the final response is kept and the same warning mid-turn is hidden', () => {
    const warn = (id: string) => sys(id, 'informational', { level: 'warning' })
    const r = select([
      prompt('p', 'x'),
      warn('w1'),
      use('u1', 't1'),
      result('r1', 't1'),
      say('a', 'done'),
      warn('w2'),
    ])
    expect(ids(r.rows)).toEqual(['p', 'a', 'w2'])
  })

  test('turn duration, memory saved, informational rows and attachments are hidden', () => {
    const r = select([
      prompt('p', 'x'),
      say('a', 'done'),
      sys('d', 'turn_duration'),
      sys('m', 'memory_saved'),
      sys('i', 'informational'),
      queued('q', { commandMode: 'task-notification' }),
    ])
    expect(ids(r.rows)).toEqual(['p', 'a'])
  })
})

describe('selectFocusView final response', () => {
  test('narration between tool calls is hidden and only the text after the last tool result shows', () => {
    const r = select([
      prompt('p', 'rename it'),
      say('n1', "I'll read the file"),
      use('u1', 't1', 'Read'),
      result('r1', 't1'),
      say('n2', 'Now editing'),
      use('u2', 't2', 'Edit'),
      result('r2', 't2'),
      say('final', 'Done: renamed the helper'),
    ])
    expect(ids(r.rows)).toEqual(['p', 'final'])
  })

  test('streamed text shows while the turn is in flight until the next tool call arrives', () => {
    const streaming = select([prompt('p', 'x'), say('n', 'working on it')], { isLoading: true })
    expect(ids(streaming.rows)).toEqual(['p', 'n'])
    const nextTool = select([prompt('p', 'x'), say('n', 'working on it'), use('u1', 't1')], { isLoading: true })
    expect(ids(nextTool.rows)).toEqual(['p'])
  })

  test('whitespace-only, redacted-thinking-only and thinking-only messages are never the final response', () => {
    const r = select([
      prompt('p', 'x'),
      use('u1', 't1'),
      result('r1', 't1'),
      say('blank', '  \n '),
      redacted('red'),
      think('th'),
    ])
    expect(ids(r.rows)).toEqual(['p'])
  })
})

describe('countUnseenFocusTurns', () => {
  test('counts turns with a final response after the divider and ignores narration runs', () => {
    const msgs: FocusMessage[] = [
      prompt('p1', 'one'),
      say('a1', 'answer one'),
      prompt('p2', 'two'),
      say('n2', 'narration'),
      use('u2', 't2'),
      result('r2', 't2'),
      say('n3', 'more narration'),
      use('u3', 't3'),
      result('r3', 't3'),
      say('f2', 'final two'),
      prompt('p3', 'three'),
      say('n4', 'narration only so far'),
      use('u4', 't4'),
    ]
    // Divider at the first message of turn two: turn two has a final response, turn three has none yet.
    expect(countUnseenFocusTurns(msgs, 2)).toBe(1)
    // Divider at the start counts both finished turns.
    expect(countUnseenFocusTurns(msgs, 0)).toBe(2)
    // Divider past the final response of turn two sees nothing new.
    expect(countUnseenFocusTurns(msgs, 10)).toBe(0)
  })
})
