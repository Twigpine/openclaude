import { EventEmitter } from 'node:events'
import { expect, spyOn, test } from 'bun:test'
import { QueryEngine } from '../QueryEngine.js'
import { GrpcServer } from './server.js'

class FakeCall extends EventEmitter {
  writes: unknown[] = []
  ended = false

  write(value: unknown): void {
    this.writes.push(value)
  }

  end(): void {
    this.ended = true
  }
}

async function exerciseInterruption(
  event: 'cancel' | 'end',
): Promise<string | undefined> {
  let releaseSubmit!: () => void
  const submitBlocked = new Promise<void>(resolve => {
    releaseSubmit = resolve
  })
  let submitEntered = false
  const submitMessage = spyOn(
    QueryEngine.prototype,
    'submitMessage',
  ).mockImplementation(
    async function* () {
      submitEntered = true
      await submitBlocked
    },
  )
  const interrupt = spyOn(QueryEngine.prototype, 'interrupt')
  try {
    const server = new GrpcServer()
    const call = new FakeCall()
    ;(server as unknown as {
      handleChat(call: FakeCall): void
    }).handleChat(call)
    call.emit('data', {
      request: {
        message: 'test',
        working_directory: process.cwd(),
        model: 'sonnet',
      },
    })
    let interruptionEmitted = false
    for (
      let attempts = 0;
      attempts < 100 && interrupt.mock.calls.length === 0;
      attempts++
    ) {
      if (event === 'cancel' && submitEntered && !interruptionEmitted) {
        call.emit('data', { cancel: {} })
        interruptionEmitted = true
      }
      if (event === 'end' && submitEntered && !interruptionEmitted) {
        call.emit('end')
        interruptionEmitted = true
      }
      await Bun.sleep(10)
    }
    if (!submitEntered) {
      throw new Error('submitMessage was never entered')
    }
    if (interrupt.mock.calls.length === 0) {
      throw new Error(
        `Timed out waiting for QueryEngine.interrupt after the '${event}' event`,
      )
    }
    return interrupt.mock.calls[0]?.[0]
  } finally {
    releaseSubmit()
    await Bun.sleep(10)
    interrupt.mockRestore()
    submitMessage.mockRestore()
  }
}

test('labels an explicit gRPC cancellation', async () => {
  expect(await exerciseInterruption('cancel')).toBe('grpc_cancel')
})

test('labels a gRPC stream ending while a query is active', async () => {
  expect(await exerciseInterruption('end')).toBe('grpc_stream_end')
})
