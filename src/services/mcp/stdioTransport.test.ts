import { describe, expect, test } from 'bun:test'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_STDIO_MAX_BUFFER_BYTES,
  McpStdioReadBuffer,
  createMcpStdioClientTransport,
  createMcpStdioServerTransport,
} from './stdioTransport.js'

const PAYLOAD_BYTES = 12 * 1024 * 1024
const PIPE_CHUNK_BYTES = 64 * 1024

// A stdio "server" that writes one 12 MiB JSON-RPC notification (above the
// SDK's 10 MiB default) and exits once it is flushed.
const SERVER_SCRIPT = `
const message = JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/message',
  params: { level: 'info', data: 'x'.repeat(${PAYLOAD_BYTES}) },
}) + '\\n'
process.stdout.write(message, () => process.exit(0))
`

type FirstEvent = { message?: JSONRPCMessage; error?: Error }

async function firstEvent(transport: StdioClientTransport): Promise<FirstEvent> {
  try {
    return await new Promise<FirstEvent>((resolve, reject) => {
      transport.onmessage = message => resolve({ message })
      transport.onerror = error => resolve({ error })
      transport.onclose = () =>
        reject(new Error('stdio server closed before sending a message'))
      transport.start().catch(reject)
    })
  } finally {
    await transport.close()
  }
}

const serverParams = {
  command: process.execPath,
  args: ['-e', SERVER_SCRIPT],
  stderr: 'pipe' as const,
}

function notification(data: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data },
    })}\n`,
  )
}

function chunksOf(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size))
  }
  return chunks
}

type ReadOutcome = { message: JSONRPCMessage } | { error: string }

/** Feeds chunks the way the SDK transports do: append, then drain. */
function readAll(
  buffer: Pick<ReadBuffer, 'append' | 'readMessage'>,
  chunks: Buffer[],
): ReadOutcome[] {
  const outcomes: ReadOutcome[] = []
  for (const chunk of chunks) {
    try {
      buffer.append(chunk)
    } catch (error) {
      outcomes.push({ error: (error as Error).message })
      continue
    }
    while (true) {
      try {
        const message = buffer.readMessage()
        if (message === null) break
        outcomes.push({ message })
      } catch (error) {
        outcomes.push({ error: (error as Error).message })
      }
    }
  }
  return outcomes
}

describe('MCP stdio client transport', () => {
  test('the limit is above the 10 MiB SDK default', () => {
    expect(MCP_STDIO_MAX_BUFFER_BYTES).toBeGreaterThan(PAYLOAD_BYTES)
  })

  test('both transports read through the linear-time buffer', () => {
    const client = createMcpStdioClientTransport(serverParams)
    const server = createMcpStdioServerTransport()
    for (const transport of [client, server]) {
      expect(
        (transport as unknown as { _readBuffer: unknown })._readBuffer,
      ).toBeInstanceOf(McpStdioReadBuffer)
    }
  })

  test('the SDK default drops a 12 MiB message', async () => {
    const { message, error } = await firstEvent(new StdioClientTransport(serverParams))
    expect(message).toBeUndefined()
    expect(error?.message).toContain('ReadBuffer exceeded maximum size')
  })

  test('delivers a 12 MiB message from a stdio server', async () => {
    const { message, error } = await firstEvent(
      createMcpStdioClientTransport(serverParams),
    )
    expect(error).toBeUndefined()
    expect(message).toMatchObject({ method: 'notifications/message' })
    const data = (message as { params?: { data?: string } } | undefined)
      ?.params?.data
    expect(data?.length).toBe(PAYLOAD_BYTES)
  })
})

describe('McpStdioReadBuffer', () => {
  test('matches the SDK buffer for split, joined, CRLF, UTF-8 and invalid lines', () => {
    const stream = Buffer.concat([
      notification('first'),
      notification('日本語 ✓ split across chunks'),
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\r\n'),
      Buffer.from('not json\n'),
      notification('after the invalid line'),
      Buffer.from('{"jsonrpc":"2.0","method":"partial"'),
    ])
    for (const size of [1, 2, 3, 5, 7, 64, stream.length]) {
      const chunks = chunksOf(stream, size)
      const ours = readAll(new McpStdioReadBuffer(), chunks)
      expect(ours).toEqual(readAll(new ReadBuffer(), chunks))
      expect(ours.filter(outcome => 'message' in outcome)).toHaveLength(4)
    }
  })

  test('accepts a message at the limit and rejects one byte more, like the SDK', () => {
    const message = notification('x'.repeat(1000))
    const chunks = chunksOf(message, 100)

    const atLimit = readAll(new McpStdioReadBuffer(message.length), chunks)
    expect(atLimit).toEqual(
      readAll(new ReadBuffer({ maxBufferSize: message.length }), chunks),
    )
    expect(atLimit).toEqual([{ message: expect.anything() }])

    const overLimit = new McpStdioReadBuffer(message.length - 1)
    const outcomes = readAll(overLimit, chunks)
    expect(outcomes).toEqual(
      readAll(new ReadBuffer({ maxBufferSize: message.length - 1 }), chunks),
    )
    expect(outcomes).toEqual([
      { error: `ReadBuffer exceeded maximum size of ${message.length - 1} bytes` },
    ])
    expect(overLimit.bufferedBytes).toBe(0)
  })

  test('reads a large chunked message with linear copying and scanning', () => {
    const message = notification('x'.repeat(32 * 1024 * 1024))
    const chunks = chunksOf(message, PIPE_CHUNK_BYTES)

    const originalConcat = Buffer.concat
    const originalIndexOf = Buffer.prototype.indexOf
    let copiedBytes = 0
    let scannedBytes = 0
    Buffer.concat = function (list, totalLength) {
      const result = originalConcat.call(Buffer, list, totalLength)
      copiedBytes += result.length
      return result
    } as typeof Buffer.concat
    Buffer.prototype.indexOf = function (
      this: Buffer,
      value: Parameters<Buffer['indexOf']>[0],
      byteOffset?: number,
      encoding?: BufferEncoding,
    ) {
      const index = originalIndexOf.call(this, value, byteOffset, encoding)
      const start = byteOffset ?? 0
      scannedBytes += (index === -1 ? this.length : index + 1) - start
      return index
    } as Buffer['indexOf']

    const buffer = new McpStdioReadBuffer()
    let outcomes: ReadOutcome[]
    try {
      outcomes = readAll(buffer, chunks)
    } finally {
      Buffer.concat = originalConcat
      Buffer.prototype.indexOf = originalIndexOf
    }

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toHaveProperty('message.params.data.length', 32 * 1024 * 1024)
    // Each byte is scanned once and the line is copied once. The SDK buffer
    // copies and scans the pending bytes again for every chunk, about 256
    // times the message size here.
    expect(scannedBytes).toBe(message.length)
    expect(copiedBytes).toBe(message.length - 1)
    expect(buffer.bufferedBytes).toBe(0)
  })

  test('keeps only the unread remainder after a message', () => {
    const buffer = new McpStdioReadBuffer()
    const first = notification('first')
    buffer.append(Buffer.concat([first, Buffer.from('{"jsonrpc"')]))
    expect(buffer.readMessage()).toMatchObject({ params: { data: 'first' } })
    expect(buffer.readMessage()).toBeNull()
    expect(buffer.bufferedBytes).toBe('{"jsonrpc"'.length)

    buffer.clear()
    buffer.append(first)
    expect(buffer.readMessage()).toMatchObject({ params: { data: 'first' } })
    expect(buffer.bufferedBytes).toBe(0)
  })
})
