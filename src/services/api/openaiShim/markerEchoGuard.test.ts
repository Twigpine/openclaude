import { expect, test } from 'bun:test'
import {
  TOOL_RESULTS_RECEIVED_MARKER,
  stripEchoedToolResultsMarker,
  stripMarkerEchoesFromStream,
} from './markerEchoGuard.js'

type GuardEvent = {
  type: string
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
}

async function collect(events: AsyncGenerator<GuardEvent>): Promise<GuardEvent[]> {
  const out: GuardEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function streamOf(events: GuardEvent[]): AsyncGenerator<GuardEvent> {
  return (async function* () {
    for (const event of events) yield event
  })()
}

function textDelta(index: number, text: string): GuardEvent {
  return { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
}

function textDeltasOf(events: GuardEvent[]): string {
  return events
    .filter(event =>
      event.type === 'content_block_delta' &&
      (event.delta as { type?: string } | undefined)?.type === 'text_delta',
    )
    .map(event => (event.delta as { text: string }).text)
    .join('')
}

test('stripEchoedToolResultsMarker removes every literal marker occurrence', () => {
  expect(stripEchoedToolResultsMarker(`A ${TOOL_RESULTS_RECEIVED_MARKER} B`)).toBe('A  B')
  expect(
    stripEchoedToolResultsMarker(`${TOOL_RESULTS_RECEIVED_MARKER}${TOOL_RESULTS_RECEIVED_MARKER}`),
  ).toBe('')
})

test('stripEchoedToolResultsMarker leaves unrelated text untouched', () => {
  expect(stripEchoedToolResultsMarker('array[0] = "[Tool"')).toBe('array[0] = "[Tool"')
  expect(stripEchoedToolResultsMarker('')).toBe('')
})

test('stream wrapper passes non-text events through untouched', async () => {
  const messageStart: GuardEvent = { type: 'message_start' }
  const thinkingDelta: GuardEvent = {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'hmm' },
  }
  const jsonDelta: GuardEvent = {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"cmd":true}' },
  }

  const events = await collect(stripMarkerEchoesFromStream(
    streamOf([messageStart, thinkingDelta, jsonDelta]),
  ))

  expect(events).toEqual([messageStart, thinkingDelta, jsonDelta])
})

test('stream wrapper drops a marker split across deltas exactly as issue #2039 captured it', async () => {
  const events = await collect(stripMarkerEchoesFromStream(streamOf([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    textDelta(0, '['),
    textDelta(0, 'Tool'),
    textDelta(0, ' results'),
    textDelta(0, ' received'),
    textDelta(0, ']'),
    { type: 'content_block_stop', index: 0 },
  ])))

  expect(textDeltasOf(events)).toBe('')
  expect(events.some(event => event.type === 'content_block_stop')).toBe(true)
})

test('stream wrapper strips an inline marker while preserving surrounding prose', async () => {
  const events = await collect(stripMarkerEchoesFromStream(streamOf([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    textDelta(0, 'Before '),
    textDelta(0, TOOL_RESULTS_RECEIVED_MARKER),
    textDelta(0, ' After'),
    { type: 'content_block_stop', index: 0 },
  ])))

  expect(textDeltasOf(events)).toBe('Before  After')
})

test('stream wrapper reassembles plain text byte-for-byte across deltas', async () => {
  const chunks = ['const arr', 'ay = [1,', ' 2]; done']
  const events = await collect(stripMarkerEchoesFromStream(streamOf([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...chunks.map((chunk, i) => textDelta(0, chunk)),
    { type: 'content_block_stop', index: 0 },
  ])))

  expect(textDeltasOf(events)).toBe(chunks.join(''))
})

test('stream wrapper releases a trailing partial marker verbatim at block close', async () => {
  const events = await collect(stripMarkerEchoesFromStream(streamOf([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    textDelta(0, 'looks like [Tool res'),
    { type: 'content_block_stop', index: 0 },
  ])))

  expect(textDeltasOf(events)).toBe('looks like [Tool res')
})
