import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Largest single stdio MCP message we buffer. MCP SDK 1.32 added a 10 MiB
 * default and closes the connection when one message exceeds it, which kills
 * servers that return a base64 screenshot, file or large query result in one
 * tool call (SDK 1.29 had no limit). Oversized results are still truncated
 * before they reach the model.
 */
export const MCP_STDIO_MAX_BUFFER_BYTES = 128 * 1024 * 1024

/** Creates the stdio client transport for a configured MCP server. */
export function createMcpStdioClientTransport(
  params: StdioServerParameters,
): StdioClientTransport {
  return new StdioClientTransport({
    maxBufferSize: MCP_STDIO_MAX_BUFFER_BYTES,
    ...params,
  })
}
