import { describe, expect, test } from 'bun:test'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_STDIO_MAX_BUFFER_BYTES,
  createMcpStdioClientTransport,
} from './stdioTransport.js'

const PAYLOAD_BYTES = 12 * 1024 * 1024

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

describe('MCP stdio client transport', () => {
  test('the limit is above the 10 MiB SDK default', () => {
    expect(MCP_STDIO_MAX_BUFFER_BYTES).toBeGreaterThan(PAYLOAD_BYTES)
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
