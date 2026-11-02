import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * Largest single stdio MCP message we buffer. MCP SDK 1.32 added a 10 MiB
 * default and closes the connection when one message exceeds it, which kills
 * servers that return a base64 screenshot, file or large query result in one
 * tool call (SDK 1.29 had no limit). Oversized results are still truncated
 * before they reach the model.
 */
export const MCP_STDIO_MAX_BUFFER_BYTES = 128 * 1024 * 1024

const NEWLINE = 0x0a

/**
 * Splits a stdio byte stream into JSON-RPC messages in linear time.
 *
 * The SDK's `ReadBuffer` (1.32.1) concatenates the whole pending buffer on
 * every chunk and searches it from the start, so an n-byte message costs
 * O(n²): a 100 MiB message in 64 KiB pipe chunks blocks the event loop for
 * about 10 seconds. It also keeps the remainder of a parsed message as a
 * `subarray`, which holds the whole allocation alive even when it is empty.
 *
 * This buffer keeps the chunks in a list, looks at each byte once when
 * searching for a newline, copies a message once when it is complete, and
 * never keeps an empty remainder. Limit, error and parsing behaviour match the
 * SDK's buffer.
 */
export class McpStdioReadBuffer {
  private chunks: Buffer[] = []
  private size = 0
  // Where the newline search resumes. Bytes before it hold no newline.
  private scanChunk = 0
  private scanOffset = 0

  constructor(private readonly maxBufferSize = MCP_STDIO_MAX_BUFFER_BYTES) {}

  get bufferedBytes(): number {
    return this.size
  }

  append(chunk: Buffer): void {
    if (this.size + chunk.length > this.maxBufferSize) {
      this.clear()
      throw new Error(
        `ReadBuffer exceeded maximum size of ${this.maxBufferSize} bytes`,
      )
    }
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  readMessage(): JSONRPCMessage | null {
    while (this.scanChunk < this.chunks.length) {
      const chunk = this.chunks[this.scanChunk]!
      const newline = chunk.indexOf(NEWLINE, this.scanOffset)
      if (newline === -1) {
        this.scanChunk++
        this.scanOffset = 0
        continue
      }
      return deserializeMessage(this.takeLine(this.scanChunk, newline))
    }
    return null
  }

  clear(): void {
    this.chunks = []
    this.size = 0
    this.scanChunk = 0
    this.scanOffset = 0
  }

  /** Removes the bytes up to and including the newline and decodes them. */
  private takeLine(lastChunk: number, newline: number): string {
    const last = this.chunks[lastChunk]!
    const parts = this.chunks.slice(0, lastChunk)
    parts.push(last.subarray(0, newline))
    const lineBytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts)

    const rest = last.subarray(newline + 1)
    const remaining = this.chunks.slice(lastChunk + 1)
    if (rest.length > 0) remaining.unshift(rest)
    this.chunks = remaining
    this.size -= lineBytes.length + 1
    this.scanChunk = 0
    this.scanOffset = 0

    return lineBytes.toString('utf8').replace(/\r$/, '')
  }
}

type ReadBufferHost = { _readBuffer?: unknown }

function isReadBuffer(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const buffer = value as Record<string, unknown>
  return (
    typeof buffer.append === 'function' &&
    typeof buffer.readMessage === 'function' &&
    typeof buffer.clear === 'function'
  )
}

/**
 * Swaps the SDK transport's private `_readBuffer` for McpStdioReadBuffer.
 * SDK 1.32.1 only calls `append`, `readMessage` and `clear` on it. If a later
 * SDK (possible for SDK embedders, who bring their own) no longer has the
 * field, the SDK's own buffer stays, still with the raised size limit.
 */
function useLinearReadBuffer(transport: object, maxBufferSize: number): void {
  const host = transport as ReadBufferHost
  if (!isReadBuffer(host._readBuffer)) return
  host._readBuffer = new McpStdioReadBuffer(maxBufferSize)
}

/** Creates the stdio client transport for a configured MCP server. */
export function createMcpStdioClientTransport(
  params: StdioServerParameters,
): StdioClientTransport {
  const maxBufferSize = params.maxBufferSize ?? MCP_STDIO_MAX_BUFFER_BYTES
  const transport = new StdioClientTransport({ ...params, maxBufferSize })
  useLinearReadBuffer(transport, maxBufferSize)
  return transport
}

/** Creates the stdio server transport for `openclaude mcp serve`. */
export function createMcpStdioServerTransport(): StdioServerTransport {
  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
  })
  useLinearReadBuffer(transport, MCP_STDIO_MAX_BUFFER_BYTES)
  return transport
}
