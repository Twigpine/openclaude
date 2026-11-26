import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, spyOn, test } from 'bun:test'
import * as mcpEntrypoint from '../entrypoints/mcp.js'
import * as mcpClient from '../services/mcp/client.js'
import { QueryEngine } from '../QueryEngine.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Tool } from '../Tool.js'
import { getCwd } from '../utils/cwd.js'
import { GrpcServer } from './server.js'

class FakeCall extends EventEmitter {
  writes: unknown[] = []
  write(value: unknown): void {
    this.writes.push(value)
  }
  end(): void {}
}

type EngineConfig = { mcpClients: MCPServerConnection[]; tools: readonly Tool[] }

// Starts one chat on a fresh stream and returns the config the server gave the QueryEngine.
async function configFor(server: GrpcServer, cwd: string): Promise<EngineConfig> {
  let captured: EngineConfig | undefined
  const submit = spyOn(QueryEngine.prototype, 'submitMessage').mockImplementation(
    async function* (this: QueryEngine) {
      captured = (this as unknown as { config: EngineConfig }).config
    },
  )
  try {
    const call = new FakeCall()
    ;(server as unknown as { handleChat(call: FakeCall): void }).handleChat(call)
    call.emit('data', { request: { message: 'list the tools', working_directory: cwd, model: 'sonnet' } })
    for (let i = 0; i < 200 && !captured; i++) await Bun.sleep(5)
    if (!captured) throw new Error(`no QueryEngine was started; the stream got ${JSON.stringify(call.writes)}`)
    return captured
  } finally {
    submit.mockRestore()
  }
}

test('a chat gets the MCP servers configured for its working directory, connected once per directory', async () => {
  const projectA = mkdtempSync(join(tmpdir(), 'grpc-mcp-a-'))
  const projectB = mkdtempSync(join(tmpdir(), 'grpc-mcp-b-'))
  const client = { name: 'example_mcp', type: 'connected' } as unknown as MCPServerConnection
  const tool = { name: 'mcp__example_mcp__list' } as unknown as Tool
  const loadedIn: string[] = []
  const load = spyOn(mcpEntrypoint, 'loadReexposedMcpTools').mockImplementation(async () => {
    loadedIn.push(getCwd())
    return { mcpClients: [client], mcpTools: [tool] }
  })
  try {
    const server = new GrpcServer()
    const first = await configFor(server, projectA)
    expect(first.mcpClients).toEqual([client])
    expect(first.tools.map(t => t.name)).toContain('mcp__example_mcp__list')

    const second = await configFor(server, projectA)
    expect(second.mcpClients).toEqual([client])
    await configFor(server, projectB)
    expect(loadedIn).toEqual([projectA, projectB])
  } finally {
    load.mockRestore()
    rmSync(projectA, { recursive: true, force: true })
    rmSync(projectB, { recursive: true, force: true })
  }
})

test('while the MCP servers connect, a second request is refused and a cancel starts no engine', async () => {
  let finishLoading!: () => void
  const loading = new Promise<void>(resolve => {
    finishLoading = resolve
  })
  const load = spyOn(mcpEntrypoint, 'loadReexposedMcpTools').mockImplementation(async () => {
    await loading
    return { mcpClients: [], mcpTools: [] }
  })
  const submit = spyOn(QueryEngine.prototype, 'submitMessage').mockImplementation(async function* () {})
  try {
    const call = new FakeCall()
    ;(new GrpcServer() as unknown as { handleChat(call: FakeCall): void }).handleChat(call)
    const request = { request: { message: 'hi', working_directory: process.cwd(), model: 'sonnet' } }
    call.emit('data', request)
    await Bun.sleep(5)
    call.emit('data', request)
    call.emit('data', { cancel: {} })
    finishLoading()
    await Bun.sleep(20)

    expect(call.writes).toContainEqual({
      error: { message: 'A request is already in progress on this stream', code: 'ALREADY_EXISTS' },
    })
    expect(submit).not.toHaveBeenCalled()
  } finally {
    load.mockRestore()
    submit.mockRestore()
  }
})

test('servers that failed or needed sign-in reconnect on the next chat, alone, without duplicate tools', async () => {
  const project = mkdtempSync(join(tmpdir(), 'grpc-mcp-retry-'))
  const config = (url: string) => ({ type: 'http', url, scope: 'project' })
  const up = { name: 'up', type: 'connected' } as unknown as MCPServerConnection
  const down = { name: 'down', type: 'failed', config: config('https://down.invalid/mcp') } as unknown as MCPServerConnection
  const locked = { name: 'locked', type: 'needs-auth', config: config('https://locked.invalid/mcp') } as unknown as MCPServerConnection
  const tool = (name: string) => ({ name }) as unknown as Tool
  const shared = [tool('ListMcpResourcesTool'), tool('ReadMcpResourceTool')]
  const load = spyOn(mcpEntrypoint, 'loadReexposedMcpTools').mockImplementation(async () => ({
    mcpClients: [up, down, locked],
    mcpTools: [tool('mcp__up__a'), tool('mcp__locked__authenticate'), ...shared],
  }))
  const reconnected: string[] = []
  const reconnect = spyOn(mcpClient, 'reconnectMcpServerImpl').mockImplementation(async name => {
    reconnected.push(name)
    return {
      client: { name, type: 'connected' } as unknown as MCPServerConnection,
      tools: [tool(`mcp__${name}__b`)],
      commands: [],
    }
  })
  try {
    const server = new GrpcServer()
    const first = await configFor(server, project)
    expect(first.mcpClients).toEqual([up, down, locked])

    const second = await configFor(server, project)
    expect(second.mcpClients.map(c => `${c.name}:${c.type}`)).toEqual(['up:connected', 'down:connected', 'locked:connected'])
    const names = second.tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['mcp__up__a', 'mcp__down__b', 'mcp__locked__b']))
    expect(names).not.toContain('mcp__locked__authenticate')
    expect(names.filter(n => n === 'ListMcpResourcesTool')).toHaveLength(1)

    await configFor(server, project)
    expect(load).toHaveBeenCalledTimes(1)
    expect(reconnected.sort()).toEqual(['down', 'locked'])
  } finally {
    load.mockRestore()
    reconnect.mockRestore()
    rmSync(project, { recursive: true, force: true })
  }
})
