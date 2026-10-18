import { describe, expect, test } from 'bun:test'
import { driveQueryEvents } from './queryEventDriver.js'

describe('driveQueryEvents', () => {
  test('registers activity only for yielded events and returns terminal state', async () => {
    async function* query(): AsyncGenerator<
      { type: string },
      { reason: string }
    > {
      yield { type: 'stream_request_start' }
      yield { type: 'stream_event' }
      return { reason: 'completed' }
    }
    const activity: string[] = []
    const events: string[] = []

    const terminal = await driveQueryEvents(
      query(),
      reason => activity.push(reason),
      event => events.push(event.type),
    )

    expect(activity).toEqual([
      'query_event:stream_request_start',
      'query_event:stream_event',
    ])
    expect(events).toEqual(['stream_request_start', 'stream_event'])
    expect(terminal).toEqual({ reason: 'completed' })
  })

  test('closes the generator if event handling throws', async () => {
    let finalized = false
    async function* query(): AsyncGenerator<{ type: string }, void> {
      try {
        yield { type: 'stream_event' }
        yield { type: 'must_not_be_seen' }
      } finally {
        finalized = true
      }
    }

    await expect(
      driveQueryEvents(
        query(),
        () => {},
        () => {
          throw new Error('consumer failed')
        },
      ),
    ).rejects.toThrow('consumer failed')
    expect(finalized).toBe(true)
  })

  test('does not let generator cleanup mask an event-handler failure', async () => {
    const generator: AsyncGenerator<{ type: string }, void> = {
      next: async () => ({ done: false, value: { type: 'stream_event' } }),
      return: async () => {
        throw new Error('generator cleanup failed')
      },
      throw: async error => {
        throw error
      },
      [Symbol.asyncIterator]() {
        return this
      },
      [Symbol.asyncDispose]: async () => {},
    }

    await expect(
      driveQueryEvents(
        generator,
        () => {},
        () => {
          throw new Error('consumer failed')
        },
      ),
    ).rejects.toThrow('consumer failed')
  })
})
