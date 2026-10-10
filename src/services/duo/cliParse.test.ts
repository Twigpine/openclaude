import { describe, expect, test } from 'bun:test'
import {
  buildClineArgs,
  buildOpenCodeArgs,
  buildOpenCodeSystemArgs,
  buildSystemPayload,
  normalizeClinePrompt,
  parseClineOutput,
  parseOpenCodeOutput,
  wrapClineTranscript,
} from './cliParse.js'

const ndjson = (objects: unknown[]) => objects.map(o => JSON.stringify(o)).join('\n')

describe('parseOpenCodeOutput', () => {  test('joins text parts and captures the session id', () => {
    const out = parseOpenCodeOutput(
      ndjson([
        { type: 'text', sessionID: 'ses_abc', part: { text: 'hello' } },
        { type: 'text', part: { text: 'world' } },
      ]),
    )
    expect(out.text).toBe('hello\n\nworld')
    expect(out.session).toBe('ses_abc')
    expect(out.error).toBeNull()
  })

  test('captures error events', () => {
    const out = parseOpenCodeOutput(
      ndjson([
        { type: 'error', error: { type: 'ProviderAuthError', status: 401, message: 'no key' } },
      ]),
    )
    expect(out.error).toBe('ProviderAuthError 401 no key')
    expect(out.text).toBe('')
  })

  test('reads usage from step_finish (input + cache read)', () => {
    const out = parseOpenCodeOutput(
      [
        { type: 'text', sessionID: 's1', part: { text: 'hello' } },
        {
          type: 'step_finish',
          part: {
            reason: 'stop',
            cost: 0,
            tokens: { input: 1200, output: 48, cache: { read: 340 } },
          },
        },
      ]
        .map(o => JSON.stringify(o))
        .join('\n'),
    )
    expect(out.text).toBe('hello')
    expect(out.usage).toEqual({ input: 1540, output: 48, cost: 0 })
  })

  test('a truncated step surfaces finishReason length', () => {
    const out = parseOpenCodeOutput(
      [
        { type: 'text', part: { text: 'long reply' } },
        {
          type: 'step_finish',
          part: { reason: 'length', tokens: { input: 10, output: 4096 } },
        },
      ]
        .map(o => JSON.stringify(o))
        .join('\n'),
    )
    expect(out.finishReason).toBe('length')
  })

  test('captures a top-level error object without a type field', () => {
    const out = parseOpenCodeOutput(
      JSON.stringify({ error: { type: 'ApiError', message: 'boom' } }),
    )
    expect(out.error).toBe('boom')
  })

  test('ignores non-JSON lines', () => {
    const out = parseOpenCodeOutput(
      `warning: something\n${JSON.stringify({ type: 'text', part: { text: 'ok' } })}\n`,
    )
    expect(out.text).toBe('ok')
    expect(out.error).toBeNull()
  })
})

describe('parseClineOutput', () => {
  test('reads run_result text, model and usage', () => {
    const out = parseClineOutput(
      ndjson([
        {
          type: 'run_result',
          text: 'final answer',
          model: { id: 'cline-free/muse-spark-1.3-contributor' },
          usage: { inputTokens: 6436, outputTokens: 14, totalCost: 0 },
          finishReason: 'completed',
        },
      ]),
    )
    expect(out.text).toBe('final answer')
    expect(out.model).toBe('cline-free/muse-spark-1.3-contributor')
    expect(out.usage).toEqual({ input: 6436, output: 14, cost: 0 })
    expect(out.error).toBeNull()
  })

  test('falls back to agent_event content_end and de-duplicates', () => {
    const out = parseClineOutput(
      ndjson([
        { type: 'agent_event', event: { type: 'content_end', contentType: 'text', text: 'part' } },
        { type: 'agent_event', event: { type: 'content_end', contentType: 'text', text: 'part' } },
        { type: 'agent_event', event: { type: 'content_end', contentType: 'text', text: 'more' } },
      ]),
    )
    expect(out.text).toBe('part\n\nmore')
  })

  test('non-completed finishReason becomes an error', () => {
    const out = parseClineOutput(
      ndjson([{ type: 'run_result', text: 'x', finishReason: 'max_tokens' }]),
    )
    expect(out.error).toBe('finishReason=max_tokens')
  })
})

describe('argv builders', () => {
  test('opencode: flags only when set, message last', () => {
    expect(buildOpenCodeArgs({ message: 'hi there' })).toEqual([
      'run',
      '--format',
      'json',
      'hi there',
    ])
    expect(
      buildOpenCodeArgs({
        message: 'hi there',
        model: 'opencode/space-bunny-free',
        session: 'ses_1',
        approve: true,
      }),
    ).toEqual([
      'run',
      '--format',
      'json',
      '--session',
      'ses_1',
      '-m',
      'opencode/space-bunny-free',
      '--auto',
      'hi there',
    ])
  })

  test('opencode system form carries no message: it travels on stdin', () => {
    expect(buildOpenCodeSystemArgs()).toEqual(['run', '--format', 'json'])
    expect(
      buildOpenCodeSystemArgs({ model: 'opencode/space-bunny-free', approve: true }),
    ).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'opencode/space-bunny-free',
      '--auto',
    ])
    const payload = JSON.parse(
      buildSystemPayload(['be terse', 'answer NONE or nothing'], 'pick a skill'),
    )
    expect(payload.system).toEqual(['be terse', 'answer NONE or nothing'])
    expect(payload.messages).toEqual([{ role: 'user', content: 'pick a skill' }])
  })

  test('cline: auto-approve is explicit and off by default', () => {
    expect(buildClineArgs({ message: 'hi there' })).toEqual([
      'hi there',
      '--json',
      '--auto-approve',
      'false',
    ])
    expect(
      buildClineArgs({ message: 'hi there', model: 'cline-free/x', provider: 'cline', approve: true }),
    ).toEqual([
      'hi there',
      '--json',
      '--auto-approve',
      'true',
      '-P',
      'cline',
      '-m',
      'cline-free/x',
    ])
  })
})

describe('wrapClineTranscript', () => {
  test('no history → message unchanged', () => {
    expect(wrapClineTranscript('hello', [])).toBe('hello')
  })

  test('replays turns oldest-first and keeps the current message last', () => {
    const out = wrapClineTranscript('now', [
      { message: 'm1', reply: 'r1' },
      { message: 'm2', reply: 'r2' },
    ])
    expect(out).toContain('[Previous message]\nm1\n\n[Your reply]\nr1')
    expect(out).toContain('[Previous message]\nm2\n\n[Your reply]\nr2')
    expect(out.endsWith('[Current message]\nnow')).toBe(true)
  })

  test('drops the oldest turns past the ~6 Ko budget', () => {
    const big = 'x'.repeat(7000)
    const out = wrapClineTranscript('now', [
      { message: 'old', reply: big },
      { message: 'recent', reply: 'small' },
    ])
    expect(out).toContain('recent')
    expect(out).not.toContain('[Previous message]\nold')
  })
})

describe('normalizeClinePrompt', () => {
  test('appends a separator to single-word prompts', () => {
    expect(normalizeClinePrompt('banana')).toBe('banana .')
  })

  test('leaves normal prompts untouched', () => {
    expect(normalizeClinePrompt('what is 2+2?')).toBe('what is 2+2?')
  })
})